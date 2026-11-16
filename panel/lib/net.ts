import os from "node:os";
import path from "node:path";

/** Where the panel keeps its own state (sessions, certificates, last-seen). */
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "fleet-panel");

export function hostName(): string {
  return os.hostname().toLowerCase();
}

/** Non-internal addresses of this machine, IPv4 first. */
export function localAddresses(): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv4") v4.push(a.address);
      else if (!a.address.startsWith("fe80")) v6.push(a.address);
    }
  }
  return [...v4, ...v6];
}

/** LAN addresses worth showing to a phone: private IPv4 only. */
export function lanAddresses(): string[] {
  return localAddresses().filter((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

/** Hostnames (no port) a browser may legitimately use to reach this panel. */
export function knownHostnames(extra: string[] = []): Set<string> {
  const h = hostName();
  return new Set(
    ["localhost", "127.0.0.1", "[::1]", h, `${h}.local`, ...localAddresses().map((a) => (a.includes(":") ? `[${a}]` : a)), ...extra].map(
      (x) => x.toLowerCase(),
    ),
  );
}
