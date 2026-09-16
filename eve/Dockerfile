FROM node:24-bookworm-slim
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
