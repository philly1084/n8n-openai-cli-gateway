# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build

FROM --platform=$TARGETPLATFORM node:20-bookworm-slim AS runtime

ARG EXTRA_NPM_GLOBAL_PACKAGES=""

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOME=/var/lib/gateway-home

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && if [ -n "$EXTRA_NPM_GLOBAL_PACKAGES" ]; then npm install -g $EXTRA_NPM_GLOBAL_PACKAGES; fi \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY config/providers.example.yaml ./config/providers.example.yaml

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin gateway \
  && mkdir -p /var/lib/gateway-home /tmp \
  && chown -R gateway:gateway /app /var/lib/gateway-home /tmp

USER gateway

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
