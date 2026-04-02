---
name: Product decisions for GPT Browser Agent
description: Key product decisions made by the user for feature design, so Claude doesn't re-ask settled questions
type: project
---

Decisions locked in as of 2026-04-02:

- **Page parsing**: Always user-triggered. Never automatic on tab load. Via Skill button or chat.
- **Auto-debug rounds**: Max 3 rounds, then prompt user "是否继续自动调试？"
- **Save-as-Skill after debug**: Popup with pre-generated name (format: `hostname 操作修复 - date`). User edits or confirms.
- **Data fields**: AI auto-extracts if no Skill defines fields. Skill-defined fields take priority.
- **Data storage**: IndexedDB for collected records (persists across sidebar close). chrome.storage.local for settings/skills only.
- **Export**: JSON + CSV download to local file.
- **Auth**: Dual mode — OpenAI API Key (primary) / ChatGPT session cookie (fallback).
- **Workflow**: No multi-browser support. Chrome only. No server-side component. All local.

**Why:** User's main use case is recruiting: open a platform like Boss直聘/LinkedIn, use Skills to screen candidates, collect contact info + resume links, export to local file. Needs real browser session (no cloud browser).
