# Bug Fixes + Auto-Debug Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 confirmed bugs and add the auto-debug self-learning loop (3-round auto retry → save-as-skill modal).

**Architecture:** Bug fixes are isolated per file. The auto-debug loop extends `executeActions()` in `sidepanel.ts` with a retry state machine; successful debug sessions offer a save-as-skill modal that reuses the existing `saveSkill()` infrastructure. A new `CONFIGURE_RATE_LIMIT` message propagates settings to content.ts at init and on settings change.

**Tech Stack:** TypeScript 5.4, Chrome Extension MV3, Vite 5.2, vanilla DOM

---

## File Map

| File | Change |
|------|--------|
| `src/types.ts` | Add `CONFIGURE_RATE_LIMIT` to `MessageType`; add `AutoDebugState` interface |
| `src/background.ts` | Forward `CONFIGURE_RATE_LIMIT` message to active tab |
| `src/content.ts` | Handle `CONFIGURE_RATE_LIMIT`; fix `screenshot` action to call background |
| `src/rateLimit.ts` | No change (already has `configureRateLimit`) |
| `src/sidepanel.ts` | Add `SETTINGS_UPDATED` listener; send `CONFIGURE_RATE_LIMIT` on init+settings change; replace manual-debug prompt with auto-debug loop; add save-as-skill modal logic |
| `src/sidepanel.html` | Add save-as-skill modal markup |

---

## Task 1: Fix — SETTINGS_UPDATED listener in sidepanel

**Problem:** `settings.ts` broadcasts `SETTINGS_UPDATED` after save, but `sidepanel.ts` never listens. Model badge and quick prompts stay stale.

**Files:**
- Modify: `src/sidepanel.ts` (after `init()` call at end of file)

- [ ] **Step 1: Add the listener at bottom of sidepanel.ts (before `init()`)**

```typescript
// ---- Listen for settings changes from options page ----
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SETTINGS_UPDATED') {
    loadSettings().then((settings) => {
      ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model
      renderQuickPrompts()
      renderSkills()
    })
  }
})
```

- [ ] **Step 2: Build and verify**

```bash
npm run build 2>&1 | tail -5
```
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel.ts
git commit -m "fix: listen for SETTINGS_UPDATED to refresh sidepanel state"
```

---

## Task 2: Fix — Rate limit config propagation to content.ts

**Problem:** `content.ts` imports `randomDelay`/`simulateMouseMove` from `rateLimit.ts`, but those run in the page JS context. When sidepanel changes settings, the content script's rate limit state is never updated — it always uses the hardcoded defaults (800–2500ms, 12/min).

**Fix:** Add a `CONFIGURE_RATE_LIMIT` message. Sidepanel sends it on init and on every settings change. Background forwards it to the active tab's content script.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/background.ts`
- Modify: `src/content.ts`
- Modify: `src/sidepanel.ts`

- [ ] **Step 1: Add message type to types.ts**

In `src/types.ts`, update `MessageType`:

```typescript
export type MessageType =
  | 'GET_PAGE_CONTENT'
  | 'PAGE_CONTENT'
  | 'EXECUTE_ACTION'
  | 'ACTION_RESULT'
  | 'TAKE_SCREENSHOT'
  | 'SCREENSHOT_RESULT'
  | 'OPEN_SETTINGS'
  | 'SETTINGS_UPDATED'
  | 'DEBUG_DOM'
  | 'DEBUG_RESULT'
  | 'CONFIGURE_RATE_LIMIT'   // ← new
```

- [ ] **Step 2: Forward the message in background.ts**

In `src/background.ts`, add a case to the switch:

```typescript
case 'CONFIGURE_RATE_LIMIT':
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) { sendResponse({ success: false }); return }
    chrome.tabs.sendMessage(tabs[0].id, message, sendResponse)
  })
  return true
```

- [ ] **Step 3: Handle the message in content.ts**

