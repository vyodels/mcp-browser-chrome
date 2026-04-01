# Bug 修复 + 自动调试循环实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 修复 4 个已确认的 Bug，并新增自动调试自学习循环（3 轮自动重试 → 保存为 Skill 弹窗）。

**架构：** Bug 修复按文件独立处理。自动调试循环通过在 `sidepanel.ts` 的 `executeActions()` 中引入重试状态机实现；调试成功后提供保存为 Skill 的弹窗，复用现有 `saveSkill()` 基础设施。新增 `CONFIGURE_RATE_LIMIT` 消息，在初始化和设置变更时将配置同步到 content.ts。

**技术栈：** TypeScript 5.4、Chrome Extension MV3、Vite 5.2、原生 DOM

---

## 文件变更清单

| 文件 | 变更内容 |
|------|--------|
| `src/types.ts` | 添加 `CONFIGURE_RATE_LIMIT` 到 `MessageType`；添加 `AutoDebugState` 接口 |
| `src/background.ts` | 将 `CONFIGURE_RATE_LIMIT` 消息转发到活跃标签页 |
| `src/content.ts` | 处理 `CONFIGURE_RATE_LIMIT`；修复 `screenshot` 动作改为调用 background |
| `src/rateLimit.ts` | 不变（已有 `configureRateLimit`） |
| `src/sidepanel.ts` | 添加 `SETTINGS_UPDATED` 监听；初始化及设置变更时发送 `CONFIGURE_RATE_LIMIT`；用自动调试循环替换手动调试提示；添加保存为 Skill 的弹窗逻辑 |
| `src/sidepanel.html` | 添加保存为 Skill 的弹窗 HTML |

---

## Task 1: 修复 — sidepanel 中的 SETTINGS_UPDATED 监听

**问题：** `settings.ts` 保存后广播 `SETTINGS_UPDATED`，但 `sidepanel.ts` 从未监听。模型标识和快捷提示词不会更新。

**文件：**
- 修改：`src/sidepanel.ts`（在文件末尾 `init()` 调用之前）

- [ ] **Step 1: 在 sidepanel.ts 底部添加监听器**

```typescript
// ---- 监听来自选项页的设置变更 ----
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

- [ ] **Step 2: 构建验证**

```bash
npm run build 2>&1 | tail -5
```
预期：无 TypeScript 错误。

- [ ] **Step 3: 提交**

```bash
git add src/sidepanel.ts
git commit -m "fix: listen for SETTINGS_UPDATED to refresh sidepanel state"
```

---

## Task 2: 修复 — 速率限制配置同步到 content.ts

**问题：** `content.ts` 从 `rateLimit.ts` 导入 `randomDelay`/`simulateMouseMove`，但这些函数运行在页面 JS 上下文中。当侧边栏修改设置时，content script 的速率限制状态从未更新，始终使用硬编码默认值（800–2500ms，12次/分）。

**修复：** 新增 `CONFIGURE_RATE_LIMIT` 消息。侧边栏在初始化和每次设置变更时发送，background 转发到活跃标签页的 content script。

**文件：**
- 修改：`src/types.ts`
- 修改：`src/background.ts`
- 修改：`src/content.ts`
- 修改：`src/sidepanel.ts`

- [ ] **Step 1: 在 types.ts 中添加消息类型**

在 `src/types.ts` 中更新 `MessageType`：

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
  | 'CONFIGURE_RATE_LIMIT'   // ← 新增
```

- [ ] **Step 2: 在 background.ts 中转发消息**

在 `src/background.ts` 的 switch 中添加：

```typescript
case 'CONFIGURE_RATE_LIMIT':
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) { sendResponse({ success: false }); return }
    chrome.tabs.sendMessage(tabs[0].id, message, sendResponse)
  })
  return true
```

- [ ] **Step 3: 在 content.ts 中处理消息**

在消息监听器中新增：

```typescript
case 'CONFIGURE_RATE_LIMIT':
  configureRateLimit(message.payload.max, message.payload.delay)
  sendResponse({ success: true })
  break
```

同时在 content.ts 顶部补充导入（已有 `randomDelay` 和 `simulateMouseMove`，添加 `configureRateLimit`）：

```typescript
import { simulateMouseMove, randomDelay, configureRateLimit } from './rateLimit'
```

- [ ] **Step 4: 在 sidepanel.ts 中提取辅助函数**

```typescript
function applyRateLimitConfig(settings: import('./types').Settings) {
  chrome.runtime.sendMessage({
    type: 'CONFIGURE_RATE_LIMIT',
    payload: { max: settings.maxActionsPerMinute, delay: settings.actionDelay },
  })
}
```

