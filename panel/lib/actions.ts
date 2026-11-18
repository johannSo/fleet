import os from "node:os";
import { agentLaunch } from "./agent-server";
import { checkById } from "./checks";
import { approvalCheck, getSavedScript } from "./scripts";
import { SSH_BASE_OPTS, shq, sshDest } from "./ssh";
import type { FleetNode, SessionSpec } from "./types";
import { updateOsInfo, type UpdateOs } from "./update-os";

export interface Launch {
  title: string;
  /** Human-readable command shown in the UI. */
  command: string;
  file: string;
  args: string[];
}

const NAME_RE = /^[A-Za-z0-9@._:\\-]+$/;
const UNIT_OPS = new Set(["start", "stop", "restart", "status", "reload"]);
const CONTAINER_OPS = new Set(["start", "stop", "restart"]);
const SIGNALS = new Set(["TERM", "KILL", "HUP", "INT"]);

/**
 * Every action is built here, on the server, from a fixed list: the browser
 * only picks one and passes validated names (a unit, a container, a pid) or
 * the id of a built-in command or a saved one. There is no shell and no way to
 * send a command line. Custom scripts (update scripts, saved commands) only run
 * where the machine approved them (lib/approval.ts).
 */

/**
 * Keeps interactive programs from handing out a shell: pagers and editors are
 * the usual way out of an updater's prompts (less's "!", vi's ":!").
 */
const NO_ESCAPES = "export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat LESSSECURE=1 EDITOR=false VISUAL=false";

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Prints a coloured banner before the command so every tab is self-describing. */
function banner(text: string) {
  return `printf '\\033[38;2;86;95;137m── \\033[38;2;122;162;247m%s\\033[38;2;86;95;137m ──\\033[0m\\n' ${shq(text)}`;
}

const DOCKER_FN = `d(){ if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi; }`;

/** Stops the step with a pointer to the setting when the chosen OS's updater isn't there. */
function requireTool(bin: string, label: string): string {
  const msg = `${bin} isn't installed here, so this doesn't look like ${label}. Pick the right OS under Edit machine → Update.`;
  return `command -v ${bin} >/dev/null 2>&1 || { printf '\\033[38;2;247;118;142m%s\\033[0m\\n' ${shq(msg)}; exit 127; }`;
}

/** The system update for an OS family; `y` answers its prompts. */
function systemUpdate(os: UpdateOs, y: boolean): string {
  switch (os) {
    case "omarchy":
      return [requireTool("omarchy-update", "Omarchy"), `omarchy-update${y ? " -y" : ""}`].join("\n");
    case "arch":
      return [
        requireTool("pacman", "Arch Linux"),
        `if command -v yay >/dev/null 2>&1; then yay -Syu${y ? " --noconfirm" : ""}`,
        `elif command -v paru >/dev/null 2>&1; then paru -Syu${y ? " --noconfirm" : ""}`,
        `else sudo pacman -Syu${y ? " --noconfirm" : ""}; fi`,
      ].join("\n");
    case "debian":
      return [requireTool("apt-get", "Debian or Ubuntu"), `sudo apt-get update && sudo${y ? " DEBIAN_FRONTEND=noninteractive" : ""} apt-get${y ? " -y" : ""} full-upgrade`].join("\n");
    case "fedora":
      return [requireTool("dnf", "Fedora or RHEL"), `sudo dnf upgrade${y ? " -y" : ""}`].join("\n");
    case "opensuse": {
      // Tumbleweed is rolling and wants dist-upgrade; Leap and SLES update in place.
      const z = `sudo zypper${y ? " --non-interactive" : ""}`;
      return [requireTool("zypper", "openSUSE"), `${z} refresh && if grep -qi tumbleweed /etc/os-release; then ${z} dist-upgrade; else ${z} update; fi`].join("\n");
    }
    case "alpine":
      return [requireTool("apk", "Alpine"), "sudo apk update && sudo apk upgrade"].join("\n");
  }
}

/**
 * The system update for the machine's OS (chosen in the panel or detected),
 * then (or first) the machine's own update script. A step that fails stops
 * the run, so a broken pre-update step never leads into a package upgrade,
 * and the tab's exit code is the failing step's.
 */
function updateCommand(node: FleetNode, auto: boolean): string {
  const y = auto;
  const info = updateOsInfo(node.updateOs);
  // The Update dialog asks for the OS before getting here; this catches every other way in.
  if (!node.updateOs || !info) {
    throw new Error(`Couldn't tell which OS ${node.id} runs, so there's no knowing which updater to use. Choose it in the Update dialog or under Edit machine → Update.`);
  }
  const system = [
    banner(`system update · ${info.label}${y ? " (unattended)" : ""}`),
    // A subshell, so "exit 1" ends this step and not the whole run.
    "(",
    systemUpdate(node.updateOs, y),
    ")",
  ].join("\n");
  // Exactly what was hashed, so what runs is what the machine approved.
  const script = node.updateScript;
  if (!script) return system;

  // FLEET_UPDATE_AUTO tells the script whether prompts are being auto-answered.
  const custom = [banner(`${node.id} update script`), `FLEET_UPDATE_AUTO=${y ? 1 : 0} bash -c ${shq(script)} fleet-update`].join("\n");
  const before = node.updateScriptWhen === "before";
  const [first, second] = before ? [custom, system] : [system, custom];
  const skipped = before ? "system update skipped: the update script" : "update script skipped: the system update";
  return [
    first,
    `rc=$?; if [ "$rc" -ne 0 ]; then printf '\\n\\033[38;2;247;118;142m%s exited with code %s\\033[0m\\n' ${shq(skipped)} "$rc"; exit "$rc"; fi`,
    "echo",
    second,
  ].join("\n");
}

