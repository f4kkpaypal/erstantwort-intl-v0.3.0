FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY core ./core
COPY engine ./engine
COPY web ./web
COPY ui ./ui
COPY db ./db
COPY fixtures ./fixtures
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV NODE_ENV=production
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ENGINE_PORT || 8787) + '/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "engine/server.js"]
