# Recruiting Agent Redesign Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the extension from a "chat assistant that sometimes clicks things" into a task execution engine capable of autonomously working through a recruiting workflow on job platforms.

**Architecture:** Replace the keyword-triggered Skills system with explicit Task Definitions. Replace single-tab lock with window-scoped session. Add a loop execution engine (think→act→observe). Add IndexedDB data collection with CSV export.

**Tech Stack:** TypeScript, Chrome Extension MV3, IndexedDB, `chrome.tabs.*`, `chrome.scripting.*`

---

## Context

### Current problems (diagnosed)
1. **Skills never activate** — keyword matching requires user to type trigger words. Nobody types "候选人" in a chat; the system is effectively dead for recruiting.
2. **Page parsing fails silently** — content script relies on manifest auto-injection, which breaks on CSPs and SPA navigation. No fallback, no user-visible error.
3. **No workflow concept** — AI returns one batch of actions per message. No loop, no "for each candidate do X".
4. **Tab lock is wrong** — just implemented but user confirmed they don't want it. Recruiting requires freely navigating between list and profile pages.

### User's recruiting workflow
```
Open 招聘平台 (Boss直聘 etc.)
→ Sidebar: define task (criteria + message template)
→ Press "开始任务"
→ Agent loops:
    Read candidate list page
    For each unprocessed candidate:
      Open profile (new tab or navigate)
      Evaluate against criteria
      If match → send message using template
      Record: name, contact, match/skip reason
    Go to next page if available
→ User can pause anytime
→ Export results as CSV
```

### Design decisions confirmed
- **Execution mode:** 全自动 (fully autonomous, user just watches)
- **Platform:** 招聘平台 (job sites — Boss直聘, 猎聘, etc.)
- **Tab approach:** No lock. Window-scoped session. Agent navigates freely.

---

## File Structure

| File | Change | Reason |
|------|--------|--------|
| `src/types.ts` | Modify | Add `TaskDefinition`, `CollectedRecord`, new `MessageType`s |
| `src/store.ts` | Modify | Add task CRUD, remove Skills default data |
| `src/background.ts` | Modify | Add scripting fallback injection, remove targetTabId routing (simplify back to active tab in session window) |
| `src/content.ts` | No change | Already works if injected |
| `src/sidepanel.html` | Rewrite | New tab layout: 对话\|任务\|数据\|调试. Remove Skills tab, remove tab lock bar, remove nav bar |
| `src/sidepanel.ts` | Rewrite | Task panel, data panel, loop execution engine, remove Skills/tab-lock code |
| `src/taskRunner.ts` | **New** | Autonomous loop execution: think→act→observe |
| `src/collector.ts` | **New** | IndexedDB storage + CSV/JSON export |
| `src/settings.ts` | Minor modify | Remove Skills section, add task templates section |
| `src/settings.html` | Minor modify | Remove Skills section |
| `manifest.json` | Modify | Add `scripting` is already there; verify `storage` covers IndexedDB |

**Remove:**
- Tab indicator bar and nav bar HTML/CSS (just added — being replaced by session concept)
- `targetTabId` / `targetTabInfo` state and all associated code in `sidepanel.ts`
- Tab lock message routing from `background.ts` (revert `resolveTab` to always use active tab in a tracked window)

---

## Task 1: Fix Page Parsing — Scripting Fallback

**Problem:** content script auto-injection fails on some pages (CSP, SPA navigation, extension reload). Currently silent failure.

**Fix:** when `GET_PAGE_CONTENT` gets a "Could not establish connection" error, background falls back to `chrome.scripting.executeScript` to inject the content script programmatically, then retries.

**Files:**
- Modify: `src/background.ts`

- [ ] **Step 1: Add injection fallback** in `GET_PAGE_CONTENT` handler. When `chrome.runtime.lastError` indicates no connection, inject content script then retry:

```typescript
case 'GET_PAGE_CONTENT': {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }

  const tryFetch = (tabId: number, attempt: number) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTENT' }, (resp) => {
      if (chrome.runtime.lastError) {
        if (attempt > 1) {
          sendResponse({ success: false, error: '页面无法访问（可能是 chrome:// 或受限页面）' })
          return
        }
        // Fallback: inject content script then retry
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['content.js'] },
          () => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: '内容脚本注入失败: ' + chrome.runtime.lastError.message })
              return
            }
            setTimeout(() => tryFetch(tabId, attempt + 1), 200)
          }
        )
        return
      }
      sendResponse({ ...resp, tabId })
    })
  }
  tryFetch(tab.id, 1)
  return true
}
```