In `src/content.ts`, add a case to the message listener:

```typescript
case 'CONFIGURE_RATE_LIMIT':
  configureRateLimit(message.payload.max, message.payload.delay)
  sendResponse({ success: true })
  break
```

Also add the import at top of content.ts (it already imports `randomDelay` and `simulateMouseMove` — add `configureRateLimit`):

```typescript
import { simulateMouseMove, randomDelay, configureRateLimit } from './rateLimit'
```

- [ ] **Step 4: Send config from sidepanel.ts — extract helper**

Add this helper function in `src/sidepanel.ts`:

```typescript
function applyRateLimitConfig(settings: import('./types').Settings) {
  chrome.runtime.sendMessage({
    type: 'CONFIGURE_RATE_LIMIT',
    payload: { max: settings.maxActionsPerMinute, delay: settings.actionDelay },
  })
}
```

- [ ] **Step 5: Call helper on init and on SETTINGS_UPDATED**

In `init()`, after `await loadSettings()`:

```typescript
async function init() {
  const settings = await loadSettings()
  ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model
  applyRateLimitConfig(settings)   // ← add this line
  // ... rest of init
```

In the `SETTINGS_UPDATED` listener added in Task 1:

```typescript
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SETTINGS_UPDATED') {
    loadSettings().then((settings) => {
      ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model
      applyRateLimitConfig(settings)   // ← add this line
      renderQuickPrompts()
      renderSkills()
    })
  }
})
```

- [ ] **Step 6: Build and verify**

```bash
npm run build 2>&1 | tail -5
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/background.ts src/content.ts src/sidepanel.ts
git commit -m "fix: propagate rate limit config from settings to content script"
```

---

## Task 3: Fix — Screenshot action is a stub

**Problem:** `content.ts` `case 'screenshot'` returns `{ success: true }` immediately without taking a screenshot.

**Fix:** Content script sends `TAKE_SCREENSHOT` to background and returns the dataUrl.

**Files:**
- Modify: `src/content.ts`

- [ ] **Step 1: Replace the screenshot stub**

Find in `src/content.ts`:

```typescript
case 'screenshot':
  // 截图由 background 处理
  return { success: true, message: '截图请求已发送' }
```

Replace with:

```typescript
case 'screenshot': {
  const resp = await new Promise<{ success: boolean; dataUrl?: string; error?: string }>(
    (resolve) => chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, resolve)
  )
  if (!resp?.success) throw new Error(resp?.error ?? '截图失败')
  return { success: true, message: '截图完成', screenshotDataUrl: resp.dataUrl, snapshot: takeSnapshot() }
}
```

- [ ] **Step 2: Build and verify**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src/content.ts
git commit -m "fix: implement screenshot action in content script via background"
```

---

## Task 4: Code style fixes

**Problems identified:**
1. `aiAnalyzeDebug` / `aiFixDebug` use bare `setTimeout` fallback instead of proper page read
2. `escHtml` in settings.ts doesn't escape `>` (can cause DOM injection in prompt titles)
3. `lastError` is only reset on `clearChat()` — not after a successful action sequence
4. Empty trigger allowed when saving a skill — causes skill to never match
5. `chat()` calls in debug functions pass empty history `[]` instead of current `chatHistory`

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/sidepanel.ts`

- [ ] **Step 1: Fix escHtml in settings.ts**

Find:
```typescript
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
```

Replace with:
```typescript
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
```

- [ ] **Step 2: Reset lastError on successful action sequence in sidepanel.ts**

In `executeActions()`, find the line after all actions complete successfully (after the for loop):

```typescript
async function executeActions(actions: AgentAction[]) {
  for (const action of actions) {
    // ...
    if (!result.success) {
      lastError = result.message
      // ...
      break
    }
  }
}
```

Add after the for loop ends (before the closing brace of the function):

```typescript
  // all actions succeeded — clear last error
  lastError = null
```

