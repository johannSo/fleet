/**
 * The Network page's model: the subnets the machines sit on, worked out from
 * what the indexer found on their interfaces (lib/indexer.ts). Nothing here is
 * typed in except a subnet's optional name. No Node imports, so pages use it.
 */
import { isPrivateV4 } from "./hardware";
import type { FleetNode, HwNic } from "./types";

/** Tailscale hands out /32s from this range; they all count as one network. */
export const TAILSCALE_CIDR = "100.64.0.0/10";

export interface NetMember {
  /** Machine id. */
  id: string;
  addr: string;
  iface: string;
  nic: HwNic["type"];
  /** Link speed in Mbit/s. */
  speed: number | null;
  /** Hypervisor or container runtime when the machine is a guest. */
  virt: string | null;
}

export type SubnetKind = "lan" | "public" | "overlay";

export interface Subnet {
  cidr: string;
  kind: SubnetKind;
  /** "Tailscale", or the name given in the panel. */
  name: string | null;
  /** Next hop the members route through, when they agree on one inside this subnet. */
  gateway: string | null;
  /** Groups subnets behind the same router (its MAC, else its address). */
  router: string | null;
  members: NetMember[];
}

export interface Router {
  key: string;
  /** Its address on each subnet behind it. */
  ips: string[];
  /** A machine in the inventory that holds one of those addresses. */
  machine: string | null;
}

export interface NetworkMap {
  subnets: Subnet[];
  routers: Router[];
  /** Machines with no IPv4 address on record (never indexed, or nothing found). */
  unplaced: string[];
}

function toInt(ip: string): number | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function toIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** "192.168.1.20/24" → "192.168.1.0/24"; null when it isn't an IPv4 CIDR. */
export function networkOf(cidr: string): string | null {
  const [ip, bits] = cidr.split("/");
  const n = toInt(ip);
  const b = Number(bits);
  if (n == null || !Number.isInteger(b) || b < 0 || b > 32) return null;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return `${toIp((n & mask) >>> 0)}/${b}`;
}

export function inSubnet(ip: string, cidr: string): boolean {
  const [net, bits] = cidr.split("/");
  const a = toInt(ip);
  const n = toInt(net);
  const b = Number(bits);
  if (a == null || n == null) return false;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return ((a & mask) >>> 0) === n;
}

/** Sort key for addresses: numeric, so .9 comes before .10. */
export function ipOrder(ip: string): number {
  return toInt(ip.split("/")[0]) ?? Number.MAX_SAFE_INTEGER;
}

/** "10G", "2.5G", "1G", "100M". */
export function speedLabel(mbit: number | null): string | null {
  if (!mbit) return null;
  if (mbit >= 1000) return `${Math.round(mbit / 100) / 10}G`.replace(".0G", "G");
  return `${mbit}M`;
}

/** What to show for a member's link: its speed, Wi-Fi, or that it's a guest's virtual NIC. */
export function linkLabel(m: NetMember): string | null {
  if (m.nic === "wifi") return "Wi-Fi";
  return speedLabel(m.speed) ?? (m.virt ? "virtual" : null);
}

const CONTAINERS = new Set(["docker", "podman", "lxc", "lxc-libvirt", "systemd-nspawn", "openvz", "wsl"]);

/** "VM" or "CT" for guests, null on bare metal. */
export function guestLabel(virt: string | null): string | null {
  if (!virt) return null;
  return CONTAINERS.has(virt) ? "CT" : "VM";
}

export function buildNetworkMap(nodes: FleetNode[], names: Record<string, string> = {}): NetworkMap {
  const byCidr = new Map<string, Subnet>();
  const unplaced: string[] = [];
  /** Per subnet: the gateways its members route through (ip → mac). */
  const gws = new Map<string, Map<string, string | null>>();

  for (const n of nodes) {
    const hw = n.hardware;
    let placed = false;
    for (const nic of hw?.nics ?? []) {
      // Indexed before prefixes were kept: the page shows it once it's re-indexed.
      const cidrs = nic.cidrs ?? [];
      for (const c of cidrs) {
        const addr = c.split("/")[0];
        let cidr: string | null;
        let kind: SubnetKind;
        if (nic.type === "tailscale") {
          cidr = TAILSCALE_CIDR;
          kind = "overlay";
        } else {
          cidr = networkOf(c);
          // A single-address tunnel isn't a network anything else shares.
          if (!cidr || cidr.endsWith("/32") || cidr.endsWith("/31")) continue;
          kind = nic.type === "vpn" ? "overlay" : isPrivateV4(addr) ? "lan" : "public";
        }
        let s = byCidr.get(cidr);
        if (!s) {
          s = { cidr, kind, name: names[cidr] || (cidr === TAILSCALE_CIDR ? "Tailscale" : null), gateway: null, router: null, members: [] };
          byCidr.set(cidr, s);
        }
        if (!s.members.some((m) => m.id === n.id && m.addr === addr)) {
          s.members.push({ id: n.id, addr, iface: nic.name, nic: nic.type, speed: nic.speed, virt: hw?.virt ?? null });
        }
        placed = true;
        const gw = hw?.gateway;
        if (gw && gw.iface === nic.name && kind === "lan" && inSubnet(gw.ip, cidr)) {
          const seen = gws.get(cidr) ?? new Map<string, string | null>();
          if (!seen.has(gw.ip) || (gw.mac && !seen.get(gw.ip))) seen.set(gw.ip, gw.mac);
          gws.set(cidr, seen);
        }
      }
    }
    if (!placed) unplaced.push(n.id);
  }

  // Each LAN subnet's gateway; subnets whose gateways share a MAC sit behind one router.
  const routers = new Map<string, Router>();
  for (const s of byCidr.values()) {
    const seen = gws.get(s.cidr);
    if (!seen?.size) continue;
    const [ip, mac] = [...seen.entries()].sort((a, b) => Number(!!b[1]) - Number(!!a[1]))[0];
    s.gateway = ip;
    s.router = mac ?? `ip:${ip}`;
    const r = routers.get(s.router) ?? { key: s.router, ips: [], machine: null };
    if (!r.ips.includes(ip)) r.ips.push(ip);
    routers.set(s.router, r);
  }
  for (const r of routers.values()) {
    r.ips.sort((a, b) => ipOrder(a) - ipOrder(b));
    r.machine = nodes.find((n) => n.hardware?.nics.some((nic) => nic.ipv4.some((a) => r.ips.includes(a))))?.id ?? null;
  }

  const order: Record<SubnetKind, number> = { lan: 0, public: 1, overlay: 2 };
  const subnets = [...byCidr.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || b.members.length - a.members.length || ipOrder(a.cidr) - ipOrder(b.cidr),
  );
  for (const s of subnets) s.members.sort((a, b) => ipOrder(a.addr) - ipOrder(b.addr));

  return { subnets, routers: [...routers.values()], unplaced };
}
