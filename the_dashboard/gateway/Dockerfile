FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends fping speedtest-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY gateway.js ./
COPY platform/ ./platform/
COPY widget-routes/ ./widget-routes/

ENV NODE_ENV=production
EXPOSE 3000

USER node

CMD ["node", "gateway.js"]
