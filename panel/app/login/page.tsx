import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginView } from "@/components/login";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginView />
    </Suspense>
  );
}
