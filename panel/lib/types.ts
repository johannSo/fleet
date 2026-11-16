import type { ActivityEvent } from "./activity-types";

export type NodeKind =
  | "desktop"
  | "laptop"
  | "server"
  | "vps"
  | "raspberry-pi"
  | "nas"
  | "other";

export interface FleetSpec {
  /** "CPU", "RAM", "Storage"… */
  label: string;
  /** One entry per line (e.g. several disks). */
  values: string[];
}

/** How the panel reaches a machine. Stored in the inventory database. */
export interface FleetSsh {
  /** IP address or hostname. */
  host: string;
  user: string;
  port: number | null;
  /** Optional ~/.ssh/config alias (shown as "ssh <alias>"; used to connect only when there is no host). */
  alias: string;
}

/** An address as shown for a machine: detected on its interfaces, entered by hand, or both. */
export interface FleetAddress {
  /** "LAN", "WLAN", "Tailscale", "Public"… */
  label: string;
  value: string;
  notes: string;
  /** Network interface it was found on, when detected. */
  iface?: string;
  detected: boolean;
  manual: boolean;
}

/** An extra address entered by hand (a public IP, a DNS name…). */
export interface AddressEntry {
  label: string;
  address: string;
  notes: string;
}

export interface HwDisk {
  name: string;
  /** "Samsung MZVLB1T0HALR-000L7"; empty when the device doesn't say. */
  model: string;
  size: number;
  /** "NVMe", "SSD", "HDD", "USB", "SD card", "eMMC", "virtual disk" or "". */
  type: string;
  removable: boolean;
}

export interface HwNic {
  name: string;
  type: "ethernet" | "wifi" | "tailscale" | "vpn" | "other";
  mac: string | null;
  ipv4: string[];
  ipv6: string[];
  up: boolean;
  /** Link speed in Mbit/s. */
  speed: number | null;
  /** Carries the default route. */
  primary: boolean;
}

/** Everything the indexer found out about a machine over ssh (lib/indexer.ts). */
export interface Hardware {
  /** "ThinkPad T14 Gen 3", "Raspberry Pi 5 Model B" */
  model: string | null;
  /** Kind guessed from the chassis type, device tree and virtualization. */
  kind: NodeKind | null;
  /** Hypervisor ("kvm") or null on bare metal. */
  virt: string | null;
  /** "Omarchy 4.5.0 (Arch Linux)", "Ubuntu 26.04.1 LTS" */
  os: string | null;
  /** os-release ID and ID_LIKE ("ubuntu", "debian"), for picking the update command. Absent on machines indexed before they were kept. */
  osId?: string | null;
  osLike?: string | null;
  /** "Hyprland", "KDE Plasma"… when a desktop session is running. */
  desktop: string | null;
  kernel: string | null;
  arch: string | null;
  hostname: string | null;
  cpu: { model: string; cores: number | null; threads: number | null; mhz: number | null } | null;
  /** Installed memory in bytes. */
  ram: number | null;
  swap: number | null;
  gpus: string[];
  disks: HwDisk[];
  nics: HwNic[];
  /** Battery health: current full capacity as a percentage of the design capacity. */
  battery: { health: number | null } | null;
  docker: "ok" | "sudo" | "denied" | "none";
  containers: { name: string; image: string; state: string; ports: string }[];
  ports: { proto: string; addr: string; port: number; process: string }[];
  /** Running systemd user services, minus desktop plumbing. */
  userServices: string[];
  pkg: PkgManager;
}

/** A machine as the panel works with it: what's stored plus what the indexer found. */
export interface FleetNode {
  id: string;
  kind: NodeKind;
  /** Where `kind` came from. */
  kindSource: "manual" | "detected" | "default";
  /** "Raspberry Pi 5 Model B"; may be empty before the first index. */
  model: string;
  os: string;
  kernel: string;
  location: string;
  use: string;
  /** Hardware summary (Model, CPU, RAM, GPU, Storage…) for display. */
  specs: FleetSpec[];
  ips: FleetAddress[];
  hostname: string;
  ssh: FleetSsh;
  /** Destination to pass to ssh ("user@192.168.1.10" or an alias), or null for the panel's own machine. */
  sshTarget: string | null;
  /** Non-default ssh port, if any. */
  sshPort: number | null;
  /** "ssh user@192.168.1.10", for copying; null when there's no way in. */
  sshCommand: string | null;
  local: boolean;
  /** True when no connection is set up and it isn't this machine. */
  unreachable: boolean;
  /** When the machine's details were last edited (ms). */
  updatedAt: number;
  /** MAC address for Wake-on-LAN: entered by hand, or the wired NIC the indexer found. */
  mac: string | null;
  macSource: "manual" | "detected" | null;
  /** Extra addresses entered by hand, as stored (for editing). */
  addresses: AddressEntry[];
  notes: string;
  hardware: Hardware | null;
  indexedAt: number | null;
  indexError: string | null;
  /** Hardware details carried over from fleet.toml, shown until the first index. */
  imported: FleetSpec[];
  /** The machine's own update steps (bash), run by the Update action next to the system updater; "" for none. */
  updateScript: string;
  /** Whether the update script runs before or after the system updater. */
  updateScriptWhen: UpdateScriptWhen;
  /** OS family the system update is run for: the one chosen in the panel, else the detected one; null when neither is known (the Update dialog then asks). */
  updateOs: UpdateOs | null;
  /** Chosen in the panel, overriding detection; null for automatic. */
  updateOsManual: UpdateOs | null;
  /** Detected from the indexed OS. */
  updateOsDetected: UpdateOs | null;
  /** Its fleet-agent, as last recorded (the live connection is in AgentStatus). */
  agent: FleetAgent;
}

