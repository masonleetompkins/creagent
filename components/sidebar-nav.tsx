"use client";

import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/chat", label: "Chat" },
  { href: "/queue", label: "Calendar" },
  { href: "/brain", label: "Brain" },
  { href: "/carousels", label: "Carousels" },
  { href: "/videos", label: "Videos" },
  { href: "/data", label: "Data" },
];

export default function SidebarNav(): React.ReactNode {
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
            {i.label}
          </a>
        ))}
      </nav>
      <nav className="foot">
        <a href="/settings" className={isOn("/settings") ? "on" : ""}>
          Settings
        </a>
      </nav>
    </aside>
  );
}
