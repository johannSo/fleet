import { connection } from "next/server";
import { loadFleet } from "@/lib/fleet";
import { getUpdates } from "@/lib/state";

export async function GET() {
  await connection();
  const nodes = loadFleet();
  const entries = await Promise.all(nodes.map(async (n) => [n.id, await getUpdates(n)] as const));
  return Response.json(Object.fromEntries(entries), { headers: { "cache-control": "no-store" } });
}
