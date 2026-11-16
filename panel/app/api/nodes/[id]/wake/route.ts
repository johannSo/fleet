import dgram from "node:dgram";
import { getNode } from "@/lib/fleet";

/** Sends a Wake-on-LAN magic packet to the machine's MAC (set by hand or detected by the indexer). */
export async function POST(_req: Request, ctx: RouteContext<"/api/nodes/[id]/wake">) {
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "Unknown node" }, { status: 404 });
  if (!node.mac) return Response.json({ error: "No MAC address known for this machine: it's detected from a wired interface when indexed, or set it in Edit machine" }, { status: 400 });

  const mac = Buffer.from(node.mac.split(/[:-]/).map((h) => parseInt(h, 16)));
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
  // Directed broadcast for each listed LAN address, plus the limited broadcast.
  const targets = new Set(["255.255.255.255"]);
  for (const ip of node.ips) {
    if (/^(10|172|192)\./.test(ip.value)) targets.add(ip.value.replace(/\.\d+$/, ".255"));
  }
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(() => r()));
  sock.setBroadcast(true);
  await Promise.all(
    [...targets].map((t) => new Promise<void>((r) => sock.send(packet, 9, t, () => r()))),
  );
  sock.close();
  return Response.json({ ok: true, targets: [...targets] });
}
