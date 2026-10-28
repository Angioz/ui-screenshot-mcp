import { chromium } from "playwright";
import { slug, USER_AGENT, UISource } from "./common.js";

// Dribbble answers plain HTTP with an empty bot-check page, so search runs in a real browser.
export const dribbble: UISource = {
  id: "dribbble",
  description: "Dribbble shots (browser-based search; one results page per call, no apps)",
  async search(query, page) {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ userAgent: USER_AGENT });
      await p.goto(`https://dribbble.com/search/${encodeURIComponent(slug(query))}?page=${page}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await p.waitForSelector("li[id^=screenshot-]", { timeout: 20000 }).catch(() => {});
      const shots = await p.$$eval("li[id^=screenshot-]", (els) =>
        els.map((e) => ({
          id: e.id.replace("screenshot-", ""),
          href: e.querySelector("a[href*='/shots/']")?.getAttribute("href") ?? "",
          title: (e.querySelector("img")?.getAttribute("alt") ?? "").trim(),
          // Below-the-fold images are lazy: the URL only sits in data-srcset until scrolled into view.
          img: [e.querySelector("img")?.getAttribute("src"), e.querySelector("img")?.getAttribute("data-srcset")]
            .find((u) => u?.startsWith("https://")) ?? "",
        }))
      );
      return {
        items: shots
          .filter((s) => s.img.startsWith("https://"))
          .map((s) => ({
            source: "dribbble",
            kind: "screen" as const,
            id: s.id,
            name: s.title || `shot ${s.id}`,
            // Without the resize query the CDN serves the original upload.
            imageUrl: s.img.split("?")[0],
            pageUrl: `https://dribbble.com${s.href}`,
          })),
        page,
        hasMore: shots.length > 0,
      };
    } finally {
      await browser.close();
    }
  },
  async screens() {
    throw new Error("dribbble has no apps: download by query instead (download_ui with query)");
  },
};
