import VideoEditor from "@/components/video-editor";
import ProjectSwitcher from "@/components/project-switcher";

export default async function VideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  const { job } = await searchParams;
  return (
    <div className="editor-main">
      <ProjectSwitcher kind="video" currentId={id} />
      <VideoEditor projectId={id} buildJobId={typeof job === "string" ? job : undefined} />
    </div>
  );
}
