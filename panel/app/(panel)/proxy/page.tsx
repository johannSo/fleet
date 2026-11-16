import type { Metadata } from "next";
import { ProxyOverview } from "@/components/proxy/overview";

export const metadata: Metadata = { title: "Overview · AI proxy" };

export default function Page() {
  return <ProxyOverview />;
}
