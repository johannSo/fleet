#!/usr/bin/env bash
# Deploys this repo (the working tree, committed or not) to the machine that runs the panel
# and restarts what changed. The first deploy to a machine installs the services there.
#
#   ./deploy.sh <alias>    deploy to that ssh alias (or set FLEET_DEPLOY_HOST)
#   ./deploy.sh --force    rebuild and restart the panel even if nothing changed
#   ./deploy.sh --proxy    also rebuild and restart CLIProxyAPI (otherwise only when
#                          the proxy/cliproxyapi submodule moved)
#
# 1. Builds fleet-agent here when its sources changed (agent/build.sh, amd64 and arm64)
#    and syncs its collectors and binaries to ~/fleet/agent. The panel reads the
#    collectors from there and connected agents update themselves to the new build.
# 2. Syncs panel/ into ~/fleet/.staging there and builds it in place (npm ci only
#    when package-lock.json changed). The running panel keeps serving meanwhile, and a
#    failed build changes nothing.
# 3. Copies the build to ~/fleet/panel and restarts fleet-panel (a few seconds).
# 4. When needed, cross-compiles CLIProxyAPI here (the target needs no Go) and restarts fleet-proxy.
# 5. Checks that the panel, the proxy and ClickHouse answer.
# Panel state in ~/.local/state/fleet-panel (including the inventory, fleet.db) is never touched.
set -euo pipefail
cd "$(dirname "$0")"
HOST=${FLEET_DEPLOY_HOST:-} FORCE=0 PROXY=0
for a; do
  case $a in
    --force) FORCE=1 ;;
    --proxy) PROXY=1 ;;
    -h | --help) sed -n '2,/^set /p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option $a (see --help)" >&2; exit 1 ;;
    *) HOST=$a ;;
  esac
done
[[ -n $HOST ]] || { echo "usage: ./deploy.sh <ssh-alias> [--force] [--proxy]   (or set FLEET_DEPLOY_HOST; see --help)" >&2; exit 1; }

step() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
SOCK=$(mktemp -u /tmp/fleet-deploy-XXXXXX)
ssh() { command ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=300 "$@"; }
trap 'command ssh -o ControlPath="$SOCK" -O exit "$HOST" 2>/dev/null || true' EXIT
RSYNC=(rsync -a --delete -e "ssh -o ControlPath=$SOCK")

SHA=$(git rev-parse --short HEAD)
DIRTY=$(git status --porcelain | wc -l)
step "Deploying $SHA$( ((DIRTY)) && echo " + $DIRTY uncommitted files") to $HOST"

# UNIT_OK: fleet-panel.service runs the panel from ~/fleet/panel (not yet on a machine last deployed
# when the panel lived in ~/fleet/control-panel; the next build reinstalls the unit).
read -r ARCH REMOTE_PROXY HAS_PANEL HAS_PROXY UNIT_OK < <(ssh "$HOST" '
  u=~/.config/systemd/user
  echo "$(uname -m) $(cat ~/fleet/proxy/bin/.commit 2>/dev/null || echo none) $(test -f $u/fleet-panel.service && echo 1 || echo 0) $(test -f $u/fleet-proxy.service && echo 1 || echo 0) $(grep -qx "WorkingDirectory=$HOME/fleet/panel" $u/fleet-panel.service 2>/dev/null && echo 1 || echo 0)"')
case $ARCH in aarch64 | arm64) GOARCH=arm64 ;; x86_64) GOARCH=amd64 ;; *) echo "unsupported architecture $ARCH" >&2; exit 1 ;; esac

# ---- everything that needs no build goes straight to ~/fleet
# (the old staging dir moves rather than starting over, so its node_modules is kept)
ssh "$HOST" '[[ -d ~/fleet/.staging/control-panel && ! -e ~/fleet/.staging/panel ]] && mv ~/fleet/.staging/control-panel ~/fleet/.staging/panel
  mkdir -p ~/fleet/proxy/bin ~/fleet/.staging/panel ~/fleet/agent/bin'
