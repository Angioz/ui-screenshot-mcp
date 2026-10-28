import { UISource } from "./common.js";
import { referoIos, referoWeb } from "./refero.js";
import { screensDesign } from "./screensdesign.js";
import { mobbin } from "./mobbin.js";
import { dribbble } from "./dribbble.js";

export const SOURCES: Record<string, UISource> = Object.fromEntries(
  [referoIos, referoWeb, screensDesign, mobbin("ios"), mobbin("android"), mobbin("web"), dribbble].map((s) => [s.id, s])
);

export function getSource(id: string): UISource {
  const s = SOURCES[id];
  if (!s) throw new Error(`Unknown source "${id}". Sources: ${Object.keys(SOURCES).join(", ")}`);
  return s;
}

export type { UIItem, UIPage, UISource } from "./common.js";
