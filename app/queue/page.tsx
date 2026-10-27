import QueueConsole from "@/components/queue-console";

export default function QueuePage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <div className="sub">
            Past posts are history; future slots are the queue. Red needs work,
            orange needs your review, green is ready to post.
          </div>
        </div>
      </div>
      <QueueConsole />
    </>
  );
}
