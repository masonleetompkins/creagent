import VideoEditor from "@/components/video-editor";
import AgentSidebar from "@/components/agent-sidebar";
import ProjectSwitcher from "@/components/project-switcher";

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return (
    <>
      <ProjectSwitcher kind="video" currentId={id} />
      <VideoEditor projectId={id} />
      <AgentSidebar kind="video" entityId={id} />
    </>
  );
}
