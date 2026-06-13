FROM node:20-alpine

WORKDIR /app

# Install production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app code
COPY gateway.js ./
COPY platform/ ./platform/
COPY widget-routes/ ./widget-routes/

ENV NODE_ENV=production
EXPOSE 3000

# Drop privileges (node user exists in node:alpine)
USER node

CMD ["node", "gateway.js"]
