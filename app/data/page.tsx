import DataConsole from "@/components/data-console";

export default function DataPage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data</h1>
          <div className="sub">
            What performed, scored as a multiplier against your average.
          </div>
        </div>
      </div>
      <DataConsole />
    </>
  );
}
