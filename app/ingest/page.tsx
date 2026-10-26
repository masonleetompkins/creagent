import IngestConsole from "@/components/ingest-console";

export default function IngestPage(): React.ReactNode {
  return (
    <>
      <h1>Ingest</h1>
      <p className="muted">
        Pull your existing content in through Monid, then run analysis to build
        the voice profile, vault, and pillars. Each ingest costs a fraction of
        a cent.
      </p>
      <IngestConsole />
    </>
  );
}
