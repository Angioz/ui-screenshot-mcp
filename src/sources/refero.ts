import { getJson, UIItem, UIPage, UISource } from "./common.js";

const API = "https://api.refero.design/v1/search";

interface ReferoRecord {
  id: number;
  url: string | string[];
  page_url?: string;
  app?: { id: number; name: string };
  site?: { id: number; name: string; domain: string };
  page_types: { name: string }[];
  design_patterns: { name: string }[];
  page_elements?: { name: string }[];
}

function toItem(source: string, r: ReferoRecord): UIItem {
  const owner = r.app ?? r.site;
  return {
    source,
    kind: "screen",
    id: String(r.id),
    name: [owner?.name, r.page_types[0]?.name].filter(Boolean).join(" - "),
    app: owner?.name,
    appId: owner ? String(owner.id) : undefined,
    // Web records hold one image per scroll segment; the first is the top of the page.
    imageUrl: Array.isArray(r.url) ? r.url[0] : r.url,
    tags: [...r.page_types, ...r.design_patterns, ...(r.page_elements ?? [])].map((t) => t.name),
    pageUrl: r.page_url,
  };
}

async function query(source: string, base: string, params: string, page: number): Promise<UIPage> {
  const j = await getJson(`${base}?${params}&order=trending&page=${page}`);
  return {
    items: j.records.map((r: ReferoRecord) => toItem(source, r)),
    page,
    hasMore: j.pagination.next != null,
    total: j.pagination.count,
  };
}

export const referoIos: UISource = {
  id: "refero-ios",
  description: "Refero iOS app screens; search matches app names, screen types and patterns",
  search: (q, page) => query("refero-ios", `${API}/apps`, `query=${encodeURIComponent(q)}`, page),
  screens: (appId, page) => query("refero-ios", `${API}/apps`, `app_id[id][]=${encodeURIComponent(appId)}`, page),
};

export const referoWeb: UISource = {
  id: "refero-web",
  description: "Refero web/SaaS page screenshots",
  search: (q, page) => query("refero-web", API, `query=${encodeURIComponent(q)}`, page),
  screens: (siteId, page) => query("refero-web", API, `site_id[id][]=${encodeURIComponent(siteId)}`, page),
};

