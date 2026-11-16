import { connection } from "next/server";
import { getFleetState, markClientPoll } from "@/lib/state";

export async function GET() {
  await connection();
  markClientPoll();
  return Response.json(await getFleetState(), { headers: { "cache-control": "no-store" } });
}
