FROM node:24-trixie-slim@sha256:6950b66b4c0cb0151ce89fa75074673850763d096b044f422c6729b588dd4956
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY scripts ./scripts
COPY tsconfig.json ./tsconfig.json
COPY agent ./agent
RUN npm run build

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh && chown -R node:node /app

USER node
ENV NODE_ENV=production PORT=3001 WORKFLOW_MAX_INLINE_STEPS=0
ENTRYPOINT ["./entrypoint.sh"]
