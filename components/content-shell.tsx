"use client";

import { usePathname } from "next/navigation";

export default function ContentShell({ children }: { children: React.ReactNode }): React.ReactNode {
  const path = usePathname() ?? "/";
  const wide = path.startsWith("/carousels/") || path.startsWith("/videos/");
  return <main className={wide ? "content wide" : "content"}>{children}</main>;
}
