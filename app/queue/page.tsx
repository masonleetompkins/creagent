import QueueConsole from "@/components/queue-console";

export default function QueuePage(): React.ReactNode {
  return (
    <>
      <h1>Calendar</h1>
      <p className="muted">
        The past shows what you have posted; the future shows the queue. Red
        needs work, orange is ready for your review, green is ready to post,
        gray is posted. The planner keeps 14 days materialized and rolls
        overdue slots forward.
      </p>
      <QueueConsole />
    </>
  );
}
