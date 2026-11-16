import type { Metadata } from "next";
import { UsageView } from "@/components/proxy/usage";

export const metadata: Metadata = { title: "Usage · AI proxy" };

export default function Page() {
  return <UsageView />;
}
