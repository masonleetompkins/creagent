import CarouselEditor from "@/components/carousel-editor";

export default async function CarouselEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactNode> {
  const { id } = await params;
  return <CarouselEditor projectId={id} />;
}
