FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

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
