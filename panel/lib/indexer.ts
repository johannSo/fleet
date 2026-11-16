/**
 * Hardware indexing: one read-only round-trip per machine (through its fleet-agent, else ssh) that finds out
 * what it is (model, CPU, RAM, GPU, disks, network interfaces, OS) and what runs
 * on it (containers, listening ports, user services). Results go into the
 * inventory database (lib/fleet.ts).
 *
 * Runs on its own: when a machine is added, when it comes online and hasn't been
 * indexed for INDEX_TTL, and when its kernel or hostname changes. "Re-index"
 * in the panel forces it.
 */
import { agentConn, runCollector } from "./agents";
import { getNode, saveIndex } from "./fleet";
import { sshError } from "./ssh";
import type { FleetNode, Hardware, HwDisk, HwNic, NodeKind, NodeMetrics, PkgManager } from "./types";

export const INDEX_TTL = 6 * 3_600_000;
/** After a failed index, wait this long before trying again on its own. */
const RETRY_MS = 15 * 60_000;

/* The script is agent/collectors/index.sh (lib/collectors.ts). */

/* ---------------- parsing ---------------- */

const JUNK = /^(|system product name|system manufacturer|system version|to be filled by o\.?e\.?m\.?|default string|not applicable|not specified|none|o\.e\.m\.?|oem|standard pc.*|unknown|invalid|x\.x|0123456789)$/i;

const VENDORS: [RegExp, string][] = [
  [/^lenovo/i, "Lenovo"],
  [/^dell/i, "Dell"],
  [/^(hp|hewlett)/i, "HP"],
  [/^asus/i, "ASUS"],
  [/^acer/i, "Acer"],
  [/^apple/i, "Apple"],
  [/^micro-star|^msi\b/i, "MSI"],
  [/^gigabyte/i, "Gigabyte"],
  [/^microsoft/i, "Microsoft"],
  [/^framework/i, "Framework"],
  [/^samsung/i, "Samsung"],
  [/^intel/i, "Intel"],
  [/^supermicro/i, "Supermicro"],
  [/^toshiba/i, "Toshiba"],
  [/^fujitsu/i, "Fujitsu"],
];

function vendorName(v: string): string {
  const t = v.trim();
  for (const [re, name] of VENDORS) if (re.test(t)) return name;
  return t.replace(/,?\s+(inc\.?|corporation|corp\.?|co\.,?\s*ltd\.?|ltd\.?|gmbh|llc|s\.a\.)$/i, "").trim();
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function modelOf(kv: Record<string, string>): string | null {
  const dt = clean(kv.dt_model);
  if (dt) return dt.replace(/\s+Rev\s+[\d.]+$/i, "");
  const vendor = clean(kv.dmi_sys_vendor);
  const name = clean(kv.dmi_product_name);
  const version = clean(kv.dmi_product_version);
  if (!JUNK.test(name)) {
    const v = JUNK.test(vendor) ? "" : vendorName(vendor);
    // Lenovo keeps the marketing name in product_version and a part number in product_name.
    if (v === "Lenovo" && version && !JUNK.test(version)) return `Lenovo ${version} (${name})`;
    const base = name.toLowerCase().startsWith(v.toLowerCase()) ? name : `${v} ${name}`.trim();
    return version && !JUNK.test(version) && /\d/.test(version) && !base.includes(version) && kv.virt && kv.virt !== "none"
      ? `${base} (${version})`
      : base;
  }
  const board = clean(kv.dmi_board_name);
  if (board && !JUNK.test(board)) {
    const bv = clean(kv.dmi_board_vendor);
    return `${JUNK.test(bv) ? "" : `${vendorName(bv)} `}${board} (custom build)`;
  }
  return null;
}

function kindOf(kv: Record<string, string>, hasBattery: boolean): NodeKind | null {
  if (/raspberry pi/i.test(kv.dt_model ?? "")) return "raspberry-pi";
  const virt = kv.virt;
  if (virt && virt !== "none" && !["docker", "podman", "lxc", "lxc-libvirt", "systemd-nspawn", "wsl"].includes(virt)) return "vps";
  const chassis = Number(kv.dmi_chassis_type);
  if ([8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32].includes(chassis)) return "laptop";
  if ([3, 4, 5, 6, 7, 13, 15, 16, 24, 35, 36].includes(chassis)) return "desktop";
  if ([17, 23, 25, 28, 29].includes(chassis)) return "server";
  if (hasBattery) return "laptop";
  if (kv.dt_model) return "other";
  return null;
}

function osOf(kv: Record<string, string>): string | null {
  const omarchy = kv.omarchy;
  if (omarchy !== undefined) {
    const v = omarchy && omarchy !== "?" ? ` ${omarchy.replace(/-\d+$/, "")}` : "";
    return `Omarchy${v} (Arch Linux)`;
  }
  const name = clean(kv.os);
  if (!name) return null;
  if (/\barch\b/.test(kv.os_like ?? "") && !/arch/i.test(name)) return `${name} (Arch-based)`;
  return name;
}

const DESKTOPS: Record<string, string> = {
  Hyprland: "Hyprland",
  plasmashell: "KDE Plasma",
  "gnome-shell": "GNOME",
  sway: "Sway",
  niri: "niri",
  "cosmic-comp": "COSMIC",
  "xfce4-session": "Xfce",
  cinnamon: "Cinnamon",
  "mate-session": "MATE",
  "lxqt-session": "LXQt",
};

function cpuModel(raw: string): string {
  return clean(
    raw
      .replace(/\((R|TM)\)/gi, "")
      .replace(/\s+@\s*[\d.]+\s*GHz/i, "")
      .replace(/\bCPU\b/g, "")
      .replace(/\s+\d+-Core Processor$/i, "")
      .replace(/\s+Processor$/i, ""),
  );
}

function gpuName(vendor: string, device: string): string {
  const v = vendorName(vendor.replace(/ Corporation$/, "")).replace(/^Advanced Micro Devices.*$/i, "AMD");
  const bracket = device.match(/\[([^\]]+)\]/)?.[1];
  const name = bracket ?? device;
  // "[AMD/ATI]" style vendor tags inside the device name
  return name.toLowerCase().startsWith(v.toLowerCase()) ? name : `${v} ${name}`;
}

