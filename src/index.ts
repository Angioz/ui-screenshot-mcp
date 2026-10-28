#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, firefox, webkit, Browser, Page, ElementHandle } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { ScreenshotOptions, ScreenshotResult, MCPToolInput } from "./types.js";
import { SOURCES, getSource } from "./sources/index.js";
import { download, searchLibrary, libraryStats } from "./library.js";

const sourceProp = { type: "string", enum: Object.keys(SOURCES), description: "UI library source" };

// Global browser instances
const browsers: Map<string, Browser> = new Map();
const pages: Map<string, Page> = new Map();
let pageCounter = 0;

// MCP Server setup
const server = new Server(
  {
    name: "ui-screenshot-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Options shared by capture_screenshot and open_browser
const pageProps = {
  waitUntil: {
    type: "string",
    enum: ["load", "domcontentloaded", "networkidle", "commit"],
    description: "Navigation wait condition (default: load)",
  },
  timeout: {
    type: "number",
    description:
      "Navigation timeout in ms (default: 30000). On timeout the page is captured as rendered so far.",
  },
  delayMs: {
    type: "number",
    description: "Sleep this many ms after load, before capture (intro animations)",
  },
  waitForSelector: {
    type: "string",
    description: "Wait for this CSS selector to appear before capture",
  },
  hideSelectors: {
    type: "array",
    items: { type: "string" },
    description: "CSS selectors to hide before capture (cookie banners, chat widgets)",
  },
  scrollY: {
    type: "number",
    description: "Scroll the page to this vertical offset in px before capture",
  },
  scrollToSelector: {
    type: "string",
    description: "Scroll this element into view (top aligned) before capture",
  },
  deviceScaleFactor: {
    type: "number",
    description: "Device pixel ratio, e.g. 2 for retina captures (default: 1)",
  },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Navigate and prepare the page; soft failures are returned as warnings. */
async function loadPage(page: Page, url: string | undefined, input: MCPToolInput): Promise<string[]> {
  const warnings: string[] = [];
  const timeout = (input.timeout as number) ?? 30000;
  if (url) {
    const waitUntil = ((input.waitUntil as string) ?? "load") as
      | "load" | "domcontentloaded" | "networkidle" | "commit";
    try {
      await page.goto(url, { waitUntil, timeout });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        warnings.push(`Navigation timed out after ${timeout}ms (waitUntil=${waitUntil}); captured as rendered`);
      } else {
        throw error;
      }
    }
  }
  const waitForSelector = input.waitForSelector as string | undefined;
  if (waitForSelector) {
    try {
      await page.waitForSelector(waitForSelector, { timeout });
    } catch {
      warnings.push(`waitForSelector not found: ${waitForSelector}`);
    }
  }
  const hide = input.hideSelectors as string[] | undefined;
  if (hide?.length) {
    await page.addStyleTag({ content: `${hide.join(",")}{display:none !important}` });
  }
  const scrollToSelector = input.scrollToSelector as string | undefined;
  if (scrollToSelector) {
    const found = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: "start" });
      return !!el;
    }, scrollToSelector);
    if (!found) warnings.push(`scrollToSelector not found: ${scrollToSelector}`);
  } else if (typeof input.scrollY === "number") {
    await page.evaluate((y) => window.scrollTo(0, y), input.scrollY);
  }
  const delayMs = input.delayMs as number | undefined;
  if (delayMs && delayMs > 0) await sleep(delayMs);
  return warnings;
}

type Shot = { page: Page; element?: ElementHandle; filepath: string; format: "png" | "jpeg";
  quality?: number; fullPage: boolean; timeout: number };

const isTimeout = (e: unknown) => e instanceof Error && e.name === "TimeoutError";

