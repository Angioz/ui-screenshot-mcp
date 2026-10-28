import * as fs from "fs";
import * as path from "path";
import { libraryDir, request, UIItem, UISource } from "./common.js";

/** Cookie header from a Netscape cookies.txt exported from a logged-in mobbin.com tab: MOBBIN_COOKIES, else <library>/mobbin-cookies.txt. */
function cookieHeader(): string {
  const file = process.env.MOBBIN_COOKIES || path.join(libraryDir(), "mobbin-cookies.txt");
  if (!fs.existsSync(file))
    throw new Error(`Mobbin needs a login: export your mobbin.com cookies (cookies.txt format) to ${file} or set MOBBIN_COOKIES`);
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 7)
    .map((f) => `${f[5]}=${f[6].trim()}`)
    .join("; ");
}

const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\u0026/g, "&");

export function mobbin(platform: "ios" | "android" | "web"): UISource {
  const source = `mobbin-${platform}`;
  return {
    id: source,
    description: `Mobbin ${platform} apps (needs a mobbin.com login cookie file; screens beyond your plan come back restricted)`,
    async search(query, page) {
      const res = await request("https://mobbin.com/api/search/fetch-search-page-apps", {
        method: "POST",
        headers: { cookie: cookieHeader(), "content-type": "application/json", origin: "https://mobbin.com" },
        body: JSON.stringify({
          searchRequestId: crypto.randomUUID(),
          pageIndex: page - 1,
          searchQuery: { contentType: "apps", platform, type: "free_text_search", mode: "standard", query },
        }),
      });
      const v = (await res.json()).value;
      return {
        items: v.data.map((a: any) => ({
          source,
          kind: "app",
          id: a.id,
          // The app page needs both ids; get_ui_screens takes them as one string.
          appId: `${a.id}/${a.appVersionId}`,
          name: a.appName,
          app: a.appName,
          imageUrl: a.appLogoUrl,
          tags: [a.appTagline].filter(Boolean),
        })),
        page,
        hasMore: v.hasNextPage,
        total: v.totalCount,
      };
    },
    // The app page server-renders every screen of the version, so there is a single page.
    async screens(appId, page) {
      if (page > 1) return { items: [], page, hasMore: false };
      const [id, version] = appId.split("/");
      if (!version) throw new Error(`Mobbin appId must be "<appId>/<appVersionId>" as returned by search, got "${appId}"`);
      const res = await request(`https://mobbin.com/apps/app-${platform}-${id}/${version}/screens`, {
        headers: { cookie: cookieHeader() },
      });
      const html = unescape(await res.text());
      const re = new RegExp(
        String.raw`"type":"curated","id":"([a-f0-9-]+)"[^{}]*?"screenElements":\[([^\]]*)\],"screenPatterns":\[([^\]]*)\][^{}]*?"appId":"${id}","appName":"([^"]+)"[^{}]*?"restricted":(true|false),"screenCdnImgSources":\{"src":"([^"]+)"`,
        "g"
      );
      // Most screens carry no patterns of their own; the named flows they belong to ("Onboarding", "Creating a profile") do.
      const flows = new Map<string, string[]>();
      for (const f of html.matchAll(/"name":"([^"]+)"[^{}]*?"screens":\[((?:\{"screenId":"[a-f0-9-]+"[^{}]*\},?)+)\]/g)) {
        for (const [, sid] of f[2].matchAll(/"screenId":"([a-f0-9-]+)"/g)) flows.set(sid, [...(flows.get(sid) ?? []), f[1]]);
      }
      const seen = new Map<string, UIItem>();
      for (const m of html.matchAll(re)) {
        const own = `${m[3]},${m[2]}`.match(/"([^"]+)"/g)?.map((t) => t.slice(1, -1)) ?? [];
        const tags = [...new Set([...(flows.get(m[1]) ?? []), ...own])];
        seen.set(m[1], {
          source,
          kind: "screen",
          id: m[1],
          name: [m[4], tags[0]].filter(Boolean).join(" - "),
          app: m[4],
          appId,
          imageUrl: m[6],
          tags,
          restricted: m[5] === "true",
        });
      }
      if (!seen.size && /NotFoundContent/.test(html) && !/"appVersion"/.test(html)) {
        throw new Error("Mobbin returned no screens: the app id is wrong or the Mobbin login cookies expired (export them again)");
      }
      return { items: [...seen.values()], page, hasMore: false, total: seen.size };
    },
  };
}