"${RSYNC[@]}" README.md "$HOST:fleet/"
"${RSYNC[@]}" clickhouse/ "$HOST:fleet/clickhouse/"
rsync -a -e "ssh -o ControlPath=$SOCK" proxy/install.sh "$HOST:fleet/proxy/"

# ---- fleet-agent: the panel reads the collectors at runtime (so they go first) and serves the
# binaries to installers and to agents updating themselves. Binaries before BUILD, so the panel
# never offers a build whose binary isn't there yet.
AGENT_BUILD=$(agent/build.sh --hash)
if [[ "$(cat agent/bin/BUILD 2>/dev/null)" != "$AGENT_BUILD" || ! -f agent/bin/fleet-agent-amd64 || ! -f agent/bin/fleet-agent-arm64 ]]; then
  step "Building fleet-agent $AGENT_BUILD (amd64, arm64)"
  agent/build.sh >/dev/null
fi
"${RSYNC[@]}" agent/collectors/ "$HOST:fleet/agent/collectors/"
"${RSYNC[@]}" --exclude BUILD agent/bin/ "$HOST:fleet/agent/bin/"
rsync -a -e "ssh -o ControlPath=$SOCK" agent/bin/BUILD "$HOST:fleet/agent/bin/"

# ---- panel: sync to staging; a leftover .pending means the last build or promote didn't finish
CHANGES=$("${RSYNC[@]}" -i --exclude node_modules --exclude .next --exclude '*.tsbuildinfo' --exclude next-env.d.ts \
  panel/ "$HOST:fleet/.staging/panel/" | grep -vc '^\.' || true)
((CHANGES)) && ssh "$HOST" 'touch ~/fleet/.staging/.pending'
PENDING=$(ssh "$HOST" 'test -f ~/fleet/.staging/.pending && echo 1 || echo 0')

if ((FORCE || PENDING || !HAS_PANEL || !UNIT_OK)); then
  step "Building the panel on $HOST ($CHANGES changed files)"
  ssh "$HOST" HAS_PANEL=$HAS_PANEL UNIT_OK=$UNIT_OK bash -s <<'REMOTE'
set -euo pipefail
S=~/fleet/.staging/panel
L=~/fleet/panel
cd "$S"
LOCK=$(sha256sum package-lock.json | cut -c1-16)
if [[ "$(cat node_modules/.fleet-lock 2>/dev/null)" != "$LOCK" ]]; then
  echo "  npm ci (package-lock.json changed)…"
  npm ci --no-audit --no-fund --loglevel=error
  echo "$LOCK" > node_modules/.fleet-lock
fi
start=$SECONDS
if ! npm run build > ../build.log 2>&1; then
  echo "  ✕ next build failed; the running panel is unchanged. Last lines of ~/fleet/.staging/build.log:"
  tail -40 ../build.log | sed 's/^/    /'
  exit 1
fi
echo "  built in $((SECONDS - start))s"
mkdir -p "$L"
rsync -a --delete --exclude '*.tsbuildinfo' "$S/" "$L/"
rm -f ~/fleet/.staging/.pending
cd "$L"
if [[ "$HAS_PANEL" == 1 && "$UNIT_OK" == 1 ]]; then
  systemctl --user restart fleet-panel.service
else
  ./deploy/install-service.sh
fi
REMOTE
else
  step "Panel unchanged, not rebuilt (--force to rebuild anyway)"
fi

