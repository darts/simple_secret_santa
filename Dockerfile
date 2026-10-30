FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/

USER node
EXPOSE 3000
CMD ["node", "server.js"]
