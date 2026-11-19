import type { Metadata } from "next";
import { NetworkView } from "@/components/network";

export const metadata: Metadata = { title: "Network" };

export default function Page() {
  return <NetworkView />;
}
