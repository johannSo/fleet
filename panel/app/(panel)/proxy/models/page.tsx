import type { Metadata } from "next";
import { ModelsView } from "@/components/proxy/models";

export const metadata: Metadata = { title: "Models · AI proxy" };

export default function Page() {
  return <ModelsView />;
}
