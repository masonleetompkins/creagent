import BrainConsole from "@/components/brain-console";

export default function BrainPage(): React.ReactNode {
  return (
    <>
      <h1>Brain</h1>
      <p className="muted">
        Everything the agent knows: your voice, the context vault, posting
        strategy, and the platform playbook it drafts from.
      </p>
      <BrainConsole />
    </>
  );
}
