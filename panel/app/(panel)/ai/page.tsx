import type { Metadata } from "next";
import { AiView } from "@/components/ai-chat";

export const metadata: Metadata = { title: "AI chat" };

export default function Page() {
  return <AiView />;
}