/** Screenshot with fallbacks for pages whose web fonts never finish loading. */
async function snap(o: Shot, warnings: string[]): Promise<void> {
  const base = { path: o.filepath, type: o.format, quality: o.quality, timeout: o.timeout };
  const run = (extra: object) =>
    o.element ? o.element.screenshot({ ...base, ...extra }) : o.page.screenshot({ ...base, ...extra, fullPage: o.fullPage });
  try {
    await run({});
    return;
  } catch (e) {
    if (!isTimeout(e)) throw e;
  }
  try {
    await run({ animations: "disabled", caret: "hide" });
    warnings.push("Screenshot timed out; succeeded on retry with animations disabled");
    return;
  } catch (e) {
    if (!isTimeout(e)) throw e;
  }
  // CDP skips Playwright's wait for document.fonts (Chromium only).
  const cdp = await o.page.context().newCDPSession(o.page);
  const clip = o.element ? await o.element.boundingBox() : null;
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: o.format,
    quality: o.format === "jpeg" ? o.quality : undefined,
    captureBeyondViewport: o.fullPage,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  fs.writeFileSync(o.filepath, Buffer.from(data, "base64"));
  warnings.push("Screenshot timed out waiting for fonts; captured via CDP");
}

// Tool definitions
const tools = [
  {
    name: "capture_screenshot",
    description:
      "Capture a screenshot of a webpage or current page. Returns path to saved screenshot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL to navigate to (optional if page already loaded)",
        },
        selector: {
          type: "string",
          description: "CSS selector for specific element to screenshot",
        },
        fullPage: {
          type: "boolean",
          description: "Capture full page (default: visible viewport)",
        },
        width: {
          type: "number",
          description: "Viewport width in pixels (default: 1280)",
        },
        height: {
          type: "number",
          description: "Viewport height in pixels (default: 720)",
        },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format (default: png)",
        },
        quality: {
          type: "number",
          description: "JPEG quality 0-100 (only for jpeg format)",
        },
        outputPath: {
          type: "string",
          description: "Full file path for the image (default: ./screenshots/screenshot-<ts>.<format>)",
        },
        filename: {
          type: "string",
          description: "File name inside ./screenshots (ignored when outputPath is set)",
        },
        ...pageProps,
      },
    },
  },
  {
    name: "open_browser",
    description:
      "Open a browser and navigate to a URL. Returns page ID for subsequent screenshots.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL to navigate to",
        },
        browser: {
          type: "string",
          enum: ["chromium", "firefox", "webkit"],
          description: "Browser engine to use (default: chromium)",
        },
        width: {
          type: "number",
          description: "Viewport width (default: 1280)",
        },
        height: {
          type: "number",
          description: "Viewport height (default: 720)",
        },
        ...pageProps,
      },
    },
  },
  {
    name: "close_browser",
    description: "Close a browser session",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
          description: "Browser session ID to close",
        },
      },
    },
  },
  {
    name: "list_screenshots",
    description: "List all screenshots in the output directory",
    inputSchema: {
      type: "object" as const,
      properties: {
        directory: {
          type: "string",
          description: "Directory to list (default: ./screenshots)",
        },
      },
    },
  },
  {
    name: "ui_sources",
    description: "List the UI library sources; with check=true, run a live search on each to report which ones work right now",
    inputSchema: { type: "object" as const, properties: { check: { type: "boolean" } } },
  },
  {
    name: "search_ui",
    description:
      "Search a UI library source. Returns screens (refero-ios, refero-web, dribbble) or apps (screensdesign, mobbin-*); pass an app's appId to get_ui_screens or download_ui.",
    inputSchema: {
      type: "object" as const,
      properties: { source: sourceProp, query: { type: "string" }, page: { type: "number", description: "1-based (default 1)" } },
      required: ["source", "query"],
    },
  },
  {
    name: "get_ui_screens",
    description: "List the screens of one app/site (appId from search_ui results), with image URLs and tags",
    inputSchema: {
      type: "object" as const,
      properties: { source: sourceProp, appId: { type: "string" }, page: { type: "number", description: "1-based (default 1)" } },
      required: ["source", "appId"],
    },
  },
  {
    name: "download_ui",
    description:
      "Download screens into the local UI library (UI_LIBRARY_DIR, default ~/.ui-library): every screen of an appId, or the results of a query. Already-downloaded and paywalled screens are skipped.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source: sourceProp,
        appId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", description: "Max screens (default 50)" },
      },
      required: ["source"],
    },
  },
  {
    name: "library_search",
    description: "Search the local UI library by words matched against folders, file names and saved metadata (app, tags, source)",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" }, limit: { type: "number", description: "Max results (default 50)" } },
      required: ["query"],
    },
  },
  {
    name: "library_stats",
    description: "Count the images in the local UI library per source/app folder",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

async function libraryTool(name: string, a: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "ui_sources":
      return Promise.all(
        Object.values(SOURCES).map(async (s) => {
          if (!a.check) return { id: s.id, description: s.description };
          try {
            const r = await s.search(s.id === "dribbble" ? "onboarding" : "instagram", 1);
            return { id: s.id, ok: r.items.length > 0, results: r.items.length };
          } catch (e) {
            return { id: s.id, ok: false, error: String(e) };
          }
        })
      );
    case "search_ui":
      return getSource(a.source).search(a.query, a.page ?? 1);
    case "get_ui_screens":
      return getSource(a.source).screens(a.appId, a.page ?? 1);
    case "download_ui":
      return download({ source: a.source, appId: a.appId, query: a.query, limit: a.limit ?? 50 });
    case "library_search":
      return searchLibrary(a.query, a.limit);
    case "library_stats":
      return libraryStats();
  }
  return undefined;
}

