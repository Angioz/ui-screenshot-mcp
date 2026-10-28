import * as fs from "fs";
import * as path from "path";
import { libraryDir, request, slug } from "./sources/common.js";
import { getSource, UIItem } from "./sources/index.js";

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : IMAGE.test(e.name) ? [p] : [];
  });
}

/** Library categories, in the order they are tried against each tag. */
const CATEGORIES: [string, RegExp][] = [
  ["06-paywalls", /paywall|subscri|pricing|upgrade|\bplans?\b|trial|billing|checkout/i],
  ["01-onboarding", /onboarding|welcome|walkthrough|launch|splash|get started|tutorial|coach mark|permission/i],
  ["02-authentication", /log ?in|sign ?(in|up)|auth|password|verif/i],
  ["12-quiz-gamification", /quiz|gamif|leaderboard|lesson/i],
  ["03-main-feed", /feed|home|timeline|stor(y|ies)|\bposts?\b|reels?/i],
  ["04-profile", /profile|account|follow/i],
  ["05-dashboard", /dashboard|stats|analytics|overview/i],
  ["07-navigation", /navigation|tab ?bar|menu|sidebar/i],
  ["08-search-discover", /search|discover|explore|filter/i],
  ["09-saved-collections", /saved|collection|bookmark|favou?rite/i],
  ["10-settings", /settings|preferences/i],
  ["11-ai-chat", /chat|message|\bai\b|assistant/i],
  ["13-empty-states", /empty/i],
  ["14-notifications", /notification|alert/i],
  ["15-progress", /progress|achievement|streak|badge|success|confetti|goal/i],
  ["16-loading", /loading|connecting|skeleton/i],
  ["17-dark-mode", /dark mode/i],
  ["18-selection", /select|picker/i],
];

/** The category the search query names, else the first one a tag matches (tags in source order), else 99-other. */
export function categoryOf(item: UIItem, query?: string): string {
  for (const text of [query ?? "", ...(item.tags ?? [])]) {
    const hit = CATEGORIES.find(([, re]) => re.test(text));
    if (hit) return hit[0];
  }
  return "99-other";
}

/** Save one screen as <library>/<category>/<app>/<id>.<ext> with a .json sidecar. Existing files are kept, which makes re-runs resume. */
export async function saveItem(item: UIItem, dir = libraryDir(), query?: string): Promise<{ path: string; status: "downloaded" | "exists" | "skipped" }> {
  const folder = path.join(dir, categoryOf(item, query), slug(item.app ?? item.appId ?? "misc"));
  const existing = fs.existsSync(folder) && fs.readdirSync(folder).find((f) => f.startsWith(`${item.id}.`) && IMAGE.test(f));
  if (existing) return { path: path.join(folder, existing), status: "exists" };
  if (item.restricted || !item.imageUrl) return { path: "", status: "skipped" };

  const res = await request(item.imageUrl);
  const type = res.headers.get("content-type") ?? "";
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
  const file = path.join(folder, `${item.id}.${ext}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(`${file}.json`, JSON.stringify({ ...item, downloadedAt: new Date().toISOString() }, null, 2));
  return { path: file, status: "downloaded" };
}

export interface DownloadOptions {
  source: string;
  appId?: string;
  query?: string;
  limit?: number;
  concurrency?: number;
  delayMs?: number;
  onProgress?: (done: number, item: UIItem, status: string) => void;
}

/** Walk the result pages of an app (appId) or a search (query) and save every open screen, politely and resumably. */
export async function download(o: DownloadOptions) {
  if (!o.appId && !o.query) throw new Error("download needs appId or query");
  const src = getSource(o.source);
  const limit = o.limit ?? Infinity;
  const counts = { downloaded: 0, exists: 0, skipped: 0, failed: 0 };
  const errors: string[] = [];
  let seen = 0;
  for (let page = 1; seen < limit; page++) {
    const res = o.appId ? await src.screens(o.appId, page) : await src.search(o.query!, page);
    const screens = res.items.filter((i) => i.kind === "screen").slice(0, limit - seen);
    // A page without screens means the end, or a source whose search returns apps (download those by appId).
    if (!screens.length) break;
    seen += screens.length;
    // Small fixed-size batches keep the request rate low enough not to get blocked.
    for (let i = 0; i < screens.length; i += o.concurrency ?? 4) {
      await Promise.all(
        screens.slice(i, i + (o.concurrency ?? 4)).map(async (item) => {
          try {
            const r = await saveItem(item, libraryDir(), o.query);
            counts[r.status]++;
            o.onProgress?.(counts.downloaded + counts.exists, item, r.status);
          } catch (e) {
            counts.failed++;
            errors.push(`${item.id}: ${String(e)}`);
          }
        })
      );
      await new Promise((r) => setTimeout(r, o.delayMs ?? 250));
    }
    if (!res.hasMore) break;
  }
  return { ...counts, library: libraryDir(), errors: errors.slice(0, 10) };
}

/** Case-insensitive search over file paths and sidecar metadata; every word must match. */
export function searchLibrary(query: string, limit = 50, dir = libraryDir()) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { path: string; meta?: unknown }[] = [];
  for (const file of walk(dir)) {
    const side = fs.existsSync(`${file}.json`) ? fs.readFileSync(`${file}.json`, "utf8") : "";
    const hay = `${path.relative(dir, file)} ${side}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      hits.push({ path: file, meta: side ? JSON.parse(side) : undefined });
      if (hits.length >= limit) break;
    }
  }
  return { library: dir, count: hits.length, results: hits };
}

export function libraryStats(dir = libraryDir()) {
  const files = walk(dir);
  const byFolder: Record<string, number> = {};
  let bytes = 0;
  for (const f of files) {
    const top = path.relative(dir, f).split(path.sep).slice(0, 2).join("/");
    byFolder[top] = (byFolder[top] ?? 0) + 1;
    bytes += fs.statSync(f).size;
  }
  return { library: dir, images: files.length, megabytes: +(bytes / 1048576).toFixed(1), byFolder };
}
