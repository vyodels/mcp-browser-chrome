// ============================================================
// sidepanel.ts — 侧边栏主逻辑 v2
// Agent Loop 控制 + Tool Calling + 工作流执行 + Apple 风格 UI
// ============================================================
import { loadSettings, saveSettings } from './store'
import { chatWithTools } from './openai'
import { TOOL_DEFINITIONS, executeTool, formatToolResult } from './tools'
import { createTaskTabGroup, getAllTabs } from './tabManager'
import { buildStepSystemPrompt } from './workflow'
import type { Settings, LoopState, InterventionRequest, Workflow, ActivityEntry, CandidateEntry, CandidateStatus, WorkspaceRecord, WorkspaceField, SchemaProposal, Skill, MemoryEntry } from './types'
import type { ToolCallRequest } from './tools'

// ============================================================
// 状态
// ============================================================
let settings: Settings
let loopState: LoopState = 'idle'
let loopMessages: object[] = []
let loopAbortController: AbortController | null = null
let targetTabId: number | undefined
let taskTabGroupId: number | undefined
let taskName = '新任务'
let currentWorkflow: Workflow | null = null
let currentStepIndex = 0
let pendingIntervention: ((answer: string) => void) | null = null
let workspaceActiveWfId: string | undefined
let previousStepSummary = ''    // 上一步 AI 完成时的摘要，注入下一步 system prompt
let sessionMemory: Record<string, string> = {}  // 会话记忆，跨步骤持久化

// ---- Context 管理参数 ----
// 主 agent：宽松，需要持久跟踪工作流整体进度
const MAIN_COMPRESS_THRESHOLD = 5000   // 超过此长度才压缩
const MAIN_HEAD_KEEP = 1200            // 头部保留（URL + 标题 + 主体内容开头）
const MAIN_TAIL_KEEP = 800             // 尾部保留（交互元素列表）
const MAX_LOOP_MESSAGES = 40           // 主 agent 消息窗口上限

// 子 agent：合理（不激进），每个子 agent 专注单一独立任务
const SUB_COMPRESS_THRESHOLD = 3000    // 子 agent 压缩阈值
const SUB_HEAD_KEEP = 800              // 子 agent 头部保留
const SUB_TAIL_KEEP = 600             // 子 agent 尾部保留
const MAX_SUB_MESSAGES = 30            // 子 agent 消息窗口上限

const LARGE_TOOLS = new Set(['get_page_content', 'take_screenshot'])

// ---- 子代理注册表 ----
interface SubAgentEntry {
  id: string
  task: string           // 任务描述（前80字）
  status: 'running' | 'completed' | 'error' | 'aborted'
  toolCallCount: number
  lastAction: string     // 最近一次工具调用
  startedAt: number
  endedAt?: number
  abortCtrl: AbortController
}
const subAgentRegistry = new Map<string, SubAgentEntry>()

// ============================================================
// 消息封装
// ============================================================
function sendMsg(msg: object): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message })
      else resolve(resp ?? { success: true })
    })
  })
}

