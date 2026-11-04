// Client-side carousel renderer: 1080x1350 canvas, zero dependencies.
import { ensureFont, type FontDef } from "./fonts";

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;

export type RenderRegion = { x: number; y: number; w: number; h: number };

export type RenderSlide = {
  layout: string;
  heading: string;
  body: string;
  image: HTMLImageElement | null;
  // Per-slide background override: null/"" follows the kit, "gradient"
  // blends primary to secondary, otherwise a #rrggbb flat fill.
  background?: string | null;
  // Forbidden-text regions (photo fractions 0-1); kept in sync with
  // lib/photo-regions.ts clearBand.
  regions?: RenderRegion[];
};

// Highest bottom-up band of fractional height bandH whose vertical span
// overlaps no region. Mirrors server-side clearBand.
export function bandTopClearOf(regions: RenderRegion[], bandH: number): number {
  const h = Math.min(Math.max(bandH, 0.1), 0.9);
  for (let top = 1 - h; top >= -1e-9; top -= 0.05) {
    const t = Math.max(0, Math.round(top * 1000) / 1000);
    if (!regions.some((r) => t < r.y + r.h && t + h > r.y)) return t;
  }
  return 1 - h;
}

export type RenderKit = {
  primary: string;
  secondary: string;
  background: string;
  headingFont: FontDef;
  bodyFont: FontDef;
};

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Readable ink for a slide background: white on dark fills, the kit's
// secondary on light ones. Gradients judge by their primary/secondary mix.
export function inkForBackground(
  background: string | null | undefined,
  kit: Pick<RenderKit, "primary" | "secondary" | "background">,
): string {
  if (background === "gradient") {
    const a = hexRgb(kit.primary);
    const b = hexRgb(kit.secondary);
    if (a && b) {
      const mix: [number, number, number] = [
        Math.round((a[0] + b[0]) / 2),
        Math.round((a[1] + b[1]) / 2),
        Math.round((a[2] + b[2]) / 2),
      ];
      return luminance(mix) > 0.35 ? kit.secondary : "#ffffff";
    }
    return "#ffffff";
  }
  const flat = background?.trim() ? background!.trim() : kit.background;
  const rgb = hexRgb(flat);
  if (!rgb) return kit.secondary;
  return luminance(rgb) > 0.35 ? kit.secondary : "#ffffff";
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) return lines;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  align: CanvasTextAlign,
): number {
  ctx.textAlign = align;
  let cy = y;
  for (const line of lines) {
    ctx.fillText(line, x, cy);
    cy += lineHeight;
  }
  return cy;
}

function coverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

