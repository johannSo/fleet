import type { DiskInfo, NodeMetrics, PkgManager } from "./types";

/* The probe script itself is agent/collectors/probe.sh (lib/collectors.ts). */

export interface RawSample {
  cpuTotal: number;
  cpuIdle: number;
  rx: number;
  tx: number;
  at: number;
}

/** Parses one probe; `at` is when it ran (an agent's report can arrive later than that). */
export function parseProbe(
  out: string,
  prev: RawSample | undefined,
  at = Date.now(),
): { metrics: NodeMetrics; sample: RawSample } {
  const kv: Record<string, string> = {};
  const disks: DiskInfo[] = [];
  const seenDev = new Set<string>();
  const addrs: { iface: string; addr: string }[] = [];
  const failed: string[] = [];
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    if (k === "disk") {
      const [dev, fstype, size, used, mount] = v.split("|");
      // btrfs subvolumes mount the same device many times; keep the first.
      if (seenDev.has(dev) || !mount || fstype?.startsWith("fuse") || mount.startsWith("/snap") || mount.startsWith("/run")) continue;
      seenDev.add(dev);
      disks.push({ mount, fstype, size: Number(size), used: Number(used) });
    } else if (k === "addr") {
      const [iface, addr] = v.split(" ");
      if (!/^(docker|br-|veth|virbr|lo)/.test(iface)) addrs.push({ iface, addr: addr?.split("/")[0] ?? "" });
    } else if (k === "failed") {
      if (v) failed.push(v);
    } else {
      kv[k] = v;
    }
  }

  const stat = (kv.cpustat ?? "").trim().split(/\s+/).slice(1).map(Number);
  const cpuIdle = (stat[3] ?? 0) + (stat[4] ?? 0);
  const cpuTotal = stat.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  const [rxRaw, txRaw] = (kv.net ?? "0 0").split(" ").map(Number);
  const now = at;
  const sample: RawSample = { cpuTotal, cpuIdle, rx: rxRaw, tx: txRaw, at: now };

  let cpu: number | null = null;
  let rx: number | null = null;
  let tx: number | null = null;
  if (prev) {
    const dt = cpuTotal - prev.cpuTotal;
    const di = cpuIdle - prev.cpuIdle;
    if (dt > 0) cpu = Math.min(100, Math.max(0, (1 - di / dt) * 100));
    const secs = (now - prev.at) / 1000;
    if (secs > 0 && rxRaw >= prev.rx && txRaw >= prev.tx) {
      rx = (rxRaw - prev.rx) / secs;
      tx = (txRaw - prev.tx) / secs;
    }
  }

  const memTotal = Number(kv.mem_MemTotal ?? 0);
  const swapTotal = Number(kv.mem_SwapTotal ?? 0);
  const temp = Number(kv.temp ?? 0);
  const load = (kv.load ?? "0 0 0").split(" ").map(Number) as [number, number, number];

  const metrics: NodeMetrics = {
    hostname: kv.hostname ?? "",
    kernel: kv.kernel ?? "",
    osName: kv.os || "Linux",
    arch: kv.arch ?? "",
    uptime: Number(kv.uptime ?? 0),
    load,
    cpus: Number(kv.cpus ?? 1),
    cpuModel: kv.cpumodel ?? "",
    cpu,
    memTotal,
    memUsed: memTotal - Number(kv.mem_MemAvailable ?? 0),
    swapTotal,
    swapUsed: swapTotal - Number(kv.mem_SwapFree ?? 0),
    disks,
    tempC: temp > 0 ? temp / 1000 : null,
    rx,
    tx,
    addrs,
    failedUnits: failed,
    rebootRequired: kv.reboot === "1",
    pkg: (kv.pkg as PkgManager) ?? "unknown",
    procs: Number(kv.procs ?? 0),
    users: Number(kv.users ?? 0),
  };
  return { metrics, sample };
}
