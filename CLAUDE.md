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

This is a Chrome Extension (Manifest V3) implementing an AI-powered browser agent. It has **no runtime npm dependencies** — pure TypeScript compiled via Vite.

### Four Entry Points (multi-entry Vite build)

| Entry | Role |
|-------|------|
| `src/background.ts` | Service Worker — routes all messages between sidepanel and content script, handles ChatGPT session proxy, manages tab capture |
| `src/content.ts` | Injected into every page — takes DOM snapshots (assigns `@e1`, `@e2`... refs to interactive elements), executes AI actions |
| `src/sidepanel.ts` | Sidebar UI — chat interface, Skills management, debug panel |
| `src/settings.ts` | Options page — auth config, model selection, rate limit sliders, saved prompts |

### Message Bus

All IPC goes through `chrome.runtime.sendMessage`. Messages always travel: `Sidepanel → Background → Content Script` (content script cannot talk directly to sidepanel).

Key message types: `GET_PAGE_CONTENT`, `EXECUTE_ACTION`, `DEBUG_DOM`, `TAKE_SCREENSHOT`, `SETTINGS_UPDATED`.

### Dual Auth Modes

- **API Key mode**: Direct calls to `api.openai.com` with user's key
- **ChatGPT session mode**: Background silently opens a `chatgpt.com` tab, uses `chrome.scripting.executeScript` to extract `accessToken`, then uses that token to call the same API

### Snapshot + Refs System (`content.ts`)

When the sidepanel requests page content, `content.ts` scans all visible interactive elements (`a[href]`, `button`, `input`, `textarea`, `select`, `[role="button"]`), assigns sequential `@e1`, `@e2`... references, and returns a structured snapshot. The AI uses these refs in its action JSON. Refs are ephemeral — re-generated on each snapshot call.

### Action Execution Flow

1. AI response is parsed for JSON action arrays
2. Each action (`click`, `fill`, `scroll`, `navigate`, etc.) is sent to `content.ts` via background
3. Content script executes with anti-detection delays (random 800–2500ms, char-by-char input, mouse simulation)
4. New snapshot returned after each action; on failure, a debug snapshot with full HTML is captured

### Storage Schema

All settings persisted to `chrome.storage.local` via `src/store.ts`. The `Settings` interface in `src/types.ts` is the canonical schema — includes `authMode`, `apiKey`, `model`, `systemPrompt`, `actionDelay`, `maxActionsPerMinute`, `prompts[]`, `skills[]`.

### Skills System

Skills are user-defined instruction sets stored in `Settings.skills`. When user input contains a skill's `trigger` keywords (pipe-separated), those `instructions` are injected into the AI system prompt. Three default skills ship with the extension: DOM Debugger, Smart Reply, Form Assistant.

## Key Design Constraints

- The extension targets Chrome 114+ (Side Panel API minimum)
- Dark theme only; primary accent color `#10a37f`
- All data is local-only (`chrome.storage.local`) — nothing is sent to any server except the configured AI API endpoint
- The rate limiting system in `src/rateLimit.ts` is intentional anti-detection behavior — do not remove or bypass it
