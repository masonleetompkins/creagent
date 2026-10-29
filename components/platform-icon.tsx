// Monochrome platform glyphs (currentColor) for the ingest console.
export type PlatformKind =
  | "x"
  | "tiktok"
  | "instagram"
  | "youtube"
  | "facebook"
  | "threads"
  | "linkedin"
  | "unknown";

export function normalizePlatform(raw: string): PlatformKind {
  const tokens = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const has = (...names: string[]): boolean => names.some((n) => tokens.includes(n));
  if (has("x", "twitter", "tweet")) return "x";
  if (has("tiktok", "tik", "tok")) return "tiktok";
  if (has("instagram", "ig", "insta", "reel", "reels")) return "instagram";
  if (has("youtube", "yt", "youtubeshorts", "shorts")) return "youtube";
  if (has("facebook", "fb")) return "facebook";
  if (has("threads", "thread")) return "threads";
  if (has("linkedin")) return "linkedin";
  return "unknown";
}

function Glyph({ kind }: { kind: PlatformKind }): React.ReactNode {
  switch (kind) {
    case "x":
      return (
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      );
    case "instagram":
      return (
        <>
          <rect
            x="3.5"
            y="3.5"
            width="17"
            height="17"
            rx="5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="17" cy="7" r="1.4" />
        </>
      );
    case "youtube":
      return (
        <path
          fillRule="evenodd"
          d="M7.5 3h9A4.5 4.5 0 0 1 21 7.5v9a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16.5v-9A4.5 4.5 0 0 1 7.5 3zm.3 6.3v5.4l4.7-2.7z"
        />
      );
    case "tiktok":
      return (
        <>
          <ellipse cx="8.8" cy="17.2" rx="4.2" ry="3.5" />
          <rect x="11" y="3.5" width="2.9" height="13.8" rx="1" />
          <path d="M13.2 3.5c.3 3.4 2.4 5.4 5.8 5.8v3.1c-2.5-.3-4.6-1.5-5.8-3.4z" />
        </>
      );
    case "facebook":
      return (
        <path d="M14.5 8.5H17V5h-2.5c-2.5 0-4 1.7-4 4.2V11H8v3.2h2.5V21h3.2v-6.8h2.6l.5-3.2h-3.1V9.4c0-.5.3-.9.8-.9z" />
      );
    case "threads":
      return (
        <text
          x="12"
          y="17.5"
          textAnchor="middle"
          fontSize="16"
          fontWeight="700"
          fill="currentColor"
        >
          @
        </text>
      );
    case "linkedin":
      return (
        <>
          <circle cx="5" cy="5" r="2.6" />
          <rect x="2.4" y="9.2" width="5.2" height="12.3" rx="1" />
          <path d="M10.2 21.5v-6.4c0-2.5 1.8-4.3 4.3-4.3s4.2 1.8 4.2 4.3v6.4h-5v-5.5c0-1-.7-1.7-1.7-1.7s-1.7.7-1.7 1.7v5.5z" />
        </>
      );
    case "unknown":
      return null;
  }
}

export default function PlatformIcon({
  platform,
  size = 14,
}: {
  platform: string;
  size?: number;
}): React.ReactNode {
  const kind = normalizePlatform(platform);
  if (kind === "unknown") {
    const letter = (platform.trim()[0] ?? "?").toUpperCase();
    return (
      <span className="pf-icon pf-letter" style={{ width: size, height: size, fontSize: size * 0.75 }} aria-hidden="true">
        {letter}
      </span>
    );
  }
  return (
    <svg
      className="pf-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <Glyph kind={kind} />
    </svg>
  );
}
