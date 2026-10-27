import type { Metadata } from "next";
import "./globals.css";
import SidebarNav from "@/components/sidebar-nav";
import ContentShell from "@/components/content-shell";

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=JSON.parse(localStorage.getItem("creagent.theme")||"{}");var h=typeof t.hue==="number"?Math.max(0,Math.min(360,Math.round(t.hue))):217;document.documentElement.style.setProperty("--hue",h);document.documentElement.dataset.mode=t.mode==="light"?"light":"dark";}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <div className="shell">
          <SidebarNav />
          <ContentShell>{children}</ContentShell>
        </div>
      </body>
    </html>
  );
}
