# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
WORKDIR /app

# Install production deps. Use `npm install` (not `npm ci`) because the
# repository doesn't commit a package-lock.json by default. Railway will
# regenerate the lockfile at build time.
COPY server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY server/ ./

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# Lightweight healthcheck against /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/server.js"]
