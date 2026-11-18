# fleet-agent: machines report to the panel

Status: **built** (`agent/`, panel side in `panel/lib/agents.ts` and `lib/agent-server.ts`). See [Rollout](#rollout) for trying it on a first machine.

Without an agent, the panel opens an ssh channel for everything it shows: a probe every 3 s while someone is watching (30 s otherwise), the details view, pending updates and indexing. `fleet-agent` is a small program on each machine that runs those same read-only scripts itself and pushes the output to the panel, so the panel doesn't have to reach in. ssh stays the fallback for machines whose agent can't reach the panel (a VPS, laptops away from home, machines without an agent yet).

## What it does and doesn't do

- **Report only.** The agent runs a fixed set of scripts built into its binary: probe, details, updates, index. The panel can't send it a command. It can only change the report interval, ask it to run one of those collectors now, and offer a new version.
- **Actions and terminals stay on ssh.** So does `usage-import` (Claude Code and Codex logs); that could become a collector later.
- **The agent starts every connection.** It listens on no port, so a machine gets no new attack surface.
- **The panel's own machine doesn't need one.** It runs the panel, which runs the scripts locally already. The panel refuses to install an agent on its own machine.

```
machine: fleet-agent (systemd user service) ──wss://<panel>:4443/ws/agent──▶ panel: server.ts → lib/agent-server.ts
  runs its built-in collectors on a timer           machine token, pinned CA        parses with the existing parsers
  pushes raw stdout                                                                 falls back to ssh without a fresh report
```

## One script, two runners

The scripts live in `agent/collectors/`:

| File | Pushed by the agent | Asked for by the panel | Timeout |
|---|---|---|---|
| `probe.sh` | every 3 s while a browser is watching, 30 s otherwise | when the last report is stale, and **Retry** | 8 s |
| `details.sh` | never | Services and Processes tabs | 15 s |
| `updates.sh` | every 15 min while connected | when the panel's copy is older than 15 min, and **Check now** | 60 s |
| `index.sh` | never | when a machine is added, its last index is over 6 h old, its kernel or hostname changed (seen in a probe), and **Re-index** | 30 s |

The agent compiles them in with `go:embed`. The panel reads the same files from disk (`lib/collectors.ts`, `../agent/collectors/` next to the panel, or `$FLEET_AGENT_DIR/collectors/`) when it runs them over ssh, re-reading a file when it changes. The agent sends stdout unchanged and the panel parses it with `parseProbe`, the details and updates parsers and `parseIndex`, exactly as for ssh. The data is the same whichever way it arrived, and since every parser reads `key=value` lines or `##section` blocks, an agent one version behind the panel is harmless.

Scripts run through the user's login environment (`$SHELL -lc 'exec bash -s'`, the shell from `$SHELL` or `/etc/passwd`), so `PATH` matches an ssh session. Under a bare systemd environment `omarchy-update` or `yay` wouldn't be found and the package manager would be detected wrong. A collector that runs past its timeout is killed with its whole process group. If the panel asks for a collector that is already running, the request waits for that run instead of starting a second one.

## Fallback

`runCollector()` in `lib/agents.ts` asks the agent first and falls back to `runScript` over ssh when there is no agent or it doesn't answer within the timeout plus 3 s. Details, updates and indexing all go through it.

The probe in `lib/state.ts` returns the agent's latest report when the agent is connected and that report is younger than twice its interval. Otherwise it asks the agent for a probe now, and only then probes over ssh. A machine with neither is offline, handled as before (Retry, Wake-on-LAN, copyable ssh command). With an agent connected, a machine with no ssh host can still be indexed.

## Protocol

JSON messages over one WebSocket, each with a `t` field naming its type.

Agent → panel:

| Message | |
|---|---|
| `hello {id, version, build, arch, hostname, now}` | first message after connecting. `now` is the agent's clock; the panel corrects every report's `at` by the difference |
| `report {kind, at, out, code, ms, err?, timedOut?}` | a collector's output. `kind` is `probe`, `details`, `updates` or `index`; `at` is when it started; `err` is the tail of stderr |
| `backfill {reports: [...]}` | probes taken while disconnected, sent right after `hello` |
| `reply {req, ...report}` | answer to a `collect` |
| `update-failed {build, error}` | a self-update didn't work; the panel shows it and logs it |

Panel → agent:

| Message | |
|---|---|
| `config {probeMs}` | probe interval: 3000 while a browser is watching, 30000 otherwise. Sent after `hello` and whenever it changes |
| `collect {req, kind}` | run one collector now. Unknown kinds are answered with an error, never run |
| `update {build, url, sha256}` | a different build is available at `url` (a path on the same panel) |

The panel closes the connection with code 4001 when the machine's token is replaced or revoked, and 4000 when the same machine connects again.

## Agent (`agent/`, Go)

- A single static binary, `fleet-agent`, for amd64 and arm64. `agent/build.sh` builds both into `agent/bin/` with `CGO_ENABLED=0`; `deploy.sh` runs it on the deploying machine when the agent's sources changed. Dependencies: `github.com/coder/websocket` and `github.com/BurntSushi/toml`.
- The **build id** is a hash of the agent's sources (Go files, collectors, `go.mod`/`go.sum`, not tests), written to `bin/BUILD`. The same sources always give the same id, so agents only update when the agent actually changed. The version (`0.2.1`) is set in `main.go`.
- Commands: `run` (what the service runs), `install`, `uninstall`, `collect <kind>` (run one collector and print it, for debugging), `approve <sha256>`, `approved`, `unapprove <hash>` (see [Approving custom scripts](#approving-custom-scripts)), `version`.
- Config in `~/.config/fleet-agent/` (0700, files 0600): `config.toml` (`id`, and `urls` in order, for example LAN `https://192.168.1.10:4443` then Tailscale `https://100.64.0.10:4443`), `token`, `ca.pem`. Always under `~/.config`, never `$XDG_CONFIG_HOME`, so the installer's shell and the service agree. `FLEET_AGENT_CONFIG` overrides the directory.
- Trusts only the panel's CA (pinned), not the system store, and ignores proxy environment variables. The CA is already name-constrained to private ranges, including Tailscale's 100.64.0.0/10.
- Reconnects with backoff (1 s doubling to 60 s), trying each URL in turn. A rejected token (401, or close code 4001) waits the full 60 s between tries. It pings the panel every 30 s and reconnects when a pong doesn't come within 15 s.
- Keeps probing while disconnected, at 30 s. It keeps the last 10 minutes of probes and sends them as a `backfill` on reconnect, so charts and last-seen have fewer gaps. The panel parses each probe at its own `at`, adds it to the chart in order, and drops any older than what it already has (when ssh covered the gap).
- **Self-update:** on `update` it downloads the binary from the panel it is connected to (never another host) with its token, checks the sha256, writes it next to itself, renames it over itself and re-execs (same PID, so systemd doesn't notice). A build that failed isn't retried for an hour, and the failure is reported with `update-failed`.
- Runs as a systemd **user** service with linger (`fleet-agent.service`, `ExecStart=%h/.local/bin/fleet-agent run`, `Restart=always`), as the same user ssh uses, so `sudo -n docker` and `sudo -n ss` behave the same. `fleet-agent install` writes the unit, enables and restarts it, and runs `sudo loginctl enable-linger` when linger is off (if that fails, it says the agent only runs while the user is logged in).

## Panel

- `lib/collectors.ts`: reads the collectors and the agent release (`bin/BUILD`, and each binary's sha256), cached by mtime, so a deploy that only changes the agent needs no panel restart.
- `lib/agents.ts`: connected agents (machine → connection, version, build, arch, connected since, clock skew, round-trip, last report per kind), request/response matching for `collect`, `config` pushes when the watching state changes, `runCollector()` with the ssh fallback, and the status the UI shows. Next's route handlers and `server.ts` import separate copies of it, so the state lives on `globalThis`.
- `lib/agent-server.ts` (server.ts only): the `/ws/agent` upgrade, authenticated by `Authorization: Bearer <machine token>` instead of a session cookie. It must still pass `trusted()` (Host and Origin), and it is only accepted on the HTTPS listener. It ingests reports, pings every 20 s (the round-trip is shown as the machine's latency), records last-seen every 5 minutes, and offers the current build to agents running another one, on `hello` and every 20 s after a deploy. Also the install routes and the terminal actions below.
- `lib/fleet.ts`: new columns `agent_token_hash` (sha256; the token itself is never stored), `agent_seen`, `agent_version`, `agent_build`, `agent_arch`, added to existing databases on start.
- Activity log, under Panel: install started (over ssh or by command), token replaced or revoked, updated itself, couldn't update itself; connects and disconnects (at most one entry per machine per 10 minutes).
- Binaries in `~/fleet/agent/bin/fleet-agent-{amd64,arm64}` on the panel's machine, put there by `deploy.sh`, served to installers and for self-update. `GET /agent/bin/<arch>` needs the machine's token or the install script's 10-minute ticket.
- `FLEET_AGENT_URLS` (comma-separated) replaces the panel addresses written into agent configs, for example to add a MagicDNS name. By default they are the panel's private LAN addresses, then its Tailscale addresses, on the HTTPS port.

## Installing

On a machine's page, the **Agent** panel (next to Hardware):

- **Install agent** (machines with ssh): runs in a terminal tab like every other action, so the `sudo loginctl enable-linger` prompt can be answered there. The tab runs a script on the panel's machine that makes a new token, writes config, token and CA into a private staging directory (deleted when the script ends), asks the machine for `uname -m`, copies the files and the right binary over ssh, and runs `~/.local/bin/fleet-agent install` with `ssh -t`. The token never appears in a command line, the activity log or the transcript. **Reinstall** does the same.
- **Install command** for machines the panel can't ssh into (10 minutes, works once, like the Claude skill's): `curl -fsSk https://<panel>:4443/agent/install/<code> | sh`. The script is fetched without checking the certificate, because the panel's CA isn't on the machine yet. It carries the CA, config and a new token, downloads the binary checking the certificate against that CA, checks the binary against its sha256, and runs `fleet-agent install`.
- **New token** (in the ⋯ menu, machines with ssh) cuts off the old token at once, writes the new one over ssh and restarts the agent.
- **Remove agent** clears the token at once, then runs `fleet-agent uninstall` over ssh, which stops and deletes the service, config and binary. For machines without ssh the menu has **Revoke token** instead; uninstall there with `~/.local/bin/fleet-agent uninstall`.

## UI

Each online machine shows how it's reporting, next to its status on the Overview card and the machine page:

- **agent** with its version (tooltip: build, connected since; yellow when it's out of date and couldn't update itself);
- **ssh** when no agent is connected (tooltip: "agent not connected for 4m, probing over ssh", or "no agent installed"); yellow when an agent is installed but not connected;
- nothing while it's unreachable: the status already says so.

The Agent panel shows status, version and build, arch, and a hint when the agent is out of date (updating, or why it couldn't). The latency in the status tooltip and Vitals is the agent's WebSocket round-trip when it reports through the agent.

## Approving custom scripts

The panel runs a custom script (a machine's update script, a saved command) on a machine only when the script's sha256 is in `~/.config/fleet/approved-scripts` there. The panel never writes that file; the machine's owner does, by running the command the panel shows:

- `fleet-agent approve <sha256>` (needs a terminal: it reads the answer from `/dev/tty`) asks the panel for the script with `GET /agent/script/<sha256>` and its machine token, checks the script has that sha256, prints it with control and formatting characters made visible (escape sequences, carriage returns, right-to-left overrides can't hide a line), and appends `<sha256> <name>` to the file (0600, directory 0700) if the answer is yes. Without a token or a reachable panel it says how to add the line by hand.
- `fleet-agent approved` lists the approvals; `fleet-agent unapprove <hash>` removes one (8+ characters of the hash).
- The file is outside `~/.config/fleet-agent/`, so it survives reinstalling or removing the agent, and machines without an agent use the same file.
- The probe reports `approvals=1` and an `approved=<sha256>` line per approval, so the panel can show what still needs approving. An agent from before this reports neither, and the panel shows "unknown" until it updates itself.
- The check that enforces it is part of the command the panel sends over ssh, built on the server around the exact script it runs; a script that isn't approved stops with exit code 126 before anything runs.

## Security

- The agent trusts only the panel's own CA and sends a per-machine token. A stolen token lets someone post fake metrics for that one machine, download the agent binary, and read a custom script whose sha256 they already know, nothing more. It can't approve anything: approvals are a file on the machine. **New token** or **Remove agent** revokes it.
- The agent accepts no commands: `collect` only picks one of four built-in read-only scripts. `approve` is run by a person on the machine; the panel can't trigger it, and the hash check means it can't swap in a different script. A compromised panel gains nothing it doesn't already have through ssh, except one thing: it can push a new agent binary, which runs as the user. That is the same reach it has through ssh as that user.
- The agent listens on nothing. Keep the panel off the internet as before; machines outside the LAN reach it over Tailscale or not at all (they fall back to ssh).
- The one-time install command skips certificate checking for the script itself, so someone who can intercept LAN traffic in those 10 minutes could serve a different script. Use **Install agent** over ssh where possible.

## Checks

- `cd agent && go test -race ./...`: against a fake panel over TLS: reports, reconnect, trying the next URL, backfill (order and window), `collect` and `config`, unknown collectors refused, rejected and revoked tokens, an untrusted certificate refused, self-update (wrong checksum and foreign host refused, binary replaced and re-exec'd), timeouts killing the process group, and every real collector on the machine running the tests, checked for the markers the panel's parsers need. Approving: yes and no answers, already approved, a script whose hash doesn't match refused (and not shown), bad hashes refused before asking the panel, unknown scripts and wrong tokens, hidden characters made visible, unapprove, and the probe reporting approvals.
- `cd panel && npm run typecheck && npm run lint`.
- End to end, run against a dev panel with its own state directory: one-time install, reports via the agent (charts at 3 s while watched, 30 s otherwise), details, updates and index through the agent with a dead ssh host, fallback to ssh within a few seconds of the agent stopping, reconnect after a panel restart, backfill after freezing the panel for 110 s, self-update to a new build (same PID), token revocation, and the install, new-token and remove terminal scripts against a fake ssh.

## Rollout

1. `./deploy.sh <panel-host>` (builds the agent, syncs collectors and binaries, then the panel).
2. Install on one machine on the LAN. It shows **agent**, charts move every 3 s while watched, and its `journalctl -u sshd` shows no probe logins from the panel's machine.
3. Stop the agent there (`systemctl --user stop fleet-agent`): within one interval it shows **ssh** and keeps updating.
4. Change a collector, `./deploy.sh <panel-host>`: the agent updates itself (Activity: "The agent updated itself to build …").
5. Then the other machines. A machine that can't reach the panel (a VPS outside your network) stays on ssh; if it joins Tailscale later, its agent just connects.
