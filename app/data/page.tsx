import DataConsole from "@/components/data-console";

export default function DataPage(): React.ReactNode {
  return (
    <>
      <h1>Data</h1>
      <p className="muted">
        Platform averages and per-post metrics. Each post is scored as a
        multiplier against its platform average — 2x means twice the usual.
        Sync pulls engagement from ingested assets and Zernio.
      </p>
      <DataConsole />
    </>
  );
}