// Tool implementations
async function captureScreenshot(input: MCPToolInput): Promise<ScreenshotResult> {
  try {
    const url = input.url as string | undefined;
    const selector = input.selector as string | undefined;
    const fullPage = (input.fullPage as boolean) ?? false;
    const width = (input.width as number) ?? 1280;
    const height = (input.height as number) ?? 720;
    const format = (input.format as string) ?? "png";
    const quality = input.quality as number | undefined;

    // Get or create page
    let page: Page;
    if (url) {
      if (!browsers.has("default")) {
        const browser = await chromium.launch();
        browsers.set("default", browser);
      }
      const browser = browsers.get("default")!;
      page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: (input.deviceScaleFactor as number) ?? 1,
      });
      pages.set(`page-${pageCounter++}`, page);
    } else {
      const pageKeys = Array.from(pages.keys());
      if (pageKeys.length === 0) {
        return {
          success: false,
          path: "",
          error: "No URL provided and no active page. Use open_browser first.",
          timestamp: new Date().toISOString(),
          format: "png",
        };
      }
      page = pages.get(pageKeys[pageKeys.length - 1])!;
    }
    const timeout = (input.timeout as number) ?? 30000;
    const warnings = await loadPage(page, url, input);

    // Create output directory
    const outputPath = input.outputPath as string | undefined;
    const filename =
      path.basename((input.filename as string | undefined) ?? "") ||
      `screenshot-${Date.now()}.${format}`;
    const filepath = outputPath ? path.resolve(outputPath) : path.join("./screenshots", filename);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });

    if (selector) {
      const element = await page.$(selector);
      if (!element) {
        return {
          success: false,
          path: "",
          error: `Element not found: ${selector}`,
          timestamp: new Date().toISOString(),
          format: format as "png" | "jpeg",
        };
      }
      await snap({ page, element, filepath, format: format as "png" | "jpeg", quality, fullPage, timeout }, warnings);
    } else {
      await snap({ page, filepath, format: format as "png" | "jpeg", quality, fullPage, timeout }, warnings);
    }

    return {
      success: true,
      path: path.resolve(filepath),
      url: url,
      timestamp: new Date().toISOString(),
      format: format as "png" | "jpeg",
      size: {
        width,
        height,
      },
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    return {
      success: false,
      path: "",
      error: `Screenshot failed: ${String(error)}`,
      timestamp: new Date().toISOString(),
      format: "png",
    };
  }
}