// ============================================================
// DOM 辅助
// ============================================================
function el<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T }

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatContent(text: string): string {
  const escaped = escHtml(text)
  // 段落（双换行）
  const paragraphed = escaped.split(/\n\n+/).map((para) => {
    // 处理段落内的列表行
    const lines = para.split('\n')
    const isListBlock = lines.every((l) => /^[-*] /.test(l.trim()) || l.trim() === '')
    if (isListBlock && lines.some((l) => /^[-*] /.test(l.trim()))) {
      const items = lines.filter((l) => /^[-*] /.test(l.trim()))
        .map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')
      return `<ul>${items}</ul>`
    }
    // 标题行（### / ## / #）
    const titleMatch = para.match(/^#{1,3} (.+)/)
    if (titleMatch) return `<strong>${titleMatch[1]}</strong>`
    // 普通段落：单换行转 <br>
    const inner = lines.join('<br>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
    return `<p>${inner}</p>`
  }).join('')
  return paragraphed
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
}

// ============================================================
// 四层记忆系统
// ============================================================

// Layer 1: 持久记忆（chrome.storage，跨会话）
async function loadPersistentMemory(workflowId?: string): Promise<MemoryEntry[]> {
  const s = await loadSettings()
  const all = s.memoryEntries ?? []
  // 返回全局条目 + 当前工作流条目
  return all.filter((e) => !e.workflowId || !workflowId || e.workflowId === workflowId)
}

async function savePersistentMemoryEntry(key: string, value: string, workflowId?: string): Promise<void> {
  const s = await loadSettings()
  const entries = s.memoryEntries ?? []
  const now = Date.now()
  const idx = entries.findIndex((e) => e.key === key && e.workflowId === workflowId)
  const entry: MemoryEntry = { key, value, layer: 'persistent', workflowId, createdAt: now, updatedAt: now }
  if (idx >= 0) { entry.createdAt = entries[idx].createdAt; entries[idx] = entry }
  else entries.push(entry)
  await saveSettings({ memoryEntries: entries })
}

async function deletePersistentMemoryEntry(key: string, workflowId?: string): Promise<void> {
  const s = await loadSettings()
  const entries = (s.memoryEntries ?? []).filter(
    (e) => !(e.key === key && e.workflowId === workflowId)
  )
  await saveSettings({ memoryEntries: entries })
}

// Layer 2: 会话记忆（内存，本次任务有效）
async function saveMemoryEntry(key: string, value: string, layer: 'session' | 'persistent' = 'session'): Promise<void> {
  if (layer === 'persistent') {
    await savePersistentMemoryEntry(key, value, currentWorkflow?.id)
    renderMemoryPanel()   // 刷新 UI
  } else {
    sessionMemory[key] = value
  }
}

async function deleteMemoryEntry(key: string, layer: 'session' | 'persistent'): Promise<void> {
  if (layer === 'persistent') {
    await deletePersistentMemoryEntry(key, currentWorkflow?.id)
    renderMemoryPanel()
  } else {
    delete sessionMemory[key]
  }
}

function listMemorySnapshot(): { persistent: MemoryEntry[]; session: Record<string, string> } {
  return {
    persistent: _cachedPersistentMemory,
    session: { ...sessionMemory },
  }
}

// 缓存的持久记忆（在步骤开始时刷新）
let _cachedPersistentMemory: MemoryEntry[] = []
// 工作区进度摘要（主 agent 专用，步骤开始时刷新）
let _cachedWorkspaceSummary = ''

async function refreshWorkspaceSummary(wfId?: string): Promise<void> {
  if (!wfId) { _cachedWorkspaceSummary = ''; return }
  const s = await loadSettings()
  const wf = s.workflows.find((w) => w.id === wfId)
  if (!wf?.workspace?.fields.length) { _cachedWorkspaceSummary = ''; return }
  const records = (s.workspaceRecords ?? []).filter((r) => r.workflowId === wfId)
  if (records.length === 0) { _cachedWorkspaceSummary = ''; return }

  const statusField = wf.workspace.fields.find((f) => f.type === 'status')
  if (!statusField?.options?.length) {
    _cachedWorkspaceSummary = `\n## 📊 工作区进度（${wf.name}）\n总计 ${records.length} 条记录\n`
    return
  }

  const counts: Record<string, number> = {}
  records.forEach((r) => {
    const status = r.data[statusField.id] ?? '未设置'
    counts[status] = (counts[status] ?? 0) + 1
  })

  const lines = statusField.options
    .filter((opt) => counts[opt])
    .map((opt) => `- ${opt}：${counts[opt]} 条`)

  _cachedWorkspaceSummary = `\n## 📊 工作区进度摘要（${wf.name}）\n总计 ${records.length} 条记录\n${lines.join('\n')}\n（详细记录通过 list_records 工具查询）\n`
}

// 构建注入 system prompt 的记忆文本（Layer 1 + Layer 2）
// includeWorkspaceSummary: 主 agent 传 true，子 agent 不传（默认 false）
function buildMemorySection(persistentEntries: MemoryEntry[] = _cachedPersistentMemory, includeWorkspaceSummary = false): string {
  const parts: string[] = []

  if (persistentEntries.length > 0) {
    parts.push('### 📚 持久记忆（跨会话，长期有效）')
    parts.push(persistentEntries.map((e) => `- **${e.key}**: ${e.value}`).join('\n'))
  }

  const sessEntries = Object.entries(sessionMemory)
  if (sessEntries.length > 0) {
    parts.push('### 🧠 会话记忆（本次任务）')
    parts.push(sessEntries.map(([k, v]) => `- **${k}**: ${v}`).join('\n'))
  }

  if (parts.length === 0 && !(includeWorkspaceSummary && _cachedWorkspaceSummary)) return ''
  const header = parts.length > 0 ? `\n## 🗃 记忆上下文\n${parts.join('\n')}\n` : ''
  const summary = includeWorkspaceSummary ? _cachedWorkspaceSummary : ''
  return header + summary
}

// ============================================================
// 消息队列压缩 + 滑动窗口
// ============================================================
// 历史消息中大型工具结果的压缩策略：
//   - 内容 < threshold：不压缩
//   - 内容 >= threshold：保留头部 headKeep + 保留尾部 tailKeep，压缩中间
// 两段式保留：头部通常是 URL/标题，尾部通常是可交互元素列表，两者对 AI 最有价值
// 主 agent 和子 agent 使用不同参数（见文件顶部常量）

function compressForHistory(
  toolName: string,
  content: string,
  threshold = MAIN_COMPRESS_THRESHOLD,
  headKeep = MAIN_HEAD_KEEP,
  tailKeep = MAIN_TAIL_KEEP
): string {
  if (!LARGE_TOOLS.has(toolName) || content.length <= threshold) return content
  const head = content.slice(0, headKeep)
  const tail = content.slice(-tailKeep)
  const dropped = content.length - headKeep - tailKeep
  return `${head}\n...[中间内容已省略 ${dropped} 字符，原始共 ${content.length} 字符]...\n${tail}`
}

function trimLoopMessages() {
  if (loopMessages.length <= MAX_LOOP_MESSAGES) return
  // 保留 index 0 (system) + index 1 (initial user)，从 index 2 开始裁剪 tool 交换对
  let i = 2
  while (loopMessages.length > MAX_LOOP_MESSAGES && i < loopMessages.length - 4) {
    const msg = loopMessages[i] as Record<string, unknown>
    const hasToolCalls = msg.role === 'assistant' && (
      (Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0) ||
      (Array.isArray(msg.content) && (msg.content as Array<{type:string}>).some((c) => c.type === 'tool_use'))
    )
    if (hasToolCalls) {
      // 找到此 assistant 消息后连续的 tool result 消息
      let j = i + 1
      while (j < loopMessages.length) {
        const next = loopMessages[j] as Record<string, unknown>
        const isResult = next.role === 'tool' ||
          (next.role === 'user' && Array.isArray(next.content) &&
           (next.content as Array<{type:string}>)[0]?.type === 'tool_result')
        if (isResult) j++
        else break
      }
      loopMessages.splice(i, j - i)
    } else {
      i++
    }
  }
}

// 子 agent 专用：相同逻辑，使用 MAX_SUB_MESSAGES 阈值，操作传入数组
function trimSubMessages(msgs: object[]) {
  if (msgs.length <= MAX_SUB_MESSAGES) return
  let i = 2
  while (msgs.length > MAX_SUB_MESSAGES && i < msgs.length - 4) {
    const msg = msgs[i] as Record<string, unknown>
    const hasToolCalls = msg.role === 'assistant' && (
      (Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0) ||
      (Array.isArray(msg.content) && (msg.content as Array<{type:string}>).some((c) => c.type === 'tool_use'))
    )
    if (hasToolCalls) {
      let j = i + 1
      while (j < msgs.length) {
        const next = msgs[j] as Record<string, unknown>
        const isResult = next.role === 'tool' ||
          (next.role === 'user' && Array.isArray(next.content) &&
           (next.content as Array<{type:string}>)[0]?.type === 'tool_result')
        if (isResult) j++
        else break
      }
      msgs.splice(i, j - i)
    } else {
      i++
    }
  }
}

function scrollToBottom() {
  const msgs = el('messages')
  if (msgs) msgs.scrollTop = msgs.scrollHeight
}

function appendMessage(role: string, content: string, opts: {
  isLog?: boolean; isError?: boolean; imageDataUrl?: string
} = {}): HTMLElement {
  const msgs = el('messages')
  const div = document.createElement('div')

  if (opts.isLog) {
    div.className = `tool-log${opts.isError ? ' tool-log--error' : ''}`
    div.innerHTML = `<span class="tool-log-icon">${opts.isError ? '✗' : '✓'}</span><span>${escHtml(content)}</span>`
  } else {
    div.className = `message message--${role}`
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    if (opts.imageDataUrl) {
      bubble.innerHTML = `<img src="${opts.imageDataUrl}" class="screenshot-preview" alt="screenshot"/><p>${formatContent(content)}</p>`
    } else {
      bubble.innerHTML = formatContent(content)
    }
    div.appendChild(bubble)
  }

  msgs.appendChild(div)
  scrollToBottom()
  return div
}

function appendStreamingMessage(role: string): { append: (chunk: string) => void; getText: () => string } {
  let full = ''
  const div = appendMessage(role, '')
  const bubble = div.querySelector('.bubble') as HTMLElement
  bubble.style.display = 'none'  // 初始隐藏，避免空白框
  return {
    append(chunk: string) {
      if (bubble.style.display === 'none') bubble.style.display = ''
      full += chunk
      bubble.innerHTML = formatContent(full)
      scrollToBottom()
    },
    getText() { return full },
  }
}

// ============================================================
// Loop 状态管理
// ============================================================
function setLoopState(state: LoopState) {
  loopState = state
  const labels: Record<LoopState, string> = {
    idle: '就绪', running: '运行中', paused: '已暂停',
    waiting_user: '等待输入', completed: '已完成', error: '出错',
  }
  el('loopStatus').textContent = labels[state]
  el('loopStatus').className = `loop-status loop-status--${state}`
  el('controlBar').style.display = state === 'idle' ? 'none' : 'flex'

  const btnStart = el<HTMLButtonElement>('btnStart')
  const btnPause = el<HTMLButtonElement>('btnPause')
  const btnStop = el<HTMLButtonElement>('btnStop')
  btnStart.disabled = state === 'running' || state === 'waiting_user'
  btnStart.textContent = state === 'paused' ? '▶ 继续' : '▶ 开始'
  btnPause.disabled = state !== 'running'
  btnStop.disabled = state === 'idle' || state === 'completed'
}

// ============================================================
// 用户介入 UI
// ============================================================
function showIntervention(req: InterventionRequest): Promise<string> {
  return new Promise((resolve) => {
    pendingIntervention = resolve
    el('interventionQuestion').textContent = req.question
    el('interventionOptions').innerHTML = ''
    el<HTMLInputElement>('interventionInput').value = ''

    if (req.options?.length) {
      el('interventionInputWrap').style.display = 'none'
      req.options.forEach((opt) => {
        const btn = document.createElement('button')
        btn.className = 'intervention-option'
        btn.textContent = opt
        btn.onclick = () => resolveIntervention(opt)
        el('interventionOptions').appendChild(btn)
      })
    } else {
      el('interventionInputWrap').style.display = 'flex'
      el<HTMLInputElement>('interventionInput').placeholder = req.placeholder ?? '请输入...'
    }

    el('interventionPanel').style.display = 'block'
    el('interventionPanel').scrollIntoView({ behavior: 'smooth' })
  })
}

function resolveIntervention(answer: string) {
  if (!pendingIntervention) return
  el('interventionPanel').style.display = 'none'
  const resolve = pendingIntervention
  pendingIntervention = null
  resolve(answer)
}

// ============================================================
// 活动记录
// ============================================================
async function addActivityEntry(entry: Omit<ActivityEntry, 'id' | 'timestamp'>) {
  const newEntry: ActivityEntry = {
    ...entry,
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
  }
  const current = await loadSettings()
  const log = [newEntry, ...(current.activityLog ?? [])].slice(0, 200)
  await saveSettings({ activityLog: log })
}


// ============================================================
// 候选人追踪
// ============================================================

async function upsertCandidate(
  entry: Partial<CandidateEntry> & { name: string; status: CandidateStatus }
): Promise<string> {
  const s = await loadSettings()
  const candidates = s.candidates ?? []
  const now = Date.now()
  const id = entry.id && candidates.find((c) => c.id === entry.id)
    ? entry.id
    : entry.id ?? `cand-${now}-${Math.random().toString(36).slice(2, 6)}`

  const existing = candidates.find((c) => c.id === id)
  const updated: CandidateEntry = {
    ...(existing ?? { createdAt: now }),
    ...entry,
    id,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  }

  const newList = existing
    ? candidates.map((c) => c.id === id ? updated : c)
    : [updated, ...candidates]

  await saveSettings({ candidates: newList })
  return id
}


// ============================================================
// 工作区记录（通用，按工作流隔离）
// ============================================================
async function upsertWorkspaceRecord(
  workflowId: string,
  recordId: string | undefined,
  data: Record<string, string>
): Promise<string> {
  const s = await loadSettings()
  const records = s.workspaceRecords ?? []
  const now = Date.now()
  const id = recordId && records.find((r) => r.id === recordId)
    ? recordId
    : `rec-${now}-${Math.random().toString(36).slice(2, 6)}`

  const existing = records.find((r) => r.id === id)
  const updated: WorkspaceRecord = {
    id,
    workflowId,
    data: { ...(existing?.data ?? {}), ...data },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const newList = existing ? records.map((r) => r.id === id ? updated : r) : [updated, ...records]
  await saveSettings({ workspaceRecords: newList })
  return id
}

async function addWorkspaceField(proposal: SchemaProposal): Promise<void> {
  const s = await loadSettings()
  const workflows = s.workflows.map((wf) => {
    if (wf.id !== proposal.workflowId) return wf
    const fields = wf.workspace?.fields ?? []
    if (fields.find((f) => f.id === proposal.field.id)) return wf // 已存在
    return { ...wf, workspace: { fields: [...fields, proposal.field] } }
  })
  await saveSettings({ workflows })
  appendMessage('system', `🔧 AI 提议新字段「${proposal.field.name}」已添加到工作流「${proposal.workflowName}」`, { isLog: true })
}

async function saveNewWorkflow(wf: Workflow): Promise<void> {
  const s = await loadSettings()
  await saveSettings({ workflows: [...s.workflows, wf] })
  settings.workflows = [...settings.workflows, wf]
  renderWorkflowList()
  refreshWorkspaceSelector()
}

async function listWorkspaceRecords(statusFilter?: string): Promise<WorkspaceRecord[]> {
  const s = await loadSettings()
  const wfId = currentWorkflow?.id
  let records = (s.workspaceRecords ?? []).filter((r) => !wfId || r.workflowId === wfId)
  if (statusFilter) {
    const statusFieldId = currentWorkflow?.workspace?.fields.find((f) => f.type === 'status')?.id
    if (statusFieldId) {
      records = records.filter((r) => r.data[statusFieldId] === statusFilter)
    }
  }
  return records
}

// 系统提示词：AI 引导用户通过实测逐步创建工作流
const WORKFLOW_CREATOR_SYSTEM_PROMPT = `你是一个工作流设计专家，通过「设计→实测→确认」的方式帮助用户创建可靠的浏览器自动化工作流。

## 创建流程（严格按顺序执行）

### 第一阶段：了解需求 + 分析目标页面
1. 用 ask_user 询问：目标网站 URL 是什么？想自动化什么任务？
2. 用 navigate_to 打开目标网站
3. 用 get_page_content 分析页面结构（页面有哪些区域、可交互元素、数据布局）
4. 用 scroll_page 浏览更多内容（如有必要）
5. 用 ask_user 展示你对页面的理解，确认需要自动化的操作和需要收集的数据字段

### 第二阶段：逐步设计 + 实测每个步骤
针对每个步骤，严格按以下循环：

**① 设计：** 基于实际页面元素编写该步骤的具体指令，然后用 ask_user 展示设计，选项为：
  「[✅ 测试此步骤] [⏭ 跳过测试直接保留] [✏ 修改设计]」

**② 实测（用户选择测试时）：** 调用 test_step 工具，在当前页面上真实执行步骤指令

**③ 确认：**
  - 测试通过 → ask_user: 「步骤通过，是否保留并继续设计下一步？[✅ 保留并继续] [✏ 微调后重测]」
  - 测试失败 → 分析原因，修改指令，重新测试，直至通过
  - 每步确认后：「还需要添加更多步骤吗？[➕ 添加下一步] [✅ 完成，创建工作流]」

### 第三阶段：汇总创建
所有步骤确认后：
1. 用 ask_user 展示完整工作流设计（步骤列表 + 数据字段汇总）
2. 用户确认后，调用 create_workflow 保存

## 步骤设计规则
- 指令必须具体，直接引用页面实际存在的元素/区域（不要写"点击按钮"，要写"点击消息列表中的候选人名称"）
- intervention: required=每步必须用户确认，optional=可跳过，none=全自动
- 敏感操作（发消息、提交表单）的步骤 intervention 设为 required
- completionHint 写明 AI 判断步骤完成的具体条件

## 数据字段规则（workspace）
- 字段 id 用英文/拼音（name、status、salary）
- 必须有一个 status 字段，options 覆盖完整状态生命周期
- type 可选: text / status / number / date / tags / url

## 核心原则
- 每个步骤都要先实测，基于真实页面编写指令
- 测试时发现的实际情况优先于假设
- 一次只专注一个步骤，不要跳跃式设计整个工作流
- 用户说「跳过测试」时可直接保留步骤进入下一步`

async function saveAiSkill(skill: Skill): Promise<void> {
  const s = await loadSettings()
  const skills = [skill, ...(s.skills ?? [])]
  await saveSettings({ skills })
  showSkillProposalBanner(skill)
}

function showSkillProposalBanner(skill: Skill) {
  const banner = document.getElementById('skillProposalBanner')
  if (!banner) return
  banner.innerHTML = `
    <div class="skill-proposal-card">
      <div class="sp-header">
        <span class="sp-badge">🧠 AI 发现</span>
        <span class="sp-name">${escHtml(skill.name)}</span>
      </div>
      <div class="sp-context">${escHtml(skill.aiContext ?? '')}</div>
      <div class="sp-desc">${escHtml(skill.description)}</div>
      <div class="sp-actions">
        <button class="sp-approve" data-id="${skill.id}">✓ 批准</button>
        <button class="sp-reject" data-id="${skill.id}">✕ 拒绝</button>
        <button class="sp-view" data-id="${skill.id}">查看详情</button>
      </div>
    </div>
  `
  banner.style.display = 'block'

  banner.querySelector('.sp-approve')!.addEventListener('click', async () => {
    const s = await loadSettings()
    await saveSettings({ skills: s.skills.map((sk) => sk.id === skill.id ? { ...sk, status: 'active' as const } : sk) })
    banner.style.display = 'none'
    appendMessage('system', `✓ Skill「${skill.name}」已批准并激活`, { isLog: true })
  })

  banner.querySelector('.sp-reject')!.addEventListener('click', async () => {
    const s = await loadSettings()
    await saveSettings({ skills: s.skills.filter((sk) => sk.id !== skill.id) })
    banner.style.display = 'none'
    appendMessage('system', `✕ Skill「${skill.name}」已拒绝删除`, { isLog: true })
  })

  banner.querySelector('.sp-view')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' })
  })
}

function renderWorkspaceTab(workflow: Workflow) {
  const titleEl = el('workspaceTitle')
  if (titleEl) titleEl.textContent = `${workflow.name} · 工作区`
  workspaceActiveWfId = workflow.id
  const sel = el<HTMLSelectElement>('workspaceWfSelector')
  if (sel) sel.value = workflow.id
  renderWorkspaceFilterBar(workflow)
  renderWorkspaceTabFiltered(workflow)
  renderMemoryPanel()
  renderWorkspaceActivity()
}

// ============================================================
// 记忆面板（工作区 tab 内）
// ============================================================
function renderMemoryPanel() {
  const container = el('memoryPanel')
  if (!container) return

  loadSettings().then((s) => {
    const wfId = workspaceActiveWfId ?? currentWorkflow?.id
    const persistent = (s.memoryEntries ?? []).filter(
      (e) => !e.workflowId || !wfId || e.workflowId === wfId
    )
    const sessionEntries = Object.entries(sessionMemory)
    const total = persistent.length + sessionEntries.length

    if (total === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:4px 0">暂无记忆。AI 执行时可通过 save_memory 工具写入。</div>'
      return
    }

    const persHtml = persistent.map((e) => `
      <div class="mem-row" data-key="${escHtml(e.key)}" data-layer="persistent">
        <span class="mem-badge mem-badge--persistent">持久</span>
        <span class="mem-key">${escHtml(e.key)}</span>
        <span class="mem-value">${escHtml(e.value)}</span>
        <button class="mem-del" title="删除">✕</button>
      </div>`).join('')

    const sessHtml = sessionEntries.map(([k, v]) => `
      <div class="mem-row" data-key="${escHtml(k)}" data-layer="session">
        <span class="mem-badge mem-badge--session">会话</span>
        <span class="mem-key">${escHtml(k)}</span>
        <span class="mem-value">${escHtml(v)}</span>
        <button class="mem-del" title="删除">✕</button>
      </div>`).join('')

    container.innerHTML = persHtml + sessHtml

    container.querySelectorAll<HTMLButtonElement>('.mem-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest<HTMLElement>('.mem-row')!
        const key = row.dataset.key!
        const layer = row.dataset.layer as 'session' | 'persistent'
        await deleteMemoryEntry(key, layer)
        renderMemoryPanel()
      })
    })
  })
}

