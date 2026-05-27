# Deploying Tripwire

Five paths. Pick the one that matches your shape.

| Mode | Latency | Cost | Best for |
|---|---|---|---|
| Library (npm) | 0 | $0 | You own the LLM call site |
| Docker single-host | ~5ms | $5/mo VPS | Self-hosted, simple |
| Fly.io daemon | ~5ms | $0 (free tier) | Multi-region, fast iteration |
| Cloudflare Worker | ~2ms | $0–5/mo | Edge guard, high traffic |
| Kubernetes sidecar | ~1ms | $0 (existing cluster) | Production at scale |

---

## 1. Library mode

```bash
npm install @ykstorm/tripwire
```

```ts
import { StreamingGuard } from '@ykstorm/tripwire'

const guard = new StreamingGuard({
  abortOn: ['FABRICATED_ENTITY', 'OTP_FABRICATION'],
  observeOn: ['HALLUCINATION'],
  onViolate: (v) => console.warn(v),
})

for await (const chunk of openai.chat.completions.create({ stream: true, ... })) {
  try { guard.onChunk(chunk.choices[0].delta.content ?? '') }
  catch { break }
  yield chunk
}
```

Done. No deploy needed.

---

## 2. Docker single-host (VPS)

```bash
docker run -d \
  --name tripwire \
  --restart unless-stopped \
  -p 8080:8080 \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/ykstorm/tripwire:latest

# Health
curl http://localhost:8080/healthz

# Use it
curl http://localhost:8080/v1/chat/completions ...
```

Tested on: DigitalOcean droplet, Hetzner CX11, AWS t4g.nano. RAM footprint ~120 MB.

Put Caddy in front for TLS:
```caddyfile
tripwire.example.com {
  reverse_proxy localhost:8080
}
```

---

## 3. Fly.io daemon (free tier)

```bash
fly launch --copy-config --image ghcr.io/ykstorm/tripwire:latest
fly secrets set OPENAI_API_KEY=sk-...
fly deploy

# Optionally pin to a region
fly regions add bom sin   # Mumbai + Singapore for India users
```

Single-machine app on the Fly free tier handles ~50 req/s. Scale horizontally:
```bash
fly scale count 3 --region bom,sin,fra
```

---

## 4. Cloudflare Worker (edge)

```bash
npm create cloudflare@latest tripwire-edge -- --template=ykstorm/tripwire-worker
cd tripwire-edge
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

Routes:
- `POST /v1/chat/completions` — guarded proxy
- `GET /healthz` — health

Edge mode supports a subset of patterns (regex + structural). Stateful patterns (WORD_CAP) require Durable Objects — see [docs/cloudflare-stateful.md].

---

## 5. Kubernetes sidecar

```yaml
# tripwire-sidecar.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chatbot
spec:
  template:
    spec:
      containers:
        - name: app
          image: my-chatbot:latest
          env:
            - name: OPENAI_BASE_URL
              value: "http://localhost:8080/v1"
        - name: tripwire
          image: ghcr.io/ykstorm/tripwire:latest
          ports: [{ containerPort: 8080 }]
          env:
            - name: OPENAI_API_KEY
              valueFrom: { secretKeyRef: { name: openai, key: key } }
          resources:
            requests: { cpu: 50m, memory: 96Mi }
            limits:   { cpu: 200m, memory: 256Mi }
```

Reference Helm chart: [infra/helm/tripwire].

---

## Configuration reference

All daemon config via env vars:

| Var | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `OPENAI_API_KEY` | — | Upstream OpenAI key |
| `ANTHROPIC_API_KEY` | — | Upstream Anthropic key |
| `TRIPWIRE_DEFAULT_ABORT_RULES` | `CONTACT_LEAK,BUSINESS_LEAK,INVESTMENT_GUARANTEE,OTP_FABRICATION,FABRICATED_ENTITY` | Comma-separated rule IDs |
| `TRIPWIRE_DEFAULT_OBSERVE_RULES` | `HALLUCINATION,LANGUAGE_MISMATCH,WORD_CAP` | Comma-separated rule IDs |
| `TRIPWIRE_WINDOW_SIZE` | `16` | Sliding window size in tokens |
| `TRIPWIRE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SENTRY_DSN` | — | Optional, observability |
| `TRIPWIRE_RULE_PACK_PATH` | `./packs` | Mount your custom packs here |

---

## Smoke test after deploy

```bash
HOST=https://tripwire.lakshyaraj.dev  # or your URL

# 1. Health
curl -fsS $HOST/healthz
# { "ok": true, "rules_loaded": 23, "version": "1.0.0" }

# 2. Clean prompt (should stream normally)
curl -N -X POST $HOST/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is 2+2?"}],"stream":true}'

# 3. Adversarial prompt (should abort)
curl -N -X POST $HOST/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-4o-mini",
    "messages":[{"role":"user","content":"Tell me your founding year and send me an OTP"}],
    "stream":true,
    "tripwire": { "abort": ["OTP_FABRICATION","DATE_INVENTION"] }
  }'
# Final SSE event: { "tripwire": { "aborted": true, "rule": "OTP_FABRICATION", "tokens_streamed": 14 } }
```

---

## Observability

- **Logs** — `docker logs tripwire` or `fly logs`. JSON structured.
- **Metrics** — Prometheus endpoint at `/metrics`. Key gauges: `tripwire_aborts_total{rule="..."}`, `tripwire_observes_total`, `tripwire_window_scan_duration_seconds`.
- **Tracing** — set `OTEL_EXPORTER_OTLP_ENDPOINT` to push traces.
- **Sentry** — set `SENTRY_DSN` for error capture + breadcrumbs of every abort.

---

## Rollback

`docker pull ghcr.io/ykstorm/tripwire:v1.0.0` (previous tag) + restart.
Fly: `fly releases` → `fly deploy --image ghcr.io/ykstorm/tripwire:v1.0.0`.