async function openBrowser(input: MCPToolInput): Promise<ScreenshotResult> {
  try {
    const url = input.url as string;
    const browserType = (input.browser as string) ?? "chromium";
    const width = (input.width as number) ?? 1280;
    const height = (input.height as number) ?? 720;

    if (!url) {
      return {
        success: false,
        path: "",
        error: "URL is required",
        timestamp: new Date().toISOString(),
        format: "png",
      };
    }

    // Launch browser
    let browser: Browser;
    if (browserType === "firefox") {
      browser = await firefox.launch();
    } else if (browserType === "webkit") {
      browser = await webkit.launch();
    } else {
      browser = await chromium.launch();
    }

    const sessionId = `session-${Date.now()}`;
    browsers.set(sessionId, browser);

    // Open page
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: (input.deviceScaleFactor as number) ?? 1,
    });
    pages.set(sessionId, page);

    const warnings = await loadPage(page, url, input);

    return {
      success: true,
      path: sessionId,
      url: url,
      timestamp: new Date().toISOString(),
      format: "png",
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    return {
      success: false,
      path: "",
      error: `Failed to open browser: ${String(error)}`,
      timestamp: new Date().toISOString(),
      format: "png",
    };
  }
}

async function closeBrowser(input: MCPToolInput): Promise<ScreenshotResult> {
  try {
    const sessionId = input.sessionId as string;

    if (!sessionId) {
      return {
        success: false,
        path: "",
        error: "sessionId is required",
        timestamp: new Date().toISOString(),
        format: "png",
      };
    }

    if (pages.has(sessionId)) {
      await pages.get(sessionId)!.close();
      pages.delete(sessionId);
    }

    if (browsers.has(sessionId)) {
      await browsers.get(sessionId)!.close();
      browsers.delete(sessionId);
    }

    return {
      success: true,
      path: sessionId,
      timestamp: new Date().toISOString(),
      format: "png",
    };
  } catch (error) {
    return {
      success: false,
      path: "",
      error: `Failed to close browser: ${String(error)}`,
      timestamp: new Date().toISOString(),
      format: "png",
    };
  }
}

async function listScreenshots(input: MCPToolInput): Promise<ScreenshotResult> {
  try {
    const directory = (input.directory as string) ?? "./screenshots";

    if (!fs.existsSync(directory)) {
      return {
        success: true,
        path: directory,
        timestamp: new Date().toISOString(),
        format: "png",
      };
    }

    const files = fs
      .readdirSync(directory)
      .filter((f) => f.match(/\.(png|jpeg|jpg)$/i))
      .map((f) => {
        const fullPath = path.join(directory, f);
        const stats = fs.statSync(fullPath);
        return {
          name: f,
          path: path.resolve(fullPath),
          size: stats.size,
          modified: stats.mtime.toISOString(),
        };
      });

    return {
      success: true,
      path: JSON.stringify(files, null, 2),
      timestamp: new Date().toISOString(),
      format: "png",
    };
  } catch (error) {
    return {
      success: false,
      path: "",
      error: `Failed to list screenshots: ${String(error)}`,
      timestamp: new Date().toISOString(),
      format: "png",
    };
  }
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let result: ScreenshotResult;

  try {
    switch (request.params.name) {
      case "capture_screenshot":
        result = await captureScreenshot(request.params.arguments ?? {});
        break;
      case "open_browser":
        result = await openBrowser(request.params.arguments ?? {});
        break;
      case "close_browser":
        result = await closeBrowser(request.params.arguments ?? {});
        break;
      case "list_screenshots":
        result = await listScreenshots(request.params.arguments ?? {});
        break;
      default: {
        const out = await libraryTool(request.params.name, request.params.arguments ?? {});
        if (out !== undefined) return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown tool: ${request.params.name}`,
            },
          ],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Main entry point
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Screenshot MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
