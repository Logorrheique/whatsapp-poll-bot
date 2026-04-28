FROM node:22-slim

# Plus de Chromium ni de deps Puppeteer : passe Baileys (port whatsapp-web.js
# vers @whiskeysockets/baileys, pure WebSocket Node.js). Image divisée par
# ~5 et RAM runtime par ~6.

WORKDIR /app

# Install all dependencies (including dev for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npx tsc

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Create data directory (Railway volume mount point) — y vivent désormais
# data/baileys_auth/ (creds Baileys multi-fichiers) + polls.db.
RUN mkdir -p data

# Runtime env : NODE_ENV=production active CORS strict + HTTPS redirect
# dans src/index.ts. Doit être défini APRÈS `npm ci` et `npm prune` pour
# ne pas interférer avec l'install (npm lit aussi NODE_ENV).
ENV NODE_ENV=production

# Docker HEALTHCHECK — Railway utilise son propre healthcheckPath déclaré
# dans railway.json, mais ce check interne permet à docker ps / docker run
# de refléter l'état du service. Shell form pour que ${PORT:-3000} soit
# expansé (Railway assigne son propre port via PORT env var).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

EXPOSE 3000

CMD ["node", "--max-old-space-size=256", "--optimize-for-size", "dist/index.js"]
