import BrainConsole from "@/components/brain-console";
import PillarsManager from "@/components/pillars-manager";

export default function BrainPage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Brain</h1>
          <div className="sub">
            Everything the agent knows: your voice, the context vault, posting
            strategy, and the platform playbook it drafts from.
          </div>
        </div>
      </div>
      <BrainConsole />
      <h2>Content pillars</h2>
      <p className="muted">
        Discovered by analysis, editable by you. The queue planner assigns one
        pillar to each posting slot.
      </p>
      <PillarsManager />
    </>
  );
}
