# Portable image for any container host (Fly.io, Railway, Cloud Run, a VM).
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV FIXR_DB=/data/fixr.db
VOLUME ["/data"]
EXPOSE 3000

# node:sqlite is built in on Node 22; no native build step needed.
CMD ["node", "server.js"]