- [ ] **Step 2: Build and test** — open a tab, close sidebar, reopen, click 📄. Should inject and parse even after extension reload.

- [ ] **Step 3: Commit**
```bash
git add src/background.ts
git commit -m "fix: add scripting fallback injection for GET_PAGE_CONTENT"
```

---

## Task 2: Types — Add TaskDefinition and CollectedRecord

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add task and data types** after `TabInfo`:

```typescript
export interface TaskDefinition {
  id: string
  name: string
  objective: string        // 任务目标，自然语言
  criteria: string         // 筛选标准，自然语言
  messageTemplate: string  // 发送消息的话术模板
  dataFields: string[]     // 要收集的字段名，如 ["姓名", "联系方式", "工作年限"]
  status: 'idle' | 'running' | 'paused' | 'done'
  createdAt: number
}

export interface CollectedRecord {
  id: string
  taskId: string
  timestamp: number
  pageUrl: string
  pageTitle: string
  fields: Record<string, string>  // 收集到的结构化数据
  matchResult: 'match' | 'skip' | 'pending'
  matchReason: string
  rawNotes?: string
}
```

- [ ] **Step 2: Add new message types** to `MessageType`:

```typescript
  | 'GET_ACTIVE_TAB'
  | 'EXECUTE_ACTION_IN_TAB'
  | 'TASK_STATUS_UPDATE'
```

(keep existing ones, just add `TASK_STATUS_UPDATE` which task runner uses to push status to sidepanel)

- [ ] **Step 3: Update Settings** to add `tasks`:

```typescript
export interface Settings {
  baseUrl: string
  apiKey: string
  apiFormat: ApiFormat
  model: string
  systemPrompt: string
  actionDelay: [number, number]
  maxActionsPerMinute: number
  prompts: SavedPrompt[]
  skills: Skill[]          // keep for backwards compat, will be removed later
  tasks: TaskDefinition[]  // new
}
```

- [ ] **Step 4: Build**, confirm no TS errors.

- [ ] **Step 5: Commit**
```bash
git add src/types.ts
git commit -m "feat: add TaskDefinition and CollectedRecord types"
```

---

## Task 3: Store — Task CRUD + Default Tasks

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Read current store.ts** to see existing saveSettings signature and DEFAULT_SETTINGS.

- [ ] **Step 2: Add `tasks: []` to `DEFAULT_SETTINGS`** and add one example task:

```typescript
tasks: [
  {
    id: 'default-recruiting',
    name: '招聘筛选',
    objective: '在招聘平台上筛选符合条件的候选人，发送沟通消息',
    criteria: '请在此填写你的招聘标准，例如：Java开发，3年以上经验，北京，本科及以上',
    messageTemplate: '你好，我是XXX公司招聘负责人，看到您的简历很符合我们的需求，想和您进一步了解，方便聊聊吗？',
    dataFields: ['姓名', '当前职位', '工作年限', '期望薪资', '联系方式'],
    status: 'idle' as const,
    createdAt: Date.now(),
  },
],
```

- [ ] **Step 3: Commit**
```bash
git add src/store.ts
git commit -m "feat: add task storage with default recruiting task"
```

---

## Task 4: New file — collector.ts (IndexedDB data layer)

**Files:**
- Create: `src/collector.ts`

- [ ] **Step 1: Create collector.ts** with IndexedDB open, save, list, export:

