FROM node:22-slim AS extractor

RUN apt-get update \
  && apt-get install -y --no-install-recommends zstd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./dist.tar.zst ./dist.tar.zst
RUN tar -axf ./dist.tar.zst && rm ./dist.tar.zst

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=extractor /app ./

USER node
CMD ["sh", "-ec", "{ cat /usr/local/share/ca-certificates/tiarastack/tiarastack.crt; printf '\\n'; cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt; } > /tmp/node-extra-ca.crt && NODE_EXTRA_CA_CERTS=/tmp/node-extra-ca.crt exec node --use-openssl-ca --enable-source-maps ./dist/index.mjs"]
