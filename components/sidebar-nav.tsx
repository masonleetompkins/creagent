"use client";

import { usePathname } from "next/navigation";

function Ico({ d }: { d: string[] }): React.ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

const ICONS: Record<string, string[]> = {
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  calendar: [
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M16 2v4M8 2v4M3 10h18",
  ],
  brain: ["M12 3l1.9 5.6L20 10l-6.1 1.4L12 17l-1.9-5.6L4 10l6.1-1.4z", "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"],
  carousels: ["M12 2l9 5-9 5-9-5 9-5z", "M3 12l9 5 9-5", "M3 17l9 5 9-5"],
  videos: ["M23 7l-7 5 7 5z", "M2 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"],
  data: ["M3 3v18h18", "M8 17v-6M13 17V7M18 17v-3"],
  settings: ["M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1", "M15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"],
};

const ITEMS = [
  { href: "/chat", label: "Chat", icon: "chat" },
  { href: "/queue", label: "Calendar", icon: "calendar" },
  { href: "/brain", label: "Brain", icon: "brain" },
  { href: "/carousels", label: "Carousels", icon: "carousels" },
  { href: "/videos", label: "Videos", icon: "videos" },
  { href: "/data", label: "Data", icon: "data" },
];

export default function SidebarNav({ stamp }: { stamp?: React.ReactNode }): React.ReactNode {
  const path = usePathname() ?? "/";
  const isOn = (href: string): boolean =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <aside className="sidebar">
      <a className="brand" href="/">
        Creagent
      </a>
      <nav>
        {ITEMS.map((i) => (
          <a key={i.href} href={i.href} className={isOn(i.href) ? "on" : ""}>
            <Ico d={ICONS[i.icon] ?? []} />
            {i.label}
          </a>
        ))}
      </nav>
      <nav className="foot">
        <a href="/settings" className={isOn("/settings") ? "on" : ""}>
          <Ico d={ICONS.settings ?? []} />
          Settings
        </a>
        {stamp}
      </nav>
    </aside>
  );
}
