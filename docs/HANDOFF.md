# Project Handoff — GPT Browser Agent

> Last updated: 2026-04-02  
> Use this file to resume work on a new machine.

---

## 1. What This Project Is

A Chrome Extension (Manifest V3) that brings "Claude for Chrome"-style AI sidebar functionality to GPT. Core use case: user opens any third-party website (e.g. a recruiting platform), the sidebar reads the page, applies pre-defined Skills, communicates with candidates, screens them against criteria, and collects their info for local export.

Key design principles:
- Runs in user's own browser → shares real login sessions, no cloud browser needed
- All data local-only (`chrome.storage.local`, IndexedDB) — nothing uploaded except AI API calls
- Anti-detection: random delays (800–2500ms), character-by-character input, mouse simulation
- Two AI auth modes: OpenAI API Key (primary) or ChatGPT session cookie (fallback)

---

## 2. Environment Setup

```bash
# Node version
nvm use v20.20.2   # or: export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"

# npm location (adjust if different)
# /Users/<you>/.nvm/versions/node/v20.20.2/bin/npm

cd gpt-browser-agent-ts
npm install
npm run build      # outputs to dist/
npm run typecheck  # TypeScript check only
```

Load in Chrome: `chrome://extensions` → Developer Mode → Load unpacked → select `dist/`

---

## 3. Current Git State

**Main branch:** `main`  
**Active feature branch:** `feat/bug-fixes-auto-debug`  
**Status:** Feature branch is complete and passes build. Not yet merged to main.

### Commits on feature branch (newest first)
```
0a8f6b8  fix: remove dead else branch and guard runAutoDebug against exceptions
f69b07c  feat: one-click parse button per skill to read page and invoke skill
607ab66  feat: save-as-skill modal after successful auto-debug
91a24b6  fix: show correct message when auto-debug AI returns no fix
7f96426  feat: auto-debug loop — 3-round automatic retry with AI fix suggestions
17c34f4  fix: only reset lastError when all actions succeeded
9bbaa51  fix: escHtml covers >, reset lastError on success, require skill trigger
4f786d5  fix: propagate rate limit config from settings to content script
27cfb93  fix: implement screenshot action in content script via background
e12380d  fix: resolve ESM build errors and add SETTINGS_UPDATED listener in sidepanel
```

---

## 4. What Was Completed This Session

### Bug Fixes (all done)
| Bug | Fix |
|-----|-----|
| `SETTINGS_UPDATED` from options page never reached sidepanel | Added `chrome.runtime.onMessage` listener in `sidepanel.ts` |
| Rate limit settings (delay/max) never applied to content script | Added `CONFIGURE_RATE_LIMIT` message type; sidepanel sends on init + settings change; background forwards to content script |
| `screenshot` action in content.ts was a no-op stub | Now sends `TAKE_SCREENSHOT` to background and returns `screenshotDataUrl` |
| `escHtml()` missing `>` escape | Fixed in `settings.ts` |
| `lastError` cleared even on failed action sequence | Guarded with `allSucceeded` flag |
| Skill could be saved with empty trigger (would never activate) | Added validation + alert in `saveSkill()` |
| ESM build error (`vite-plugin-static-copy` is ESM-only) | Added `"type": "module"` to `package.json` |
| HTML script tags referenced built `.js` files instead of source `.ts` | Fixed `sidepanel.html` and `settings.html` to use `./sidepanel.ts` / `./settings.ts` |

### New Features (all done)
| Feature | Description |
|---------|-------------|
| **Auto-debug loop** | When an action fails, AI automatically gets the DOM snapshot, generates a fix, and retries — up to 3 rounds. After 3 rounds, prompts user "是否继续？" |
| **Save-as-Skill modal** | When auto-debug succeeds (all actions eventually pass), pops a modal with pre-filled Skill name (`hostname 操作修复 - date`), trigger, and the working action JSON as instructions. User can edit or confirm. |
| **One-click parse button** | Each Skill card now has a "解析当前页面" button. Clicking it reads the page, applies that Skill's instructions, and streams the AI response — without needing to type in the chat. |

---

## 5. Architecture Reference

### File Roles
| File | Role |
|------|------|
| `src/background.ts` | Service Worker — message routing, ChatGPT session proxy, screenshot capture |
| `src/content.ts` | Injected into every page — DOM snapshots (`@e1`…`@eN`), action execution |
| `src/sidepanel.ts` | Sidebar UI — chat, Skills management, auto-debug loop |
| `src/sidepanel.html` | Sidebar markup + styles |
| `src/settings.ts` | Options page logic |
| `src/settings.html` | Options page markup |
| `src/openai.ts` | OpenAI API client (API Key mode + ChatGPT session mode) |
| `src/store.ts` | `chrome.storage.local` wrapper + default settings |
| `src/rateLimit.ts` | Anti-detection: delays, rate throttle, mouse simulation |
| `src/types.ts` | All TypeScript interfaces and types |