/** `display` is what the tab shows when it isn't the command with its banner taken off. */
function remoteCommand(node: FleetNode, spec: SessionSpec): { title: string; cmd: string; display?: string } {
  const p = spec.params ?? {};
  switch (spec.action) {
    case "update": {
      const cmd = updateCommand(node, p.auto === true);
      // Checked before anything runs, so an unapproved script never leaves an update half done.
      if (!node.updateScript || !node.updateScriptHash) return { title: "update", cmd };
      return { title: "update", cmd: `${approvalCheck(node, node.updateScriptHash, `The update script for ${node.id}`)}\n${cmd}`, display: cmd };
    }

    case "reboot":
      return { title: "reboot", cmd: `${banner("rebooting")}; sudo systemctl reboot` };

    case "shutdown":
      return { title: "shutdown", cmd: `${banner("powering off")}; sudo systemctl poweroff` };

    case "unit": {
      const unit = String(p.unit ?? "");
      const op = String(p.op ?? "status");
      need(NAME_RE.test(unit), "Invalid unit name");
      need(UNIT_OPS.has(op), "Invalid unit operation");
      const user = p.scope === "user";
      const sc = user ? "systemctl --user" : "systemctl";
      const priv = user || op === "status" ? "" : "sudo ";
      const cmd =
        op === "status"
          ? `${sc} status --no-pager -l ${shq(unit)}`
          : `${banner(`${op} ${unit}`)}; ${priv}${sc} ${op} ${shq(unit)} && ${sc} status --no-pager -l ${shq(unit)}`;
      return { title: `${op} ${unit.replace(/\.service$/, "")}`, cmd };
    }

    case "container": {
      const name = String(p.name ?? "");
      const op = String(p.op ?? "");
      need(NAME_RE.test(name), "Invalid container name");
      need(CONTAINER_OPS.has(op), "Invalid container operation");
      return {
        title: `${op} ${name}`,
        cmd: `${DOCKER_FN}; ${banner(`docker ${op} ${name}`)}; d ${op} ${shq(name)} && d ps -a --filter ${shq(`name=^${name}$`)}`,
      };
    }

    case "logs": {
      if (p.container) {
        const name = String(p.container);
        need(NAME_RE.test(name), "Invalid container name");
        return { title: `logs ${name}`, cmd: `${DOCKER_FN}; d logs -f --tail 300 ${shq(name)}` };
      }
      const unit = String(p.unit ?? "");
      need(NAME_RE.test(unit), "Invalid unit name");
      const user = p.scope === "user" ? "--user " : "";
      return {
        title: `logs ${unit.replace(/\.service$/, "")}`,
        cmd: `journalctl ${user}-f -n 300 --no-hostname -o short-iso -u ${shq(unit)}`,
      };
    }

    case "kill": {
      const pid = Number(p.pid);
      const sig = String(p.signal ?? "TERM");
      need(Number.isInteger(pid) && pid > 1, "Invalid pid");
      need(SIGNALS.has(sig), "Invalid signal");
      return {
        title: `kill ${pid}`,
        cmd: `${banner(`kill -${sig} ${pid}`)}; kill -${sig} ${pid} 2>/dev/null || sudo kill -${sig} ${pid}; sleep 0.5; ps -p ${pid} -o pid=,args= || echo "process ${pid} is gone"`,
      };
    }

    case "check": {
      const check = checkById(String(p.check ?? ""));
      need(check, "Unknown built-in command");
      return { title: check.label, cmd: `${banner(check.label)}; ${check.cmd}`, display: check.cmd };
    }

    case "script": {
      const saved = getSavedScript(String(p.script ?? ""));
      need(saved, "That saved command doesn't exist any more");
      const run = `${banner(saved.name)}\nbash -c ${shq(saved.script)} ${shq(saved.name)}`;
      return { title: saved.name, cmd: `${approvalCheck(node, saved.hash, `“${saved.name}”`)}\n${run}`, display: saved.script };
    }

    case "agent":
      throw new Error("agent actions run on the panel's machine");

    default:
      // "shell" and "exec" from an old tab or a crafted message: there's no free-form command any more.
      throw new Error(`“${String(spec.action)}” isn't an action the panel runs`);
  }
}

export function buildLaunch(node: FleetNode, spec: SessionSpec, actor = "unknown"): Launch {
  // Installing, re-keying and removing fleet-agent: a script on this machine that uses ssh (lib/agent-server.ts).
  if (spec.action === "agent") return agentLaunch(node, String(spec.params?.op ?? ""), actor);
  const { title, cmd, display: shown } = remoteCommand(node, spec);
  const display = shown ?? cmd.replace(/^printf[^;\n]*;?\s*/m, "").replace(/^d\(\)\{[^}]*\}; /, "");
  const script = `${NO_ESCAPES}\n${cmd}`;

  if (node.local) return { title, command: display, file: "bash", args: ["-lc", script] };
  need(node.sshTarget, `${node.id} has no connection set up`);
  // ssh hands this to the login shell, which may be fish or zsh; the commands are bash. Base64 inside
  // plain single quotes reads the same in every shell, and keeps the terminal as stdin for prompts.
  const payload = Buffer.from(script, "utf8").toString("base64");
  const remote = `bash -c 'eval "$(echo ${payload} | base64 -d)"'`;
  const args = [...SSH_BASE_OPTS, "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", "-t", ...sshDest(node), "--", remote];
  return { title, command: display, file: "ssh", args };
}

export const PANEL_HOST = os.hostname();
