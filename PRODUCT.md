# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Installable as a PWA on phones (HTTPS listener with the panel's own name-constrained CA). Mobile web, not native.

## Users

One operator: the owner of the fleet, managing their own machines (a handful of desktops, laptops, a Raspberry Pi or home server, maybe a VPS). They use it in two situations:

- **At the desk on their laptop**, alongside their terminal and Claude Code.
- **From their phone** on the home network, installed as an app, to check on machines or fix something without opening a laptop.

There are no other accounts or roles. The operator knows every machine intimately; the panel never needs to explain what a machine is for.

**Open source:** other people run it against their own machines, so nothing about one particular fleet belongs in the product.

## Product Purpose

A control panel for every machine in its inventory. It lets the operator see, in one place, whether every machine is healthy, and act on any of them immediately: updates, reboots, service and container control, built-in commands and the operator's own approved scripts, over ssh.

Monitoring and acting are equal jobs. Success means the operator can tell at a glance that everything is fine (or exactly what isn't), and get from "something's wrong" to fixing it in a couple of steps, from either the laptop or the phone.

## Positioning

It is built on plain ssh, plus an optional report-only agent (`fleet-agent`) that pushes a machine's metrics to the panel instead of being polled; ssh stays the fallback and carries every action. The inventory lives in the panel's own database: the operator adds and edits machines in the panel, and the panel indexes each one's hardware, addresses and workloads over ssh by itself. Nothing about the fleet is hardcoded. The `fleet` Claude skill is generated from the same inventory and downloaded from the panel. Every action runs in a real terminal tab the operator can watch and answer prompts in. There is no shell and no free-form command: the panel runs built-in actions, and custom scripts only where the machine approved them.

## Operating Context

- Runs as a systemd user service on an always-on machine on the home network (`http://<host>:4747`, HTTPS on `:4443` for phones). Home LAN only; remote access via Tailscale or an ssh tunnel, never port-forwarding.
- Machines are typically a mix of Linux desktops, laptops, a Raspberry Pi and servers; updates use the right tool per machine (`omarchy-update`, `yay`/`paru`/`pacman`, `apt`, `dnf`).
- Phones pair by scanning a one-time QR code; sessions last 180 days and can be revoked.
- Machines are frequently offline (laptops asleep, desktops off): unreachable is a normal state, not an error, handled with Retry, Wake-on-LAN and a copyable ssh command.

## Capabilities and Constraints

- Screens: Overview (live CPU, memory, disk, temperature, network, uptime, pending updates, reboot-required, failed units), Machines, per-machine node view (with indexed hardware and notes), Add/Edit machine, Claude skill, Activity, AI proxy (Overview, Accounts, API keys, Models, Usage, Logs, Settings), login/pairing, Add a device.
- AI proxy: CLIProxyAPI (git submodule, unmodified) runs as `fleet-proxy.service` next to the panel; the panel is its only UI and keeps its usage history.
- Terminal dock with persistent PTY sessions (reattach with scrollback); full-screen on phones with an extra-keys row.
- Command palette (Ctrl+K) for navigation and every action; Ctrl+` toggles the terminal.
- Actions come from a fixed, validated set built on the server: update, reboot, shutdown, unit, container, logs, kill, built-in commands and saved commands (including on several machines at once). The panel never offers a shell or runs a command line typed into it.
- Custom scripts (update scripts, saved commands) run on a machine only after someone approves their exact sha256 on that machine (`fleet-agent approve`, or a line in `~/.config/fleet/approved-scripts`). A signed-in session alone can't get new code run anywhere. Destructive actions must stay visible and deliberate.
- Stack is fixed by the codebase: Next.js 16 with a custom server (`panel/server.ts`), React 19, Tailwind 4, xterm.js, node-pty, cmdk, motion, sonner, lucide icons.
- Machine names and addresses come from the inventory, never from the product itself.

## Brand Commitments

- **Name:** Fleet (manifest: "Fleet — control panel").
- **Tokyo Night is binding.** The panel uses the Tokyo Night (night) palette (folke/tokyonight.nvim), as defined in `panel/app/globals.css`. Confirmed by the owner as part of the product's identity.
- Voice: plain, direct, operator-to-operator, as in the README. Short labels, concrete instructions.

## Evidence on Hand

- The inventory (`fleet.db` in the panel's state directory): machines with services, addresses, notes and indexed hardware.
- `panel/README.md`: full feature, security and settings documentation.
- App icons: `panel/app/icon.svg`, `panel/public/icons/`, sources in `panel/scripts/icons/`.
- Screenshot tooling for design review: `npm run screenshot` and `npm run screenshot:mobile`.
- No testimonials, no metrics on usage. Do not invent any.

## Product Principles

1. **Health and action side by side.** Neither the status view nor the controls get buried; seeing a problem and acting on it sit one step apart.
2. **Offline is normal.** Unreachable machines are an expected state with a clear path back (retry, wake, ssh), never an alarm.
3. **Every action is watchable.** Commands run where the operator can see output and step in; nothing powerful happens silently.
4. **Laptop and phone are both first-class.** Any core job works from the phone, not just a read-only view.
5. **The inventory is the truth.** It lives in the panel; what can be detected is indexed, never typed in, and nothing else (the skill) keeps a second copy.
