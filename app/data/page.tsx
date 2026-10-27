import DataConsole from "@/components/data-console";

export default function DataPage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data</h1>
          <div className="sub">
            Platform averages and per-post metrics. Each post is scored as a
            multiplier against its platform average — 2x means twice the usual.
            Sync pulls engagement from ingested assets and Zernio.
          </div>
        </div>
      </div>
      <DataConsole />
    </>
  );
}
