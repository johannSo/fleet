/**
 * The inventory: every machine the panel manages, stored in SQLite at
 * $STATE_DIR/fleet.db. Machines are added and edited from the panel (or through
 * /api/machines); hardware, addresses and workloads are filled in by the
 * indexer (lib/indexer.ts).
 *
 * Both server.ts and Next's route handlers import this module (as separate
 * copies), so the connection, cache and listeners live on globalThis.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import { hardwareSpecs, mergeAddresses, wolMac } from "./hardware";
import { knownHostnames, STATE_DIR } from "./net";
import type { AddressEntry, FleetNode, FleetSpec, Hardware, MachineInput, NodeKind } from "./types";
import { detectUpdateOs, UPDATE_OS_IDS, type UpdateOs } from "./update-os";

const DB_FILE = path.join(STATE_DIR, "fleet.db");

export const KINDS = ["desktop", "laptop", "server", "vps", "raspberry-pi", "nas", "other"] as const satisfies readonly NodeKind[];

/** A request to change the inventory that can't be carried out; the message is for the person. */
export class InventoryError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  kind: string | null;
  use: string;
  location: string;
  notes: string;
  mac: string | null;
  host: string;
  user: string;
  port: number | null;
  alias: string;
  addresses: string;
  hardware: string | null;
  indexed_at: number | null;
  index_error: string | null;
  imported: string | null;
  update_script: string;
  update_script_when: string;
  update_os: string | null;
  created_at: number;
  updated_at: number;
  /** sha256 of the machine's agent token; the token itself is never stored. */
  agent_token_hash: string | null;
  agent_seen: number | null;
  agent_version: string | null;
  agent_build: string | null;
  agent_arch: string | null;
}

/** Hardware facts carried over from fleet.toml, shown until the first index. */
interface Imported {
  model: string;
  os: string;
  kernel: string;
  hostname: string;
  specs: FleetSpec[];
}

interface Shared {
  db: DatabaseSync | null;
  version: number;
  cache: { version: number; at: number; nodes: FleetNode[] } | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}
const g = globalThis as unknown as { __fleetInv?: Shared };
const shared: Shared = (g.__fleetInv ??= { db: null, version: 0, cache: null, listeners: new Set(), timer: null });

/* ---------------- database ---------------- */

