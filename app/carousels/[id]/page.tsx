import CarouselEditor from "@/components/carousel-editor";
import AgentSidebar from "@/components/agent-sidebar";
import ProjectSwitcher from "@/components/project-switcher";

export default async function CarouselEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return (
    <>
      <ProjectSwitcher kind="carousel" currentId={id} />
      <CarouselEditor projectId={id} />
      <AgentSidebar kind="carousel" entityId={id} />
    </>
  );
}