function renderWorkspaceActivity() {
  const container = el('workspaceActivity')
  if (!container) return
  loadSettings().then((s) => {
    const entries = (s.activityLog ?? []).slice(0, 20)
    if (entries.length === 0) {
      container.innerHTML = '<div class="log-empty" style="padding:16px 0;font-size:11px">暂无活动记录</div>'
      return
    }
    const ICONS: Record<string, string> = { download: '📥', navigate: '🌐', candidate: '👤', note: '📝' }
    container.innerHTML = entries.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      return `<div class="activity-row">
        <span class="activity-icon">${ICONS[e.type] ?? '📌'}</span>
        <span class="activity-title">${escHtml(e.title)}</span>
        <span class="activity-time">${time}</span>
      </div>`
    }).join('')
  })
}

function getStatusColor(field: WorkspaceField | undefined, value: string | undefined): string {
  if (!field || !value) return '#aeaeb2'
  const idx = (field.options ?? []).indexOf(value)
  const colors = ['#aeaeb2', '#007aff', '#5856d6', '#ff9f0a', '#30d158', '#ff3b30', '#34c759']
  return colors[idx % colors.length] ?? '#aeaeb2'
}

// ============================================================
// 工具调用日志友好化
// ============================================================
function formatToolCallDisplay(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown, max = 60) => String(v ?? '').slice(0, max)
  switch (name) {
    case 'ask_user':
      return `💬 ${s(args.question, 80)}`
    case 'navigate_to':
      return `🌐 打开页面：${s(args.url)}`
    case 'click_element':
      return args.description
        ? `👆 点击「${s(args.description, 40)}」`
        : `👆 点击元素 ${args.ref}`
    case 'fill_input':
      return args.description
        ? `✏️ 填写「${s(args.description, 30)}」：${s(args.value, 30)}`
        : `✏️ 填写 ${args.ref}：${s(args.value, 30)}`
    case 'get_page_content':
      return `📄 读取页面内容`
    case 'scroll_page':
      return `↕️ 页面向${args.direction === 'up' ? '上' : '下'}滚动`
    case 'press_key':
      return `⌨️ 按键：${args.key}`
    case 'wait_ms':
      return `⏳ 等待 ${args.ms}ms`
    case 'take_screenshot':
      return `📸 申请截图（需用户确认）`
    case 'download_data':
      return `📥 下载文件：${s(args.filename)}`
    case 'open_new_tab':
      return `🔖 打开新标签页：${s(args.url)}`
    case 'log_record':
      return `📝 记录数据`
    case 'log_candidate':
      return `👤 记录候选人：${s(args.name)}`
    case 'save_memory':
      return `🧠 保存记忆：${s(args.key)} = ${s(args.value, 40)}`
    case 'list_memory':
      return `🧠 查看记忆列表`
    case 'delete_memory':
      return `🗑️ 删除记忆：${s(args.key)}`
    case 'run_sub_agent':
      return `🤖 启动子任务：${s(args.task, 60)}`
    case 'save_skill':
      return `💡 保存经验：${s(args.name)}`
    case 'evolve_schema':
      return `🔧 提议新字段：${s(args.fieldName ?? (args.field as Record<string,unknown>)?.name)}`
    case 'list_records':
      return `📋 查询工作区记录${args.statusFilter ? `（${args.statusFilter}）` : ''}`
    case 'create_workflow':
      return `⚙️ 创建工作流：${s(args.name)}`
    case 'test_step':
      return `🧪 测试步骤`
    default:
      return `⚙️ ${name}`
  }
}