function db(): DatabaseSync {
  if (shared.db) return shared.db;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const d = new DatabaseSync(DB_FILE);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS machines (
      id          TEXT PRIMARY KEY COLLATE NOCASE,
      kind        TEXT,
      use         TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      notes       TEXT NOT NULL DEFAULT '',
      mac         TEXT,
      host        TEXT NOT NULL DEFAULT '',
      user        TEXT NOT NULL DEFAULT '',
      port        INTEGER,
      alias       TEXT NOT NULL DEFAULT '',
      services    TEXT NOT NULL DEFAULT '[]',
      addresses   TEXT NOT NULL DEFAULT '[]',
      hardware    TEXT,
      indexed_at  INTEGER,
      index_error TEXT,
      imported    TEXT,
      update_script      TEXT NOT NULL DEFAULT '',
      update_script_when TEXT NOT NULL DEFAULT 'after',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Columns added after the first release.
  const cols = new Set((d.prepare("PRAGMA table_info(machines)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("update_script")) d.exec("ALTER TABLE machines ADD COLUMN update_script TEXT NOT NULL DEFAULT ''");
  if (!cols.has("update_script_when")) d.exec("ALTER TABLE machines ADD COLUMN update_script_when TEXT NOT NULL DEFAULT 'after'");
  if (!cols.has("update_os")) d.exec("ALTER TABLE machines ADD COLUMN update_os TEXT");
  // fleet-agent (lib/agents.ts)
  for (const [col, type] of [
    ["agent_token_hash", "TEXT"],
    ["agent_seen", "INTEGER"],
    ["agent_version", "TEXT"],
    ["agent_build", "TEXT"],
    ["agent_arch", "TEXT"],
  ]) {
    if (!cols.has(col)) d.exec(`ALTER TABLE machines ADD COLUMN ${col} ${type}`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS machines_agent_token ON machines(agent_token_hash) WHERE agent_token_hash IS NOT NULL");
  // It holds addresses, notes and the skill's access token: keep it private.
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      /* not created yet */
    }
  }
  shared.db = d;
  if (!getSetting("inventory.initialized")) {
    try {
      importLegacy(d);
    } catch (err) {
      console.error("[fleet] importing fleet.toml failed:", err);
    }
    setSetting("inventory.initialized", String(Date.now()));
  }
  return d;
}

export function getSetting(key: string): string | null {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/* ---------------- one-time import of the old fleet.toml ---------------- */

const SPEC_LABELS: Record<string, string> = { cpu: "CPU", gpu: "GPU", ram: "RAM", npu: "NPU", psu: "PSU", os: "OS" };
const str = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? "" : String(v));

/**
 * Before the inventory moved into this database it lived in fleet.toml next to
 * the panel. The first start imports it once and renames it to
 * fleet.toml.imported, so it's clear nothing reads it any more.
 */
function importLegacy(d: DatabaseSync) {
  const candidates = [process.env.FLEET_FILE, path.resolve(process.cwd(), "..", "fleet.toml")].filter((p): p is string => !!p);
  const file = candidates.find((p) => existsSync(p));
  if (!file) return;
  const raw = parseToml(readFileSync(file, "utf8")) as { machines?: Record<string, Record<string, unknown>> };
  const insert = d.prepare(`INSERT OR IGNORE INTO machines
    (id, kind, use, location, notes, mac, host, user, port, alias, addresses, imported, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const [id, m] of Object.entries(raw.machines ?? {})) {
    const ssh = (m.ssh ?? {}) as Record<string, unknown>;
    const aliases = Array.isArray(ssh.aliases) ? ssh.aliases.map(String) : [];
    const specs = Object.entries((m.specs ?? {}) as Record<string, unknown>).map(([k, v]) => ({
      label: SPEC_LABELS[k.toLowerCase()] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/[_-]/g, " "),
      values: (Array.isArray(v) ? v : [v]).map(str),
    }));
    if (str(m.model)) specs.unshift({ label: "Model", values: [str(m.model)] });
    if (str(m.os)) specs.push({ label: "OS", values: [str(m.os)] });
    if (str(m.kernel)) specs.push({ label: "Kernel", values: [str(m.kernel)] });
    const imported: Imported = { model: str(m.model), os: str(m.os), kernel: str(m.kernel), hostname: str(m.hostname), specs };
    const sshNotes = str(ssh.notes);
    const notes = [str(m.notes).replace(/^NONE$/i, ""), sshNotes && sshNotes !== "key auth" ? `ssh: ${sshNotes}` : ""].filter(Boolean).join("\n\n");
    const addresses: AddressEntry[] = ((m.ips ?? []) as Record<string, unknown>[]).map((a) => ({ label: str(a.network), address: str(a.address), notes: str(a.notes) }));
    const updated = Date.parse(str(m.updated)) || Date.now();
    const kind = KINDS.includes(m.type as NodeKind) ? (m.type as string) : null;
    insert.run(
      id,
      kind,
      str(m.use),
      str(m.location),
      notes,
      typeof m.mac === "string" ? m.mac.toLowerCase().replace(/-/g, ":") : null,
      str(ssh.host),
      str(ssh.user),
      typeof ssh.port === "number" && ssh.port !== 22 ? ssh.port : null,
      aliases[0] ?? "",
      JSON.stringify(addresses),
      JSON.stringify(imported),
      updated,
      updated,
    );
    n++;
  }
  try {
    renameSync(file, `${file}.imported`);
  } catch {
    /* read-only; harmless */
  }
  console.log(`[fleet] imported ${n} machines from ${file} (renamed to ${path.basename(file)}.imported)`);
}

/* ---------------- reading ---------------- */

function json<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toNode(r: Row, localNames: Set<string>, localHost: string, hostnameClaimed: boolean): FleetNode {
  const hw = json<Hardware | null>(r.hardware, null);
  const imp = json<Imported | null>(r.imported, null);
  const manualKind = KINDS.includes(r.kind as NodeKind) ? (r.kind as NodeKind) : null;
  const hostname = hw?.hostname || imp?.hostname || r.id;
  const local =
    process.env.FLEET_LOCAL_NODE === r.id ||
    hostname.toLowerCase() === localHost ||
    (!!r.host && localNames.has(r.host.toLowerCase())) ||
    (!hostnameClaimed && r.id.toLowerCase() === localHost);
  const remote = r.host ? (r.user ? `${r.user}@${r.host}` : r.host) : r.alias || null;
  const port = r.host && r.port && r.port !== 22 ? r.port : null;
  const addresses = json<AddressEntry[]>(r.addresses, []);
  const detectedMac = wolMac(hw);
  const osName = hw?.os ?? imp?.os ?? "";
  const manualOs = UPDATE_OS_IDS.includes(r.update_os as UpdateOs) ? (r.update_os as UpdateOs) : null;
  const detectedOs = detectUpdateOs(hw, osName);
  return {
    id: r.id,
    kind: manualKind ?? hw?.kind ?? "other",
    kindSource: manualKind ? "manual" : hw?.kind ? "detected" : "default",
    model: hw?.model ?? imp?.model ?? "",
    os: osName,
    kernel: hw?.kernel ?? imp?.kernel ?? "",
    location: r.location,
    use: r.use,
    specs: hw ? hardwareSpecs(hw) : (imp?.specs ?? []),
    ips: mergeAddresses(hw, addresses),
    hostname,
    ssh: { host: r.host, user: r.user, port: r.port, alias: r.alias },
    sshTarget: local ? null : remote,
    sshPort: local ? null : port,
    sshCommand: remote ? `ssh ${port ? `-p ${port} ` : ""}${remote}` : null,
    local,
    unreachable: !local && !remote,
    updatedAt: r.updated_at,
    mac: r.mac ?? detectedMac,
    macSource: r.mac ? "manual" : detectedMac ? "detected" : null,
    addresses,
    notes: r.notes,
    hardware: hw,
    indexedAt: r.indexed_at,
    indexError: r.index_error,
    imported: hw ? [] : (imp?.specs ?? []),
    updateScript: r.update_script ?? "",
    updateScriptWhen: r.update_script_when === "before" ? "before" : "after",
    updateOs: manualOs ?? detectedOs,
    updateOsManual: manualOs,
    updateOsDetected: detectedOs,
    agent: {
      installed: !!r.agent_token_hash,
      seen: r.agent_seen ?? null,
      version: r.agent_version ?? null,
      build: r.agent_build ?? null,
      arch: r.agent_arch ?? null,
    },
  };
}

/** Every machine, sorted by name. Cheap: rebuilt only after a change (or every few seconds, for address changes). */
export function loadFleet(): FleetNode[] {
  const c = shared.cache;
  if (c && c.version === shared.version && Date.now() - c.at < 10_000) return c.nodes;
  const rows = db().prepare("SELECT * FROM machines ORDER BY id COLLATE NOCASE").all() as unknown as Row[];
  const localHost = os.hostname().toLowerCase();
  const localNames = knownHostnames();
  const hostnameClaimed = rows.some((r) => {
    const hw = json<Hardware | null>(r.hardware, null);
    const imp = json<Imported | null>(r.imported, null);
    return (hw?.hostname || imp?.hostname || r.id).toLowerCase() === localHost;
  });
  const nodes = rows.map((r) => toNode(r, localNames, localHost, hostnameClaimed));
  shared.cache = { version: shared.version, at: Date.now(), nodes };
  return nodes;
}

export function getNode(id: string): FleetNode | undefined {
  const lower = id.toLowerCase();
  return loadFleet().find((n) => n.id.toLowerCase() === lower);
}

/* ---------------- changes ---------------- */

/** Calls `fn` (debounced) whenever the inventory changes. */
export function onFleetChange(fn: () => void): () => void {
  shared.listeners.add(fn);
  return () => void shared.listeners.delete(fn);
}

function changed() {
  shared.version++;
  shared.cache = null;
  if (shared.timer) clearTimeout(shared.timer);
  shared.timer = setTimeout(() => {
    shared.timer = null;
    for (const l of shared.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[fleet] change listener failed:", err);
      }
    }
  }, 100);
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const HOST_RE = /^(?!-)[A-Za-z0-9._:%-]{1,253}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const ALIAS_RE = /^(?!-)[A-Za-z0-9_.@-]{1,64}$/;
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

function text(v: unknown, what: string, max: number): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new InventoryError(`${what} must be text`);
  const s = v.trim();
  if (s.length > max) throw new InventoryError(`${what} is too long (at most ${max} characters)`);
  return s;
}

function list<T>(v: unknown, what: string, item: (x: Record<string, unknown>, i: number) => T): T[] {
  if (!Array.isArray(v)) throw new InventoryError(`${what} must be a list`);
  if (v.length > 200) throw new InventoryError(`Too many ${what}`);
  return v.map((x, i) => {
    if (!x || typeof x !== "object") throw new InventoryError(`${what} #${i + 1} must be an object`);
    return item(x as Record<string, unknown>, i);
  });
}

/** Checks and normalizes the fields present in `input`. */
function normalize(input: MachineInput): Partial<Omit<Row, "id">> {
  const out: Partial<Omit<Row, "id">> = {};
  if ("kind" in input) {
    if (input.kind != null && !KINDS.includes(input.kind)) throw new InventoryError(`Type must be one of ${KINDS.join(", ")}`);
    out.kind = input.kind ?? null;
  }
  if ("use" in input) out.use = text(input.use, "What it's for", 500);
  if ("location" in input) out.location = text(input.location, "Location", 200);
  if ("notes" in input) out.notes = text(input.notes, "Notes", 20_000);
  if ("mac" in input) {
    const mac = text(input.mac, "MAC address", 17);
    if (mac && !MAC_RE.test(mac)) throw new InventoryError("MAC address should look like aa:bb:cc:dd:ee:ff");
    out.mac = mac ? mac.toLowerCase().replace(/-/g, ":") : null;
  }
  if ("host" in input) {
    const host = text(input.host, "Host", 253).replace(/^\[|\]$/g, "");
    if (host && !HOST_RE.test(host)) throw new InventoryError("Host should be an IP address or a hostname");
    out.host = host;
  }
  if ("user" in input) {
    const user = text(input.user, "User", 32);
    if (user && !USER_RE.test(user)) throw new InventoryError("That doesn't look like a user name");
    out.user = user;
  }
  if ("port" in input) {
    const port = input.port == null || (input.port as unknown) === "" ? null : Number(input.port);
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new InventoryError("Port must be a number from 1 to 65535");
    out.port = port === 22 ? null : port;
  }
  if ("alias" in input) {
    const alias = text(input.alias, "ssh alias", 64);
    if (alias && !ALIAS_RE.test(alias)) throw new InventoryError("Not a valid ssh alias");
    out.alias = alias;
  }
  if ("addresses" in input) {
    const addresses = list(input.addresses, "addresses", (a, i) => ({
      label: text(a.label, `Address #${i + 1} label`, 60),
      address: text(a.address, `Address #${i + 1}`, 253),
      notes: text(a.notes, `Address #${i + 1} notes`, 2000),
    })).filter((a) => a.label || a.address || a.notes);
    if (addresses.some((a) => !a.address)) throw new InventoryError("Every extra address needs an address");
    out.addresses = JSON.stringify(addresses);
  }
  if ("updateScript" in input) {
    if (input.updateScript != null && typeof input.updateScript !== "string") throw new InventoryError("Update script must be text");
    const script = (input.updateScript ?? "").replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
    if (script.length > 20_000) throw new InventoryError("Update script is too long (at most 20,000 characters)");
    out.update_script = script;
  }
  if ("updateScriptWhen" in input) {
    const when = input.updateScriptWhen ?? "after";
    if (when !== "before" && when !== "after") throw new InventoryError("Update script runs either before or after the system update");
    out.update_script_when = when;
  }
  if ("updateOs" in input) {
    const os = input.updateOs ?? null;
    if (os !== null && !UPDATE_OS_IDS.includes(os)) throw new InventoryError(`OS must be one of ${UPDATE_OS_IDS.join(", ")}, or null to detect it`);
    out.update_os = os;
  }
  return out;
}

export function createMachine(input: MachineInput): FleetNode {
  const id = text(input.id, "Name", 32);
  if (!ID_RE.test(id)) throw new InventoryError("Name: letters, digits, - and _ only (up to 32), starting with a letter or digit");
  if (getNode(id)) throw new InventoryError(`There's already a machine called “${id}”`, 409);
  const f = normalize(input);
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO machines (id, kind, use, location, notes, mac, host, user, port, alias, addresses, update_script, update_script_when, update_os, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, f.kind ?? null, f.use ?? "", f.location ?? "", f.notes ?? "", f.mac ?? null, f.host ?? "", f.user ?? "", f.port ?? null, f.alias ?? "", f.addresses ?? "[]", f.update_script ?? "", f.update_script_when ?? "after", f.update_os ?? null, now, now);
  changed();
  return getNode(id)!;
}

export function updateMachine(id: string, input: MachineInput): FleetNode {
  const node = getNode(id);
  if (!node) throw new InventoryError(`No machine called “${id}”`, 404);
  if (input.id != null && input.id !== node.id) throw new InventoryError("A machine's name can't be changed");
  const f = normalize(input);
  const keys = Object.keys(f) as (keyof typeof f)[];
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    db()
      .prepare(`UPDATE machines SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => f[k] as string | number | null), Date.now(), node.id);
    changed();
  }
  return getNode(node.id)!;
}

export function deleteMachine(id: string): FleetNode {
  const node = getNode(id);
  if (!node) throw new InventoryError(`No machine called “${id}”`, 404);
  db().prepare("DELETE FROM machines WHERE id = ?").run(node.id);
  changed();
  return node;
}

/** Stores an index result: new hardware replaces the old (and anything imported); an error keeps the last good one. */
export function saveIndex(id: string, hw: Hardware | null, error: string | null) {
  if (hw) {
    db().prepare("UPDATE machines SET hardware = ?, indexed_at = ?, index_error = NULL, imported = NULL WHERE id = ?").run(JSON.stringify(hw), Date.now(), id);
  } else {
    db().prepare("UPDATE machines SET index_error = ? WHERE id = ?").run(error ?? "Unknown error", id);
  }
  changed();
}

/* ---------------- fleet-agent ---------------- */

/** Sets (or with null, clears) the hash of a machine's agent token. The old token stops working at once. */
export function setAgentTokenHash(id: string, hash: string | null) {
  const node = getNode(id);
  if (!node) throw new InventoryError(`No machine called “${id}”`, 404);
  if (hash) db().prepare("UPDATE machines SET agent_token_hash = ? WHERE id = ?").run(hash, node.id);
  else db().prepare("UPDATE machines SET agent_token_hash = NULL, agent_version = NULL, agent_build = NULL, agent_arch = NULL WHERE id = ?").run(node.id);
  changed();
}

/** The machine a token hash belongs to, if any. */
export function machineForAgentToken(hash: string): string | null {
  const r = db().prepare("SELECT id FROM machines WHERE agent_token_hash = ?").get(hash) as { id: string } | undefined;
  return r?.id ?? null;
}

/** Records what an agent said about itself and when it was last around. */
export function recordAgent(id: string, a: { seen: number; version?: string; build?: string; arch?: string }, notify = false) {
  if (a.version === undefined) {
    db().prepare("UPDATE machines SET agent_seen = ? WHERE id = ?").run(a.seen, id);
  } else {
    db()
      .prepare("UPDATE machines SET agent_seen = ?, agent_version = ?, agent_build = ?, agent_arch = ? WHERE id = ?")
      .run(a.seen, a.version, a.build ?? null, a.arch ?? null, id);
  }
  if (notify) changed();
  else {
    // Not worth a push to every open panel; the next read picks it up.
    shared.version++;
    shared.cache = null;
  }
}
