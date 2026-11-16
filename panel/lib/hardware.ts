/**
 * Pure helpers that turn indexed hardware into what people read: spec lines,
 * addresses with labels, sizes. No Node imports, so pages can use it too.
 */
import type { AddressEntry, FleetAddress, FleetSpec, Hardware, HwNic } from "./types";

/** Vendor-style size: "512 GB", "1 TB"; exact GiB multiples (virtual disks, RAM) stay round. */
export function vendorSize(n: number): string {
  const gib = n / 2 ** 30;
  if (Number.isInteger(gib)) return gib >= 1024 && Number.isInteger(gib / 1024) ? `${gib / 1024} TB` : `${gib} GB`;
  if (n >= 1e12) {
    const tb = n / 1e12;
    return `${tb >= 10 ? Math.round(tb) : Math.round(tb * 10) / 10} TB`;
  }
  return `${Math.round(n / 1e9)} GB`;
}

/** Installed memory as sold: what the kernel or firmware keeps back is rounded away. */
export function ramSize(n: number): string {
  return `${Math.max(1, Math.ceil(n / 2 ** 30 - 0.05))} GB`;
}

export function cpuLine(cpu: NonNullable<Hardware["cpu"]>): string {
  const bits: string[] = [];
  if (cpu.cores && cpu.threads && cpu.threads !== cpu.cores) bits.push(`${cpu.cores}C/${cpu.threads}T`);
  else if (cpu.cores) bits.push(`${cpu.cores} core${cpu.cores === 1 ? "" : "s"}`);
  if (cpu.mhz) bits.push(`${(cpu.mhz / 1000).toFixed(cpu.mhz % 1000 === 0 ? 0 : 1)} GHz`);
  return bits.length ? `${cpu.model} (${bits.join(", ")})` : cpu.model;
}

export function diskLine(d: Hardware["disks"][number]): string {
  const type = d.type && !d.model.toLowerCase().includes(d.type.toLowerCase()) ? d.type : "";
  return [vendorSize(d.size), d.model, type].filter(Boolean).join(" ");
}

/** The hardware panel's rows, in display order. */
export function hardwareSpecs(hw: Hardware): FleetSpec[] {
  const specs: FleetSpec[] = [];
  const add = (label: string, values: (string | null | undefined)[]) => {
    const v = values.filter((x): x is string => !!x);
    if (v.length) specs.push({ label, values: v });
  };
  add("Model", [hw.model]);
  add("CPU", [hw.cpu ? cpuLine(hw.cpu) : null]);
  add("RAM", [hw.ram ? ramSize(hw.ram) : null]);
  add("GPU", hw.gpus);
  add("Storage", hw.disks.map(diskLine));
  add("Battery", [hw.battery?.health != null ? `${hw.battery.health}% of design capacity` : null]);
  add("OS", [hw.os ? `${hw.os}${hw.desktop ? `, ${hw.desktop}` : ""}` : null]);
  add("Kernel", [hw.kernel ? `${hw.kernel}${hw.arch ? ` · ${hw.arch}` : ""}` : null]);
  return specs;
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/;
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

export function isPrivateV4(a: string): boolean {
  return PRIVATE_V4.test(a) || CGNAT.test(a);
}

function nicLabel(nic: HwNic, addr: string, v6: boolean): string {
  if (nic.type === "tailscale") return "Tailscale";
  if (nic.type === "vpn") return `VPN (${nic.name})`;
  if (v6) return "Public IPv6";
  if (!isPrivateV4(addr)) return "Public";
  return nic.type === "wifi" ? "WLAN" : "LAN";
}

/** Addresses found on the machine's interfaces, primary interface first. */
export function detectedAddresses(hw: Hardware | null): FleetAddress[] {
  if (!hw) return [];
  const out: FleetAddress[] = [];
  const nics = [...hw.nics].sort((a, b) => Number(b.primary) - Number(a.primary));
  for (const nic of nics) {
    for (const a of nic.ipv4) out.push({ label: nicLabel(nic, a, false), value: a, notes: "", iface: nic.name, detected: true, manual: false });
    // Only public servers' IPv6 addresses are worth listing; home LANs hand out short-lived ones.
    const publicV4 = nic.ipv4.some((a) => !isPrivateV4(a));
    if ((nic.type === "ethernet" || nic.type === "wifi") && (publicV4 || nic.ipv4.length === 0)) {
      for (const a of nic.ipv6) out.push({ label: nicLabel(nic, a, true), value: a, notes: "", iface: nic.name, detected: true, manual: false });
    }
  }
  return out;
}

/** Detected addresses merged with the ones entered by hand (which win on label and notes). */
export function mergeAddresses(hw: Hardware | null, manual: AddressEntry[]): FleetAddress[] {
  const out = detectedAddresses(hw);
  for (const m of manual) {
    const hit = out.find((a) => a.value.toLowerCase() === m.address.toLowerCase());
    if (hit) {
      hit.label = m.label || hit.label;
      hit.notes = m.notes;
      hit.manual = true;
    } else {
      out.push({ label: m.label || "Address", value: m.address, notes: m.notes, detected: false, manual: true });
    }
  }
  return out;
}

/** MAC to use for Wake-on-LAN: the first wired interface's. */
export function wolMac(hw: Hardware | null): string | null {
  if (!hw || hw.virt) return null;
  const wired = hw.nics.filter((n) => n.type === "ethernet" && n.mac);
  return (wired.find((n) => n.primary) ?? wired[0])?.mac ?? null;
}

/** Listening ports worth showing: no ephemeral loopback listeners or resolver noise. */
export function notablePorts(hw: Hardware): { port: number; proto: string; process: string; local: boolean }[] {
  const seen = new Map<string, { port: number; proto: string; process: string; local: boolean }>();
  for (const p of hw.ports) {
    const local = /^(127\.|::1|localhost)/.test(p.addr);
    if (p.port === 53 && (local || /^172\.17\./.test(p.addr))) continue;
    if (local && p.port >= 32768) continue;
    if (p.addr.includes("%tailscale") && p.port >= 32768) continue;
    const key = `${p.proto}:${p.port}`;
    const prev = seen.get(key);
    if (prev) {
      prev.local &&= local;
      if (!prev.process) prev.process = p.process;
    } else seen.set(key, { port: p.port, proto: p.proto, process: p.process, local });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}