- [ ] **Step 5: 在初始化和 SETTINGS_UPDATED 中调用**

在 `init()` 中 `loadSettings()` 之后：

```typescript
async function init() {
  const settings = await loadSettings()
  ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model
  applyRateLimitConfig(settings)   // ← 新增
  // ... 其余初始化
```

在 Task 1 添加的 `SETTINGS_UPDATED` 监听中：

```typescript
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SETTINGS_UPDATED') {
    loadSettings().then((settings) => {
      ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model
      applyRateLimitConfig(settings)   // ← 新增
      renderQuickPrompts()
      renderSkills()
    })
  }
})
```

- [ ] **Step 6: 构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 7: 提交**

```bash
git add src/types.ts src/background.ts src/content.ts src/sidepanel.ts
git commit -m "fix: propagate rate limit config from settings to content script"
```

---

## Task 3: 修复 — screenshot 动作是空壳

**问题：** `content.ts` 的 `case 'screenshot'` 直接返回 `{ success: true }` 而不做任何截图操作。

**修复：** content script 向 background 发送 `TAKE_SCREENSHOT` 消息并返回 dataUrl。

**文件：**
- 修改：`src/content.ts`

- [ ] **Step 1: 替换截图空壳**

找到：
```typescript
case 'screenshot':
  // 截图由 background 处理
  return { success: true, message: '截图请求已发送' }
```

替换为：
```typescript
case 'screenshot': {
  const resp = await new Promise<{ success: boolean; dataUrl?: string; error?: string }>(
    (resolve) => chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, resolve)
  )
  if (!resp?.success) throw new Error(resp?.error ?? '截图失败')
  return { success: true, message: '截图完成', screenshotDataUrl: resp.dataUrl, snapshot: takeSnapshot() }
}
```

- [ ] **Step 2: 构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 3: 提交**

```bash
git add src/content.ts
git commit -m "fix: implement screenshot action in content script via background"
```

---

## Task 4: 代码风格修复

**问题：**
1. `settings.ts` 中 `escHtml` 未转义 `>` — 可能导致 prompt 标题注入 DOM
2. `lastError` 仅在 `clearChat()` 时重置 — 成功执行后应清除
3. 允许创建触发词为空的 Skill — 导致 Skill 永远不被激活

**文件：**
- 修改：`src/settings.ts`
- 修改：`src/sidepanel.ts`

- [ ] **Step 1: 修复 settings.ts 中的 escHtml**

找到：
```typescript
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
```

替换为：
```typescript
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
```

- [ ] **Step 2: 成功执行后重置 lastError**

在 `executeActions()` 的 for 循环结束后添加：

```typescript
  // 所有动作执行成功 — 清除错误状态
  lastError = null
```

- [ ] **Step 3: 在 saveSkill() 中添加触发词校验**

找到：
```typescript
if (!name || !instructions) { alert('名称和 AI 指令不能为空'); return }
```

替换为：
```typescript
if (!name || !instructions) { alert('名称和 AI 指令不能为空'); return }
if (!trigger) { alert('触发词不能为空，否则 Skill 永远不会被激活'); return }
```

- [ ] **Step 4: 构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: 提交**

```bash
git add src/settings.ts src/sidepanel.ts
git commit -m "fix: escHtml covers >, reset lastError on success, require skill trigger"
```

---

## Task 5: 自动调试循环（3 轮 → 询问用户）

**目标：** 动作失败时，不再显示"请去调试标签"，而是自动：
1. 获取含 HTML 的完整页面快照
2. 发给 AI 获取修复建议
3. 解析 AI 返回的新动作
4. 重新执行失败动作（及后续动作）
5. 最多重试 3 次；超过后询问用户"继续？"

**文件：**
- 修改：`src/sidepanel.ts`

- [ ] **Step 1: 添加自动调试状态变量**

```typescript
let autoDebugRound = 0
const MAX_AUTO_DEBUG_ROUNDS = 3
```

- [ ] **Step 2: 添加 runAutoDebug() 辅助函数**

```typescript
async function runAutoDebug(failedAction: AgentAction, errorMsg: string): Promise<AgentAction[] | null> {
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

  const logEl = document.createElement('div')
  logEl.className = 'action-log'
  logEl.textContent = `🔍 自动调试第 ${autoDebugRound} 轮：AI 生成 ${actions.length} 个修复动作`
  document.getElementById('chatMessages')!.appendChild(logEl)
  scrollToBottom()

  return actions
}
```

