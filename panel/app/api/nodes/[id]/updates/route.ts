import { connection } from "next/server";
import { getNode } from "@/lib/fleet";
import { getUpdates } from "@/lib/state";

export async function GET(req: Request, ctx: RouteContext<"/api/nodes/[id]/updates">) {
  await connection();
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({ error: "Unknown node" }, { status: 404 });
  const force = new URL(req.url).searchParams.get("force") === "1";
  return Response.json(await getUpdates(node, force), { headers: { "cache-control": "no-store" } });
}