function formatToolSuccessLog(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown, max = 50) => String(v ?? '').slice(0, max)
  switch (name) {
    case 'navigate_to': return `✓ 已打开：${s(args.url)}`
    case 'click_element': return args.description ? `✓ 已点击「${s(args.description, 30)}」` : `✓ 已点击`
    case 'fill_input': return `✓ 已填写`
    case 'scroll_page': return `✓ 已滚动`
    case 'press_key': return `✓ 已按键 ${args.key}`
    case 'wait_ms': return `✓ 已等待`
    case 'get_page_content': return `✓ 页面内容已读取`
    case 'open_new_tab': return `✓ 新标签页已打开`
    case 'log_record': return `✓ 数据已记录`
    case 'log_candidate': return `✓ 候选人「${s(args.name)}」已记录`
    case 'save_memory': return `✓ 记忆已保存`
    case 'delete_memory': return `✓ 记忆已删除`
    case 'download_data': return `✓ 文件已下载：${s(args.filename)}`
    case 'save_skill': return `✓ 经验已保存：${s(args.name)}`
    case 'create_workflow': return `✓ 工作流已创建：${s(args.name)}`
    case 'list_records': return `✓ 查询完成`
    default: return `✓ 完成`
  }
}

// ============================================================
// Agent Loop 核心
// ============================================================
async function runAgentLoop(initialUserMessage?: string) {
  if (loopState === 'running') return
  setLoopState('running')

  const wfId = currentWorkflow?.id
  const ctx = {
    targetTabId,
    taskName,
    tabGroupId: taskTabGroupId,
    workflowId: wfId,
    sendMsg,
    logActivity: addActivityEntry,
    logCandidate: upsertCandidate,
    logRecord: (recordId: string | undefined, data: Record<string, string>) =>
      upsertWorkspaceRecord(wfId ?? 'general', recordId, data),
    saveSkill: saveAiSkill,
    evolveSchema: addWorkspaceField,
    saveMemory: saveMemoryEntry,
    listMemory: listMemorySnapshot,
    deleteMemory: deleteMemoryEntry,
    runSubAgent: (task: string, context: string) => runSubAgentLoop(task, context, ctx),
    createWorkflow: saveNewWorkflow,
    listRecords: listWorkspaceRecords,
  }

  if (initialUserMessage) {
    loopMessages.push({ role: 'user', content: initialUserMessage })
    appendMessage('user', initialUserMessage)
  }

  const abortCtrl = new AbortController()
  loopAbortController = abortCtrl

  try {
    while ((loopState as string) === 'running' && !abortCtrl.signal.aborted) {
      const streaming = appendStreamingMessage('assistant')

      const response = await chatWithTools(loopMessages, TOOL_DEFINITIONS, settings, (chunk) => {
        streaming.append(chunk)
      })

      const assistantText = streaming.getText() || response.content

      // 记录 assistant 消息到队列
      if (settings.apiFormat === 'openai' && response.toolCalls.length > 0) {
        loopMessages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        })
      } else {
        loopMessages.push({ role: 'assistant', content: assistantText })
      }

      // 无 tool calls → 任务完成（或 AI 在等待）
      if (response.toolCalls.length === 0) {
        // 保存步骤摘要（用于下一步 system prompt 注入）
        previousStepSummary = assistantText.slice(0, 600)

        // 工作流：检查是否进入下一步
        if (currentWorkflow && currentStepIndex < currentWorkflow.steps.length - 1) {
          const prevStep = currentWorkflow.steps[currentStepIndex]
          currentStepIndex++
          updateWorkflowProgress()

          if (prevStep.intervention !== 'none') {
            setLoopState('paused')
            const nextStep = currentWorkflow.steps[currentStepIndex]
            appendMessage('assistant', `✅ 步骤完成！\n\n下一步：**${nextStep.name}**\n点击「▶ 继续」开始执行。`)
            break
          } else {
            // 自动进入下一步，刷新持久记忆缓存 + 工作区摘要
            _cachedPersistentMemory = await loadPersistentMemory(currentWorkflow.id)
            await refreshWorkspaceSummary(currentWorkflow.id)
            const nextStep = currentWorkflow.steps[currentStepIndex]
            const newSystemPrompt = buildStepSystemPrompt(nextStep, currentWorkflow, currentStepIndex, settings.skills)
              + buildMemorySection(_cachedPersistentMemory, true)
              + (previousStepSummary ? `\n## 上一步完成摘要\n${previousStepSummary}\n` : '')
            loopMessages = [
              { role: 'system', content: newSystemPrompt },
              { role: 'user', content: `请执行：${nextStep.name}` },
            ]
            appendMessage('assistant', `🔄 自动进入下一步：**${nextStep.name}**`)
            continue
          }
        }
        setLoopState('completed')
        break
      }

      // 执行 tool calls
      for (const toolCall of response.toolCalls) {
        if (abortCtrl.signal.aborted || (loopState as string) !== 'running') break

        appendMessage('system', formatToolCallDisplay(toolCall.name, toolCall.arguments), { isLog: true })

        const result = await executeTool(toolCall.name, toolCall.arguments, ctx)

        if (result.interventionRequest) {
          setLoopState('waiting_user')
          const answer = await showIntervention(result.interventionRequest)
          setLoopState('running')

          // take_screenshot 两阶段：用户同意后才真正截图
          if (result.pendingScreenshot) {
            if (answer === '允许截图') {
              const ssResp = await sendMsg({ type: 'TAKE_SCREENSHOT', targetTabId: ctx.targetTabId }) as {
                success: boolean; dataUrl?: string; error?: string
              }
              if (ssResp.success && ssResp.dataUrl) {
                appendMessage('assistant', '📸 截图', { imageDataUrl: ssResp.dataUrl })
                pushToolResult(toolCall, '截图已获取，请分析图像内容后继续。')
              } else {
                pushToolResult(toolCall, `截图失败: ${ssResp.error ?? '未知错误'}。请改用 get_page_content 或 ask_user。`)
              }
            } else {
              pushToolResult(toolCall, '用户拒绝截图。请通过 get_page_content + scroll_page 分析页面，或用 ask_user 让用户描述当前画面。')
            }
          } else {
            appendMessage('user', answer)
            pushToolResult(toolCall, answer)
          }
        } else {
          const resultText = formatToolResult(result)
          if (result.success) {
            appendMessage('system', formatToolSuccessLog(toolCall.name, toolCall.arguments), { isLog: true })
          } else {
            appendMessage('system', resultText.slice(0, 200), { isLog: true, isError: true })
          }
          if (result.screenshotDataUrl) {
            appendMessage('assistant', '📸 截图', { imageDataUrl: result.screenshotDataUrl })
          }
          // 工作区数据变化时刷新
          if (toolCall.name === 'log_record' && currentWorkflow) {
            renderWorkspaceTab(currentWorkflow)
          }
          // 新工作流创建后刷新工作流列表
          if (toolCall.name === 'create_workflow') {
            renderWorkflowList()
            refreshWorkspaceSelector()
          }
          pushToolResult(toolCall, resultText)
        }
      }
    }
  } catch (e) {
    if (!abortCtrl.signal.aborted) {
      appendMessage('assistant', `❌ 错误: ${e instanceof Error ? e.message : String(e)}`)
      setLoopState('error')
    }
  }
}

