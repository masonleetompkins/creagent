import HomeConsole from "@/components/home-console";

export default function Home(): React.ReactNode {
  const today = new Date().toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <div className="sub">{today} — what is due, what needs your review, and what the agent did.</div>
        </div>
        <div className="actions">
          <a href="/queue">
            <button>Calendar</button>
          </a>
          <a href="/chat">
            <button className="primary">Agent chat</button>
          </a>
        </div>
      </div>
      <HomeConsole />
    </>
  );
}
