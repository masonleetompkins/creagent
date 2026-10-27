import VideoEditor from "@/components/video-editor";
import ProjectSwitcher from "@/components/project-switcher";

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return (
    <div className="editor-main">
      <ProjectSwitcher kind="video" currentId={id} />
      <VideoEditor projectId={id} />
    </div>
  );
}