function pushToolResult(toolCall: ToolCallRequest, content: string) {
  const stored = compressForHistory(toolCall.name, content)
  if (settings.apiFormat === 'anthropic') {
    loopMessages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: stored }],
    })
  } else {
    loopMessages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: stored })
  }
  trimLoopMessages()
}


// ============================================================
// 工作流
// ============================================================
const INTERVENTION_LABELS: Record<string, string> = {
  none: '自动', optional: '⚡ 可选介入', required: '⚠️ 必须介入',
}

function renderWorkflowList() {
  const list = el('workflowList')
  list.innerHTML = ''
  settings.workflows.forEach((wf) => {
    const card = document.createElement('div')
    card.className = 'workflow-card'
    const stepsHtml = wf.steps.map((step, i) => `
      <div class="wf-step-item">
        <span class="wf-step-num">${i + 1}</span>
        <div>
          <div class="wf-step-name">${escHtml(step.name)}</div>
          <div class="wf-step-intervention">${INTERVENTION_LABELS[step.intervention] ?? step.intervention}</div>
        </div>
      </div>
    `).join('')
    card.innerHTML = `
      <div class="wf-header">
        <span class="wf-name">${escHtml(wf.name)}</span>
        <span class="wf-steps">${wf.steps.length} 步</span>
      </div>
      <p class="wf-desc">${escHtml(wf.description)}</p>
      ${wf.startUrl ? `<p class="wf-url">🔗 ${escHtml(wf.startUrl)}</p>` : ''}
      <div class="wf-footer">
        <div style="display:flex;gap:6px">
          <button class="wf-toggle-btn">▸ 步骤</button>
          <button class="wf-ctx-btn">✏ 背景</button>
        </div>
        <div style="display:flex;gap:6px">
          ${(wf.workspace?.fields.length ?? 0) > 0
            ? `<button class="btn-workspace" data-id="${wf.id}" style="height:30px;padding:0 10px;border:1px solid var(--accent);border-radius:20px;font-size:11px;color:var(--accent);background:none;cursor:pointer">🗂 工作区</button>`
            : ''}
          <button class="btn-primary btn-run-wf" data-id="${wf.id}">▶ 开始</button>
        </div>
      </div>
      <div class="wf-steps-list">${stepsHtml}</div>
      <div class="wf-ctx-editor" style="display:none;margin-top:8px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px">招聘标准、候选人要求等全局背景（注入每步 system prompt）</div>
        <textarea class="wf-ctx-textarea" rows="6" style="width:100%;font-size:11px;font-family:var(--font);border:1px solid var(--border);border-radius:8px;padding:7px 9px;resize:vertical;background:var(--bg-input);color:var(--text);outline:none;line-height:1.5">${escHtml(wf.context ?? '')}</textarea>
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:6px">
          <button class="wf-ctx-cancel" style="height:26px;padding:0 12px;border:1px solid var(--border);border-radius:13px;font-size:11px;color:var(--text2);background:none;cursor:pointer">取消</button>
          <button class="wf-ctx-save" style="height:26px;padding:0 12px;border:none;border-radius:13px;font-size:11px;font-weight:500;color:white;background:var(--accent);cursor:pointer">保存</button>
        </div>
      </div>
    `
    list.appendChild(card)

    const toggleBtn = card.querySelector<HTMLButtonElement>('.wf-toggle-btn')!
    const stepsList = card.querySelector<HTMLElement>('.wf-steps-list')!
    toggleBtn.addEventListener('click', () => {
      const open = stepsList.style.display === 'flex'
      stepsList.style.display = open ? 'none' : 'flex'
      toggleBtn.textContent = open ? '▸ 步骤' : '▾ 步骤'
    })

    // 内联 context 编辑
    const ctxBtn = card.querySelector<HTMLButtonElement>('.wf-ctx-btn')!
    const ctxEditor = card.querySelector<HTMLElement>('.wf-ctx-editor')!
    const ctxTextarea = card.querySelector<HTMLTextAreaElement>('.wf-ctx-textarea')!
    ctxBtn.addEventListener('click', () => {
      const open = ctxEditor.style.display !== 'none'
      ctxEditor.style.display = open ? 'none' : 'block'
      ctxBtn.textContent = open ? '✏ 背景' : '✕ 背景'
    })
    card.querySelector<HTMLButtonElement>('.wf-ctx-cancel')!.addEventListener('click', () => {
      ctxEditor.style.display = 'none'
      ctxBtn.textContent = '✏ 背景'
    })
    card.querySelector<HTMLButtonElement>('.wf-ctx-save')!.addEventListener('click', async () => {
      const newContext = ctxTextarea.value
      const updated = settings.workflows.map((w) => w.id === wf.id ? { ...w, context: newContext } : w)
      await saveSettings({ workflows: updated })
      settings.workflows = updated
      ctxEditor.style.display = 'none'
      ctxBtn.textContent = '✏ 背景'
      appendMessage('system', `✓ 工作流「${wf.name}」背景已更新`, { isLog: true })
    })

    card.querySelector<HTMLButtonElement>('.btn-workspace')?.addEventListener('click', () => {
      const target = settings.workflows.find((w) => w.id === wf.id)
      if (target) {
        switchTab('workspace')
        renderWorkspaceTab(target)
      }
    })
  })

  list.querySelectorAll<HTMLButtonElement>('.btn-run-wf').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wf = settings.workflows.find((w) => w.id === btn.dataset.id)
      if (wf) startWorkflow(wf)
    })
  })
}