```typescript
// collector.ts — IndexedDB data collection
import type { CollectedRecord } from './types'

const DB_NAME = 'gpt-agent-collector'
const DB_VERSION = 1
const STORE_NAME = 'records'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveRecord(record: CollectedRecord): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function listRecords(taskId?: string): Promise<CollectedRecord[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => {
      const all = req.result as CollectedRecord[]
      resolve(taskId ? all.filter((r) => r.taskId === taskId) : all)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function clearRecords(taskId: string): Promise<void> {
  const records = await listRecords(taskId)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    records.forEach((r) => store.delete(r.id))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function exportCSV(records: CollectedRecord[]): string {
  if (records.length === 0) return ''
  const allKeys = Array.from(new Set(records.flatMap((r) => Object.keys(r.fields))))
  const header = ['时间', 'URL', '标题', '匹配结果', '原因', ...allKeys].join(',')
  const rows = records.map((r) => {
    const base = [
      new Date(r.timestamp).toLocaleString('zh-CN'),
      r.pageUrl,
      r.pageTitle,
      r.matchResult,
      r.matchReason,
    ]
    const fields = allKeys.map((k) => r.fields[k] ?? '')
    return [...base, ...fields].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
  })
  return [header, ...rows].join('\n')
}

export function downloadCSV(records: CollectedRecord[], filename = 'candidates.csv'): void {
  const csv = exportCSV(records)
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 2: Build**, confirm no TS errors.

- [ ] **Step 3: Commit**
```bash
git add src/collector.ts
git commit -m "feat: add IndexedDB collector with CSV export"
```

---

## Task 5: New file — taskRunner.ts (autonomous loop engine)

This is the core of the redesign. The task runner executes a think→act→observe loop.

**Files:**
- Create: `src/taskRunner.ts`

- [ ] **Step 1: Create taskRunner.ts**:

```typescript
// taskRunner.ts — Autonomous task execution loop
import type { TaskDefinition, CollectedRecord, AgentAction, PageSnapshot } from './types'
import { chat, parseActions } from './openai'
import { loadSettings } from './store'
import { saveRecord } from './collector'
import { throttleAction } from './rateLimit'

export type TaskRunnerStatus = 'running' | 'paused' | 'stopped' | 'done' | 'error'

export interface TaskRunnerCallbacks {
  onStatusChange: (status: TaskRunnerStatus, message: string) => void
  onLog: (message: string, type?: 'info' | 'success' | 'error') => void
  onRecordSaved: (record: CollectedRecord) => void
}

let currentStatus: TaskRunnerStatus = 'stopped'
let stopRequested = false
let pauseRequested = false

export function pauseTask() { pauseRequested = true }
export function resumeTask() { pauseRequested = false }
export function stopTask() { stopRequested = true }
export function getStatus() { return currentStatus }

function getSnapshot(): Promise<{ success: boolean; snapshot?: PageSnapshot }> {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' }, resolve)
  )
}

function executeAction(action: AgentAction): Promise<{ success: boolean; message: string; snapshot?: PageSnapshot }> {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(
      { type: 'EXECUTE_ACTION_IN_TAB', payload: { type: 'EXECUTE_ACTION', payload: action } },
      resolve
    )
  )
}

