FROM node:22-slim AS extractor

RUN apt-get update \
  && apt-get install -y --no-install-recommends zstd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./dist.tar.zst ./dist.tar.zst
RUN tar -axf ./dist.tar.zst && rm ./dist.tar.zst

# Capability identity is loaded for every workflow role, so all runtime images
# need the pinned Node package even when they do not have a browser binary.
FROM node:22-slim AS playwright-node-package

WORKDIR /playwright-node-package

COPY ./package.json ./sheet-workflows-package.json

RUN npm init -y \
  && playwright_version="$(node -p "require('./sheet-workflows-package.json').dependencies.playwright")" \
  && npm install --no-save --ignore-scripts "playwright@${playwright_version}" \
  && rm ./sheet-workflows-package.json

FROM node:22-slim AS runtime-base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libargon2-1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=extractor /app/dist ./dist
COPY --from=playwright-node-package /playwright-node-package/node_modules ./node_modules

CMD ["sh", "-ec", "{ cat /usr/local/share/ca-certificates/tiarastack/tiarastack.crt; printf '\\n'; cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt; } > /tmp/node-extra-ca.crt && NODE_EXTRA_CA_CERTS=/tmp/node-extra-ca.crt exec node --use-openssl-ca --enable-source-maps ./dist/index.mjs"]

# Build this named target for SHEET_WORKFLOWS_ROLE=browser-runner. The default runtime target
# intentionally cannot load Chromium.
FROM runtime-base AS browser-runner

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY ./package.json /tmp/sheet-workflows-package.json

RUN playwright_version="$(node -p "require('/tmp/sheet-workflows-package.json').dependencies.playwright")" \
  && installed_version="$(node -p "require('/app/node_modules/playwright/package.json').version")" \
  && test "${installed_version}" = "${playwright_version}" \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/* /tmp/sheet-workflows-package.json \
  && chown -R node:node /app /ms-playwright

USER node

FROM runtime-base AS runtime

USER node