/** What the inventory remembers about a machine's fleet-agent. */
export interface FleetAgent {
  /** A token is set: the agent was installed, or an install was started. */
  installed: boolean;
  /** Last connected or disconnected. */
  seen: number | null;
  version: string | null;
  build: string | null;
  arch: string | null;
}

/** How a machine's metrics reached the panel. */
export type ReportVia = "agent" | "ssh" | "local";

/** A machine's fleet-agent right now (lib/agents.ts). */
export interface AgentStatus {
  installed: boolean;
  connected: boolean;
  version: string | null;
  build: string | null;
  arch: string | null;
  /** Connected since, or last seen when not connected. */
  since: number | null;
  /** WebSocket round-trip in ms, when connected. */
  rtt: number | null;
  /** The panel has a different build than the agent runs. */
  outdated: boolean;
  /** Why its last self-update failed, if it did. */
  updateError: string | null;
}

import type { UpdateOs } from "./update-os";

export type UpdateScriptWhen = "before" | "after";

/** What the add/edit form sends (POST /api/machines, PATCH /api/machines/:id). */
export interface MachineInput {
  id?: string;
  kind?: NodeKind | null;
  use?: string;
  location?: string;
  notes?: string;
  mac?: string | null;
  host?: string;
  user?: string;
  port?: number | null;
  alias?: string;
  addresses?: AddressEntry[];
  updateScript?: string;
  updateScriptWhen?: UpdateScriptWhen;
  /** null for automatic. */
  updateOs?: UpdateOs | null;
}

export interface DiskInfo {
  mount: string;
  size: number;
  used: number;
  fstype: string;
}

export type PkgManager = "omarchy" | "yay" | "paru" | "pacman" | "apt" | "dnf" | "unknown";

export interface NodeMetrics {
  hostname: string;
  kernel: string;
  osName: string;
  arch: string;
  uptime: number;
  load: [number, number, number];
  cpus: number;
  cpuModel: string;
  /** 0..100, null on first sample */
  cpu: number | null;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  disks: DiskInfo[];
  tempC: number | null;
  /** bytes/sec, null on first sample */
  rx: number | null;
  tx: number | null;
  addrs: { iface: string; addr: string }[];
  failedUnits: string[];
  rebootRequired: boolean;
  pkg: PkgManager;
  procs: number;
  users: number;
}

export interface Sample {
  at: number;
  cpu: number | null;
  mem: number;
  rx: number | null;
  tx: number | null;
}

export type NodeStatus = "online" | "offline" | "unknown";

export interface NodeState {
  id: string;
  status: NodeStatus;
  latencyMs: number | null;
  checkedAt: number;
  lastSeen: number | null;
  error: string | null;
  metrics: NodeMetrics | null;
  /** Where the metrics came from: the machine's agent, ssh, or this machine itself. */
  via: ReportVia | null;
}

export interface UpdateInfo {
  checkedAt: number;
  count: number;
  packages: { name: string; from: string; to: string }[];
  error: string | null;
}

export interface ProcessRow {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  command: string;
}

export interface UnitRow {
  unit: string;
  scope: "system" | "user";
  active: string;
  sub: string;
  description: string;
}

export interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface NodeDetails {
  processes: ProcessRow[];
  units: UnitRow[];
  containers: ContainerRow[];
  dockerAccess: "ok" | "sudo" | "none" | "denied";
  listening: { proto: string; addr: string; port: number; process: string }[];
  error: string | null;
}

/* ---------- terminal protocol ---------- */

export type ActionKind =
  | "shell"
  | "update"
  | "reboot"
  | "shutdown"
  | "unit"
  | "container"
  | "exec"
  | "logs"
  | "kill"
  /** Install, re-key or remove fleet-agent (params.op); runs on the panel's machine and reaches the machine over ssh. */
  | "agent";

export interface SessionSpec {
  node: string;
  action: ActionKind;
  /** Extra parameters for the action. */
  params?: Record<string, string | boolean | undefined>;
}

export interface SessionInfo {
  id: string;
  node: string;
  action: ActionKind;
  spec: SessionSpec;
  title: string;
  command: string;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
  /** Row in the activity log (lib/audit.ts). */
  activityId?: number;
}

export type ClientMsg =
  | { t: "create"; spec: SessionSpec; cols: number; rows: number; nonce: string }
  | { t: "attach"; id: string }
  | { t: "input"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "kill"; id: string }
  | { t: "close"; id: string }
  | { t: "list" };

export type ServerMsg =
  | { t: "sessions"; list: SessionInfo[] }
  | { t: "created"; nonce: string; session: SessionInfo }
  | { t: "error"; nonce?: string; message: string }
  | { t: "data"; id: string; data: string }
  | { t: "replay"; id: string; data: string }
  | { t: "exit"; id: string; code: number | null }
  | { t: "activity"; event: ActivityEvent }
  /** The inventory changed (a machine was added, edited, removed or re-indexed); re-fetch /api/fleet. */
  | { t: "fleet" }
  /** Something changed in the AI proxy (new requests, accounts, settings); re-fetch. */
  | { t: "proxy" };