export async function runTask(task: TaskDefinition, callbacks: TaskRunnerCallbacks): Promise<void> {
  stopRequested = false
  pauseRequested = false
  currentStatus = 'running'
  callbacks.onStatusChange('running', `任务「${task.name}」已启动`)

  const systemPrompt = `你是一个自动化招聘助手，在招聘平台上执行以下任务：

任务目标：${task.objective}

筛选标准：
${task.criteria}

沟通话术模板：
${task.messageTemplate}

需要收集的数据字段：${task.dataFields.join('、')}

执行规则：
1. 每次收到页面快照后，决定下一步操作
2. 如果当前是候选人列表页，读取未处理的候选人，逐个处理
3. 如果当前是候选人详情页，评估是否符合标准，符合则发消息并记录数据
4. 操作完成后返回列表继续下一个
5. 当一页候选人处理完毕，翻页继续
6. 使用 JSON 格式返回操作，或者返回 TASK_COMPLETE / TASK_PAUSE(原因) 指令

返回格式：
- 操作序列：\`\`\`json\n[动作列表]\`\`\`
- 任务完成：TASK_COMPLETE
- 需要暂停：TASK_PAUSE: 原因
- 记录数据：DATA_RECORD: {"字段名": "值", ...}
- 匹配结果：MATCH: 是/否, 原因: ...`

  let iterationCount = 0
  const MAX_ITERATIONS = 200  // safety limit

  while (!stopRequested && iterationCount < MAX_ITERATIONS) {
    iterationCount++

    // Wait if paused
    while (pauseRequested && !stopRequested) {
      await new Promise((r) => setTimeout(r, 500))
    }
    if (stopRequested) break

    // Get current page state
    const snapResp = await getSnapshot()
    if (!snapResp?.success || !snapResp.snapshot) {
      callbacks.onLog('读取页面失败，等待后重试...', 'error')
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }

    const snap = snapResp.snapshot
    callbacks.onLog(`[第${iterationCount}轮] ${snap.title} — ${snap.url}`)

    // Ask AI what to do
    const settings = await loadSettings()
    const contextPrompt = `当前页面：
URL: ${snap.url}
标题: ${snap.title}

页面文本（前3000字）：
${snap.text.slice(0, 3000)}

交互元素：
${snap.interactiveElements.slice(0, 50).map((el) =>
  `  ${el.ref} [${el.tag}] "${el.text ?? el.placeholder ?? el.ariaLabel ?? ''}"`
).join('\n')}

请决定下一步操作。`

    let aiReply = ''
    try {
      aiReply = await chat([], contextPrompt, { ...settings, systemPrompt })
    } catch (e) {
      callbacks.onLog(`AI 调用失败: ${String(e)}`, 'error')
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }

    // Parse AI directives
    if (aiReply.includes('TASK_COMPLETE')) {
      currentStatus = 'done'
      callbacks.onStatusChange('done', '任务已完成')
      break
    }

    if (aiReply.includes('TASK_PAUSE:')) {
      const reason = aiReply.split('TASK_PAUSE:')[1]?.split('\n')[0]?.trim() ?? '未知原因'
      pauseRequested = true
      currentStatus = 'paused'
      callbacks.onStatusChange('paused', `任务暂停: ${reason}`)
    }

    // Parse DATA_RECORD
    const dataMatch = aiReply.match(/DATA_RECORD:\s*(\{[^}]+\})/s)
    if (dataMatch) {
      try {
        const fields = JSON.parse(dataMatch[1]) as Record<string, string>
        const matchLine = aiReply.match(/MATCH:\s*(是|否),\s*原因:\s*(.+)/)
        const matchResult = matchLine?.[1] === '是' ? 'match' : 'skip'
        const matchReason = matchLine?.[2]?.trim() ?? ''
        const record: CollectedRecord = {
          id: Math.random().toString(36).slice(2),
          taskId: task.id,
          timestamp: Date.now(),
          pageUrl: snap.url,
          pageTitle: snap.title,
          fields,
          matchResult,
          matchReason,
        }
        await saveRecord(record)
        callbacks.onRecordSaved(record)
        callbacks.onLog(
          `📌 已记录: ${Object.values(fields).slice(0, 2).join(' / ')} — ${matchResult === 'match' ? '✅ 符合' : '⏭ 跳过'}`,
          matchResult === 'match' ? 'success' : 'info'
        )
      } catch {
        callbacks.onLog('数据解析失败，继续执行', 'error')
      }
    }

    // Parse and execute actions
    const actions = parseActions(aiReply)
    if (actions.length === 0) {
      callbacks.onLog('AI 未返回操作，等待后重试...', 'error')
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }

    for (const action of actions) {
      if (stopRequested || pauseRequested) break
      await throttleAction()
      const result = await executeAction(action)
      callbacks.onLog(
        `${result.success ? '✓' : '✗'} ${action.action}${action.ref ? ' ' + action.ref : ''}: ${result.message}`,
        result.success ? 'info' : 'error'
      )
      if (!result.success) {
        callbacks.onLog('操作失败，继续下一轮...', 'error')
        break
      }
    }
  }

  if (stopRequested) {
    currentStatus = 'stopped'
    callbacks.onStatusChange('stopped', '任务已停止')
  } else if (iterationCount >= MAX_ITERATIONS) {
    currentStatus = 'done'
    callbacks.onStatusChange('done', `已达到最大迭代次数 (${MAX_ITERATIONS})`)
  }
}
```

- [ ] **Step 2: Build**, confirm no TS errors.

- [ ] **Step 3: Commit**
```bash
git add src/taskRunner.ts
git commit -m "feat: add autonomous task runner with think-act-observe loop"
```

---

## Task 6: Redesign sidepanel.html

Remove: Skills tab, tab indicator bar, URL nav bar.
Add: 任务 tab, 数据 tab.

**Files:**
- Modify: `src/sidepanel.html`

**New tab layout:**
```
[ 💬 对话 | 🎯 任务 | 📊 数据 | 🔧 调试 ]
```

- [ ] **Step 1: Remove from HTML**:
    - The `<div class="tab-indicator">` block
    - The `<div class="nav-bar">` block
    - The `<div class="tab" data-tab="skills">⚡ Skills</div>` tab button
    - The entire `<div class="panel" id="panel-skills">` panel
    - The Add Skill Modal (`skillModal` overlay)
    - The Save Debug Skill Modal (`saveDebugSkillModal` overlay)

- [ ] **Step 2: Add new tab buttons**:

```html
<div class="tabs">
  <div class="tab active" data-tab="chat">💬 对话</div>
  <div class="tab" data-tab="task">🎯 任务</div>
  <div class="tab" data-tab="data">📊 数据</div>
  <div class="tab" data-tab="debug">🔧 调试</div>
