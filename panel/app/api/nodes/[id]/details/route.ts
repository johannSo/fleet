import { connection } from "next/server";
import { getNode } from "@/lib/fleet";
import { getDetails } from "@/lib/state";

export async function GET(_req: Request, ctx: RouteContext<"/api/nodes/[id]/details">) {
  await connection();
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "Unknown node" }, { status: 404 });
  return Response.json(await getDetails(node), { headers: { "cache-control": "no-store" } });
}
