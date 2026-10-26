import CarouselList from "@/components/carousel-list";

export default function CarouselsPage(): React.ReactNode {
  return (
    <>
      <h1>Carousels</h1>
      <p className="muted">
        Brand kit, model-written copy, ingested photos or Muse Image graphics —
        exported as 1080×1350 PNGs.
      </p>
      <CarouselList />
    </>
  );
}
