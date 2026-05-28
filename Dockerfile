# =====================================================================
# Tripwire — multi-stage Dockerfile
# Builds the HTTP daemon (OpenAI-compatible proxy with mid-stream guard).
# Final image ~80 MB on node:20-alpine.
# =====================================================================

# ---------- Stage 1: deps + build ----------
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

# Install all deps (incl dev) for the build
COPY package.json package-lock.json* ./
RUN npm ci

# Build the library + daemon entrypoint
COPY src ./src
COPY bin ./bin
COPY tsconfig.json tsup.config.ts ./
RUN npm run build

# ---------- Stage 2: prod deps ----------
FROM node:20-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ---------- Stage 3: runtime ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Unprivileged user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 tripwire

COPY --from=prod-deps --chown=tripwire:nodejs /app/node_modules ./node_modules
COPY --from=builder   --chown=tripwire:nodejs /app/dist          ./dist
COPY --from=builder   --chown=tripwire:nodejs /app/bin           ./bin
COPY --chown=tripwire:nodejs package.json ./

USER tripwire

EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=3s --start-period=8s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

CMD ["node", "dist/daemon.js"]
