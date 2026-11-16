import { AppShell } from "@/components/shell";

export default function PanelLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
