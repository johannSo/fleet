import type { Metadata } from "next";
import { LogsView } from "@/components/proxy/logs";

export const metadata: Metadata = { title: "Logs · AI proxy" };

export default function Page() {
  return <LogsView />;
}