# ---- proxy: rebuild when the submodule moved, or when asked
COMMIT=$(git -C proxy/cliproxyapi rev-parse --short HEAD 2>/dev/null || echo none)
if ((PROXY || !HAS_PROXY)) || [[ "$COMMIT" != none && "$COMMIT" != "$REMOTE_PROXY" ]]; then
  GO=$(command -v go) || { echo "go not found on PATH (needed to build CLIProxyAPI for $HOST)" >&2; exit 1; }
  [[ -f proxy/cliproxyapi/go.mod ]] || git submodule update --init proxy/cliproxyapi
  COMMIT=$(git -C proxy/cliproxyapi rev-parse --short HEAD)
  VERSION=$(git -C proxy/cliproxyapi describe --tags --always 2>/dev/null || echo dev)
  step "Building CLIProxyAPI $VERSION ($COMMIT) for linux/$GOARCH"
  mkdir -p proxy/bin
  (cd proxy/cliproxyapi && CGO_ENABLED=0 GOOS=linux GOARCH=$GOARCH "$GO" build -trimpath \
    -ldflags "-s -w -X main.Version=$VERSION -X main.Commit=$COMMIT -X main.BuildDate=$(date -u +%FT%TZ)" \
    -o "../bin/cli-proxy-api-linux-$GOARCH" ./cmd/server)
  rsync -a -e "ssh -o ControlPath=$SOCK" "proxy/bin/cli-proxy-api-linux-$GOARCH" "$HOST:fleet/proxy/bin/cli-proxy-api.new"
  step "Restarting fleet-proxy (requests in flight are cut off)"
  ssh "$HOST" COMMIT="$COMMIT" HAS_PROXY=$HAS_PROXY bash -s <<'REMOTE'
set -euo pipefail
cd ~/fleet/proxy
mv -f bin/cli-proxy-api.new bin/cli-proxy-api
echo "$COMMIT" > bin/.commit
if [[ "$HAS_PROXY" == 1 ]]; then systemctl --user restart fleet-proxy.service; else PATH=/usr/bin:/bin ./install.sh; fi
REMOTE
else
  step "Proxy unchanged ($REMOTE_PROXY), not restarted (--proxy to rebuild anyway)"
fi

# ---- health
step "Checking"
ssh "$HOST" SHA="$SHA" DIRTY="$DIRTY" FROM="$(hostname)" bash -s <<'REMOTE'
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✕\033[0m %s\n' "$*"; FAIL=1; }
FAIL=0
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m3 http://127.0.0.1:4747/api/fleet || true)
  [[ $code == 200 ]] && break
  sleep 1
done
page=$(curl -s -o /dev/null -w '%{http_code}' -m20 http://127.0.0.1:4747/proxy/traffic || true)
if [[ $code == 200 && $page == 200 ]]; then ok "panel answers (http://$(hostname -I | awk '{print $1}'):4747)"; else
  bad "panel doesn't answer (API $code, page $page). Its log:"; journalctl --user -u fleet-panel -n 25 --no-pager -o cat | sed 's/^/    /'; fi
code=$(curl -s -o /dev/null -w '%{http_code}' -m5 http://127.0.0.1:8317/v1/models || true)
if [[ $code == 401 || $code == 200 ]]; then ok "proxy answers on :8317"; else bad "proxy doesn't answer on :8317 (HTTP $code); journalctl --user -u fleet-proxy"; fi
st=$(curl -s -m20 http://127.0.0.1:4747/api/proxy/traffic/status || true)
if grep -q '"reachable":true' <<<"$st"; then ok "ClickHouse reachable, Traffic logging"; else bad "ClickHouse: $(grep -o '"error":"[^"]*"' <<<"$st" | head -1)"; fi
if [[ -f ~/fleet/agent/collectors/probe.sh && -f ~/fleet/agent/bin/BUILD ]]; then ok "fleet-agent build $(cat ~/fleet/agent/bin/BUILD) ready for agents"; else bad "fleet-agent collectors or binaries missing in ~/fleet/agent"; fi
# Left over from before the panel and agent dirs were renamed; only once the new ones work.
if ((!FAIL)) && grep -qx "WorkingDirectory=$HOME/fleet/panel" ~/.config/systemd/user/fleet-panel.service; then
  for d in ~/fleet/control-panel ~/fleet/fleet-server ~/fleet/.staging/control-panel; do
    [[ -e $d ]] && rm -rf "$d" && ok "removed the old $d"
  done
fi
echo "$SHA dirty=$DIRTY from=$FROM at=$(date -Is)" > ~/fleet/.deployed
exit $FAIL
REMOTE