/** Desktop plumbing that tells nobody anything about what a machine is for. */
const BORING_USER_UNIT = new RegExp(
  "^(" +
    [
      "dbus.*", "pipewire.*", "wireplumber", "xdg-.*", "gvfs-.*", "at-spi-.*", "dconf", "gcr-.*", "gnome-keyring.*", "gnome-.*",
      "evolution-.*", "flatpak-.*", "wayland-.*", "localsearch.*", "tracker-.*", "obex", "mpris-proxy", "filter-chain", "ssh-agent",
      "gpg-agent.*", "plasma-.*", "kde-.*", "org\\.kde\\..*", "app-.*@autostart", "omarchy-.*", "bt-agent", "systemd-.*",
      "kwalletd.*", "p11-kit-.*", "xsettingsd", "pulseaudio", "arch-update-.*", "geoclue.*", "graphical-session.*",
    ].join("|") +
    ")$",
);

function userUnit(raw: string): string | null {
  const name = raw.replace(/\.service$/, "").replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (BORING_USER_UNIT.test(name)) return null;
  if (/-[0-9a-f]{8,}$/.test(name) || /@[0-9a-f]{16,}$/.test(name)) return null; // transient, hash-named units
  return name.replace(/^app-/, "");
}

const UDP_NOISE = new Set([53, 67, 68, 123, 137, 138, 546, 547, 1900, 5353, 5355]);