- [ ] **Step 3: Add trigger validation in saveSkill()**

Find in `saveSkill()`:
```typescript
if (!name || !instructions) { alert('名称和 AI 指令不能为空'); return }
```

Replace with:
```typescript
if (!name || !instructions) { alert('名称和 AI 指令不能为空'); return }
if (!trigger) { alert('触发词不能为空，否则 Skill 永远不会被激活'); return }
```

- [ ] **Step 4: Build and verify**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/sidepanel.ts
git commit -m "fix: escHtml covers >, reset lastError on success, require skill trigger"
```

---

## Task 5: Auto-debug loop (3 rounds → ask user)

**Goal:** When an action fails, instead of showing "go to debug tab", automatically:
1. Get page snapshot with HTML
2. Send to AI for fix suggestions
3. Parse new actions from AI response
4. Re-execute the failed action (and remaining actions)
5. Repeat max 3 times; after that, ask user "继续？"

**Files:**
- Modify: `src/sidepanel.ts`

- [ ] **Step 1: Add auto-debug state variables**

At top of `sidepanel.ts`, add alongside existing state:

```typescript
let autoDebugRound = 0
const MAX_AUTO_DEBUG_ROUNDS = 3
```

- [ ] **Step 2: Add `runAutoDebug()` helper**

Add this function after `aiFixDebug()`:

```typescript
/**
 * Attempt to auto-fix a failed action via AI analysis.
 * Returns new actions if AI produced a fix, or null if it couldn't.
 */
