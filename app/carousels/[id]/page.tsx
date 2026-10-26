import CarouselEditor from "@/components/carousel-editor";
import AgentSidebar from "@/components/agent-sidebar";

export default async function CarouselEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return (
    <>
      <CarouselEditor projectId={id} />
      <AgentSidebar kind="carousel" entityId={id} />
    </>
  );
}
