# ./netstats/Dockerfile

FROM node:20-bookworm-slim

# Install fping + speedtest-cli from Debian packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      fping \
      speedtest-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps (keep this for caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the app code
COPY . .

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["node", "index.js"]
