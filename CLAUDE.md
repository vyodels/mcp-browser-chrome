# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Watch mode build (for development)
npm run build      # Production build → dist/
npm run typecheck  # TypeScript type checking without emit
```

To load in Chrome: go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", select the `dist/` folder.

## Architecture

Chrome Extension (Manifest V3), AI-powered browser agent. **No runtime npm dependencies** — pure TypeScript compiled via Vite.

### Source Files

| File | Role |
|------|------|
| `src/background.ts` | Service Worker — routes all messages, handles tab management, screenshots, file downloads |
| `src/content.ts` | Injected into every page — DOM snapshot with `@e1/@e2` refs, executes agent actions |
| `src/sidepanel.ts` | Sidebar UI — Agent Loop controller, workflow runner, intervention UI |
| `src/settings.ts` | Options page — API config, rate limit sliders, saved prompts |
| `src/tools.ts` | Tool definitions (JSON Schema) + local execution router for all 11 agent tools |
| `src/workflow.ts` | Workflow data structures, step system prompt builder, default workflow templates |
| `src/tabManager.ts` | Chrome TabGroups API helpers — create/manage task tab groups |
| `src/openai.ts` | AI client — `chat()` for streaming, `chatWithTools()` for Tool Calling Loop |
| `src/types.ts` | All global types — Settings, Workflow, LoopState, ToolCallRequest, etc. |
| `src/store.ts` | `chrome.storage.local` wrapper, DEFAULT_SETTINGS with built-in workflows |
| `src/rateLimit.ts` | Anti-detection: random delays, rate limiting, mouse simulation |

### Agent Loop (core pattern)

The agent operates as a **Tool Calling Loop** — not text parsing:

```
User starts task → runAgentLoop():
  while running:
    chatWithTools(messages, TOOL_DEFINITIONS, settings)
      → AI returns tool_calls (e.g. get_page_content, click_element)
    executeTool(name, args, ctx) for each call
      → if ask_user: pause loop, show intervention UI, wait for user input
    push tool results back to messages
    repeat until no tool_calls → task complete
```

Loop states: `idle → running → (paused | waiting_user) → running → completed/error`

### 11 Agent Tools (`src/tools.ts`)

| Tool | Purpose |
|------|---------|
| `get_page_content` | DOM snapshot with URL, text, interactive elements |
| `click_element` | Click by `@eN` ref (simulated mouse) |
| `fill_input` | Fill input char-by-char |
| `navigate_to` | Open URL in target tab |
| `scroll_page` | Scroll up/down |
| `press_key` | Keyboard event (Enter, Tab, Escape…) |
| `wait_ms` | Wait for page load / animation |
| `take_screenshot` | Capture visible tab |
| `download_data` | Save JSON/CSV/TXT to `~/Downloads/browser-agent-files/<task>/` |
| `open_new_tab` | Open new tab in agent's tab group |
| `ask_user` | **Pause loop** and show user intervention UI |

### Tool Calling API Format

**OpenAI:** request includes `tools: [...]`, response parsed for `choices[0].message.tool_calls`.  
Tool results sent as `{ role: "tool", tool_call_id, content }`.

**Anthropic:** request includes `tools: [...]`, response parsed for `content[].type === "tool_use"`.  
Tool results sent as `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`.

Both are handled in `chatWithTools()` in `src/openai.ts`.

### Message Bus

All IPC: `Sidepanel → Background → Content Script` via `chrome.runtime.sendMessage`.

Key message types: `GET_PAGE_CONTENT`, `EXECUTE_ACTION_IN_TAB`, `TAKE_SCREENSHOT`, `OPEN_TAB`, `CREATE_TAB_GROUP`, `CLOSE_TAB_GROUP`, `DOWNLOAD_DATA`, `GET_ALL_TABS`, `SETTINGS_UPDATED`, `CONFIGURE_RATE_LIMIT`.

### Workflow System

Workflows are sequences of `WorkflowStep` objects stored in `Settings.workflows`. Each step has:
- `instructions` — prompt injected as system message for that step
- `intervention` — `none | optional | required` (controls whether loop pauses between steps)
- `completionHint` — how the AI knows the step is done

Two built-in workflow templates in `store.ts`: BOSS直聘招聘 and 小红书内容采集.

### Storage

All settings (including workflows) persisted to `chrome.storage.local` via `src/store.ts`.  
Downloaded files go through `chrome.downloads` API → `~/Downloads/browser-agent-files/`.

### Snapshot + Refs System

`content.ts` scans visible interactive elements on each `get_page_content` call, assigns ephemeral `@e1`, `@e2`... refs. Refs are regenerated on every snapshot — do not persist across calls.

## Key Design Constraints

- Chrome 114+ required (Side Panel API)
- **Apple light theme** — `#f5f5f7` bg, `#007aff` accent, `rgba(255,255,255,0.85)` cards, `backdrop-filter: blur`
- All data local-only (`chrome.storage.local` + `chrome.downloads`) — only the configured AI API receives network traffic
- `src/rateLimit.ts` anti-detection behavior is intentional — do not remove or bypass it
- No ChatGPT session mode — only OpenAI-compatible and Anthropic API Key formats
- Required permissions: `activeTab, tabs, scripting, storage, sidePanel, desktopCapture, tabGroups, downloads`
