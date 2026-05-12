# syntax=docker/dockerfile:1.7
# Multi-stage build: smaller image, no dev deps shipped, non-root runtime.

# ---------- stage 1: install ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY server/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund ; \
    else \
      npm install --omit=dev --no-audit --no-fund ; \
    fi

# ---------- stage 2: runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# tini provides clean PID 1 signal handling so SIGTERM reaches Node promptly.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production
# Render injects PORT=10000; Railway injects its own. env.js honours both.
EXPOSE 10000

# Copy production node_modules from deps stage.
COPY --from=deps /app/node_modules ./node_modules
# Copy server source (kept after deps so source changes don't bust the install
# cache layer).
COPY server/package*.json ./
COPY server/src ./src
COPY server/README.md ./

# Drop privileges. node:alpine ships a `node` user (uid 1000).
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-10000}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
