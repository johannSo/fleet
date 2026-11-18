/**
 * The inventory as Markdown: for /api/inventory.md, and as the Claude skill (SKILL.md) people download from
 * the panel and install into ~/.claude/skills/fleet/.
 */
import { deflateRawSync } from "node:zlib";
import { notablePorts } from "./hardware";
import type { FleetNode } from "./types";
import { updateOsInfo } from "./update-os";

const KIND: Record<string, string> = { "raspberry-pi": "Raspberry Pi", vps: "VPS", nas: "NAS" };
const kindName = (k: string) => KIND[k] ?? k;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** Indents continuation lines so multi-line notes stay inside their list item. */
function indent(text: string, by = "  "): string {
  return text.trim().split("\n").join(`\n${by}`);
}

function connect(n: FleetNode): string {
  const parts: string[] = [];
  if (n.ssh.alias) parts.push(`\`ssh ${n.ssh.alias}\` (alias in ~/.ssh/config, where it's set up)`);
  if (n.ssh.host) parts.push(`\`ssh ${n.ssh.port && n.ssh.port !== 22 ? `-p ${n.ssh.port} ` : ""}${n.ssh.user ? `${n.ssh.user}@` : ""}${n.ssh.host}\``);
  return parts.join(" or ") || "no ssh connection recorded";
}

export function machineMarkdown(n: FleetNode, panelNode: string | null): string {
  const hw = n.hardware;
  const L: string[] = [];
  const head = [kindName(n.kind), n.model, hw?.os ? `${hw.os}${hw.desktop ? `, ${hw.desktop}` : ""}` : n.os, n.location].filter(Boolean);
  L.push(`### ${n.id}`, "", head.join(" · "));
  if (n.use) L.push("", `**Use:** ${oneLine(n.use)}`);
  L.push("");
  L.push(`- **Connect:** ${connect(n)}${n.id === panelNode ? " · the Fleet panel runs here" : ""}`);
  if (n.hostname && n.hostname !== n.id) L.push(`- **Hostname:** \`${n.hostname}\``);
  if (n.ips.length) {
    const addr = (a: FleetNode["ips"][number]) => {
      const notes = a.notes ? oneLine(a.notes) : "";
      const extra = [a.iface && !notes.includes(a.iface) ? a.iface : "", notes, a.detected ? "" : "entered by hand, not seen on an interface"].filter(Boolean);
      return `${a.label} ${a.value}${extra.length ? ` (${extra.join("; ")})` : ""}`;
    };
    L.push(`- **Addresses:** ${n.ips.map(addr).join(" · ")}`);
  }
  const specs = n.specs.filter((s) => !["Model", "OS"].includes(s.label));
  if (specs.length) {
    const src = hw && n.indexedAt ? `indexed ${day(n.indexedAt)}` : "from the old fleet.toml, not indexed yet";
    L.push(`- **Hardware** (${src}):`);
    for (const s of specs) L.push(`  - ${s.label}: ${s.values.join("; ")}`);
  }
  if (n.mac) L.push(`- **Wake-on-LAN MAC:** ${n.mac}`);
  const upd = updateOsInfo(n.updateOs);
  if (upd) L.push(`- **Updates with:** ${upd.command} (${upd.label}, ${n.updateOsManual ? "chosen in the panel" : "detected"})`);
  if (n.updateScript) {
    const fence = n.updateScript.includes("```") ? "~~~~" : "```";
    L.push(`- **Update script** (the user's own steps, run ${n.updateScriptWhen} the system update by the panel's Update button):`, "", `  ${fence}sh`, ...n.updateScript.split("\n").map((l) => `  ${l}`), `  ${fence}`, "");
  }
  if (n.notes) L.push(`- **Notes:** ${indent(n.notes)}`);
  if (hw) {
    if (hw.containers.length) {
      L.push(`- **Docker containers** (indexed${hw.docker === "sudo" ? "; docker needs sudo here" : ""}):`);
      for (const c of hw.containers) L.push(`  - \`${c.name}\` — ${c.image}, ${c.state}${c.ports ? `, ${c.ports}` : ""}`);
    }
    const ports = notablePorts(hw);
    if (ports.length) {
      L.push(`- **Listening ports** (indexed): ${ports.map((p) => `${p.port}${p.proto === "udp" ? "/udp" : ""}${p.process ? ` ${p.process}` : ""}${p.local ? " (localhost)" : ""}`).join(" · ")}`);
    }
    if (hw.userServices.length) L.push(`- **User services running** (indexed): ${hw.userServices.join(", ")}`);
  }
  if (n.indexError && !hw) L.push(`- **Not indexed:** ${oneLine(n.indexError)}`);
  return L.join("\n");
}

/** The "at a glance" table and every machine in full. */
export function inventoryMarkdown(nodes: FleetNode[]): string {
  const panelNode = nodes.find((n) => n.local)?.id ?? null;
  const L: string[] = ["## At a glance", "", "| Machine | Type | Connect | Address | Use |", "|---|---|---|---|---|"];
  for (const n of nodes) {
    const ssh = n.ssh.alias ? `\`ssh ${n.ssh.alias}\`` : n.sshCommand ? `\`${n.sshCommand}\`` : "—";
    L.push(`| ${n.id} | ${kindName(n.kind)} | ${ssh} | ${n.ips[0]?.value ?? "—"} | ${oneLine(n.use).replace(/\|/g, "/") || "—"} |`);
  }
  if (!nodes.length) L.push("| (none yet) | | | | |");
  L.push("", "## Machines", "");
  for (const n of nodes) L.push(machineMarkdown(n, panelNode), "");
  return L.join("\n").trim() + "\n";
}