async function startWorkflow(wf: Workflow) {
  currentWorkflow = wf
  currentStepIndex = 0
  taskName = wf.name
  loopMessages = []
  previousStepSummary = ''
  sessionMemory = {}   // 新工作流重置会话记忆
  // 加载 Layer 1 持久记忆 + L2 工作区摘要（缓存，供后续同步使用）
  _cachedPersistentMemory = await loadPersistentMemory(wf.id)
  await refreshWorkspaceSummary(wf.id)

  switchTab('chat')
  updateWorkflowProgress()

  appendMessage('assistant', `🚀 开始工作流：**${wf.name}**\n共 ${wf.steps.length} 步`)

  // 有 startUrl 时，让用户选择如何处理标签页
  if (wf.startUrl) {
    setLoopState('waiting_user')
    const tabChoice = await showIntervention({
      question: `工作流起始页面：${wf.startUrl}\n\n请选择打开方式：`,
      options: ['新标签页打开', '当前标签页导航', '使用当前标签页（已在目标页面）'],
    })
    setLoopState('running')

    if (tabChoice === '新标签页打开') {
      appendMessage('system', `📂 正在新标签页打开 ${wf.startUrl} ...`, { isLog: true })
      const resp = await sendMsg({
        type: 'OPEN_TAB_AND_WAIT',
        payload: { url: wf.startUrl },
      }) as { success: boolean; tabId?: number; error?: string }

      if (resp.success && resp.tabId) {
        targetTabId = resp.tabId
        const groupId = await (async () => {
          const r = await sendMsg({
            type: 'CREATE_TAB_GROUP',
            payload: { tabIds: [resp.tabId!], title: `Agent: ${wf.name}`, color: 'blue' },
          }) as { success: boolean; groupId?: number }
          return r.success ? r.groupId : undefined
        })()
        if (groupId) taskTabGroupId = groupId
        appendMessage('system', `✓ 新标签页已就绪 (tab ${resp.tabId})`, { isLog: true })
        const sel = el<HTMLSelectElement>('tabSelector')
        const existing = sel.querySelector<HTMLOptionElement>(`option[value="${resp.tabId}"]`)
        if (!existing) {
          const opt = document.createElement('option')
          opt.value = String(resp.tabId)
          opt.textContent = wf.startUrl!.slice(0, 45)
          sel.appendChild(opt)
        }
        sel.value = String(resp.tabId)
      } else {
        appendMessage('assistant', `⚠️ 无法打开目标页面：${resp.error ?? '未知错误'}\n\n请手动打开后在「目标页面」下拉框选中，再点击「▶ 开始」。`)
        setLoopState('paused')
        return
      }
    } else if (tabChoice === '当前标签页导航') {
      appendMessage('system', `📂 正在当前标签页导航至 ${wf.startUrl} ...`, { isLog: true })
      const resp = await sendMsg({
        type: 'NAVIGATE_TAB',
        payload: { url: wf.startUrl, targetTabId },
      }) as { success: boolean; tabId?: number; error?: string }
      if (resp.success) {
        if (resp.tabId) targetTabId = resp.tabId
        await new Promise((r) => setTimeout(r, 1000))
        appendMessage('system', `✓ 当前标签页已导航至目标页面`, { isLog: true })
      } else {
        appendMessage('assistant', `⚠️ 导航失败：${resp.error ?? '未知错误'}`)
        setLoopState('paused')
        return
      }
    } else {
      // 使用当前标签页，不导航
      appendMessage('system', `✓ 使用当前标签页（tab ${targetTabId ?? '活跃标签'}）`, { isLog: true })
    }
  }

  const firstStep = wf.steps[0]
  loopMessages = [
    { role: 'system', content: buildStepSystemPrompt(firstStep, wf, 0, settings.skills) + buildMemorySection(_cachedPersistentMemory, true) },
    { role: 'user', content: `请开始执行第一步：${firstStep.name}` },
  ]

  await runAgentLoop()
}

// ============================================================
// 子代理循环（独立上下文，不影响主循环 loopMessages）
// ============================================================
async function runSubAgentLoop(
  task: string,
  context: string,
  parentCtx: Parameters<typeof executeTool>[2]
): Promise<string> {
  // 子代理系统提示：只含任务背景，不注入工作区摘要（主 agent 专用）
  // 也不注入完整 session memory（避免不同候选人上下文污染）
  const subSystemPrompt = `你是浏览器自动化子代理，执行具体的独立子任务。

操作规则：
- 每次工具调用前先输出一句「正在…」说明
- get_page_content 是主要分析手段，禁止主动截图
- 遇到敏感操作（发消息、提交表单）先调用 ask_user 确认
- 任务完成后简洁报告：执行了什么、结果是什么、遇到了什么问题

## 子任务背景
${context}`

  // 并发上限检查（条件 1：超出上限时拒绝启动）
  const runningCount = [...subAgentRegistry.values()].filter((e) => e.status === 'running').length
  if (runningCount >= settings.maxConcurrentAgents) {
    return `子代理启动被拒绝：当前已有 ${runningCount} 个子任务运行中（上限 ${settings.maxConcurrentAgents}），请等待子任务完成后重试。`
  }

  const subMessages: object[] = [
    { role: 'system', content: subSystemPrompt },
    { role: 'user', content: task },
  ]

  // 每个子代理独立的 AbortController，父循环中止时级联中止
  const subAbortCtrl = new AbortController()
  if (loopAbortController) {
    loopAbortController.signal.addEventListener('abort', () => subAbortCtrl.abort(), { once: true })
  }

  // 注册到子代理注册表
  const agentId = `sa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const entry: SubAgentEntry = {
    id: agentId,
    task: task.slice(0, 80),
    status: 'running',
    toolCallCount: 0,
    lastAction: '启动中…',
    startedAt: Date.now(),
    abortCtrl: subAbortCtrl,
  }
  subAgentRegistry.set(agentId, entry)
  renderSubAgentPanel()

  appendMessage('system', `🤖 子代理 #${agentId.slice(-4)} 启动: ${task.slice(0, 60)}`, { isLog: true })

  let finalText = ''
  let iterations = 0
  const MAX_SUB_ITER = 30

  try {
    while (iterations < MAX_SUB_ITER && !subAbortCtrl.signal.aborted) {
      // 超时检查（条件 2：距启动超过 subAgentTimeoutMs）
      if (Date.now() - entry.startedAt > settings.subAgentTimeoutMs) {
        entry.status = 'aborted'
        entry.endedAt = Date.now()
        renderSubAgentPanel()
        appendMessage('system', `🤖 [#${agentId.slice(-4)}] 超时自动结束（超过 ${Math.round(settings.subAgentTimeoutMs / 3600000)}h）`, { isLog: true })
        return `子代理超时：已超过配置的最长运行时间（${Math.round(settings.subAgentTimeoutMs / 3600000)} 小时）`
      }
      iterations++
      const response = await chatWithTools(subMessages, TOOL_DEFINITIONS, settings)
      const assistantText = response.content

      if (response.toolCalls.length === 0) {
        finalText = assistantText
        break
      }

      if (settings.apiFormat === 'openai' && response.toolCalls.length > 0) {
        subMessages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        })
      } else {
        subMessages.push({ role: 'assistant', content: assistantText })
      }

      for (const toolCall of response.toolCalls) {
        if (subAbortCtrl.signal.aborted) break

        entry.toolCallCount++
        entry.lastAction = formatToolCallDisplay(toolCall.name, toolCall.arguments)
        renderSubAgentPanel()

        appendMessage('system', `  ↳ [#${agentId.slice(-4)}] ${formatToolCallDisplay(toolCall.name, toolCall.arguments)}`, { isLog: true })

        const result = await executeTool(toolCall.name, toolCall.arguments, parentCtx)

        let resultText: string
        if (result.interventionRequest) {
          setLoopState('waiting_user')
          const answer = await showIntervention(result.interventionRequest)
          setLoopState('running')
          resultText = result.pendingScreenshot
            ? (answer === '允许截图'
              ? await (async () => {
                  const ssResp = await sendMsg({ type: 'TAKE_SCREENSHOT', targetTabId: parentCtx.targetTabId }) as { success: boolean; dataUrl?: string; error?: string }
                  if (ssResp.success && ssResp.dataUrl) {
                    appendMessage('assistant', '📸 [子代理截图]', { imageDataUrl: ssResp.dataUrl })
                    return '截图已获取。'
                  }
                  return `截图失败: ${ssResp.error ?? '未知'}`
                })()
              : '用户拒绝截图。请用 get_page_content 继续分析。')
            : answer
        } else {
          resultText = formatToolResult(result)
          if (result.screenshotDataUrl) {
            appendMessage('assistant', '📸 [子代理截图]', { imageDataUrl: result.screenshotDataUrl })
          }
          if (toolCall.name === 'log_record' && currentWorkflow) {
            renderWorkspaceTab(currentWorkflow)
          }
        }

        // 子 agent 使用 SUB_ 压缩参数（不激进）
        const compressed = compressForHistory(toolCall.name, resultText, SUB_COMPRESS_THRESHOLD, SUB_HEAD_KEEP, SUB_TAIL_KEEP)
        if (settings.apiFormat === 'anthropic') {
          subMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: compressed }] })
        } else {
          subMessages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: compressed })
        }

        trimSubMessages(subMessages)
      }
    }

    const aborted = subAbortCtrl.signal.aborted
    entry.status = aborted ? 'aborted' : 'completed'
    entry.endedAt = Date.now()
    const summary = finalText || (aborted ? '子代理已被终止' : '子代理已完成任务（无文本输出）')
    appendMessage('system', `🤖 [#${agentId.slice(-4)}] ${entry.status === 'aborted' ? '已终止' : '完成'}: ${summary.slice(0, 80)}`, { isLog: true })
    renderSubAgentPanel()
    return summary
  } catch (e) {
    entry.status = 'error'
    entry.endedAt = Date.now()
    renderSubAgentPanel()
    const errMsg = e instanceof Error ? e.message : String(e)
    appendMessage('system', `🤖 [#${agentId.slice(-4)}] 出错: ${errMsg.slice(0, 80)}`, { isLog: true, isError: true })
    return `子代理出错: ${errMsg}`
  }
}

