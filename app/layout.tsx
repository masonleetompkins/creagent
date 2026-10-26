import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Creagent",
  description: "Local-first creator agent, powered by Meta models.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              Creagent
            </a>
            <nav>
              <a href="/ingest">Ingest</a>
              <a href="/chat">Chat</a>
              <a href="/brain">Brain</a>
              <a href="/pillars">Pillars</a>
              <a href="/queue">Queue</a>
              <a href="/carousels">Carousels</a>
              <a href="/videos">Videos</a>
              <a href="/data">Data</a>
              <a href="/settings">Settings</a>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
