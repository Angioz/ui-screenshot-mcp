# ui-screenshot-mcp

An MCP server and CLI for UI research. Search real app and website screens from public design libraries, download them into a local library that is organized by category, search that library later, and screenshot any web page with a real browser.

Works with Claude Code, Claude Desktop, Gemini CLI, Codex and any other MCP client.

## Features

- **Search design libraries**: Refero (iOS and web), Mobbin (iOS, Android, web), ScreensDesign and Dribbble.
- **Build a local library**: download a whole app or a search into `<library>/<category>/<app>/`. Downloads resume, and screens locked behind a paywall are skipped.
- **Search offline**: each image has a `.json` file with its source, app and tags, and `library_search` matches against it.
- **Capture web pages**: full page, single element or viewport, with waits for animations and a way to hide cookie banners.

## Install

### Claude Code plugin (recommended)

```
/plugin marketplace add Angioz/ui-screenshot-mcp
/plugin install ui-screenshot-mcp@angioz
```

This installs the MCP server and the `ui-screenshot-mcp` skill, which teaches Claude how to use the tools. Claude Code asks where to keep the library; leave it empty for `~/.ui-library`.

### Any MCP client

```json
{
  "mcpServers": {
    "ui-screenshot": {
      "command": "npx",
      "args": ["-y", "ui-screenshot-mcp"],
      "env": { "UI_LIBRARY_DIR": "/path/to/your/ui-library" }
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add --scope user ui-screenshot -- npx -y ui-screenshot-mcp
```

To use the skill in other harnesses, copy `skills/ui-screenshot-mcp/` into their skills folder.

### Browser

Web capture and Dribbble search need a Playwright browser. Install it once:

```bash
npx playwright install chromium
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `UI_LIBRARY_DIR` | `~/.ui-library` | Where downloaded screens are saved |
| `MOBBIN_COOKIES` | `<library>/mobbin-cookies.txt` | Mobbin login cookies (see below) |

### Mobbin login

Mobbin only serves screens to logged-in users. To use it:

1. Log in at mobbin.com in your browser.
2. Export the site's cookies in Netscape `cookies.txt` format, for example with the "Get cookies.txt LOCALLY" extension.
3. Save the file as `mobbin-cookies.txt` in your library folder, or point `MOBBIN_COOKIES` at it.

The file is a login: keep it private and never commit it. Free plans only open part of each app, and locked screens are skipped. When the login expires, export the cookies again.

## Sources

| Source id | Search returns | Account |
|---|---|---|
| `refero-ios`, `refero-web` | screens | none |
| `screensdesign` | apps | none |
| `mobbin-ios`, `mobbin-android`, `mobbin-web` | apps | Mobbin login |
| `dribbble` | shots | none |

Use the `appId` from an app result with `get_ui_screens` or `download_ui`.

## Library layout

```
~/.ui-library/
├── 01-onboarding/
│   └── duolingo/
│       ├── 6d1f….webp
│       └── 6d1f….webp.json
├── 06-paywalls/
└── 99-other/
```

The category comes from the search query when it names one, otherwise from the screen's first matching tag. The categories are:

`01-onboarding`, `02-authentication`, `03-main-feed`, `04-profile`, `05-dashboard`, `06-paywalls`, `07-navigation`, `08-search-discover`, `09-saved-collections`, `10-settings`, `11-ai-chat`, `12-quiz-gamification`, `13-empty-states`, `14-notifications`, `15-progress`, `16-loading`, `17-dark-mode` and `18-selection`. Anything that matches none of them goes to `99-other`.

## MCP tools

| Tool | What it does |
|---|---|
| `ui_sources` | List sources; with `check: true`, test each one live |
| `search_ui` | Search a source (`source`, `query`, `page`) |
| `get_ui_screens` | List one app's screens with tags (`source`, `appId`, `page`) |
| `download_ui` | Save an app (`appId`) or a search (`query`) into the library, with a `limit` |
| `library_search` | Search the local library by words |
| `library_stats` | Library folder, image count and size per folder |
| `capture_screenshot` | Screenshot a URL or an open session (`url`, `selector`, `fullPage`, `width`, `height`, `waitUntil`, `delayMs`, `waitForSelector`, `hideSelectors`, `scrollY`, `scrollToSelector`, `deviceScaleFactor`, `outputPath`) |
| `open_browser` / `close_browser` | Keep a browser session open for several captures |
| `list_screenshots` | List captured screenshots |

## CLI

The same features without an MCP client:

```bash
npx ui-screenshot-mcp            # MCP server on stdio
npm i -g ui-screenshot-mcp       # installs the `ui-screenshot` CLI

ui-screenshot sources --check
ui-screenshot search --source refero-ios --query paywall
ui-screenshot screens --source screensdesign --app 862
ui-screenshot sync --source refero-ios --query onboarding --limit 50
ui-screenshot library --query "duolingo paywall"
ui-screenshot capture --url https://example.com --full-page --output page.png
ui-screenshot --help
```

## Development

```bash
git clone https://github.com/Angioz/ui-screenshot-mcp
cd ui-screenshot-mcp
npm install
npx playwright install chromium
npm test
```

## Disclaimer

This project is not affiliated with Refero, Mobbin, ScreensDesign or Dribbble. It uses their public web endpoints, which can change without notice. Respect each site's terms, keep downloads for personal reference and research, and don't redistribute the images.

## License

MIT © Angioz
