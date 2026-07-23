FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    C_POCKET_DATA_DIR=/app/data

WORKDIR /app

RUN apk add --no-cache su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY deploy/docker-entrypoint.sh /usr/local/bin/c-pocket-entrypoint

RUN chmod 0755 /usr/local/bin/c-pocket-entrypoint \
  && mkdir -p /app/data/media \
  && chown -R node:node /app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["c-pocket-entrypoint"]
CMD ["sh", "-c", "node server/production-config-check.js && exec node server/index.js"]
