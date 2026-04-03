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
| `src/sidepanel.ts` | Sidebar UI — Agent Loop controller, workflow runner, 4-layer memory system, sub-agent |
| `src/settings.ts` | Options page — full CRUD for API config, workflows, skills, prompts |
| `src/tools.ts` | Tool definitions (JSON Schema) + local execution router for all 19 agent tools |
| `src/workflow.ts` | Workflow data structures, step system prompt builder (injects context + memory + skills) |
| `src/tabManager.ts` | Chrome TabGroups API helpers — create/manage task tab groups |
| `src/openai.ts` | AI client — `chat()` for streaming, `chatWithTools()` for Tool Calling Loop |
| `src/types.ts` | All global types — Settings, Workflow, MemoryEntry, LoopState, ToolCallRequest, etc. |
| `src/store.ts` | `chrome.storage.local` wrapper, DEFAULT_SETTINGS with built-in workflows |
| `src/rateLimit.ts` | Anti-detection: random delays, rate limiting, mouse simulation |

### Agent Loop (core pattern)

The agent operates as a **Tool Calling Loop** — not text parsing:

```
User starts task → runAgentLoop():
  while running:
    chatWithTools(loopMessages, TOOL_DEFINITIONS, settings)
      → AI returns tool_calls (e.g. get_page_content, click_element)
    executeTool(name, args, ctx) for each call
      → if ask_user: pause loop, show intervention UI, wait for user input
    push tool results back to loopMessages (compressed for large tools)
    trim loopMessages sliding window if > MAX_LOOP_MESSAGES (40)
    repeat until no tool_calls → step complete
  if workflow: advance to next step, reset loopMessages, inject memory
```

Loop states: `idle → running → (paused | waiting_user) → running → completed/error`

### 19 Agent Tools (`src/tools.ts`)

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
| `log_candidate` | Write/update a candidate record (recruiting workflows) |
| `log_record` | Write/update a workspace record using workflow's custom schema |
| `save_skill` | Save a discovered solution as a reusable Skill (pending user approval) |
| `evolve_schema` | Propose a new field to add to the workflow's workspace schema |
| `save_memory` | Write key-value to session or persistent memory layer |
| `list_memory` | List all current memory entries (both layers) |
| `delete_memory` | Delete a memory entry by key and layer |
| `run_sub_agent` | Spawn an isolated sub-agent loop for a specific sub-task |

### 4-Layer Context / Memory System

```
Layer 0: Workflow Definition (static, user-defined)
  → workflow.context + workspace schema + step instructions
  → injected every step, AI cannot modify

Layer 1: Persistent Memory (chrome.storage.local, cross-session)
  → settings.memoryEntries[], keyed by workflowId
  → survives browser restarts; typical: DOM tricks, site-specific knowledge
  → AI writes via save_memory(key, value, "persistent")
  → refreshed from storage at each step transition

Layer 2: Session Memory (in-memory, this run only)
  → sessionMemory{} variable, reset on workflow stop
  → typical: candidate decisions, current progress
  → AI writes via save_memory(key, value) [default]

Layer 3: Step Context (ephemeral, current step only)
  → loopMessages[] — compressed tool call history
  → previousStepSummary — injected into next step's system prompt
  → large tool results (get_page_content, take_screenshot) compressed:
      keep first 800 chars + last 600 chars, drop middle if > 2000 chars
  → sliding window: drop oldest tool exchange pairs when > 40 messages
```

Injection order in system prompt per step:
```
step instructions → workflow.context → workspace schema →
📚 persistent memory → 🧠 session memory → previous step summary → completion hint
```

### Sub-Agent Pattern

`run_sub_agent(task, context)` spawns an isolated `runSubAgentLoop()` in `sidepanel.ts`:
- Has its own `subMessages[]` array — does not pollute main `loopMessages`
- Inherits all tools and session memory from parent ctx
- Compresses its own history with the same strategy
- Returns a text summary to the orchestrator agent
- Use case: processing each recruiting candidate independently

### Workflow System

Workflows (`Workflow`) = ordered `WorkflowStep[]` stored in `Settings.workflows`.

Each step:
- `instructions` — injected as system message for that step
- `intervention` — `none | optional | required` (whether loop pauses between steps)
- `completionHint` — how the AI knows the step is done
- `skillIds?` — references to Skills whose instructions are injected into this step

`Workflow` also has:
- `context` — global background (candidate criteria, goals) injected every step
- `workspace` — custom `WorkspaceSchema` (field definitions for `log_record`)

`buildStepSystemPrompt()` in `workflow.ts` assembles the full system prompt from all these sources.

### Skill System

Skills are reusable instruction blocks stored in `Settings.skills`. Sources:
- `builtin` — shipped with extension
- `user` — created in settings page
- `ai_generated` — created by AI via `save_skill`, status `pending_review` until user approves in chat banner

Skills can be referenced per step (`WorkflowStep.skillIds`) and their instructions are injected into the step's system prompt.

### Tool Calling API Format

**OpenAI:** request includes `tools: [...]`, response parsed for `choices[0].message.tool_calls`.
Tool results sent as `{ role: "tool", tool_call_id, content }`.

**Anthropic:** request includes `tools: [...]`, response parsed for `content[].type === "tool_use"`.
Tool results sent as `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`.

Both handled in `chatWithTools()` in `src/openai.ts`.

### Message Bus

All IPC: `Sidepanel → Background → Content Script` via `chrome.runtime.sendMessage`.

Key message types: `GET_PAGE_CONTENT`, `EXECUTE_ACTION_IN_TAB`, `TAKE_SCREENSHOT`, `OPEN_TAB`, `OPEN_TAB_AND_WAIT`, `NAVIGATE_TAB`, `CREATE_TAB_GROUP`, `CLOSE_TAB_GROUP`, `DOWNLOAD_DATA`, `GET_ALL_TABS`, `SETTINGS_UPDATED`, `CONFIGURE_RATE_LIMIT`.

### Storage Schema (`Settings`)

```typescript
Settings {
  baseUrl, apiKey, apiFormat, model, systemPrompt
  actionDelay, maxActionsPerMinute
  prompts: SavedPrompt[]
  skills: Skill[]
  workflows: Workflow[]           // includes workspace schema per workflow
  activityLog: ActivityEntry[]    // downloads + navigations (last 200)
  candidates: CandidateEntry[]    // recruiting workflow candidate records
  workspaceRecords: WorkspaceRecord[]  // log_record data per workflow
  memoryEntries: MemoryEntry[]    // Layer 1 persistent memory
}
```

### Snapshot + Refs System

`content.ts` scans visible interactive elements on each `get_page_content` call, assigns ephemeral `@e1`, `@e2`... refs. Refs are regenerated on every snapshot — do not persist across calls.

## Key Design Constraints

- Chrome 114+ required (Side Panel API)
- **Apple light theme** — `#f5f5f7` bg, `#007aff` accent, `rgba(255,255,255,0.85)` cards, `backdrop-filter: blur`
- All data local-only (`chrome.storage.local` + `chrome.downloads`) — only the configured AI API receives network traffic
- `src/rateLimit.ts` anti-detection behavior is intentional — do not remove or bypass it
- No inline event handlers in HTML (CSP) — all listeners via `addEventListener` in `.ts` files
- No ChatGPT session mode — only OpenAI-compatible and Anthropic API Key formats
- Required permissions: `activeTab, tabs, scripting, storage, sidePanel, desktopCapture, tabGroups, downloads`
