---
name: ui-screenshot-mcp
description: How to use the ui-screenshot MCP tools. Find real UI references and keep them in a local library, or screenshot a web page. Use whenever those tools are used, and when the user wants design inspiration, examples of a screen or flow (onboarding, paywall, settings, checkout...), screens of a named app or website, to download or build a UI library, to search screens they already saved, or to capture a URL. Covers setup of the library folder and the Mobbin login.
---

# UI Screenshot

Tools come from the `ui-screenshot` MCP server. Two jobs:

- **UI library**: search Refero, Mobbin, ScreensDesign and Dribbble, download screens into a local folder, search that folder later.
- **Web capture**: screenshot any URL with a real browser.

## First use: set up once

Run this the first time in a session the user asks for library work.

1. Call `library_stats`. It returns the library folder (`library`) and what is in it.
2. If the library is empty, ask the user where to keep downloaded screens:
   - **Default**: keep the folder `library_stats` reported.
   - **Custom folder**: tell them to run `/config`, set **UI library folder** for this plugin, then `/mcp` and reconnect `ui-screenshot`. Outside Claude Code, set the `UI_LIBRARY_DIR` environment variable on the MCP server.
3. Call `ui_sources` with `check: true` to see which sources work right now. Report failures as they are; don't hide them.
4. If a Mobbin source fails with "Mobbin needs a login", offer the Mobbin setup below. The other sources need no account.
5. If anything fails with a missing browser, tell the user to run `npx playwright install chromium` once.

### Mobbin login (optional)

Mobbin only serves screens to logged-in accounts, so the tool reads your browser cookies. Tell the user:

1. Log in at https://mobbin.com in Chrome, Edge or Firefox.
2. Install a cookie exporter that writes the **Netscape cookies.txt** format, such as "Get cookies.txt LOCALLY".
3. On a mobbin.com tab, export the cookies for that site.
4. Save the file as `mobbin-cookies.txt` inside the library folder (the exact path is in the Mobbin error message). No restart needed.

Warn them plainly:
- The file is a login. Anyone with it can use their Mobbin account. Never commit or share it.
- Free plans only open a small part of each app. Locked screens are skipped, never saved as placeholders.
- When the login expires, Mobbin returns no screens. Export the cookies again.

## Sources

| Source | Search returns | Then |
|---|---|---|
| `refero-ios`, `refero-web` | screens | `download_ui` with `query`, or `appId` from a result |
| `screensdesign` | apps | `get_ui_screens` / `download_ui` with the app `appId` |
| `mobbin-ios`, `mobbin-android`, `mobbin-web` | apps (needs login) | `get_ui_screens` / `download_ui` with the app `appId` |
| `dribbble` | shots (concept art, not shipped apps) | `download_ui` with `query` |

Refero is the best default for real, shipped screens. Use Dribbble only when the user wants visual ideas.

## Workflow

1. **Local first.** Call `library_search` with the pattern words, such as `"paywall"` or `"duolingo onboarding"`. If it finds enough, use those files.
2. **Search online.** Call `search_ui` on one or two sources. Pick by the table above. Never hardcode app names; let search find them.
3. **Look before you download.** `get_ui_screens` lists one app's screens with their tags, so you can pick the relevant ones.
4. **Download.** Call `download_ui` with `source` plus `appId` (a whole app) or `query` (search results), and a `limit`. Re-running skips files already saved, so an interrupted download resumes. For a large app, start with a limit of about 50. Offer a full download only if the user wants it.
5. **Inspect the images.** Open the saved files and describe what you see. Don't judge a screen by its file name or tags.
6. **Report.** Give the absolute paths of the screens you used.

Screens are filed as `<library>/<category>/<app>/<id>.<ext>`, for example `06-paywalls/duolingo/`. The category comes from the search query when it names one, else from the screen's tags; anything unmatched goes to `99-other`. Each image has a `.json` file next to it with source, app, tags and page URL. `library_search` matches folder names and that metadata, so a screen can be found under every tag it has.

## Web capture

- `capture_screenshot` with `url` takes a one-shot capture. For pages that animate in or lazy-load, use `waitUntil`, `delayMs` or `waitForSelector`. Use `hideSelectors` for cookie banners, `fullPage` for long pages, `deviceScaleFactor: 2` for retina, and `outputPath` to choose the file.
- For several captures of one page, use `open_browser`, then `capture_screenshot` without a `url`, then `close_browser`. Always close the sessions you open.
- `list_screenshots` lists what was captured.

## Rules

- These sources are third-party sites. Respect their terms, keep downloads for reference and research, and don't redistribute the images.
- Don't loop `download_ui` over many apps without asking first. Bulk downloads are slow and can get you rate-limited.
- If a source breaks, the site probably changed. Say which source failed and continue with the others.