- [ ] **Step 3: 重写 executeActions() 使用自动调试循环**

```typescript
async function executeActions(actions: AgentAction[]) {
  let remaining = [...actions]
  const completedActions: AgentAction[] = []
  const pageUrlAtStart = lastSnapshot?.url ?? ''

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
      completedActions.push(action)
      remaining.shift()
      continue
    }

    lastError = result.message

    if (autoDebugRound < MAX_AUTO_DEBUG_ROUNDS) {
      autoDebugRound++
      setStatus('busy', `自动调试第 ${autoDebugRound}/${MAX_AUTO_DEBUG_ROUNDS} 轮...`)

      const fixedActions = await runAutoDebug(action, result.message)
      if (fixedActions) {
        remaining = [...fixedActions, ...remaining.slice(1)]
        continue
      }
    }

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
    return
  }

  const wasAutoDebugUsed = autoDebugRound > 0
  autoDebugRound = 0
  lastError = null

  if (wasAutoDebugUsed && completedActions.length > 0) {
    offerSaveDebugAsSkill(completedActions, pageUrlAtStart)
  }
}
```

- [ ] **Step 4: 构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel.ts
git commit -m "feat: auto-debug loop — 3-round automatic retry with AI fix suggestions"
```

---

## Task 6: 自动调试成功后保存为 Skill 的弹窗

**目标：** 当 `autoDebugRound > 0` 且所有动作执行成功时，弹出"保存为 Skill"弹窗，预填名称供用户修改或直接确认。

**文件：**
- 修改：`src/sidepanel.html` — 添加保存弹窗 HTML
- 修改：`src/sidepanel.ts` — 添加 `offerSaveDebugAsSkill()` 及弹窗绑定

- [ ] **Step 1: 在 sidepanel.html 添加弹窗 HTML**

在现有 `<div id="skillModal"` 之后、`</body>` 之前添加：

```html
<!-- 调试结果保存为 Skill 弹窗 -->
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

- [ ] **Step 2: 在 sidepanel.ts 添加弹窗函数**

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

- [ ] **Step 3: 在 init() 中绑定弹窗按钮**

```typescript
document.getElementById('debugSkillCancel')!.addEventListener('click', closeDebugSkillModal)
document.getElementById('debugSkillSave')!.addEventListener('click', saveDebugSkill)
```

- [ ] **Step 4: 构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel.html src/sidepanel.ts
git commit -m "feat: save-as-skill modal after successful auto-debug"
```

---

## Task 7: 用户控制的页面解析模式

**背景：** 用户明确要求页面解析必须用户主动触发，不自动执行。现有"读取页面"按钮已是用户触发。新增需求：每个 Skill 卡片提供"解析当前页面"按钮，一键完成读取页面 + 调用该 Skill 的完整流程。

**文件：**
- 修改：`src/sidepanel.ts`

- [ ] **Step 1: 添加 quickParseWithSkill() 函数**

```typescript
async function quickParseWithSkill(skillId: string) {
  if (isStreaming) return

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

- [ ] **Step 2: 在 renderSkills() 的 skill 卡片中添加解析按钮**

在 `skill-actions` div 中，在切换按钮前添加：

```typescript
<button class="skill-btn parse" data-id="${skill.id}" data-action="parse">解析当前页面</button>
```

- [ ] **Step 3: 在事件监听器中处理 'parse' 动作**

```typescript
} else if (action === 'parse') {
  document.querySelector<HTMLElement>('.tab[data-tab="chat"]')!.click()
  quickParseWithSkill(id)
}
```

- [ ] **Step 4: 构建验证**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel.ts
git commit -m "feat: one-click parse button per skill to read page and invoke skill"
```

---

## 需求覆盖自检

| 需求 | 对应 Task |
|------|-----------|
| 修复 SETTINGS_UPDATED | Task 1 |
| 速率限制配置同步 | Task 2 |
| screenshot 动作正常工作 | Task 3 |
| 代码风格：escHtml、lastError 重置、触发词校验 | Task 4 |
| 自动调试 3 轮后询问用户 | Task 5 |
| 预填名称的保存为 Skill 弹窗 | Task 6 |
| Skill 按钮触发用户控制解析 | Task 7 |
| 通过对话控制（已有功能） | 现有实现 |
| 不自动解析每个页面 | 未改变 — 始终需用户触发 |

**超出范围（单独计划）：** 数据采集（CollectedRecord、IndexedDB、CSV 导出）。
