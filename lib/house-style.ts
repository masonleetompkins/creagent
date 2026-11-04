// Locked house image style: every generated carousel image renders in
// this style, whether the prompt was planned, story-written, or typed by
// hand in the editor.
export const HOUSE_IMAGE_STYLE =
  "Minimalist 2D anime cartoon, a vector graphic in the style of Western anime such as Pantheon: " +
  "bold outlines, bright but realistic colors, a realistic-looking scene rendered in this anime style, " +
  "with no text in the image.";

const STYLE_MARK = /pantheon/i;

// Append the house style unless it is already there (idempotent so a
// styled plan prompt passed through generation keeps one copy).
export function withHouseStyle(prompt: string): string {
  const clean = prompt.trim();
  if (!clean) return HOUSE_IMAGE_STYLE;
  if (STYLE_MARK.test(clean)) return clean;
  return `${clean} ${HOUSE_IMAGE_STYLE}`;
}
