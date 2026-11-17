# syntax=docker/dockerfile:1.7
# Fleet all-in-one image: the panel, fleet-agent's collectors and binaries (amd64 + arm64,
# served to agents) and CLIProxyAPI, which the panel runs and supervises itself.
#
#   docker build -t fleet .            (needs the proxy/cliproxyapi submodule checked out)
#   docker compose up -d               (see compose.yml)
#
# Architecture-independent work (Go cross-compiles, next build) runs on the build machine's
# platform; only the panel's native dependencies (node-pty) are installed per target platform.

ARG NODE_IMAGE=node:26-trixie-slim
ARG GO_IMAGE=golang:1.26-trixie

# ---------------------------------------------------------------- Go: fleet-agent + CLIProxyAPI
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS go
ARG TARGETARCH
ARG CPA_VERSION=dev
ARG CPA_COMMIT=none
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false

# fleet-agent: both architectures, whatever the image's own, since the panel serves them to machines.
WORKDIR /src/agent
COPY agent/go.mod agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY agent/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    rm -rf bin && ./build.sh

# CLIProxyAPI: the image's own architecture.
WORKDIR /src/cpa
COPY proxy/cliproxyapi/go.mod proxy/cliproxyapi/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY proxy/cliproxyapi/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=linux GOARCH=$TARGETARCH go build -trimpath \
      -ldflags "-s -w -X main.Version=${CPA_VERSION} -X main.Commit=${CPA_COMMIT} -X main.BuildDate=$(date -u +%FT%TZ)" \
      -o /out/cli-proxy-api ./cmd/server

# ---------------------------------------------------------------- panel: next build + server bundle
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
WORKDIR /app/panel
COPY panel/package.json panel/package-lock.json ./
# No install scripts: node-pty's native build isn't needed to build (it's a server external).
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
COPY panel/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && rm -rf .next/cache
# server.ts and the lib/ it imports, bundled for plain node (the systemd service runs it with tsx).
RUN npx esbuild server.ts --bundle --platform=node --format=cjs --target=node24 \
      --packages=external --log-level=warning --outfile=dist/server.cjs

# ---------------------------------------------------------------- panel: runtime dependencies
FROM ${NODE_IMAGE} AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/panel
COPY panel/package.json panel/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund --loglevel=error \
    && test -f node_modules/node-pty/build/Release/pty.node \
    && rm -rf node_modules/node-pty/prebuilds

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini bash ca-certificates curl openssh-client openssl procps iproute2 iputils-ping tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/panel
COPY --from=deps /app/panel/node_modules ./node_modules
COPY --from=web /app/panel/package.json /app/panel/next.config.ts ./
COPY --from=web /app/panel/.next ./.next
COPY --from=web /app/panel/public ./public
COPY --from=web /app/panel/dist ./dist
COPY --from=go /src/agent/collectors /app/agent/collectors
COPY --from=go /src/agent/bin /app/agent/bin
COPY --from=go /out/cli-proxy-api /usr/local/bin/cli-proxy-api
COPY docker/entrypoint.sh /usr/local/bin/fleet-entrypoint

# Everything the panel keeps (inventory, auth, TLS CA, ssh keys, proxy accounts) lives in /data:
# HOME is /data, so its state is /data/.local/state/fleet-panel and its ssh keys /data/.ssh.
RUN mkdir -p /data && chown node:node /data
# The release this image is (the panel shows it and checks for newer ones); empty: package.json's.
ARG FLEET_VERSION=""
ARG FLEET_COMMIT=""
ENV FLEET_VERSION=${FLEET_VERSION} \
    FLEET_COMMIT=${FLEET_COMMIT} \
    FLEET_INSTALL=docker
ENV NODE_ENV=production \
    HOME=/data \
    PORT=4747 \
    TLS_PORT=4443 \
    PROXY_PORT=8317 \
    FLEET_AGENT_DIR=/app/agent \
    FLEET_PROXY_BIN=/usr/local/bin/cli-proxy-api \
    FLEET_NO_LOCAL=1 \
    NEXT_TELEMETRY_DISABLED=1
USER node
VOLUME /data
EXPOSE 4747 4443 8317

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -s -o /dev/null -m 4 "http://127.0.0.1:${PORT}/" || exit 1

LABEL org.opencontainers.image.title="fleet" \
      org.opencontainers.image.description="Self-hosted control panel for your machines, with fleet-agent and the CLIProxyAPI AI proxy" \
      org.opencontainers.image.source="https://github.com/johannSo/fleet" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/bin/tini", "--", "fleet-entrypoint"]
CMD ["node", "dist/server.cjs"]