// ---- 子代理面板渲染 ----
function renderSubAgentPanel() {
  const panel = document.getElementById('subAgentPanel')
  const list = document.getElementById('subAgentList')
  if (!panel || !list) return

  const entries = [...subAgentRegistry.values()].reverse()  // 最新在前
  if (entries.length === 0) { panel.style.display = 'none'; return }
  panel.style.display = 'block'

  const runningCount = entries.filter((e) => e.status === 'running').length
  const header = document.getElementById('subAgentPanelTitle')
  if (header) header.textContent = `🤖 子任务 (${runningCount} 运行中 / ${entries.length} 总计)`

  list.innerHTML = entries.map((entry) => {
    const elapsed = entry.endedAt
      ? `${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)}s`
      : `${((Date.now() - entry.startedAt) / 1000).toFixed(0)}s`
    const statusDot = { running: '🟡', completed: '🟢', error: '🔴', aborted: '⚪' }[entry.status]
    const stopBtn = entry.status === 'running'
      ? `<button class="sa-stop-btn" data-id="${entry.id}" title="终止此子任务">⏹</button>`
      : ''
    return `<div class="sa-entry sa-${entry.status}">
      <div class="sa-row1">
        <span class="sa-status">${statusDot}</span>
        <span class="sa-id">#${entry.id.slice(-4)}</span>
        <span class="sa-task">${escHtml(entry.task)}</span>
        ${stopBtn}
      </div>
      <div class="sa-row2">
        <span class="sa-meta">${entry.toolCallCount} 次操作 · ${elapsed}</span>
        <span class="sa-last">${escHtml(entry.lastAction)}</span>
      </div>
    </div>`
  }).join('')

  // 绑定停止按钮
  list.querySelectorAll<HTMLButtonElement>('.sa-stop-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id!
      const e = subAgentRegistry.get(id)
      if (e) { e.abortCtrl.abort(); e.status = 'aborted'; e.endedAt = Date.now(); renderSubAgentPanel() }
    })
  })
}

function updateWorkflowProgress() {
  const el2 = el('workflowProgress')
  if (!currentWorkflow || !el2) return
  const total = currentWorkflow.steps.length
  const cur = currentStepIndex + 1
  el2.style.display = 'block'
  el2.innerHTML = `
    <div class="progress-info">步骤 ${cur}/${total}：${escHtml(currentWorkflow.steps[currentStepIndex]?.name ?? '')}</div>
    <div class="progress-track"><div class="progress-fill" style="width:${(cur / total * 100).toFixed(0)}%"></div></div>
  `
}

// ============================================================
// 工作区
// ============================================================
function refreshWorkspaceSelector() {
  const sel = el<HTMLSelectElement>('workspaceWfSelector')
  if (!sel) return
  const prev = sel.value
  sel.innerHTML = '<option value="">选择工作流…</option>'
  settings.workflows.forEach((wf) => {
    if (!wf.workspace?.fields.length) return
    const opt = document.createElement('option')
    opt.value = wf.id
    opt.textContent = wf.name
    sel.appendChild(opt)
  })
  if (prev) sel.value = prev
}

function refreshWorkspaceTab() {
  refreshWorkspaceSelector()
  renderMemoryPanel()   // 无论选哪个工作流都刷新记忆面板
  const sel = el<HTMLSelectElement>('workspaceWfSelector')
  let wfId = workspaceActiveWfId ?? currentWorkflow?.id
  // 没有活跃工作流时，自动选中下拉框中第一个可用工作流
  if (!wfId && sel && sel.options.length > 1) {
    wfId = sel.options[1].value
    workspaceActiveWfId = wfId
  }
  if (!wfId) return
  const wf = settings.workflows.find((w) => w.id === wfId)
  if (wf) {
    if (sel && sel.value !== wfId) sel.value = wfId
    renderWorkspaceFilterBar(wf)
    renderWorkspaceTab(wf)
  }
}

function renderWorkspaceFilterBar(wf: import('./types').Workflow) {
  const bar = el('workspaceFilterBar')
  if (!bar) return
  const statusField = wf.workspace?.fields.find((f) => f.type === 'status')
  if (!statusField?.options?.length) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'
  bar.innerHTML = ['全部', ...statusField.options].map((opt, i) =>
    `<button class="filter-btn${i === 0 ? ' active' : ''}" data-ws-status="${opt}">${escHtml(opt)}</button>`
  ).join('')
  bar.querySelectorAll<HTMLButtonElement>('[data-ws-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      renderWorkspaceTabFiltered(wf, btn.dataset.wsStatus === '全部' ? undefined : btn.dataset.wsStatus)
    })
  })
}

function renderWorkspaceTabFiltered(wf: import('./types').Workflow, statusFilter?: string) {
  loadSettings().then((s) => {
    const schema = wf.workspace?.fields ?? []
    const statusField = schema.find((f) => f.type === 'status')
    let records = (s.workspaceRecords ?? []).filter((r) => r.workflowId === wf.id)
    if (statusFilter && statusField) {
      records = records.filter((r) => r.data[statusField.id] === statusFilter)
    }
    renderWorkspaceRecords(el('workspaceRecords'), schema, records)
  })
}

