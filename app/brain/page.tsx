import BrainConsole from "@/components/brain-console";
import PillarsManager from "@/components/pillars-manager";

export default function BrainPage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Brain</h1>
          <div className="sub">
            Your voice, vault, pillars, and strategy — everything the agent drafts from.
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
