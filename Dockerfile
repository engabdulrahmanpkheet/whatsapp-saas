# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app

# Install production deps. Use `npm install` when no lockfile is present so the
# image builds cleanly on Render/Railway even without a committed lockfile.
COPY server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY server/ ./

ENV NODE_ENV=production
# PORT is injected by Render (10000) / Railway. Don't hardcode — env.js reads it.
EXPOSE 10000

# Lightweight healthcheck against /healthz (Render convention).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-10000}/healthz" || exit 1

CMD ["node", "src/server.js"]