function renderWorkspaceRecords(
  container: HTMLElement | null,
  schema: import('./types').WorkspaceField[],
  records: WorkspaceRecord[]
) {
  if (!container) return
  if (records.length === 0) {
    container.innerHTML = '<div class="workspace-empty">暂无记录。AI 执行工作流时会自动写入。</div>'
    return
  }
  const nameField = schema.find((f) => f.required) ?? schema[0]
  const statusField = schema.find((f) => f.type === 'status')

  container.innerHTML = records.map((rec) => {
    const name = nameField ? rec.data[nameField.id] ?? '未命名' : '未命名'
    const status = statusField ? rec.data[statusField.id] : undefined
    const statusColor = getStatusColor(statusField, status)
    const time = new Date(rec.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })

    const otherFields = schema
      .filter((f) => f.id !== nameField?.id && f.id !== statusField?.id && rec.data[f.id])
      .map((f) => {
        const val = rec.data[f.id]
        if (f.type === 'tags') {
          return val.split(',').map((t) => `<span class="cand-tag">${escHtml(t.trim())}</span>`).join('')
        }
        return `<span class="ws-field"><span class="ws-field-label">${escHtml(f.name)}:</span>${escHtml(val)}</span>`
      }).join('')

    // 状态字段的手动编辑下拉框
    const statusEditHtml = statusField?.options?.length
      ? `<select class="ws-status-edit" data-record-id="${escHtml(rec.id)}" data-field-id="${escHtml(statusField.id)}" title="手动修改状态">
          ${statusField.options.map((opt) =>
            `<option value="${escHtml(opt)}"${opt === status ? ' selected' : ''}>${escHtml(opt)}</option>`
          ).join('')}
        </select>`
      : ''

    return `<div class="cand-card" data-record-id="${escHtml(rec.id)}">
      <div class="cand-header">
        <span class="cand-name">${escHtml(name)}</span>
        ${statusEditHtml || (status ? `<span class="cand-status" style="color:${statusColor};border-color:${statusColor}">${escHtml(status)}</span>` : '')}
        <span class="cand-time">${time}</span>
      </div>
      ${otherFields ? `<div class="ws-fields" style="margin-top:5px;display:flex;flex-wrap:wrap;gap:6px">${otherFields}</div>` : ''}
    </div>`
  }).join('')

  // 绑定状态下拉框的修改事件
  container.querySelectorAll<HTMLSelectElement>('.ws-status-edit').forEach((sel) => {
    // 为状态标签着色
    const applyColor = () => {
      const val = sel.value
      const color = getStatusColor(statusField, val)
      sel.style.color = color
      sel.style.borderColor = color
    }
    applyColor()
    sel.addEventListener('change', async () => {
      const recId = sel.dataset.recordId!
      const fieldId = sel.dataset.fieldId!
      const wfId = workspaceActiveWfId ?? currentWorkflow?.id ?? ''
      await upsertWorkspaceRecord(wfId, recId, { [fieldId]: sel.value })
      applyColor()
      // 刷新工作区摘要（用户手动改状态后需更新）
      await refreshWorkspaceSummary(wfId)
      appendMessage('system', `✓ 状态已更新：${sel.value}`, { isLog: true })
    })
  })
}

// ============================================================
// 标签切换
// ============================================================
function switchTab(tab: string) {
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
    panel.style.display = panel.dataset.tab === tab ? 'flex' : 'none'
  })
  if (tab === 'workspace') refreshWorkspaceTab()
}

// ============================================================
// 标签页选择器
// ============================================================
async function refreshTabSelector() {
  const tabs = await getAllTabs(sendMsg)
  const select = el<HTMLSelectElement>('tabSelector')
  select.innerHTML = '<option value="">自动（当前活跃页）</option>'
  tabs.forEach((tab) => {
    const opt = document.createElement('option')
    opt.value = String(tab.id)
    opt.textContent = (tab.title ?? tab.url ?? '未知页面').slice(0, 45)
    select.appendChild(opt)
  })
  if (targetTabId) select.value = String(targetTabId)
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  settings = await loadSettings()

  // 标签切换
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab ?? 'chat'
      switchTab(tab)
      if (tab === 'workflow') renderWorkflowList()
    })
  })

  // 设置标签页按钮（CSP-safe，不用 onclick）
  el('openSettingsBtn')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' })
  })

  // 初始加载 tab 选择器
  await refreshTabSelector()

  el('tabSelector').addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value
    targetTabId = val ? parseInt(val) : undefined
  })

  el('refreshTabsBtn').addEventListener('click', refreshTabSelector)

  // Loop 控制
  el('btnStart').addEventListener('click', async () => {
    if (loopState === 'paused' && currentWorkflow) {
      // 刷新持久记忆缓存 + 工作区摘要（用户可能在步骤间手动修改了记忆/记录）
      _cachedPersistentMemory = await loadPersistentMemory(currentWorkflow.id)
      await refreshWorkspaceSummary(currentWorkflow.id)
      const nextStep = currentWorkflow.steps[currentStepIndex]
      const resumeSystemPrompt = buildStepSystemPrompt(nextStep, currentWorkflow, currentStepIndex, settings.skills)
        + buildMemorySection(_cachedPersistentMemory, true)
        + (previousStepSummary ? `\n## 上一步完成摘要\n${previousStepSummary}\n` : '')
      loopMessages = [
        { role: 'system', content: resumeSystemPrompt },
        { role: 'user', content: `请继续执行：${nextStep.name}` },
      ]
      await runAgentLoop()
    } else if (loopState === 'paused') {
      await runAgentLoop()
    } else {
      const input = el<HTMLTextAreaElement>('userInput')
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      loopMessages = [{ role: 'system', content: settings.systemPrompt }]
      taskName = text.slice(0, 30)
      await runAgentLoop(text)
    }
  })

  el('btnPause').addEventListener('click', () => {
    if (loopState === 'running') setLoopState('paused')
  })

  el('btnStop').addEventListener('click', () => {
    loopAbortController?.abort()
    loopMessages = []
    currentWorkflow = null
    currentStepIndex = 0
    previousStepSummary = ''
    sessionMemory = {}
    el('workflowProgress').style.display = 'none'
    setLoopState('idle')
    appendMessage('assistant', '⏹ 任务已停止')
  })

  // 普通发送
  el('sendBtn').addEventListener('click', handleSend)
  el<HTMLTextAreaElement>('userInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  })

  // 用户介入面板
  el('interventionSubmit').addEventListener('click', () => {
    const answer = el<HTMLInputElement>('interventionInput').value.trim()
    if (answer) resolveIntervention(answer)
  })
  el<HTMLInputElement>('interventionInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const answer = (e.target as HTMLInputElement).value.trim()
      if (answer) resolveIntervention(answer)
    }
  })

  // 创建标签分组
  el('createGroupBtn')?.addEventListener('click', async () => {
    const select = el<HTMLSelectElement>('tabSelector')
    const tabId = select.value ? parseInt(select.value) : undefined
    if (!tabId) { appendMessage('assistant', '请先选择一个标签页'); return }
    const groupId = await createTaskTabGroup(sendMsg, [tabId], taskName)
    if (groupId !== null) {
      taskTabGroupId = groupId
      appendMessage('system', `✓ 已创建任务标签组 (id=${groupId})`, { isLog: true })
    }
  })

  // 设置页按钮
  el('settingsBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' })
  })

  // 工作流管理按钮（跳转到设置页）
  el('manageWorkflowsBtn')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' })
  })

  // AI 创建工作流
  el('btnCreateWorkflowAi')?.addEventListener('click', async () => {
    if (loopState === 'running' || loopState === 'waiting_user') {
      appendMessage('assistant', '⚠️ 当前有任务正在执行，请先停止后再创建工作流。')
      switchTab('chat')
      return
    }
    loopAbortController?.abort()
    currentWorkflow = null
    currentStepIndex = 0
    previousStepSummary = ''
    sessionMemory = {}
    taskName = 'AI 创建工作流'
    loopMessages = [{ role: 'system', content: WORKFLOW_CREATOR_SYSTEM_PROMPT }]
    el('workflowProgress').style.display = 'none'
    switchTab('chat')
    // AI 立刻开始提问（会通过 ask_user 工具与用户对话）
    await runAgentLoop('请帮我创建一个浏览器自动化工作流。请先问我目标网站，然后打开页面分析结构，再逐步设计并实测每个步骤。')
  })

  // 子代理面板折叠
  document.getElementById('subAgentPanelHeader')?.addEventListener('click', () => {
    const list = document.getElementById('subAgentList')!
    const toggle = document.getElementById('subAgentPanelToggle')!
    const collapsed = list.style.display === 'none'
    list.style.display = collapsed ? '' : 'none'
    toggle.textContent = collapsed ? '▾' : '▸'
  })

  // 工作区工作流选择器
  el('workspaceWfSelector')?.addEventListener('change', (e) => {
    workspaceActiveWfId = (e.target as HTMLSelectElement).value || undefined
    if (workspaceActiveWfId) {
      const wf = settings.workflows.find((w) => w.id === workspaceActiveWfId)
      if (wf) renderWorkspaceTab(wf)
    }
  })

  // 设置更新监听
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATED') {
      loadSettings().then((s) => {
        settings = s
        renderWorkflowList()
        refreshWorkspaceSelector()
      })
    }
  })

  setLoopState('idle')
}

async function handleSend() {
  const input = el<HTMLTextAreaElement>('userInput')
  const text = input.value.trim()
  if (!text || loopState === 'running' || loopState === 'waiting_user') return
  input.value = ''

  if (loopState === 'idle' || loopState === 'completed' || loopState === 'error') {
    loopMessages = [{ role: 'system', content: settings.systemPrompt }]
    taskName = text.slice(0, 30)
    await runAgentLoop(text)
  } else if (loopState === 'paused') {
    appendMessage('user', text)
    loopMessages.push({ role: 'user', content: text })
    await runAgentLoop()
  }
}

document.addEventListener('DOMContentLoaded', init)
