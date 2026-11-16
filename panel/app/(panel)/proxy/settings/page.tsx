import type { Metadata } from "next";
import { SettingsView } from "@/components/proxy/settings";

export const metadata: Metadata = { title: "Settings · AI proxy" };

export default function Page() {
  return <SettingsView />;
}
