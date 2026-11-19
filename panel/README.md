# fleet control panel

A Next.js control panel for every machine in its inventory, in Tokyo Night. Run it on an always-on machine on your home network and open **http://&lt;that machine&gt;:4747**. See [Running it on an always-on machine](#running-it-on-an-always-on-machine).

- **Inventory**: machines live in the panel's database, not in a file. **Add machine** (sidebar +, Overview, Machines, Ctrl+K) takes a name and how to reach it (host, user, port); the pencil on a machine edits what it's for, location, notes and extra addresses. Everything that can be detected is indexed over ssh instead of typed in: model, CPU, RAM, GPU, disks, battery health, OS and desktop, kernel, network interfaces and addresses, the wired MAC for Wake-on-LAN, Docker containers, listening ports and user services. See [Inventory and indexing](#inventory-and-indexing).
- **Claude skill**: generated from the inventory on the **Claude skill** page. Install it with a one-time command or download it. See [Claude skill](#claude-skill).
- **Agents** (optional): `fleet-agent` on a machine pushes its metrics, pending updates and index to the panel, so the panel doesn't ssh in every few seconds. See [Agents](#agents).

- **Overview**: live CPU, memory, disk, temperature, network and uptime for each machine, plus pending updates, reboot-required and failed-unit warnings. Unreachable machines get Retry, Wake-on-LAN and a copyable `ssh` command.
- **Terminal dock**: every action runs in a real terminal in the browser (xterm.js + a PTY on the server), so you can watch it and answer prompts. Sessions keep running on the server, so reloading the page reattaches with scrollback. Toggle with <kbd>Ctrl</kbd>+<kbd>`</kbd>. There is no shell: the panel never runs a command typed into it.
- **Actions**: update, reboot and shut down machines; restart, stop and tail logs for systemd units and Docker containers; kill processes; run a built-in command (uptime, disk usage, failed units, htop…) or one of your saved commands on several machines at once.
- **Custom scripts need approving on the machine**: a machine's update script and your saved commands only run on machines that approved them, by running a command there that the panel shows you. See [Custom scripts](#custom-scripts).
- **AI proxy**: one OpenAI, Anthropic and Gemini compatible endpoint (`http://<panel machine>:8317/v1`) for your Claude, ChatGPT/Codex, Antigravity and Grok subscriptions, plus any API keys. It is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) running unchanged as its own service; the panel is its control panel. See [AI proxy](#ai-proxy).
- **Command palette**: <kbd>Ctrl</kbd>+<kbd>K</kbd> jumps to machines and runs any action.

## Run it

```sh
npm install
npm run build
npm run service:install    # systemd user service: http://localhost:4747, starts at login
npm run service:logs       # follow its output
npm run dev                # development server on :4848 (no HTTPS)
```

### Running it on an always-on machine

The panel, the AI proxy and ClickHouse are meant to run on one always-on machine on your home network (a Raspberry Pi or a small server); you develop and deploy from your own computer. From the repo:

```sh
./deploy.sh <alias>            # deploy the working tree (committed or not) to that ssh alias
./deploy.sh <alias> --force    # rebuild and restart the panel even if nothing changed
./deploy.sh <alias> --proxy    # also rebuild and restart CLIProxyAPI
./deploy.sh --help
```

Set `FLEET_DEPLOY_HOST=<alias>` to leave the alias out (also for `npm run deploy` here). The first deploy to a machine installs the services there.

It only does what the change needs:

- **Panel**: syncs `panel/` into `~/fleet/.staging` on the target and builds there (`npm ci` only when `package-lock.json` changed, about 1.5 min on a Raspberry Pi; otherwise `next build` takes 10–30 s). The running panel keeps serving during the build. If the build fails, the deploy stops with the build's errors and the live panel is unchanged; the next run retries. Then it copies the build to `~/fleet/panel` and restarts `fleet-panel` (a few seconds). With nothing changed it skips all of that (about 2 s).
- **Proxy**: CLIProxyAPI is only rebuilt when the `proxy/cliproxyapi` submodule moved or with `--proxy`, because a restart cuts off requests in flight. It is cross-compiled on the deploying machine, so the target needs no Go. The deployed commit is in `~/fleet/proxy/bin/.commit` on the target.
- **Check**: it ends by checking that the panel, the proxy and ClickHouse answer, and exits non-zero if one doesn't. `~/fleet/.deployed` on the target records what was deployed.

Both are systemd user services; turn on linger (`sudo loginctl enable-linger $USER`) so they run without anyone logged in. State is never touched: it lives in `~/.local/state/fleet-panel/` on the target.

**Moving the panel to another machine:** stop `fleet-proxy` and `fleet-panel` on the old one, copy `~/.local/state/fleet-panel/` except `tls/` (the CA is name-constrained to the machine's own hostname, so the new machine makes its own), fix `auth-dir` in `proxy/config.yaml` if the home directory differs, give the new machine an ssh key and authorize it on your machines (**Add machine** shows the command), then deploy there.

## Phone & LAN

The service listens on every interface:

| | |
|---|---|
| `http://<panel machine>:4747` | works in any browser |
| `https://<panel machine>:4443` | needed to **install as an app** (PWA), and for clipboard paste in the terminal |

1. **Open the firewall** if the machine runs one. With ufw, allowing your LAN (adjust the subnet):
   `sudo ufw allow from 192.168.1.0/24 to any port 4443,4747 proto tcp`
2. **Pair your phone:** on a signed-in device (or through `ssh -L 4747:localhost:4747 <panel machine>` and http://localhost:4747, which counts as local), open Fleet → **Add a device** (sidebar, or Ctrl+K). Scan the code with the phone's camera to sign it in. No password to type.
3. **To install it as an app,** do the "Trust the panel" step first. The panel has its own small certificate authority; install its certificate on the phone once. Then scan the HTTPS code and use *Add to Home Screen* / *Install app*.

The certificate authority is created on first start in `~/.local/state/fleet-panel/tls/`. It is **name-constrained** to `localhost`, `.local`, this machine's hostname and private IP ranges, so even if its key leaked it couldn't impersonate a real website. The server certificate is reissued automatically when the machine gets a new address.

### Signing in

- Requests from the panel's machine itself to `localhost` never need a login (an `ssh -L` tunnel counts).
- Every other device needs a session. Get one by signing in to the panel's account or by scanning a one-time pairing code (valid 5 minutes).
- There is one account: a username, a password (at least 10 characters) and, optionally, two-factor sign-in with an authenticator app (Google Authenticator, 1Password, Aegis…; TOTP, 6 digits, each code works once). You create it on first start: open the panel on its own machine (`http://localhost:4747`), or from another device with the setup code printed in the service log. Until it exists, nobody else can create it.
- **Account** (sidebar, or Ctrl+K) changes the password and turns two-factor on or off. Both need the current password. Changing the password signs out every other device.
- Locked out? `http://localhost:4747` on the panel's machine (or through `ssh -L`) never asks to sign in, so you can change the password or turn off two-factor there. Or set `FLEET_PASSWORD` and restart.
- Sessions last 180 days. They're listed in **Add a device**, where you can revoke each one.
- Login attempts are throttled per IP.

### Settings

Set these as `Environment=` lines in a drop-in, `~/.config/systemd/user/fleet-panel.service.d/*.conf` (the unit itself is rewritten on every install), then `systemctl --user daemon-reload && systemctl --user restart fleet-panel`.

| Variable | Default | |
|---|---|---|
| `PORT` | `4747` | HTTP port |
| `TLS_PORT` | `4443` | HTTPS listener for phones; `0` disables it |
| `HOST` | `0.0.0.0` | `127.0.0.1` keeps the panel on this machine only |
| `FLEET_USERNAME` | `admin` | With `FLEET_PASSWORD`: the account's username |
| `FLEET_PASSWORD` | – | Create the account with this password, or reset its password, on every start (two-factor stays as it is) |
| `ALLOWED_HOSTS` | – | Extra hostnames that may reach the panel, such as a reverse-proxy name |
| `FLEET_FILE` | `../fleet.toml` | Legacy inventory to import once, on the first start with an empty database |
| `FLEET_LOCAL_NODE` | – | Force which entry is "this machine" |
| `FLEET_AGENT_DIR` | `../agent` | Where the agent's collectors and binaries are |
| `FLEET_AGENT_URLS` | LAN, then Tailscale addresses | Panel addresses written into agent configs, comma-separated (`https://…:4443`) |

On the phone, the bottom bar has Overview, Machines, Terminal, Activity and More. The terminal is full-screen and follows the on-screen keyboard. It has a row of the keys phones lack: esc, tab, sticky ctrl/alt, arrows, pipes, paste.

## AI proxy

The backend is CLIProxyAPI, pinned as the git submodule [`../proxy/cliproxyapi`](../proxy/cliproxyapi) and built from source. The panel replaces its bundled web UI (which is switched off) and talks to its Management API.

```sh
../proxy/install.sh            # build, write a config on first run, start fleet-proxy.service
../proxy/install.sh --remove   # stop and remove the service; accounts and config stay
# update CLIProxyAPI:
git submodule update --remote ../proxy/cliproxyapi && ../proxy/install.sh
```

`../deploy.sh` does this on the panel's machine with a binary cross-compiled on the deploying machine. Where ufw runs, open the port once: `sudo ufw allow from 192.168.1.0/24 to any port 8317 proto tcp`.

| Page | |
|---|---|
| **Overview** | Requests and tokens in the last 24 h, server status with start/stop/restart, accounts that need attention, and copy-ready setup for Claude Code, Codex CLI, the OpenAI SDK, Gemini CLI and curl. |
| **Accounts** | Sign in to subscriptions (OAuth: in a browser on the panel's machine itself the proxy catches the redirect; from anywhere else, paste the address you land on). Per account: health (active, resting after a limit and until when, needs sign-in), recent requests, Claude/Codex plan limits, models, refresh, verify, priority/weight, disable, remove. Below: API-key upstreams (Anthropic, OpenAI, Gemini, xAI, Vertex, any OpenAI-compatible endpoint). |
| **API keys** | The keys clients use, with 30-day usage per key. |
| **Models** | Everything clients can ask for, a test prompt for any model, aliases and hidden models. |
| **Usage** | Requests and tokens per hour/day/week up to all time, by machine, model, provider, account and key; every request with its error and full log. Covers the proxies and Claude Code/Codex on every machine (see below), filterable by source. |
| **Traffic** | Every request through the proxy in full, from ClickHouse: the prompt and answer up top, then the client request, each upstream attempt and the response, as sections or raw text. Live, searchable across everything (prompts, answers, headers), filter by model or failures; scroll back as far as it goes. <kbd>j</kbd>/<kbd>k</kbd> step through requests. |
| **Logs** | CLIProxyAPI's log (live, with the panel's own polling hidden), saved failed requests, the service's journal. |
| **Settings** | The options worth changing (listen address, port, routing, retries, cooldown, streaming, logs) and a full `config.yaml` editor for everything else. |

State lives in `~/.local/state/fleet-panel/proxy/`: `config.yaml`, `mgmt.key` (the Management API key: the Management API only listens to localhost and the key never reaches a browser), `auths/` (account tokens) and `usage.db`.

**Usage history is the panel's.** CLIProxyAPI dropped its own statistics and only publishes a 60-second queue of per-request events. `lib/cpa-usage.ts` drains it every 5 s into SQLite, kept forever, so requests made while the panel is down for more than a minute aren't counted. Client keys and upstream keys are stored only as previews (`sk-fleet…4e46`).

**Every request, in full, in ClickHouse.** With Settings → Logs → **Request logs** on, CLIProxyAPI writes one file per request with the client's request, every upstream attempt (with the account used) and the answer. `lib/proxy-capture.ts` ships each finished file to ClickHouse within a few seconds (`fs.watch`, plus a 10 s sweep) and remembers it in `proxy/capture.db` only once ClickHouse has accepted it, so nothing is lost while ClickHouse is down. The files stay for CLIProxyAPI's own size limit. Keys in the logs are already masked by CLIProxyAPI (`sk-f...4e46`).

ClickHouse runs in Docker on a fleet machine, usually the panel's own (`../clickhouse/`): `../clickhouse/install.sh <ssh-alias>` deploys it to `~/containers/clickhouse` there and writes `~/.local/state/fleet-panel/clickhouse.json` (machine, password) on the machine you ran it from; copy that file to the panel's machine and restart the panel. It listens on that machine's loopback only: a panel on the same machine connects directly, a panel anywhere else keeps an ssh tunnel to it (`lib/clickhouse.ts`). The table is `ai.proxy_requests` (one row per request: time, model, account, status, tokens, prompt and answer previews, and the whole `raw` log), a ReplacingMergeTree, so re-shipping a file never duplicates it. To be kind to SD cards, ClickHouse's own system log tables are off and inserts are batched; ZSTD keeps the raw logs at roughly a sixth of their size. Query it yourself over ssh on that machine with `docker exec -it clickhouse clickhouse-client --user fleet --password "$(cut -d= -f2 ~/containers/clickhouse/.env)"`.

**Usage from every machine.** `lib/usage-import.ts` reads each machine in the inventory (ssh, or local bash for the panel's own machine) on start and then hourly, or on **Import now**, into the same history, tagged with the machine and source:

- **Claude Code**: `~/.claude/projects/**/*.jsonl`, one row per API response with exact tokens (input counts cache reads and writes; cached = cache reads), the account from `~/.claude.json`. Claude Code deletes these logs after 30 days, so the import is what keeps them.
- **Codex**: `~/.codex/sessions/**/*.jsonl`, one row per `token_count` event.
- **Another CLIProxyAPI** (a standalone install): `~/.cli-proxy-api/logs/main*.log`. Its request lines give time, endpoint, client, status and duration, its routing lines the model and account. It never logged tokens, so those rows have none.

Session logs are only re-read when they changed since the last good import. Row ids are stable, so re-reading never double counts. A machine that's off is caught up on the next run. Requests a machine's Claude Code sent through a proxy would appear twice (once per source); none did as of the first import.

Changes made from the proxy pages (sign-ins, keys, settings, start/stop) go to the Activity log under **AI proxy**.

## Inventory and indexing

The first start with an empty database imports `../fleet.toml` (or `FLEET_FILE`) once and renames it to `fleet.toml.imported`; nothing reads it after that. Machines, settings and the skill's token are in `~/.local/state/fleet-panel/fleet.db`.

**Connecting.** The panel runs `ssh -p <port> <user>@<host>` with its own key (`~/.ssh/id_ed25519` on the panel's machine). A machine's ssh alias is only shown (for the skill) and used to connect only when it has no host. The first connection to a new machine accepts its host key (`StrictHostKeyChecking=accept-new`); a key that changes later is refused. When a new machine can't be reached, **Add machine** shows why and the one command that authorizes the panel's key there (`GET /api/panel/ssh-key`; if the panel's machine has no key, it offers to create one). A machine whose host matches one of the panel's own addresses or hostname is "this machine" and runs locally.

**Indexing** (`lib/indexer.ts`) is one read-only `bash -s` (`../agent/collectors/index.sh`), through the machine's agent when one is connected, otherwise over ssh: `/etc/os-release`, DMI and the device tree, `systemd-detect-virt`, `lscpu`, `lsmem`, `lspci`, `nvidia-smi`, `lsblk`, `/sys/class/net`, `ip`, the battery, `docker ps` (or `sudo -n docker`), `ss -ltnup` (with `sudo -n` when allowed) and `systemctl --user`. It runs when a machine is added or its connection changes, after a probe when the last index is over 6 hours old or the kernel or hostname changed, and on **Re-index** (the scan button on the Hardware panel). A failed index keeps the last good one and retries after 15 minutes. The type, Wake-on-LAN MAC and addresses come from the index unless set by hand (an address entered by hand with the same value as a detected one adds a label and notes to it).

| | |
|---|---|
| `GET /api/inventory` | every machine (JSON); `/api/inventory.md` the same as Markdown |
| `POST /api/machines` | add `{id, host, user, port, alias, kind, use, location, notes, mac, services, addresses}`; indexes it before answering |
| `PATCH /api/machines/:id` | change some fields; `services` and `addresses` replace the list; re-indexes when the connection changed |
| `DELETE /api/machines/:id` | remove it (activity and usage history stay) |
| `POST /api/machines/:id/index` | index now |
| `PUT /api/networks/name` | name a subnet on the Network page `{cidr, name}` (`""` removes the name; signed-in sessions only) |

Every change is in the Activity log under Panel.

**Network** (`/network`, `lib/network.ts`) groups the machines by the subnets the index found on their interfaces, with each address's prefix and the default gateway (its MAC from the neighbour table). Subnets whose gateways share a MAC sit behind one Gateway on the map; machines with their own public address hang off the Internet; Tailscale and WireGuard are overlay strips. A Map and a List view show the same thing (phones get the list). The only thing typed in is an optional name per subnet, stored in the settings table. Machines indexed before this was kept are re-indexed on their next probe.

## Agents

`fleet-agent` (`../agent/`, design in [`../docs/SERVER_AGENT.md`](../docs/SERVER_AGENT.md)) is a small Go program that runs the panel's own read-only collectors (probe, details, updates, index) on a machine and pushes their output over a WebSocket it opens to the panel (`wss://<panel>:4443/ws/agent`). It is report-only: it listens on no port and runs nothing but those four scripts. Terminals, actions and usage import still use ssh, and so do metrics whenever the agent isn't connected or its last report is stale.

- **Install**: the **Agent** panel on a machine's page. **Install agent** copies it over ssh in a terminal tab and runs `fleet-agent install` (a systemd user service, with linger; answer the sudo prompt there). **Install command** gives a one-time `curl … | sh` (10 minutes, works once) for machines the panel can't ssh into. Every install makes a new token; **New token** and **Remove agent** are in the ⋯ menu. Not offered for the panel's own machine.
- **Shows**: **agent** or **ssh** next to each online machine's status, and the agent's version, build and arch in the Agent panel, with a hint when it's out of date.
- **Updates**: `../deploy.sh` builds the agent when its sources changed and syncs it to `~/fleet/agent/` on the panel's machine; connected agents download the new build, check its sha256 and restart themselves. Nothing to do on the machines.
- **Files**: the collectors are `../agent/collectors/*.sh`, read by the panel at runtime for ssh and compiled into the agent. On a machine: `~/.local/bin/fleet-agent`, `~/.config/fleet-agent/` (config, token, CA), `~/.config/systemd/user/fleet-agent.service`. Logs: `journalctl --user -u fleet-agent`.

## Custom scripts

A machine's **update script** (Edit machine → Update) and **saved commands** (Run command → Your commands) are bash you write in the panel. Someone who got into the panel could write one too, so a script only runs on a machine after it was approved **on that machine**:

- The panel shows the command wherever a script still needs approving (the Update dialog, Run command). Run it at the machine or over your own ssh, never from the panel:
  - with `fleet-agent`: `~/.local/bin/fleet-agent approve <sha256>` fetches the script from the panel, checks it has that sha256, shows it (with hidden characters made visible) and asks;
  - without it: `mkdir -p ~/.config/fleet && echo <sha256> >> ~/.config/fleet/approved-scripts`, after reading the script in the panel.
- Approvals are sha256 hashes, one per line, in `~/.config/fleet/approved-scripts` on the machine. Changing a script changes its hash, so it needs approving again. `fleet-agent approved` lists them and `fleet-agent unapprove <hash>` takes one back (or edit the file).
- Right before running, the command the panel sends checks that file for the exact script it carries, and stops with exit code 126 and the approve command if it isn't there. The probe reports the approved hashes, so the panel shows which machines still need to approve something.

## Claude skill

The **Claude skill** page generates `SKILL.md` from the inventory: when to use it, how to answer, a table of machines, and every machine in full (connection, addresses, indexed hardware, notes, containers, listening ports, user services), plus your own **More instructions**.

- **Install**: **Get install command** makes a one-time command (10 minutes, works once) that writes `~/.claude/skills/fleet/SKILL.md` on whatever machine runs it. Run a new one to update. Or download `SKILL.md`, or `fleet-skill.zip` for claude.ai.
- **Live access** (on by default) puts the panel's address and an access token in the skill, so Claude fetches the current inventory instead of trusting the snapshot, and can add, edit, re-index and remove machines through the API above. The token opens only `/api/inventory*`, `/api/machines*` and `GET /api/panel/ssh-key`; not terminals, saved commands, the proxy or anything else. Its changes show up in Activity as "Claude skill (ip)". **New token** cuts off copies installed before; switching live access off makes the token useless and the skill a snapshot.
- **Panel address** defaults to the address you opened the panel with (a LAN address when that was localhost); it must work from the machines that run Claude Code.

## How it works

- `lib/fleet.ts` is the inventory: SQLite at `~/.local/state/fleet-panel/fleet.db` (0600), one row per machine with what the operator entered (connection, type, use, location, notes, MAC, services, extra addresses) and the last index. Every change tells every open panel over `/ws`, so edits and fresh indexes show up within a second. `lib/indexer.ts` does the indexing, `lib/hardware.ts` turns it into what the pages show, and `lib/inventory-api.ts` is the HTTP API.
- `lib/state.ts` collects metrics:
  - A machine with a connected agent pushes a probe every 3 s while a browser is watching and every 30 s otherwise (`lib/agents.ts`, `lib/agent-server.ts`); the panel uses it while it's fresh.
  - For every other machine, a background sampler probes every 3 s while a browser is watching, and every 30 s otherwise.
  - Each probe is one `ssh … bash -s` round-trip over a multiplexed connection (`ControlMaster`), so it costs ~100 ms rather than a full handshake.
  - It keeps a short history for the charts.
  - It saves last-seen times to `~/.local/state/fleet-panel/`.
- `server.ts` is a custom Next server. It serves the app, and the `/ws` WebSocket multiplexes PTY sessions (`node-pty` → `ssh -t alias …`).
- Actions in `lib/actions.ts` come from a fixed set (update, reboot, shutdown, unit, container, logs, kill, check, script), built on the server. The browser only picks one and sends validated names, a pid, or the id of a built-in command (`lib/checks.ts`) or saved command (`lib/scripts.ts`); there is no action that takes a command line. Each runs as `bash` whatever the login shell is, with pagers and editors switched off (`PAGER=cat`, `LESSSECURE=1`, `EDITOR=false`) so an updater's prompt can't be turned into a shell.
- The AI proxy (`lib/cpa.ts`) forwards `/api/proxy/m/*` to CLIProxyAPI's `/v8/management/*` with the management key, after the panel's own sign-in check, and logs every change. `/api/proxy/status`, `/service`, `/journal`, `/models`, `/test`, `/usage` and `/requests` are the panel's additions. The pages are in `components/proxy/`, one file per tab.
- The activity log (`lib/audit.ts`) records everything done through the panel in SQLite at `~/.local/state/fleet-panel/activity.db` (Node's built-in `node:sqlite`): every terminal session and action with its command, who started it and its exit code; each line typed into it (answers to password prompts are replaced with dots); the full terminal output in `transcripts/<id>.log`; Wake-on-LAN, update checks and re-checks; account setup, sign-ins, pairing, revoked devices, password changes and two-factor changes. It is kept forever. The Activity page reads it from `/api/activity` and gets live updates over `/ws`.
- Updates use the right tool for each machine's OS, detected from the index (os-release ID/ID_LIKE, then the OS name, then the package manager): Omarchy → `omarchy-update`, Arch → `yay`/`paru`/`pacman`, Debian/Ubuntu → `apt`, Fedora/RHEL → `dnf`, openSUSE → `zypper`, Alpine → `apk`. When the OS can't be detected, the Update dialog asks and saves the answer; it can also be set under Edit machine → Update. Pending packages come from `checkupdates` (+ `yay -Qua`) or `apt list --upgradable`.

## Security

Anyone who can use this panel can update, reboot and shut down every machine, restart services and containers, and run the scripts each machine approved. They can't run a command of their own: there is no shell, and a new or changed script runs nowhere until someone approves it on the machine itself. So:

- **Everything needs a signed-in session**, including the WebSocket that carries terminals. The only exception is requests made on the panel's machine itself to `localhost` (an `ssh -L` tunnel counts).
- Agents authenticate `/ws/agent` (HTTPS only) and binary downloads with a per-machine token, stored only as a sha256. A token can report metrics for its own machine and nothing else. One-time agent install codes work once, for 10 minutes. See [Agents](#agents).
- The session cookie is `HttpOnly` and `SameSite=Lax`, and also `Secure` over HTTPS.
- Every HTTP request and WebSocket upgrade must use one of this machine's own names or addresses in `Host`, and a matching `Origin`. This blocks DNS rebinding and cross-site WebSocket hijacking.
- Pages can't be framed, and the `Referer` header is off, so pairing codes never leak through it.
- Custom scripts (update scripts, saved commands) only run where the machine approved their exact sha256 (see [Custom scripts](#custom-scripts)). The panel checks that right before running and never writes approvals itself.
- What you type into a running action's terminal still reaches it (sudo passwords, updater prompts), so treat a signed-in session as able to answer those prompts.
- Keep it on your home network. Don't port-forward it. For access away from home, prefer Tailscale or `ssh -L 4747:localhost:4747 <panel machine>`.
- Set `HOST=127.0.0.1` in the unit to make it local-only again.

## Scripts

- `npm run typecheck` / `npm run lint`
- `npm run screenshot -- <outDir>` and `npm run screenshot:mobile -- <outDir> <lanUrl>` capture the main screens with the system Chromium (used for design review).
