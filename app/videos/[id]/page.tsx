import VideoEditor from "@/components/video-editor";

export default async function VideoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return <VideoEditor projectId={id} />;
}
