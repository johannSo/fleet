import type { Metadata } from "next";
import { TrafficView } from "@/components/proxy/traffic";

export const metadata: Metadata = { title: "Traffic · AI proxy" };

export default function Page() {
  return <TrafficView />;
}