### Message Flow
```
Sidepanel ──→ background ──→ content script
              (routing)      (DOM / actions)

Key message types:
  GET_PAGE_CONTENT       → get DOM snapshot
  EXECUTE_ACTION_IN_TAB  → run a click/fill/scroll/etc
  DEBUG_DOM              → get snapshot with full HTML
  TAKE_SCREENSHOT        → capture visible tab
  CONFIGURE_RATE_LIMIT   → sync delay/max settings to content script
  SETTINGS_UPDATED       → options page notifies sidepanel
```

### Snapshot + Refs System
`content.ts` scans all visible interactive elements, assigns `@e1`, `@e2`... refs per page load. AI uses these refs in action JSON. Refs are ephemeral — regenerated each snapshot call.

### Skills System
Stored in `chrome.storage.local` under `Settings.skills`. Each skill has:
- `trigger`: pipe-separated keywords (`"面试|候选人"`)
- `instructions`: injected into AI system context when trigger matches
- Skills can also be activated via the new "解析当前页面" button

---

## 6. Current Next Task: Tab Targeting + URL Navigation

**In progress.** Plan file: `/Users/vyodels/.claude/plans/curious-yawning-turing.md`

### Problem
The sidepanel always routes to `{ active: true, currentWindow: true }` — unreliable when the sidebar itself has focus. No way to navigate to a URL from within the sidepanel.

### What's being built
- `targetTabId` state in sidepanel — explicit tab targeting
- Tab indicator bar: favicon + title + 🎯 lock / ✕ unlock buttons
- URL navigation bar: input + → button to navigate without leaving sidepanel
- `resolveTab(targetTabId?)` helper in `background.ts` — all 4 handlers use it
- `GET_ACTIVE_TAB` new message type

### Files touched
`src/types.ts`, `src/background.ts`, `src/sidepanel.html`, `src/sidepanel.ts`

---

## 7. Upcoming Task: Data Collection System

**Not started.** After tab targeting is complete.

**Decisions:**
1. **Fields**: AI auto-extracts by default; Skill-defined fields take priority
2. **Storage**: IndexedDB
3. **Export**: JSON + CSV local download
4. **Trigger**: Always user-controlled (button or chat), never automatic

**Suggested plan:**
- `src/collector.ts` — `CollectedRecord` type, IndexedDB read/write, JSON/CSV export
- `src/types.ts` — add `CollectedRecord` interface
- `src/sidepanel.html` — new "📊 数据" tab panel
- `src/sidepanel.ts` — wire up collector + export buttons

```typescript
interface CollectedRecord {
  id: string
  timestamp: number
  pageUrl: string
  pageTitle: string
  fields: Record<string, string>
  rawText?: string
  skillUsed?: string
}
```

---

## 8. Key Product Decisions (for context)

| Decision | Choice |
|----------|--------|
| Page parsing trigger | **Always user-triggered** — never automatic on tab load |
| Parse mode | Via Skill "解析当前页面" button OR natural language in chat |
| Auto-debug rounds | **3 rounds max**, then prompt user "是否继续自动调试？" |
| Save-as-Skill after debug | **Popup with pre-filled name**, user can edit then confirm |
| Data field extraction | AI-inferred by default; Skill-defined fields take priority |
| Export format | JSON + CSV download to local file |
| Auth | Dual mode: OpenAI API Key (preferred) / ChatGPT session cookie |
| Data storage | `chrome.storage.local` for settings/skills; IndexedDB for collected records |

---

## 9. How to Resume on a New Machine

```bash
# 1. Clone / pull repo
git clone <repo-url>
cd gpt-browser-agent-ts

# 2. Set up Node
nvm install v20.20.2
nvm use v20.20.2

# 3. Install dependencies
npm install

# 4. Switch to feature branch
git checkout feat/bug-fixes-auto-debug

# 5. Build
npm run build

# 6. Load in Chrome
# chrome://extensions → Developer Mode → Load unpacked → select dist/

# 7. Next step
# Tab targeting feature is in progress (plan: ~/.claude/plans/curious-yawning-turing.md)
# After that: data collection system (IndexedDB + CSV export)
```

---

## 10. Tools & Workflow Used

- **Build**: Vite 8 + TypeScript 5.4, multi-entry (background/content/sidepanel/settings); `"type": "module"` required in package.json (ESM-only deps)
- **Skills used**: `superpowers:writing-plans` → `superpowers:subagent-driven-development` → spec review + code quality review per task
- **Review pattern**: Each task gets spec compliance review (must pass before quality review), then code quality review. Issues go back to implementer before marking complete.
- **Commit style**: one commit per task, imperative message (`fix:` / `feat:` prefix)
