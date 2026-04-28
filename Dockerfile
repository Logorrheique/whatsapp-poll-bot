# syntax=docker/dockerfile:1.7

# ---------- Stage 1 : build ----------
FROM node:22-slim AS builder
WORKDIR /app

# Install all dependencies (including dev for tsc)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Drop dev dependencies — only production deps stay in node_modules
RUN npm prune --omit=dev

# ---------- Stage 2 : runtime ----------
FROM node:22-slim AS runtime
WORKDIR /app

# OCI labels — picked up by GitHub Container Registry to link the image
# to the source repo and license, and shown on the package page.
LABEL org.opencontainers.image.title="WhatsApp Poll Bot" \
      org.opencontainers.image.description="Self-hosted WhatsApp bot to schedule recurring polls across multiple groups." \
      org.opencontainers.image.source="https://github.com/Logorrheique/whatsapp-poll-bot" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.documentation="https://github.com/Logorrheique/whatsapp-poll-bot#readme"

# Copy built artifacts and pruned node_modules from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public/ ./public/

# Persistent data lives here (mount a volume on /app/data in production):
#   - data/baileys_auth/   Baileys multi-file creds + Signal keys
#   - data/polls.db        SQLite primary DB (WAL mode)
RUN mkdir -p data

# Runtime env: NODE_ENV=production enables strict CORS + HTTPS redirect
# in src/index.ts. Set AFTER the build stage to avoid affecting npm install.
ENV NODE_ENV=production

# Drop root for runtime — the upstream node:22-slim image ships a
# non-privileged "node" user we can re-use.
RUN chown -R node:node /app
USER node

# Container HEALTHCHECK — orchestrators (docker, podman, k8s probes) read
# this. Railway uses its own healthcheckPath in railway.json, this one is
# for any other deployment target.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

EXPOSE 3000

CMD ["node", "--max-old-space-size=256", "--optimize-for-size", "dist/index.js"]
