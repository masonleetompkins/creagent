import VideoEditor from "@/components/video-editor";
import AgentSidebar from "@/components/agent-sidebar";

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return (
    <>
      <VideoEditor projectId={id} />
      <AgentSidebar kind="video" entityId={id} />
    </>
  );
}