function lsblkPairs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export function parseIndex(out: string): Hardware {
  const kv: Record<string, string> = {};
  const pci: string[][] = [[]];
  const nvidia: string[] = [];
  const disks: Record<string, string>[] = [];
  const mmc = new Map<string, string>();
  const nicRows: string[] = [];
  const ipRows: string[] = [];
  const routes: string[] = [];
  const batteries: string[] = [];
  const containers: Hardware["containers"] = [];
  const ports: Hardware["ports"] = [];
  const usvc: string[] = [];

  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    switch (k) {
      case "pci":
        if (v === "--") pci.push([]);
        else pci[pci.length - 1].push(v);
        break;
      case "nvidia":
        nvidia.push(v);
        break;
      case "disk":
        disks.push(lsblkPairs(v));
        break;
      case "mmc": {
        const [n, t] = v.split("|");
        mmc.set(n, t);
        break;
      }
      case "nic":
        nicRows.push(v);
        break;
      case "ip":
        ipRows.push(v);
        break;
      case "route":
        routes.push(v);
        break;
      case "battery":
        batteries.push(v);
        break;
      case "ctr": {
        const [name, image, state, ports] = v.split("\t");
        if (name) containers.push({ name, image: image ?? "", state: state ?? "", ports: ports ?? "" });
        break;
      }
      case "port": {
        const [proto, local, proc] = v.split("|");
        const idx = local.lastIndexOf(":");
        const port = Number(local.slice(idx + 1));
        const addr = local.slice(0, idx).replace(/^\[|\]$/g, "");
        if (!port) break;
        if (proto === "udp" && (UDP_NOISE.has(port) || port >= 32768 || /^(22[4-9]|23\d)\./.test(addr) || addr.startsWith("ff"))) break;
        ports.push({ proto, addr, port, process: proc ?? "" });
        break;
      }
      case "usvc": {
        const u = userUnit(v);
        if (u) usvc.push(u);
        break;
      }
      default:
        if (k.startsWith("cpu_")) kv[k] ??= v.trim();
        else kv[k] = v.trim();
    }
  }

  /* cpu */
  const threads = Number(kv["cpu_CPU(s)"]) || null;
  const tpc = Number(kv["cpu_Thread(s) per core"]) || 1;
  const mhz = Number(kv["cpu_CPU max MHz"]) || null;
  const cpu = kv["cpu_Model name"]
    ? { model: cpuModel(kv["cpu_Model name"]), cores: threads ? Math.round(threads / tpc) : null, threads, mhz: mhz ? Math.round(mhz / 100) * 100 : null }
    : null;

  /* memory: installed (lsmem) beats MemTotal, which loses what the kernel reserves */
  const online = Number(kv.mem_online) || 0;
  const memTotal = Number(kv.mem_MemTotal) || 0;
  const ram = online || (memTotal ? Math.ceil(memTotal / 2 ** 30) * 2 ** 30 : null);

  /* gpus */
  const virt = kv.virt && kv.virt !== "none" ? kv.virt : null;
  const gpus: string[] = [];
  for (const [i, line] of nvidia.entries()) {
    const [name, mem] = line.split(",").map((s) => s.trim());
    if (name) gpus.push(`${name}${Number(mem) ? ` ${Math.round(Number(mem) / 1024)} GB` : ""}`);
    void i;
  }
  if (!virt) {
    for (const block of pci) {
      const f = Object.fromEntries(block.map((l) => [l.split(":")[0], l.slice(l.indexOf(":") + 1).trim()]));
      if (!f.Device) continue;
      if (/nvidia/i.test(f.Vendor ?? "") && gpus.some((g) => /nvidia/i.test(g))) continue;
      gpus.push(gpuName(f.Vendor ?? "", f.Device));
    }
  }

  /* disks */
  const hwDisks: HwDisk[] = [];
  for (const d of disks) {
    const name = d.NAME ?? "";
    const size = Number(d.SIZE) || 0;
    if (d.TYPE !== "disk" || !size || /^(zram|loop|ram|nbd|sr|md|dm-)/.test(name)) continue;
    const tran = (d.TRAN ?? "").toLowerCase();
    let type = "";
    if (name.startsWith("nvme")) type = "NVMe";
    else if (name.startsWith("mmcblk")) type = mmc.get(name) === "MMC" ? "eMMC" : "SD card";
    else if (tran === "usb") type = "USB";
    else if (tran === "virtio" || name.startsWith("vd") || (virt && !tran)) type = "virtual disk";
    else if (virt) type = "virtual disk";
    else if (d.ROTA === "1") type = "HDD";
    else if (tran === "sata" || tran === "ata" || tran === "sas") type = "SSD";
    const vendor = /^0x/i.test(clean(d.VENDOR)) ? "" : clean(d.VENDOR);
    let model = clean(d.MODEL).replace(/\s+\d+(\.\d+)?\s*[GT]B$/i, "");
    if (/^(qemu|virtio|vbox|0x)/i.test(model)) model = "";
    if (vendor && !/^ata$/i.test(vendor) && !model.toLowerCase().startsWith(vendor.toLowerCase())) model = `${vendorName(vendor)} ${model}`.trim();
    model = model.replace(/^SAMSUNG\b/, "Samsung");
    hwDisks.push({ name, model, size, type, removable: d.RM === "1" });
  }

  /* network */
  const nics: HwNic[] = [];
  for (const row of nicRows) {
    const [name, mac, state, speed, physical, wireless, arp] = row.split("|");
    if (/^(docker|br-|veth|virbr|vnet|cni|flannel|kube|vxlan|dummy|ifb|lxc|podman)/.test(name)) continue;
    let type: HwNic["type"];
    if (name.startsWith("tailscale")) type = "tailscale";
    else if (/^(wg|tun|tap|ppp|zt)/.test(name) || /mullvad|proton|nordlynx/.test(name)) type = "vpn";
    else if (wireless === "1") type = "wifi";
    else if (physical === "1" && arp === "1") type = "ethernet";
    else continue;
    // Commercial VPN tunnels aren't ways to reach the machine.
    if (type === "vpn" && /mullvad|proton|nordlynx|ivpn/.test(name)) continue;
    const ipv4: string[] = [];
    const ipv6: string[] = [];
    for (const ip of ipRows) {
      const [iface, fam, cidr, flag] = ip.split("|");
      if (iface !== name || flag === "tmp") continue;
      const a = cidr.split("/")[0];
      if (fam === "inet") ipv4.push(a);
      else if (/^[23]/.test(a)) ipv6.push(a);
    }
    nics.push({
      name,
      type,
      mac: mac && mac !== "00:00:00:00:00:00" ? mac.toLowerCase() : null,
      ipv4,
      ipv6,
      up: state === "up" || (state === "unknown" && ipv4.length > 0),
      speed: Number(speed) > 0 ? Number(speed) : null,
      primary: false,
    });
  }
  const primary = routes.map((r) => nics.find((n) => n.name === r)).find((n) => n && (n.type === "ethernet" || n.type === "wifi")) ?? nics.find((n) => n.name === routes[0]);
  if (primary) primary.primary = true;

  /* battery */
  let battery: Hardware["battery"] = null;
  for (const b of batteries) {
    const [full, design] = b.split("|").map(Number);
    battery = { health: full && design ? Math.min(100, Math.round((full / design) * 100)) : null };
  }

  const desktop = kv.desktop ? (DESKTOPS[kv.desktop] ?? kv.desktop) : null;

  return {
    model: modelOf(kv),
    kind: kindOf(kv, batteries.length > 0),
    virt,
    os: osOf(kv),
    osId: kv.os_id || null,
    osLike: kv.os_like || null,
    desktop,
    kernel: kv.kernel || null,
    arch: kv.arch || null,
    hostname: kv.hostname || null,
    cpu,
    ram,
    swap: Number(kv.mem_SwapTotal) || null,
    gpus,
    disks: hwDisks,
    nics,
    battery,
    docker: (["ok", "sudo", "denied", "none"].includes(kv.docker) ? kv.docker : "none") as Hardware["docker"],
    containers,
    ports,
    userServices: [...new Set(usvc)].sort(),
    pkg: (kv.pkg as PkgManager) || "unknown",
  };
}

