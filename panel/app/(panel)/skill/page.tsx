import type { Metadata } from "next";
import { SkillView } from "@/components/skill-view";

export const metadata: Metadata = { title: "Claude skill" };

export default function Page() {
  return <SkillView />;
}
