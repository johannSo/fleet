import type { Metadata } from "next";
import { ProxyShell } from "@/components/proxy/shell";

export const metadata: Metadata = { title: "AI proxy" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ProxyShell>{children}</ProxyShell>;
}
