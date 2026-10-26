// Carousel font catalog. System fonts work offline; Google fonts load on
// demand in the browser via the Fonts CSS API. Client-safe.
export type FontDef = {
  id: string;
  label: string;
  face: string;
  stack: string;
  weight: string;
  css?: string;
};

export const HEADING_FONTS: FontDef[] = [
  { id: "system-black", label: "System Black", face: "System Black", stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", weight: "900" },
  { id: "arial-black", label: "Arial Black", face: "Arial Black", stack: "'Arial Black', 'Arial Bold', sans-serif", weight: "900" },
  { id: "archivo-black", label: "Archivo Black", face: "Archivo Black", stack: "'Archivo Black', sans-serif", weight: "400", css: "Archivo+Black" },
  { id: "anton", label: "Anton", face: "Anton", stack: "'Anton', sans-serif", weight: "400", css: "Anton" },
  { id: "bebas-neue", label: "Bebas Neue", face: "Bebas Neue", stack: "'Bebas Neue', sans-serif", weight: "400", css: "Bebas+Neue" },
  { id: "montserrat", label: "Montserrat XBold", face: "Montserrat", stack: "'Montserrat', sans-serif", weight: "800", css: "Montserrat:wght@800" },
  { id: "oswald", label: "Oswald Bold", face: "Oswald", stack: "'Oswald', sans-serif", weight: "700", css: "Oswald:wght@700" },
  { id: "playfair", label: "Playfair Black", face: "Playfair Display", stack: "'Playfair Display', serif", weight: "900", css: "Playfair+Display:wght@900" },
];

export const BODY_FONTS: FontDef[] = [
  { id: "system", label: "System", face: "System", stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", weight: "400" },
  { id: "helvetica", label: "Helvetica / Arial", face: "Helvetica", stack: "'Helvetica Neue', Arial, sans-serif", weight: "400" },
  { id: "georgia", label: "Georgia", face: "Georgia", stack: "Georgia, serif", weight: "400" },
  { id: "inter", label: "Inter", face: "Inter", stack: "'Inter', sans-serif", weight: "400", css: "Inter:wght@400" },
  { id: "roboto", label: "Roboto", face: "Roboto", stack: "'Roboto', sans-serif", weight: "400", css: "Roboto:wght@400" },
  { id: "lora", label: "Lora", face: "Lora", stack: "'Lora', serif", weight: "400", css: "Lora:wght@400" },
];

export function fontById(list: FontDef[], id: string): FontDef {
  return list.find((f) => f.id === id) ?? list[0];
}

const loaded = new Set<string>();

// Fetch the woff2 for a Google font and register it with the document so
// canvas can use it. Last URL in the CSS is the latin subset.
export async function ensureFont(def: FontDef): Promise<void> {
  if (!def.css || loaded.has(def.id)) return;
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${def.css}&display=swap`)).text();
  const urls = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
  if (urls.length === 0) throw new Error(`no font file for ${def.label}`);
  const face = new FontFace(def.face, `url(${urls[urls.length - 1]})`, {
    weight: def.weight,
  });
  await face.load();
  document.fonts.add(face);
  loaded.add(def.id);
}
