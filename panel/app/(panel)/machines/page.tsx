import type { Metadata } from "next";
import { MachinesView } from "@/components/shell";

export const metadata: Metadata = { title: "Machines" };

export default function Page() {
  return <MachinesView />;
}
