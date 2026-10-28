import { getJson, UIPage, UISource } from "./common.js";

const API = "https://api.screensdesign.com/v1";

export const screensDesign: UISource = {
  id: "screensdesign",
  description: "ScreensDesign mobile app onboarding/paywall flows; search matches app names",
  async search(q, page) {
    const j = await getJson(`${API}/apps/?name=${encodeURIComponent(q)}&page=${page}`);
    return {
      items: j.results.map((a: any) => ({
        source: "screensdesign",
        kind: "app",
        id: String(a.id),
        appId: String(a.id),
        name: a.name,
        app: a.name,
        imageUrl: a.icon,
        tags: [a.avs?.paywall_type, a.developer?.name].filter(Boolean),
      })),
      page,
      hasMore: j.next != null,
      total: j.count,
    };
  },
  async screens(appId, page): Promise<UIPage> {
    const j = await getJson(`${API}/appvideoscreens/?app=${encodeURIComponent(appId)}&page_size=100&page=${page}`);
    return {
      items: j.results.map((s: any) => ({
        source: "screensdesign",
        kind: "screen",
        id: String(s.id),
        name: `app ${appId} @${s.timestamp}s`,
        appId,
        imageUrl: s.screen,
        tags: s.labels,
        restricted: s.is_blurry,
      })),
      page,
      hasMore: j.next != null,
      total: j.count,
    };
  },
};