/* ---------------- running it ---------------- */

interface IndexState {
  inflight: Map<string, Promise<FleetNode | undefined>>;
  failedAt: Map<string, number>;
}
const g = globalThis as unknown as { __fleetIndex?: IndexState };
const st: IndexState = (g.__fleetIndex ??= { inflight: new Map(), failedAt: new Map() });

/** Indexes a machine now (deduplicated) and returns it as stored afterwards. */
export function indexMachine(node: FleetNode): Promise<FleetNode | undefined> {
  let p = st.inflight.get(node.id);
  if (p) return p;
  p = (async () => {
    if (node.unreachable && !agentConn(node.id)) {
      saveIndex(node.id, null, "No connection set up: add a host to reach it over ssh");
      return getNode(node.id);
    }
    let r;
    try {
      r = await runCollector(node, "index");
    } catch (err) {
      st.failedAt.set(node.id, Date.now());
      saveIndex(node.id, null, (err as Error).message);
      return getNode(node.id);
    }
    if (!r.stdout.includes("end=1")) {
      st.failedAt.set(node.id, Date.now());
      saveIndex(node.id, null, sshError(r));
      return getNode(node.id);
    }
    st.failedAt.delete(node.id);
    try {
      saveIndex(node.id, parseIndex(r.stdout), null);
    } catch (err) {
      saveIndex(node.id, null, `Couldn't read the index: ${(err as Error).message}`);
    }
    return getNode(node.id);
  })().finally(() => st.inflight.delete(node.id));
  st.inflight.set(node.id, p);
  return p;
}

export function indexing(id: string): boolean {
  return st.inflight.has(id);
}

/**
 * Called after every successful probe: indexes the machine in the background if
 * it never was, the last index is old, or the kernel or hostname changed.
 */
export function maybeIndex(node: FleetNode, m: NodeMetrics) {
  if (st.inflight.has(node.id)) return;
  const failed = st.failedAt.get(node.id);
  if (failed && Date.now() - failed < RETRY_MS) return;
  const hw = node.hardware;
  const stale =
    !hw ||
    !node.indexedAt ||
    Date.now() - node.indexedAt > INDEX_TTL ||
    (m.kernel && hw.kernel !== m.kernel) ||
    (m.hostname && hw.hostname !== m.hostname);
  if (stale) void indexMachine(node);
}