</div>
```

- [ ] **Step 3: Add Task panel HTML**:

```html
<div class="panel" id="panel-task">
  <div class="task-panel">
    <div id="taskList"></div>
    <button class="add-task-btn" id="addTaskBtn">＋ 创建新任务</button>
  </div>
</div>
```

- [ ] **Step 4: Add Data panel HTML**:

```html
<div class="panel" id="panel-data">
  <div class="data-panel">
    <div class="data-toolbar">
      <select id="dataTaskFilter" class="data-filter"></select>
      <button class="data-btn" id="exportCsvBtn">📥 导出 CSV</button>
      <button class="data-btn danger" id="clearDataBtn">🗑 清空</button>
    </div>
    <div id="dataRecordsList" class="records-list"></div>
  </div>
</div>
```

- [ ] **Step 5: Add Task modal HTML** (for creating/editing tasks):

```html
<div class="modal-overlay" id="taskModal">
  <div class="modal">
    <div class="modal-title">新建任务</div>
    <div class="form-group">
      <label class="form-label">任务名称</label>
      <input class="form-input" id="taskName" placeholder="例：Java开发招聘" />
    </div>
    <div class="form-group">
      <label class="form-label">任务目标</label>
      <textarea class="form-textarea" id="taskObjective" rows="2" placeholder="在招聘平台筛选符合条件的候选人并发送消息"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">筛选标准</label>
      <textarea class="form-textarea" id="taskCriteria" rows="3" placeholder="Java开发，3年以上经验，北京，本科及以上..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">沟通话术</label>
      <textarea class="form-textarea" id="taskMessage" rows="3" placeholder="你好，我们正在寻找..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">收集字段（用逗号分隔）</label>
      <input class="form-input" id="taskFields" placeholder="姓名,联系方式,工作年限,期望薪资" />
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" id="taskModalCancel">取消</button>
      <button class="btn-confirm" id="taskModalSave">保存</button>
    </div>
  </div>
</div>
```

- [ ] **Step 6: Add CSS** for new panels (task cards, data records, toolbar).

- [ ] **Step 7: Build**, verify HTML is valid.

- [ ] **Step 8: Commit**
```bash
git add src/sidepanel.html
git commit -m "feat: redesign sidepanel — replace Skills tab with Task+Data tabs"
```

---

## Task 7: Rewrite sidepanel.ts

Remove skills/tab-lock code. Add task panel, data panel, task runner integration.

**Files:**
- Modify: `src/sidepanel.ts`

- [ ] **Step 1: Add imports**:

```typescript
import type { ChatMessage, AgentAction, ActionResult, PageSnapshot, TaskDefinition, CollectedRecord } from './types'
import { loadSettings, saveSettings } from './store'
import { chat, parseActions } from './openai'
import { throttleAction } from './rateLimit'
import { listRecords, clearRecords, downloadCSV } from './collector'
import { runTask, pauseTask, resumeTask, stopTask, getStatus } from './taskRunner'
```

- [ ] **Step 2: Remove from state**:
    - `targetTabId`, `targetTabInfo` variables
    - All tab targeting functions: `lockToTab`, `unlockTab`, `updateTabBar`, `navigateUrl`

- [ ] **Step 3: Remove from `init()`**:
    - `lockTabBtn`, `unlockTabBtn`, `urlNavBtn`, `urlInput` event listeners
    - Skills-related: `addSkillBtn`, `skillModalCancel`, `skillModalSave`
    - Debug skill modal: `debugSkillCancel`, `debugSkillSave`

- [ ] **Step 4: Add task panel functions**:

```typescript
async function renderTasks() {
  const settings = await loadSettings()
  const list = document.getElementById('taskList')!
  list.innerHTML = ''
  if (settings.tasks.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有任务，点击下方按钮创建</div>'
    return
  }
  settings.tasks.forEach((task) => {
    const card = document.createElement('div')
    card.className = 'task-card'
    const isRunning = getStatus() === 'running'
    card.innerHTML = `
      <div class="task-header">
        <span class="task-name">${task.name}</span>
        <span class="task-status-badge ${task.status}">${
          { idle: '就绪', running: '运行中', paused: '暂停', done: '完成', error: '错误' }[task.status] ?? task.status
        }</span>
      </div>
      <div class="task-criteria">${task.criteria.slice(0, 80)}...</div>
      <div class="task-actions">
        ${isRunning
          ? `<button class="task-btn danger" data-id="${task.id}" data-action="stop">■ 停止</button>
             <button class="task-btn" data-id="${task.id}" data-action="pause">⏸ 暂停</button>`
          : `<button class="task-btn primary" data-id="${task.id}" data-action="start">▶ 开始任务</button>`
        }
        <button class="task-btn" data-id="${task.id}" data-action="delete">删除</button>
      </div>`
    list.appendChild(card)
  })
  list.querySelectorAll('.task-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const el = e.target as HTMLElement
      const id = el.dataset.id!
      const action = el.dataset.action!
      const s = await loadSettings()
      const task = s.tasks.find((t) => t.id === id)
      if (!task) return
      if (action === 'start') startTaskExecution(task)
      else if (action === 'stop') stopTask()
      else if (action === 'pause') pauseTask()
      else if (action === 'delete') {
        await saveSettings({ tasks: s.tasks.filter((t) => t.id !== id) })
        renderTasks()
      }
    })
  })
}

