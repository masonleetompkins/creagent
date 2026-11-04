import CarouselEditor from "@/components/carousel-editor";
import ProjectSwitcher from "@/components/project-switcher";

export default async function CarouselEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ build?: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  const { build } = await searchParams;
  return (
    <div className="editor-main">
      <ProjectSwitcher kind="carousel" currentId={id} />
      <CarouselEditor projectId={id} buildJobId={typeof build === "string" ? build : undefined} />
    </div>
  );
}
