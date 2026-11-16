import { connection } from "next/server";
import { getNode } from "@/lib/fleet";
import { getState } from "@/lib/state";

/** Re-checks one machine right now (the "Retry" button on offline machines). */
export async function GET(_req: Request, ctx: RouteContext<"/api/nodes/[id]/probe">) {
  await connection();
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "Unknown node" }, { status: 404 });
  return Response.json(await getState(node, true), { headers: { "cache-control": "no-store" } });
}
