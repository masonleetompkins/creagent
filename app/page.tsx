import InfraStatus from "@/components/infra-status";

export default function Home(): React.ReactNode {
  return (
    <>
      <h1>Creagent</h1>
      <p className="muted">
        Local-first content agent. Ingest your work, learn your voice, keep a
        two-week queue drafted, and get approvals in one place.
      </p>
      <h2>Get started</h2>
      <ol className="steps">
        <li>
          Open <a href="/settings">Settings</a> and save your Meta Model API
          key.
        </li>
        <li>Use Test on the Meta key to confirm the connection.</li>
        <li>Add Monid, Zernio, and Brave keys as integrations land.</li>
      </ol>
      <h2>System status</h2>
      <InfraStatus />
      <h2>Workflow</h2>
      <p>
        <a href="/settings">Ingest</a> your content, run analysis to build the
        voice profile and vault, refine <a href="/brain">pillars</a>, then
        set your cadence and plan the <a href="/queue">calendar</a>.
      </p>
    </>
  );
}
