import ChatConsole from "@/components/chat-console";

export default function ChatPage(): React.ReactNode {
  return (
    <>
      <h1>Agent chat</h1>
      <p className="muted">
        The in-built agent works anywhere in the app: queue, drafts, carousels,
        timelines, captions, audio, keying, exports. Spends and publishes still
        need your approval.
      </p>
      <ChatConsole />
    </>
  );
}