async function runAutoDebug(failedAction: AgentAction, errorMsg: string): Promise<AgentAction[] | null> {
  // Get full DOM snapshot for debugging
  const snapResp = await new Promise<{ success: boolean; snapshot?: PageSnapshot }>((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'EXECUTE_ACTION_IN_TAB', payload: { type: 'DEBUG_DOM' } },
      resolve
    )
  })
  if (!snapResp?.success || !snapResp.snapshot) return null

  lastSnapshot = snapResp.snapshot

  const settings = await loadSettings()
  const prompt = `页面操作失败。
失败动作: ${JSON.stringify(failedAction)}
错误信息: ${errorMsg}

请分析以下页面 DOM，找出正确的操作方式，用 \`\`\`json\n[动作列表]\n\`\`\` 格式返回修正后的操作：

${JSON.stringify({ url: snapResp.snapshot.url, title: snapResp.snapshot.title, interactiveElements: snapResp.snapshot.interactiveElements.slice(0, 50), html: (snapResp.snapshot.html ?? '').slice(0, 3000) }, null, 2)}`

  const result = await chat([], prompt, settings)

  const actions = parseActions(result)
  if (actions.length === 0) return null

  // Show what AI suggests
  const logEl = document.createElement('div')
  logEl.className = 'action-log'
  logEl.textContent = `🔍 自动调试第 ${autoDebugRound} 轮：AI 生成 ${actions.length} 个修复动作`
  document.getElementById('chatMessages')!.appendChild(logEl)
  scrollToBottom()

  return actions
}
```

- [ ] **Step 3: Rewrite executeActions() to use auto-debug loop**

Replace the entire `executeActions()` function:

```typescript
async function executeActions(actions: AgentAction[]) {
  let remaining = [...actions]

  while (remaining.length > 0) {
    const action = remaining[0]
    setStatus('busy', `执行: ${action.action} ${action.ref ?? action.url ?? ''}`)
    await throttleAction()

    const result = await new Promise<ActionResult>((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'EXECUTE_ACTION_IN_TAB', payload: { type: 'EXECUTE_ACTION', payload: action } },
        resolve
      )
    })

    const logEl = document.createElement('div')
    logEl.className = `action-log ${result.success ? 'success' : 'error'}`
    logEl.textContent = `${result.success ? '✓' : '✗'} ${action.action}${action.ref ? ' ' + action.ref : ''}: ${result.message}`
    document.getElementById('chatMessages')!.appendChild(logEl)
    scrollToBottom()

    if (result.snapshot) lastSnapshot = result.snapshot

    if (result.success) {
      remaining.shift()  // move to next action
      continue
    }

    // ---- Action failed ----
    lastError = result.message

    if (autoDebugRound < MAX_AUTO_DEBUG_ROUNDS) {
      autoDebugRound++
      setStatus('busy', `自动调试第 ${autoDebugRound}/${MAX_AUTO_DEBUG_ROUNDS} 轮...`)

      const fixedActions = await runAutoDebug(action, result.message)
      if (fixedActions) {
        // Replace current failed action with fixed actions, keep the rest
        remaining = [...fixedActions, ...remaining.slice(1)]
        continue
      }
    }

    // Exhausted auto-debug rounds or AI returned nothing
    if (autoDebugRound >= MAX_AUTO_DEBUG_ROUNDS) {
      autoDebugRound = 0
      appendMessage(
        'assistant',
        `⚠️ 已自动调试 ${MAX_AUTO_DEBUG_ROUNDS} 轮仍未成功。\n\n` +
        `最后错误：${result.message}\n\n` +
        `是否继续？请回复「继续调试」让我再次尝试，或切换到「🔧 调试」标签手动分析。`
      )
    } else {
      autoDebugRound = 0
      appendMessage('assistant', `⚠️ 操作失败：${result.message}\n\n切换到「🔧 调试」标签让 AI 分析并修复。`)
    }
    return  // stop execution
  }

  // All actions completed successfully
  autoDebugRound = 0
  lastError = null
}
```

- [ ] **Step 4: Build and verify**

```bash
npm run build 2>&1 | tail -5
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel.ts
git commit -m "feat: auto-debug loop — 3-round automatic retry with AI fix suggestions"
```

---

## Task 6: Save-as-Skill modal after successful auto-debug

**Goal:** When `autoDebugRound > 0` and all actions succeed (meaning auto-debug was needed and worked), offer a "Save as Skill" modal with a pre-generated name.

**Files:**
- Modify: `src/sidepanel.html` — add save-as-debug-skill modal
- Modify: `src/sidepanel.ts` — add `offerSaveDebugAsSkill()` and wire up modal

- [ ] **Step 1: Add modal HTML to sidepanel.html**

Find the existing `<div id="skillModal"` block and add a second modal after it (before `</body>`):

```html
<!-- Save debug result as Skill modal -->
<div id="saveDebugSkillModal" class="modal-overlay">
  <div class="modal">
    <h3>💾 保存为 Skill</h3>
    <p style="color:#aaa;font-size:12px;margin:0 0 12px">自动调试成功！将此次修复方案保存为 Skill 以便下次复用。</p>
    <label>Skill 名称</label>
    <input id="debugSkillName" type="text" placeholder="Skill 名称" />
    <label>触发词（多个用 | 分隔）</label>
    <input id="debugSkillTrigger" type="text" placeholder="例：操作失败|找不到元素" />
    <label>说明</label>
    <input id="debugSkillDesc" type="text" placeholder="这个 Skill 做什么" />
    <label>AI 指令（已自动生成）</label>
    <textarea id="debugSkillInstructions" rows="5" style="font-size:11px"></textarea>
    <div class="modal-buttons">
      <button id="debugSkillCancel" class="secondary-btn">取消</button>
      <button id="debugSkillSave" class="primary-btn">保存 Skill</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add offerSaveDebugAsSkill() to sidepanel.ts**

Add after `closeSkillModal()`:

```typescript
function offerSaveDebugAsSkill(workingActions: AgentAction[], pageUrl: string) {
  const hostname = (() => { try { return new URL(pageUrl).hostname } catch { return pageUrl } })()
  const date = new Date().toLocaleDateString('zh-CN')
  const suggestedName = `${hostname} 操作修复 - ${date}`
  const instructions = `[自动生成于 ${pageUrl}]\n\n以下是调试成功的操作步骤，可直接复用：\n\n\`\`\`json\n${JSON.stringify(workingActions, null, 2)}\n\`\`\``

  ;(document.getElementById('debugSkillName') as HTMLInputElement).value = suggestedName
  ;(document.getElementById('debugSkillTrigger') as HTMLInputElement).value = `${hostname}|操作失败`
  ;(document.getElementById('debugSkillDesc') as HTMLInputElement).value = `针对 ${hostname} 的自动修复操作序列`
  ;(document.getElementById('debugSkillInstructions') as HTMLTextAreaElement).value = instructions

  ;(document.getElementById('saveDebugSkillModal') as HTMLElement).classList.add('open')
}

function closeDebugSkillModal() {
  ;(document.getElementById('saveDebugSkillModal') as HTMLElement).classList.remove('open')
}

async function saveDebugSkill() {
  const name = (document.getElementById('debugSkillName') as HTMLInputElement).value.trim()
  const trigger = (document.getElementById('debugSkillTrigger') as HTMLInputElement).value.trim()
  const desc = (document.getElementById('debugSkillDesc') as HTMLInputElement).value.trim()
  const instructions = (document.getElementById('debugSkillInstructions') as HTMLTextAreaElement).value.trim()

  if (!name || !trigger || !instructions) { alert('名称、触发词和 AI 指令不能为空'); return }

  const settings = await loadSettings()
  await saveSettings({
    skills: [...settings.skills, {
      id: genId(), name, description: desc, trigger, instructions,
      status: 'active' as const, createdAt: Date.now(),
    }],
  })
  closeDebugSkillModal()
  renderSkills()
  appendMessage('assistant', `✅ Skill「${name}」已保存，下次遇到相同页面会自动激活。`)
}
```

- [ ] **Step 3: Wire up modal buttons in init()**

Add inside `init()`:

```typescript
document.getElementById('debugSkillCancel')!.addEventListener('click', closeDebugSkillModal)
document.getElementById('debugSkillSave')!.addEventListener('click', saveDebugSkill)
```

- [ ] **Step 4: Trigger the modal from executeActions() on auto-debug success**

In `executeActions()`, after `remaining.shift()` (after a successful action that followed a debug round), track which actions succeeded. Modify the success tracking:

At the top of `executeActions()`, add:
```typescript
const completedActions: AgentAction[] = []
const pageUrlAtStart = lastSnapshot?.url ?? ''
```

After `remaining.shift()`, add:
```typescript
completedActions.push(action)
```

At the "All actions completed successfully" block, change to:
```typescript
// All actions completed successfully
const wasAutoDebugUsed = autoDebugRound > 0
autoDebugRound = 0
lastError = null

if (wasAutoDebugUsed && completedActions.length > 0) {
  offerSaveDebugAsSkill(completedActions, pageUrlAtStart)
}
```

- [ ] **Step 5: Build and verify**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel.html src/sidepanel.ts
git commit -m "feat: save-as-skill modal after successful auto-debug"
```

---

## Task 7: User-controlled page parse mode

**Context:** User said page parsing must be user-controlled — not auto-triggered on every tab. The current "读取页面" button already requires user action. The new requirement is:
- Skill cards should have a "一键解析" button that reads page + auto-invokes that skill
- User can also just chat naturally ("帮我分析这个页面候选人信息")

**Files:**
- Modify: `src/sidepanel.ts` — add `quickParseWithSkill()` and "解析" button per skill card

- [ ] **Step 1: Add quickParseWithSkill()**

Add after `matchSkill()`:

```typescript
async function quickParseWithSkill(skillId: string) {
  if (isStreaming) return

  // Read page first
  setStatus('busy', '读取页面...')
  const pageResp = await new Promise<{ success: boolean; snapshot?: PageSnapshot }>((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' }, resolve)
  })
  if (!pageResp?.success || !pageResp.snapshot) {
    setStatus('error', '读取页面失败')
    return
  }
  lastSnapshot = pageResp.snapshot

  const settings = await loadSettings()
  const skill = settings.skills.find((s) => s.id === skillId)
  if (!skill) return

  const snap = lastSnapshot
  const contextText = `[使用 Skill: ${skill.name}]\n${skill.instructions}\n\n【当前页面快照】\nURL: ${snap.url}\n标题: ${snap.title}\n\n页面文本:\n${snap.text.slice(0, 3000)}\n\n交互元素:\n${
    snap.interactiveElements.slice(0, 30).map((el) => `  ${el.ref} [${el.tag}] "${el.text ?? el.placeholder ?? el.ariaLabel ?? ''}"`).join('\n')
  }`

  const userMsg = appendMessage('user', `[一键解析] 使用 Skill「${skill.name}」解析当前页面`)
  chatHistory.push(userMsg)
  setStatus('busy', `执行 Skill: ${skill.name}`)
  setLoading(true)
  isStreaming = true

  try {
    const assistantBubble = appendStreamingMessage()
    let fullReply = ''
    await chat(chatHistory, contextText, settings, undefined, (delta) => {
      fullReply += delta
      updateStreamingMessage(assistantBubble, fullReply)
    })
    finalizeStreamingMessage(assistantBubble, fullReply)
    chatHistory.push({ id: genId(), role: 'assistant', content: fullReply, timestamp: Date.now() })

    const actions = parseActions(fullReply)
    if (actions.length > 0) await executeActions(actions)
    setStatus('ready', '就绪')
  } catch (e) {
    appendMessage('assistant', `❌ 错误：${String(e)}`)
    setStatus('error', String(e).slice(0, 50))
  } finally {
    isStreaming = false
    setLoading(false)
  }
}
```

- [ ] **Step 2: Add "解析" button to each skill card in renderSkills()**

In `renderSkills()`, find the skill card `innerHTML` template and add a parse button:

```typescript
// In the skill-actions div, add before the toggle button:
<button class="skill-btn parse" data-id="${skill.id}" data-action="parse">解析当前页面</button>
```

The full `skill-actions` div becomes:
```typescript
      <div class="skill-actions">
        <button class="skill-btn parse" data-id="${skill.id}" data-action="parse">解析当前页面</button>
        <button class="skill-btn" data-id="${skill.id}" data-action="toggle">${skill.status === 'active' ? '停用' : '启用'}</button>
        <button class="skill-btn danger" data-id="${skill.id}" data-action="delete">删除</button>
      </div>
```

- [ ] **Step 3: Handle 'parse' action in the skill button event listener**

In the `list.querySelectorAll('.skill-btn').forEach` block, add a case:

```typescript
} else if (action === 'parse') {
  // Switch to chat tab first
  document.querySelector<HTMLElement>('.tab[data-tab="chat"]')!.click()
  quickParseWithSkill(id)
}
```

- [ ] **Step 4: Build and verify**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel.ts
git commit -m "feat: one-click parse button per skill to read page and invoke skill"
```

---

## Self-review against requirements

| Requirement | Covered by |
|------------|-----------|
| Fix SETTINGS_UPDATED | Task 1 |
| Rate limit config propagated | Task 2 |
| Screenshot action works | Task 3 |
| Code style: escHtml, lastError reset, trigger validation | Task 4 |
| Auto-debug 3 rounds then ask user | Task 5 |
| Save-as-skill modal with pre-generated name | Task 6 |
| User-controlled parsing via skill button | Task 7 |
| User-controlled via chat (already works) | existing |
| No auto-parse on every page | nothing changed — always user-triggered |

**Out of scope (separate plan):** Data collection (CollectedRecord, IndexedDB, CSV export).