function startTaskExecution(task: TaskDefinition) {
  document.querySelector<HTMLElement>('.tab[data-tab="chat"]')!.click()
  runTask(task, {
    onStatusChange: (status, message) => {
      setStatus(status === 'running' ? 'busy' : status === 'error' ? 'error' : 'ready', message)
      renderTasks()
    },
    onLog: (message, type) => {
      const logEl = document.createElement('div')
      logEl.className = `action-log ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`
      logEl.textContent = message
      document.getElementById('chatMessages')!.appendChild(logEl)
      scrollToBottom()
    },
    onRecordSaved: () => {
      // refresh data tab if active
      if (document.getElementById('panel-data')?.classList.contains('active')) {
        renderDataRecords()
      }
    },
  })
}
```

- [ ] **Step 5: Add data panel functions**:

```typescript
async function renderDataRecords() {
  const filter = (document.getElementById('dataTaskFilter') as HTMLSelectElement)?.value
  const records = await listRecords(filter || undefined)
  const list = document.getElementById('dataRecordsList')!
  if (records.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有数据记录</div>'
    return
  }
  list.innerHTML = records.map((r) => `
    <div class="record-card ${r.matchResult}">
      <div class="record-header">
        <span class="record-title">${r.pageTitle}</span>
        <span class="record-badge ${r.matchResult}">${r.matchResult === 'match' ? '✅ 符合' : '⏭ 跳过'}</span>
      </div>
      <div class="record-fields">${Object.entries(r.fields).map(([k, v]) => `<span><b>${k}:</b> ${v}</span>`).join(' · ')}</div>
      <div class="record-reason">${r.matchReason}</div>
      <div class="record-time">${new Date(r.timestamp).toLocaleString('zh-CN')}</div>
    </div>
  `).join('')
}

async function populateTaskFilter() {
  const settings = await loadSettings()
  const select = document.getElementById('dataTaskFilter') as HTMLSelectElement
  select.innerHTML = '<option value="">全部任务</option>' +
    settings.tasks.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')
}
```

- [ ] **Step 6: Wire up new buttons in `init()`**:

```typescript
// Task panel
document.getElementById('addTaskBtn')!.addEventListener('click', () => {
  (document.getElementById('taskModal') as HTMLElement).classList.add('open')
})
document.getElementById('taskModalCancel')!.addEventListener('click', () => {
  (document.getElementById('taskModal') as HTMLElement).classList.remove('open')
})
document.getElementById('taskModalSave')!.addEventListener('click', saveTask)

// Data panel
document.getElementById('exportCsvBtn')!.addEventListener('click', async () => {
  const filter = (document.getElementById('dataTaskFilter') as HTMLSelectElement)?.value
  const records = await listRecords(filter || undefined)
  downloadCSV(records)
})
document.getElementById('clearDataBtn')!.addEventListener('click', async () => {
  if (!confirm('确定清空所有数据记录？')) return
  const filter = (document.getElementById('dataTaskFilter') as HTMLSelectElement)?.value
  if (filter) await clearRecords(filter)
  renderDataRecords()
})
document.getElementById('dataTaskFilter')!.addEventListener('change', renderDataRecords)

