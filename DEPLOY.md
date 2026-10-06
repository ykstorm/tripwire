# Deploying Tripwire

Three shapes. Pick the one that matches yours.

| Mode | Best for |
|---|---|
| Library (npm) | You own the LLM call site |
| Docker single-host | Self-hosted sidecar or standalone |
| Kubernetes sidecar | Per-pod guard, no network hop |

---

## 1. Library mode

```bash
npm install @ykstormsorg/tripwire
```

```ts
import { createStreamingGuard, GuardAbortError } from '@ykstormsorg/tripwire'

const guard = createStreamingGuard({
  onViolate: (v) => console.warn(v),
})

try {
  for await (const chunk of openai.chat.completions.create({ stream: true, /* ... */ })) {
    send(guard.onChunk(chunk.choices[0].delta.content ?? ''))
  }
  send(guard.flush())
} catch (err) {
  if (err instanceof GuardAbortError) {
    // err.rule names the pattern; swap in a safe fallback
  } else {
    throw err
  }
}
```

No deploy needed.

---

## 2. Docker single-host

The proxy holds no upstream key: callers pass their own key as the `Authorization`
Bearer, and the proxy forwards it to the pinned upstream.

```bash
docker run -d \
  --name tripwire \
  --restart unless-stopped \
  -p 8080:8080 \
  -e TRIPWIRE_PROXY_TOKEN=choose-a-strong-value \
  ghcr.io/ykstorm/tripwire:latest

curl http://localhost:8080/healthz
```

Or with `docker compose up -d` using the bundled `docker-compose.yml`.

Put a TLS terminator in front (Caddy, nginx) for public exposure:

```caddyfile
tripwire.example.com {
  reverse_proxy localhost:8080
}
```

---

## 3. Kubernetes sidecar

```yaml
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
              value: "http://localhost:8080/v1"   # point the SDK at the sidecar
        - name: tripwire
          image: ghcr.io/ykstorm/tripwire:latest
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 50m, memory: 96Mi }
            limits:   { cpu: 200m, memory: 256Mi }
```

The app still sends its own key as the Bearer token; the sidecar guards the stream
and forwards upstream. Every request must ask for `stream: true`: the proxy only
serves streams and answers a non-streaming request with a 400.

---

## Configuration reference

All config is read once at boot. An invalid upstream URL or a bad custom pattern
stops the process with a non-zero exit instead of failing mid-request.

| Var | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `TRIPWIRE_UPSTREAM_URL` | `https://api.openai.com/v1` | Pinned upstream base URL (`OPENAI_BASE_URL` is never consulted) |
| `TRIPWIRE_ALLOW_INSECURE_UPSTREAM` | `0` | Allow an `http` upstream (for local dev) |
| `TRIPWIRE_ALLOW_PRIVATE_UPSTREAM` | `0` | Allow a private / loopback / link-local upstream host |
| `TRIPWIRE_PROXY_TOKEN` | — | If set, callers must send it as `X-Tripwire-Token` (timing-safe compared). A warning is logged if unset. |
| `TRIPWIRE_CUSTOM_PATTERNS` | — | JSON array of `{ source, flags, label, mode }`; validated and ReDoS-screened at boot |
| `TRIPWIRE_HOLDBACK` | `48` | Characters withheld until following context arrives |
| `TRIPWIRE_MAX_STREAM_MS` | `120000` | Per-stream time cap before the upstream is aborted |
| `TRIPWIRE_MAX_STREAM_CHARS` | `200000` | Per-stream content cap (`stream_too_large` past it) |
| `TRIPWIRE_MAX_CONCURRENT_STREAMS` | `32` | Global in-flight cap (503 past it) |
| `TRIPWIRE_RATE_LIMIT_RPM` | `60` | Per-IP requests/min (429 + `Retry-After` past it). Must be at least 1; there is no value that turns the limit off |
| `TRIPWIRE_TRUST_PROXY` | `0` | Number of reverse proxies in front of Tripwire (`1`/`true` mean one). The client IP is read that many entries from the right of `X-Forwarded-For`. Set it only when every request arrives through those proxies; a client that can reach the port directly can write the header itself |
| `TRIPWIRE_DEFAULT_MAX_TOKENS` | `4096` | Cap applied to the request `max_tokens` |
| `TRIPWIRE_LOG_LEVEL` | `info` | `silent` suppresses per-request logs |

Flags accept `1`, `true`, `yes`, or `on`.

---

## Smoke test after deploy

```bash
HOST=https://tripwire.example.com

# Health
curl -fsS $HOST/healthz
# { "ok": true, "version": "1.1.0" }

# Clean prompt streams normally
curl -N -X POST $HOST/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is 2+2?"}],"stream":true}'
```

---

## Observability

Logs are one JSON line per request on stdout/stderr (latency, tokens streamed,
abort status, rule fired). Error detail is logged server-side with secrets
redacted; the client only ever receives a generic error. Set `TRIPWIRE_LOG_LEVEL=silent`
to suppress request logs.

## Rollback

Pull the previous image tag and restart:
`docker pull ghcr.io/ykstorm/tripwire:<previous>` then recreate the container.
