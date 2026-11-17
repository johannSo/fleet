#!/usr/bin/env bash
# First start in the container: the state directories, and CLIProxyAPI's config and
# management key (what proxy/install.sh writes on a systemd install). Then runs the panel,
# which starts and supervises CLIProxyAPI itself ($FLEET_PROXY_BIN).
set -euo pipefail

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-panel"
PROXY="$STATE/proxy"
mkdir -p "$PROXY/auths" "$HOME/.ssh"
chmod 700 "$STATE" "$PROXY" "$PROXY/auths" "$HOME/.ssh"

if [[ ! -s "$PROXY/mgmt.key" ]]; then
  (umask 077 && openssl rand -hex 32 > "$PROXY/mgmt.key")
fi

if [[ ! -f "$PROXY/config.yaml" ]]; then
  CLIENT_KEY="${FLEET_PROXY_API_KEY:-sk-fleet-$(openssl rand -hex 20)}"
  (umask 077 && cat > "$PROXY/config.yaml" <<YAML
# CLIProxyAPI config, managed by the Fleet panel (Proxy → Settings).
config-version: 8
server:
  host: ""
  port: ${PROXY_PORT:-8317}
management:
  allow-remote: false
  secret-key: "$(cat "$PROXY/mgmt.key")"
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys:
    - "$CLIENT_KEY"
routing:
  strategy: "round-robin"
oauth:
  auth-dir: "$PROXY/auths"
observability:
  logs:
    logging-to-file: true
    logs-max-total-size-mb: 200
  usage:
    usage-statistics-enabled: true
YAML
  )
  echo "[fleet] wrote $PROXY/config.yaml (first proxy API key: $CLIENT_KEY)"
fi

exec "$@"
