# Dockerfile — the Automaton storefront as a deployable service.
# Runs automaton/server.mjs: shop, Stripe checkout, scheduled heartbeat.
#
#   docker build -t automaton .
#   docker run -p 8791:8791 -v automaton-data:/data \
#     -e ANTHROPIC_API_KEY=sk-ant-... -e STRIPE_SECRET_KEY=sk_test_... automaton
#
# /data holds the agent's life (state.json, tasks, orders, TOMBSTONE.md) —
# mount a volume there or every restart births a fresh agent and forgets
# the dead one. See automaton/DEPLOY.md for Railway / Fly.io / VPS steps.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY automaton ./automaton

ENV AUTOMATON_HOME=/data \
    AUTOMATON_AUTOBOOT=1 \
    PORT=8791 \
    NODE_ENV=production
VOLUME /data
EXPOSE 8791

CMD ["node", "automaton/server.mjs"]