// Tab switch — load data when switching to data tab
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = (tab as HTMLElement).dataset.tab!
    // ... existing tab switching code ...
    if (name === 'task') renderTasks()
    if (name === 'data') { populateTaskFilter(); renderDataRecords() }
  })
})
```

- [ ] **Step 7: Add `saveTask()` function**:

```typescript
async function saveTask() {
  const name = (document.getElementById('taskName') as HTMLInputElement).value.trim()
  const objective = (document.getElementById('taskObjective') as HTMLTextAreaElement).value.trim()
  const criteria = (document.getElementById('taskCriteria') as HTMLTextAreaElement).value.trim()
  const messageTemplate = (document.getElementById('taskMessage') as HTMLTextAreaElement).value.trim()
  const fieldsRaw = (document.getElementById('taskFields') as HTMLInputElement).value.trim()
  if (!name || !criteria) { alert('任务名称和筛选标准不能为空'); return }
  const dataFields = fieldsRaw ? fieldsRaw.split(',').map((f) => f.trim()).filter(Boolean) : ['姓名', '联系方式']
  const settings = await loadSettings()
  const newTask: TaskDefinition = {
    id: Math.random().toString(36).slice(2),
    name, objective, criteria, messageTemplate, dataFields,
    status: 'idle', createdAt: Date.now(),
  }
  await saveSettings({ tasks: [...settings.tasks, newTask] })
  ;(document.getElementById('taskModal') as HTMLElement).classList.remove('open')
  renderTasks()
}
```

- [ ] **Step 8: Update message sends** — remove `targetTabId` from all `chrome.runtime.sendMessage` calls (revert to default active tab routing in background).

- [ ] **Step 9: Build**, confirm zero TS errors.

- [ ] **Step 10: Manual smoke test**
    1. Load extension, open sidepanel
    2. Go to 任务 tab — see default recruiting task card
    3. Click 创建新任务 — modal opens, fill in, save — new card appears
    4. Click ▶ 开始任务 on a task while on a job site — chat tab switches, logs start appearing
    5. Go to 📊 数据 tab — records appear as agent processes candidates
    6. Click 导出 CSV — file downloads

- [ ] **Step 11: Commit**
```bash
git add src/sidepanel.ts
git commit -m "feat: rewrite sidepanel with task/data panels, integrate autonomous task runner"
```

---

## Task 8: Revert background.ts to simple active-tab routing

Remove the `resolveTab` complexity (no more `targetTabId` in messages). Background always uses active tab in the active window.

**Files:**
- Modify: `src/background.ts`

- [ ] **Step 1: Replace `resolveTab`-based handlers** with the simpler original pattern:

```typescript
case 'EXECUTE_ACTION_IN_TAB':
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
    chrome.tabs.sendMessage(tabs[0].id, message.payload, sendResponse)
  })
  return true
```

Keep `GET_ACTIVE_TAB` handler (still useful). Keep scripting fallback from Task 1. Remove `resolveTab` function.

- [ ] **Step 2: Build**, zero errors.

- [ ] **Step 3: Commit**
```bash
git add src/background.ts
git commit -m "refactor: simplify background to always use active tab, remove resolveTab"
```

---

## Verification

End-to-end test on a real job platform (Boss直聘 or 猎聘):
1. `npm run build` — zero errors
2. Load `dist/` in Chrome
3. Open job site (e.g., boss.zhipin.com)
4. Open sidepanel
5. Go to 🎯 任务 tab — default task visible
6. Edit the task: set real criteria + message template
7. Navigate to a candidate list page
8. Press ▶ 开始任务
9. Watch chat tab: agent reads page, opens candidates, evaluates, sends messages
10. Go to 📊 数据 tab: records appear in real time
11. Press 📥 导出 CSV: file downloads with candidate data

---

## Notes

- **Tab group API**: Not included in this plan. The simple "active tab in current window" approach is sufficient for the sequential recruiting workflow (list → detail → back → next). Tab groups can be added later if agent needs parallel tab processing.
- **Skills system**: Left in storage/types for backwards compatibility but UI removed. Can be formally deleted in a later cleanup.
- **Message templates**: Currently plain text. Can add variable substitution ({{name}}, {{position}}) in a future iteration.
- **Anti-detection**: All existing delay/throttle logic in `rateLimit.ts` is preserved and used by task runner.