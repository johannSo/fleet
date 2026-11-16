#!/usr/bin/env bash
# Installs Fleet as a systemd *user* service (starts at login, restarts on failure).
# Usage: ./deploy/install-service.sh            install/update and (re)start
#        ./deploy/install-service.sh --remove   stop and remove
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
UNIT="$HOME/.config/systemd/user/fleet-panel.service"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now fleet-panel.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Removed fleet-panel.service"
  exit 0
fi

NODE="$(command -v node)"
[[ -x "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }
# Version-manager shims need a shell environment the service won't have: use the real binary.
# (mise's "latest" symlink is kept as-is so node upgrades don't break the service.)
if [[ "$NODE" == */shims/* ]]; then NODE="$(readlink -f "$NODE")"; fi

[[ -d .next ]] || npm run build

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT
[Unit]
Description=Fleet control panel
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/node_modules/tsx/dist/cli.mjs server.ts
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable fleet-panel.service >/dev/null
systemctl --user restart fleet-panel.service
sleep 3
systemctl --user --no-pager --lines=12 status fleet-panel.service | sed -n '1,4p'
echo
journalctl --user -u fleet-panel.service -n 20 --no-pager -o cat | sed -n '/fleet control panel/,$p'