export interface SkillOptions {
  /** Where the panel answers, e.g. http://192.168.1.10:4747. */
  panelUrl: string;
  /** Inventory access token; null leaves live access out of the skill. */
  token: string | null;
  /** The user's own extra instructions, appended as-is. */
  extra: string;
  generatedAt: number;
}

export function skillMarkdown(nodes: FleetNode[], o: SkillOptions): string {
  const names = nodes.map((n) => n.id);
  const panel = nodes.find((n) => n.local)?.id;
  const description =
    `The user's computers${names.length ? ` (${names.join(", ")})` : ""}: what each one is and is used for, its hardware, IP addresses, how to ssh in, and what runs on it (services, containers, ports). ` +
    `Use whenever the user mentions one of these machines by name, asks for an IP, host or ssh target, asks where a service runs or which machine does something, wants to connect or deploy to "my server/laptop/pi/...", or wants to add, change or remove a machine. ` +
    `Triggers: fleet, my computers, my machines, my servers, which box, IP of, ssh into, what's running on.`;
  const auth = o.token ? ` -H 'Authorization: Bearer ${o.token}'` : "";
  const L: string[] = [
    "---",
    "name: fleet",
    `description: ${JSON.stringify(description.slice(0, 1000))}`,
    "---",
    "",
    "# Fleet",
    "",
    `The user's machines, from their Fleet control panel (${o.panelUrl}${panel ? `, running on \`${panel}\`` : ""}). The panel is the source of truth: the user adds and edits machines there, and it indexes each machine's hardware, OS, network addresses, containers, listening ports and user services over ssh by itself.`,
    "",
    `This file was generated on ${new Date(o.generatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC.`,
    "",
  ];
  if (o.token) {
    L.push(
      "## Live inventory",
      "",
      "This file is a snapshot. Before answering anything that could have changed (addresses, ports, services, hardware), fetch the current inventory:",
      "",
      "```sh",
      `curl -fsS${auth} ${o.panelUrl}/api/inventory.md`,
      "```",
      "",
      "It has the same layout as the snapshot below; `/api/inventory` returns JSON. If the panel can't be reached (for example away from the home network), use the snapshot and say it may be out of date.",
      "",
      "## Changing the inventory",
      "",
      "Make the changes the user asks for; ask before removing a machine. Don't type in what the indexer finds (hardware, OS, interface addresses, containers, ports): it updates itself. Record what it can't know.",
      "",
      "```sh",
      `curl -fsS${auth} -H 'Content-Type: application/json' -X POST ${o.panelUrl}/api/machines -d '{"id":"nas","host":"192.168.1.20","user":"admin","use":"backups"}'`,
      `curl -fsS${auth} -H 'Content-Type: application/json' -X PATCH ${o.panelUrl}/api/machines/<name> -d '{"notes":"…"}'`,
      `curl -fsS${auth} -X POST ${o.panelUrl}/api/machines/<name>/index      # re-index now; returns the machine`,
      `curl -fsS${auth} -X DELETE ${o.panelUrl}/api/machines/<name>`,
      `curl -fsS${auth} ${o.panelUrl}/api/panel/ssh-key                      # the key a new machine must authorize`,
      "```",
      "",
      "Fields: `id` (the name; set once), `host`, `user`, `port`, `alias` (an ~/.ssh/config alias), `kind` (desktop, laptop, server, vps, raspberry-pi, nas, other; `null` to detect it), `use` (what it's for), `location`, `notes`, `mac` (for Wake-on-LAN; `null` to use the detected wired MAC), `addresses` (`[{\"label\", \"address\", \"notes\"}]`, for addresses the machine doesn't have on an interface, like a DNS name, or notes on one it does), `updateOs` (which OS family the Update button runs the system update for: omarchy, arch, debian, fedora, opensuse, alpine; `null` to detect it from the indexed OS). `addresses` replaces the whole list, so read the machine from `/api/inventory` first and send the edited list back. A machine's update script (`updateScript`, `updateScriptWhen`) can only be changed in the panel; if the user wants one, write it for them and tell them to paste it under Edit machine → Update. It only runs after they approve it on the machine itself (the panel's Update dialog shows the command to run there).",
      "",
      "A new machine is indexed as soon as it's added, if the panel's ssh key is in its `~/.ssh/authorized_keys`. The response's `indexError` says what went wrong otherwise.",
      "",
    );
  } else {
    L.push(
      "## Changing the inventory",
      "",
      `The user edits machines in the panel (${o.panelUrl}/machines). If they ask you to add or change one, tell them exactly what to enter there. This file doesn't update itself: they re-download it from the panel's Claude skill page.`,
      "",
    );
  }
  L.push(
    "## Answering questions",
    "",
    "1. Never guess IPs, ports or hostnames; take them from the inventory.",
    "2. Match machines by name, hostname, ssh alias, or a loose description (\"the pi\", \"my VPS\").",
    "3. To connect, use the machine's ssh command. Add `-o BatchMode=yes` for non-interactive commands so a missing key fails instead of prompting.",
    "4. Notes carry the gotchas (unusual users, login shells, sudo needs); read them before running things on a machine.",
    "5. If something isn't in the inventory, say so and offer to add it.",
    "",
    inventoryMarkdown(nodes).trim(),
    "",
  );
  if (o.extra.trim()) L.push("## More from the user", "", o.extra.trim(), "");
  return L.join("\n");
}

/* ---------------- zip (one file, so claude.ai can take it as an upload) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal ZIP archive (deflate) of the given files. */
export function zip(files: { name: string; data: string }[], at = new Date()): Buffer {
  const dosTime = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2);
  const dosDate = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data, "utf8");
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