export async function renderSlide(
  canvas: HTMLCanvasElement,
  slide: RenderSlide,
  kit: RenderKit,
): Promise<void> {
  await Promise.all([ensureFont(kit.headingFont), ensureFont(kit.bodyFont)]).catch(() => {});
  canvas.width = SLIDE_W;
  canvas.height = SLIDE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = SLIDE_W;
  const M = 90; // margin

  if (slide.background === "gradient") {
    const grad = ctx.createLinearGradient(0, 0, 0, SLIDE_H);
    grad.addColorStop(0, kit.primary);
    grad.addColorStop(1, kit.secondary);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, SLIDE_H);
  } else {
    ctx.fillStyle = slide.background?.trim() ? slide.background.trim() : kit.background;
    ctx.fillRect(0, 0, W, SLIDE_H);
  }
  const ink = inkForBackground(slide.background, kit);

  const heading = (slide.heading || "").trim();
  const body = (slide.body || "").trim();

  if (slide.layout === "photo" && slide.image) {
    coverImage(ctx, slide.image, 0, 0, W, SLIDE_H);
    ctx.font = `${kit.headingFont.weight} 88px ${kit.headingFont.stack}`;
    const hLines = wrap(ctx, heading || " ", W - M * 2, 4);
    ctx.font = `400 42px ${kit.bodyFont.stack}`;
    const bLines = wrap(ctx, body, W - M * 2, 6);
    const blockH = hLines.length * 104 + bLines.length * 54 + 24;
    const bandTop = bandTopClearOf(slide.regions ?? [], (blockH + M * 2) / SLIDE_H);
    const bandTopPx = bandTop * SLIDE_H;
    const bandBottomPx = Math.min(SLIDE_H, bandTopPx + blockH + M * 2);
    const scrim = ctx.createLinearGradient(0, Math.max(0, bandTopPx - 220), 0, bandBottomPx);
    scrim.addColorStop(0, "rgba(0,0,0,0)");
    scrim.addColorStop(1, "rgba(0,0,0,0.72)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, Math.max(0, bandTopPx - 220), W, bandBottomPx - Math.max(0, bandTopPx - 220));
    ctx.fillStyle = "#ffffff";
    let cy = bandTopPx + M;
    ctx.font = `${kit.headingFont.weight} 88px ${kit.headingFont.stack}`;
    cy = drawLines(ctx, hLines, M, cy, 104, "left");
    ctx.font = `400 42px ${kit.bodyFont.stack}`;
    drawLines(ctx, bLines, M, cy + 24, 54, "left");
    return;
  }

  if (slide.layout === "cover" || slide.layout === "cta") {
    // Attached image: full-bleed photo treatment so the image (and its
    // no-text zones) is honored instead of silently ignored.
    if (slide.image) {
      coverImage(ctx, slide.image, 0, 0, W, SLIDE_H);
      const hSize = slide.layout === "cover" ? 100 : 88;
      ctx.font = `${kit.headingFont.weight} ${hSize}px ${kit.headingFont.stack}`;
      const hLines = wrap(ctx, heading || " ", W - M * 2, 5);
      ctx.font = `400 46px ${kit.bodyFont.stack}`;
      const bLines = wrap(ctx, body, W - M * 2, 6);
      const lh = hSize + 14;
      const blockH = hLines.length * lh + 40 + bLines.length * 60;
      const bandTop = bandTopClearOf(slide.regions ?? [], (blockH + M * 2) / SLIDE_H);
      const bandTopPx = bandTop * SLIDE_H;
      const bandBottomPx = Math.min(SLIDE_H, bandTopPx + blockH + M * 2);
      const scrim = ctx.createLinearGradient(0, Math.max(0, bandTopPx - 220), 0, bandBottomPx);
      scrim.addColorStop(0, "rgba(0,0,0,0)");
      scrim.addColorStop(1, "rgba(0,0,0,0.72)");
      ctx.fillStyle = scrim;
      ctx.fillRect(0, Math.max(0, bandTopPx - 220), W, bandBottomPx - Math.max(0, bandTopPx - 220));
      ctx.fillStyle = "#ffffff";
      let cy = bandTopPx + M;
      ctx.font = `${kit.headingFont.weight} ${hSize}px ${kit.headingFont.stack}`;
      cy = drawLines(ctx, hLines, W / 2, cy, lh, "center");
      ctx.globalAlpha = 0.9;
      ctx.font = `400 46px ${kit.bodyFont.stack}`;
      cy = drawLines(ctx, bLines, W / 2, cy + 40, 60, "center");
      ctx.globalAlpha = 1;
      ctx.fillStyle = kit.primary;
      ctx.fillRect(0, 0, W, 26);
      ctx.fillRect(0, SLIDE_H - 26, W, 26);
      if (slide.layout === "cta") {
        ctx.fillRect(W / 2 - 90, cy + 30, 180, 12);
      }
      return;
    }
    ctx.fillStyle = kit.primary;
    ctx.fillRect(0, 0, W, 26);
    ctx.fillRect(0, SLIDE_H - 26, W, 26);
    ctx.fillStyle = ink;
    const hSize = slide.layout === "cover" ? 104 : 92;
    ctx.font = `${kit.headingFont.weight} ${hSize}px ${kit.headingFont.stack}`;
    const hLines = wrap(ctx, heading || " ", W - M * 2, 5);
    ctx.font = `400 46px ${kit.bodyFont.stack}`;
    const bLines = wrap(ctx, body, W - M * 2 - 120, 8);
    const lh = hSize + 16;
    const blockH = hLines.length * lh + 40 + bLines.length * 60;
    let cy = (SLIDE_H - blockH) / 2;
    ctx.font = `${kit.headingFont.weight} ${hSize}px ${kit.headingFont.stack}`;
    cy = drawLines(ctx, hLines, W / 2, cy, lh, "center");
    ctx.globalAlpha = 0.82;
    ctx.font = `400 46px ${kit.bodyFont.stack}`;
    cy = drawLines(ctx, bLines, W / 2, cy + 40, 60, "center");
    ctx.globalAlpha = 1;
    if (slide.layout === "cta") {
      ctx.fillStyle = kit.primary;
      ctx.fillRect(W / 2 - 90, cy + 30, 180, 12);
    }
    return;
  }

  // content (default): heading, accent rule, body, optional image below.
  ctx.fillStyle = ink;
  ctx.font = `${kit.headingFont.weight} 76px ${kit.headingFont.stack}`;
  const hLines = wrap(ctx, heading || " ", W - M * 2, 3);
  let cy = M + 60;
  cy = drawLines(ctx, hLines, M, cy, 92, "left");
  ctx.fillStyle = kit.primary;
  ctx.fillRect(M, cy + 18, 140, 12);
  cy += 90;
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.88;
  ctx.font = `400 44px ${kit.bodyFont.stack}`;
  const maxBodyLines = slide.image ? 7 : 14;
  const bLines = wrap(ctx, body, W - M * 2, maxBodyLines);
  cy = drawLines(ctx, bLines, M, cy, 58, "left");
  ctx.globalAlpha = 1;
  if (slide.image) {
    const imgTop = Math.min(cy + 40, SLIDE_H - M - 420);
    const imgH = SLIDE_H - M - imgTop;
    if (imgH > 160) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(M, imgTop, W - M * 2, imgH, 28);
      ctx.clip();
      coverImage(ctx, slide.image, M, imgTop, W - M * 2, imgH);
      ctx.restore();
    }
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load image"));
    img.src = url;
  });
}
