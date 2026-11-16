#!/usr/bin/env bash
# Runs ClickHouse in Docker on a fleet machine (usually the panel's own) for the panel's AI log,
# and tells the panel how to reach it.
#
# Usage: ./clickhouse/install.sh <ssh-alias>   deploy or update
#        ./clickhouse/install.sh --remove <ssh-alias>   stop and remove the container (keeps data)
#        MACHINE=<name> ./clickhouse/install.sh <ssh-alias>   when the machine's name in the panel
#                                                            differs from the alias
#
# On the target: ~/containers/clickhouse/{compose.yml,.env,config.d,users.d,data/}
# Here:          ~/.local/state/fleet-panel/clickhouse.json   (machine, port, user, password; 0600)
# ClickHouse listens on the target's 127.0.0.1:8123 only; the panel opens an ssh tunnel.
set -euo pipefail
cd "$(dirname "$0")"
REMOVE=0
if [[ "${1:-}" == "--remove" ]]; then REMOVE=1; shift; fi
HOST="${1:-}"
[[ -n $HOST ]] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-panel"
CONF="$STATE/clickhouse.json"
REMOTE_DIR="containers/clickhouse"

if (( REMOVE )); then
  ssh "$HOST" "cd $REMOTE_DIR 2>/dev/null && docker compose down" || true
  echo "Stopped ClickHouse on $HOST (data is still in ~/$REMOTE_DIR/data there)"
  exit 0
fi

# One multiplexed connection for every ssh/scp below (sshd throttles bursts of new ones).
SOCK="$(mktemp -u "${TMPDIR:-/tmp}/fleet-ch-XXXXXX")"
SSHO=(-o ControlMaster=auto -o "ControlPath=$SOCK" -o ControlPersist=60 -o ConnectTimeout=10)
trap 'ssh "${SSHO[@]}" -O exit "$HOST" 2>/dev/null || true' EXIT
ssh() { command ssh "${SSHO[@]}" "$@"; }
scp() { command scp "${SSHO[@]}" "$@"; }

mkdir -p "$STATE"
if [[ -f "$CONF" ]]; then
  PASSWORD="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["password"])' "$CONF")"
else
  PASSWORD="$(openssl rand -hex 24)"
fi

# The machine's name in the panel's inventory; the alias unless MACHINE says otherwise.
MACHINE="${MACHINE:-$HOST}"

echo "Deploying ClickHouse to $HOST ($MACHINE)…"
ssh "$HOST" "mkdir -p $REMOTE_DIR/config.d $REMOTE_DIR/users.d $REMOTE_DIR/data"
scp -q compose.yml "$HOST:$REMOTE_DIR/compose.yml"
scp -q config.d/fleet.xml "$HOST:$REMOTE_DIR/config.d/fleet.xml"
scp -q users.d/fleet.xml "$HOST:$REMOTE_DIR/users.d/fleet.xml"
printf 'CLICKHOUSE_PASSWORD=%s\n' "$PASSWORD" | ssh "$HOST" "umask 077 && cat > $REMOTE_DIR/.env"
ssh "$HOST" "cd $REMOTE_DIR && docker compose pull -q && docker compose up -d"

echo -n "Waiting for ClickHouse"
for _ in $(seq 60); do
  if ssh "$HOST" "curl -sf http://127.0.0.1:8123/ping" >/dev/null 2>&1; then
    echo " up."
    (umask 077 && printf '{"machine":"%s","port":8123,"user":"fleet","password":"%s","database":"ai"}\n' "$MACHINE" "$PASSWORD" > "$CONF")
    echo "Wrote $CONF. Restart the panel to connect: systemctl --user restart fleet-panel"
    exit 0
  fi
  echo -n .; sleep 2
done
echo; echo "ClickHouse didn't answer; see: ssh $HOST 'docker logs --tail 50 clickhouse'" >&2
exit 1
