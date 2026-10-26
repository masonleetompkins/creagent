import PillarsManager from "@/components/pillars-manager";

export default function PillarsPage(): React.ReactNode {
  return (
    <>
      <h1>Content pillars</h1>
      <p className="muted">
        Discovered by analysis, editable by you. The queue planner assigns one
        pillar to each posting slot.
      </p>
      <PillarsManager />
    </>
  );
}
