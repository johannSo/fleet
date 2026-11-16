import type { Metadata } from "next";
import { AccountsView } from "@/components/proxy/accounts";

export const metadata: Metadata = { title: "Accounts · AI proxy" };

export default function Page() {
  return <AccountsView />;
}
