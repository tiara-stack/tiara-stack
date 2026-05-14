FROM node:22-slim AS extractor

RUN apt-get update \
  && apt-get install -y --no-install-recommends zstd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./dist.tar.zst ./dist.tar.zst
RUN tar -axf ./dist.tar.zst && rm ./dist.tar.zst

FROM node:22-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libargon2-1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm init -y \
  && npm pkg set type="module" \
  && npm install --no-save playwright@1.58.2 \
  && npx playwright install --with-deps chromium \
  && chown -R node:node /app /ms-playwright \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY --from=extractor /app/dist ./dist

# Chromium reads the system CA store, so root is required only to refresh it from the mounted CA before dropping to the node user.
USER root
CMD ["sh", "-ec", "update-ca-certificates && { cat /usr/local/share/ca-certificates/tiarastack/tiarastack.crt; printf '\\n'; cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt; } > /tmp/node-extra-ca.crt && exec su node -s /bin/sh -c 'NODE_EXTRA_CA_CERTS=/tmp/node-extra-ca.crt exec node --use-openssl-ca --enable-source-maps ./dist/index.mjs'"]
