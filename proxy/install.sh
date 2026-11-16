#!/usr/bin/env bash
# Builds CLIProxyAPI from the submodule and runs it as a systemd *user* service
# (fleet-proxy.service) that the Fleet panel manages from its Proxy page.
#
# Usage: ./proxy/install.sh            build, write config on first run, (re)start
#        ./proxy/install.sh --remove   stop and remove the service (keeps accounts and config)
#
# State lives next to the panel's: ~/.local/state/fleet-panel/proxy/
#   config.yaml   CLIProxyAPI's config (the panel edits it through the Management API)
#   mgmt.key      management key the panel uses; never leaves this machine
#   auths/        signed-in accounts (OAuth tokens)
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-panel/proxy"
UNIT="$HOME/.config/systemd/user/fleet-proxy.service"
PORT="${PROXY_PORT:-8317}"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now fleet-proxy.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed fleet-proxy.service (accounts and config are still in $STATE)"
  exit 0
fi

if GO="$(command -v go)"; then
  [[ -f cliproxyapi/go.mod ]] || git -C .. submodule update --init proxy/cliproxyapi
  VERSION="$(git -C cliproxyapi describe --tags --always 2>/dev/null || echo dev)"
  COMMIT="$(git -C cliproxyapi rev-parse --short HEAD)"
  echo "Building CLIProxyAPI $VERSION ($COMMIT)…"
  mkdir -p bin
  (cd cliproxyapi && "$GO" build -trimpath -ldflags "-s -w -X main.Version=$VERSION -X main.Commit=$COMMIT -X main.BuildDate=$(date -u +%FT%TZ)" -o "$DIR/bin/cli-proxy-api.new" ./cmd/server)
  mv -f bin/cli-proxy-api.new bin/cli-proxy-api
elif [[ -x bin/cli-proxy-api ]]; then
  # No Go here: ../deploy.sh cross-compiled it on the deploying machine.
  echo "Using the prebuilt bin/cli-proxy-api"
else
  echo "go not found on PATH and no prebuilt bin/cli-proxy-api" >&2
  exit 1
fi

mkdir -p "$STATE/auths"
chmod 700 "$STATE" "$STATE/auths"
if [[ ! -f "$STATE/mgmt.key" ]]; then
  (umask 077 && openssl rand -hex 32 > "$STATE/mgmt.key")
fi
if [[ ! -f "$STATE/config.yaml" ]]; then
  CLIENT_KEY="sk-fleet-$(openssl rand -hex 20)"
  (umask 077 && cat > "$STATE/config.yaml" <<YAML
# CLIProxyAPI config, managed by the Fleet panel (Proxy → Settings).
config-version: 8
server:
  host: ""
  port: $PORT
management:
  allow-remote: false
  secret-key: "$(cat "$STATE/mgmt.key")"
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys:
    - "$CLIENT_KEY"
routing:
  strategy: "round-robin"
oauth:
  auth-dir: "$STATE/auths"
observability:
  logs:
    logging-to-file: true
    logs-max-total-size-mb: 200
  usage:
    usage-statistics-enabled: true
YAML
  )
  echo "Wrote $STATE/config.yaml (first API key: $CLIENT_KEY)"
fi

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=Fleet AI proxy (CLIProxyAPI)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$STATE
ExecStart=$DIR/bin/cli-proxy-api -config $STATE/config.yaml
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable fleet-proxy.service >/dev/null
systemctl --user restart fleet-proxy.service
sleep 2
systemctl --user --no-pager status fleet-proxy.service | sed -n '1,4p'
