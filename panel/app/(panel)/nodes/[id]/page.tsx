import { Suspense } from "react";
import { NodeView } from "@/components/node-view";

async function Node({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NodeView id={decodeURIComponent(id)} />;
}

export default function Page({ params }: PageProps<"/nodes/[id]">) {
  return (
    <Suspense fallback={null}>
      <Node params={params} />
    </Suspense>
  );
}
