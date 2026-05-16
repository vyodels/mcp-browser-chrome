# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                  # Watch mode build (for development)
npm run build                # Production build → dist/
npm run typecheck            # TypeScript type checking without emit
npm run setup:auto           # One-shot: build + install native host + register Codex MCP
npm run native-host:start    # Debug-mode native host (persistent, for local testing)
npm run native-host:stdio    # Simulate Chrome's stdio invocation of the native host
npm run mcp:start            # Start MCP server directly (stdio — normally managed by Codex)
npm run native-host:install  # Install Chrome Native Messaging manifest only
npm run codex:mcp:install    # Register mcp/server.mjs in ~/.codex/config.toml only
```

To load in Chrome: `chrome://extensions` → Developer Mode → Load unpacked → select `dist/`.

## Architecture

**Stealth-first Chrome browser MCP runtime.** Three-layer chain:

```
Codex / MCP Client
  → mcp/server.mjs          (stdio MCP server — browser_* tools)
  → Unix socket              (MCP_BROWSER_CHROME_SOCKET, default: os.tmpdir()/browser-mcp.sock)
  → native-host/host.mjs    (Chrome Native Messaging host, name: com.vyodels.browser_mcp)
  → Chrome Extension         (background service worker + content scripts)
  → Page DOM / Chrome APIs
```

**Normal operation:** nothing needs to be started manually. Chrome loads the extension, the extension auto-wakes the background service worker, which auto-launches the native host. Codex auto-manages `mcp/server.mjs` via `~/.codex/config.toml`.

`npm run mcp:start` and `npm run native-host:start` are debug-only.

### Source Layout

**Active MCP runtime** (everything that matters):

| Path | Role |
|------|------|
| `src/background.ts` | Thin entry — registers background handlers |
| `src/content.ts` | Thin entry — registers content script handlers |
| `src/types.ts` | Shared types for tabs, message bus, and read-only snapshot payloads |
| `src/extension/background/handlers.ts` | Background main router — maps `browser_*` commands to Chrome API or content script |
| `src/extension/background/nativeHost.ts` | Native Messaging connection — receives commands from host, drives execution |
| `src/extension/background/contentBridge.ts` | Background↔content bridge — locates target tab, re-injects content script if needed, always targets the top frame |
| `src/extension/content/snapshot.ts` | Page snapshot collector — traverses same-origin iframes + open shadow DOM and returns viewport/document/clickables |
| `src/extension/content/locators.ts` | Read-only element lookup by ref / selector / text / role / index against current snapshot data |
| `src/extension/content/state.ts` | Ephemeral `@e1`/`@e2` ref → DOM element map used by read-only lookup helpers |
| `src/extension/content/waits.ts` | `wait_for_element`, `wait_for_text`, `wait_for_disappear` |
| `src/extension/content/handlers.ts` | Content script message router |
| `src/extension/shared/protocol.ts` | Command names, Native Messaging bridge types, and read-only snapshot/query schemas |
| `mcp/server.mjs` | MCP stdio server — registers `browser_*` tools, forwards calls to native host |
| `native-host/host.mjs` | Native Messaging host — bridges Chrome extension ↔ Unix socket |
| `scripts/setup-auto.mjs` | Full install: build + native host + Codex config |
| `scripts/install-native-host.mjs` | Installs `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vyodels.browser_mcp.json` |
| `scripts/install-codex-mcp.mjs` | Writes `browser-mcp` entry to `~/.codex/config.toml` |

### MCP Tools (`browser_*`)

Default `tools/list` exposes only these 10 read-only tools:

`browser_list_tabs`, `browser_get_active_tab`, `browser_snapshot`, `browser_query_elements`, `browser_get_element`, `browser_wait_for_element`, `browser_wait_for_text`, `browser_wait_for_disappear`, `browser_wait_for_navigation`, `browser_wait_for_url`

Default runtime must not expose screenshot, cookie, download-history, tab mutation, or extension reload tools.

For local fixture acceptance and one-off debugging only, set `MCP_BROWSER_CHROME_DEBUG_TOOLS=1` to expose:

`browser_debug_dom`, `browser_reload_extension`, `browser_select_tab`, `browser_open_tab`

These tab tools are not part of the production/default MCP surface. They are intentionally page-visible because opening, selecting, and focusing tabs can fire lifecycle events.

### Snapshot + Ref System

`browser_snapshot` now returns a read-only payload with `viewport`, `document`, and `clickables`; top-level results also carry `tabId` plus `target.{tabId,windowId,url,title}` so external consumers can disambiguate the destination tab/window. The `viewport` block exposes page-level geometry observations (`innerWidth/Height`, `outerWidth/Height`, `scrollX/Y`, `devicePixelRatio`, `screenX/Y` as browser-window metrics, and an optional `visualViewport` with pinch-zoom scale + offsets). These fields are not an authoritative HID screen-coordinate mapping contract; absolute mapping belongs to the external HID layer. Each clickable also carries a stable 16-character `signature`, `hitTestState`, and a randomized `clickPoint` guaranteed to lie inside a currently effective hit region. File-related elements also expose semantic fields such as `type`, `accept`, `multiple`, and `download`. `clickables` are descriptive targets for inspection and querying only; refs are no longer used for browser interaction. Refs may still appear in read-only lookup results from `browser_query_elements` / `browser_get_element`, but they do not drive any action tool. `browser_debug_dom` provides verbose DOM detail only when debug tools are enabled.

### Key Design Constraints

- Chrome 114+ required
- No runtime npm dependencies — pure TypeScript compiled via Vite
- All data stays local — only `mcp/server.mjs` communicates over the network (to the MCP client's AI)
- No synthetic page interaction helpers — the default runtime is intentionally read-only
- No inline event handlers in HTML (CSP) — all listeners via `addEventListener`
- Unix socket path: `path.join(os.tmpdir(), 'browser-mcp.sock')` — never hardcode `/tmp/browser-mcp.sock`
- New builds should normally be applied from `chrome://extensions`; `browser_reload_extension` is debug-only and requires `MCP_BROWSER_CHROME_DEBUG_TOOLS=1`
