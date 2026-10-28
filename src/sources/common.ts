import * as os from "os";
import * as path from "path";

export const libraryDir = () => path.resolve(process.env.UI_LIBRARY_DIR || path.join(os.homedir(), ".ui-library"));

/** A UI library result: an app/site to browse, or a single screen image. */
export interface UIItem {
  source: string;
  kind: "app" | "screen";
  id: string;
  name: string;
  app?: string;
  /** Id to pass to get_ui_screens for the whole app/site. */
  appId?: string;
  imageUrl?: string;
  tags?: string[];
  pageUrl?: string;
  /** Behind the source's paywall: the image is a placeholder, so it is never downloaded. */
  restricted?: boolean;
}

export interface UIPage {
  items: UIItem[];
  page: number;
  hasMore: boolean;
  total?: number;
}

export interface UISource {
  id: string;
  description: string;
  /** Text search. Returns apps or screens, depending on what the source searches. */
  search(query: string, page: number): Promise<UIPage>;
  /** All screens of an app/site id returned by search. */
  screens(appId: string, page: number): Promise<UIPage>;
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** fetch with a browser User-Agent; retries 429/5xx with backoff, throws on any other non-2xx. */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string>) },
    });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${init.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname} failed: HTTP ${res.status}`);
  }
}

export async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  return (await request(url, init)).json() as Promise<T>;
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "unknown";
