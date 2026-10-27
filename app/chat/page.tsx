import ChatConsole from "@/components/chat-console";

export default function ChatPage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent chat</h1>
          <div className="sub">
            One conversation that works anywhere in the app. Spends and
            publishes still need your approval.
          </div>
        </div>
      </div>
      <ChatConsole />
    </>
  );
}
