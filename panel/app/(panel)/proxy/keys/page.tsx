import type { Metadata } from "next";
import { KeysView } from "@/components/proxy/keys";

export const metadata: Metadata = { title: "API keys · AI proxy" };

export default function Page() {
  return <KeysView />;
}
