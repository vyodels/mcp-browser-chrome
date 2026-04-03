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
const MAX_LOOP_MESSAGES = 40    // 消息总数上限（超出时丢弃最旧的 tool 对）
const LARGE_TOOLS = new Set(['get_page_content', 'take_screenshot'])

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

// 构建注入 system prompt 的记忆文本（Layer 1 + Layer 2）
function buildMemorySection(persistentEntries: MemoryEntry[] = _cachedPersistentMemory): string {
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

  if (parts.length === 0) return ''
  return `\n## 🗃 记忆上下文\n${parts.join('\n')}\n`
}

// ============================================================
// 消息队列压缩 + 滑动窗口
// ============================================================
function compressForHistory(toolName: string, content: string): string {
  if (LARGE_TOOLS.has(toolName) && content.length > 600) {
    return `${content.slice(0, 400)}\n...[${toolName} 结果已截断，原始 ${content.length} 字符]`
  }
  return content
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
            // 自动进入下一步，刷新持久记忆缓存（AI 可能在上一步写了持久记忆）
            _cachedPersistentMemory = await loadPersistentMemory(currentWorkflow.id)
            const nextStep = currentWorkflow.steps[currentStepIndex]
            const newSystemPrompt = buildStepSystemPrompt(nextStep, currentWorkflow, currentStepIndex, settings.skills)
              + buildMemorySection()
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

        appendMessage('system', `🔧 ${toolCall.name}(${formatToolArgs(toolCall.arguments)})`, { isLog: true })

        const result = await executeTool(toolCall.name, toolCall.arguments, ctx)

        if (result.interventionRequest) {
          setLoopState('waiting_user')
          const answer = await showIntervention(result.interventionRequest)
          setLoopState('running')
          appendMessage('user', answer)
          pushToolResult(toolCall, answer)
        } else {
          const resultText = formatToolResult(result)
          appendMessage('system', resultText.slice(0, 300), { isLog: true, isError: !result.success })
          if (result.screenshotDataUrl) {
            appendMessage('assistant', '📸 截图', { imageDataUrl: result.screenshotDataUrl })
          }
          // 工作区数据变化时刷新
          if (toolCall.name === 'log_record' && currentWorkflow) {
            renderWorkspaceTab(currentWorkflow)
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

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args).slice(0, 3)
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 30)}`).join(', ')
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
  // 加载 Layer 1 持久记忆（缓存，供后续同步使用）
  _cachedPersistentMemory = await loadPersistentMemory(wf.id)

  switchTab('chat')
  updateWorkflowProgress()

  appendMessage('assistant', `🚀 开始工作流：**${wf.name}**\n共 ${wf.steps.length} 步`)

  // 有 startUrl 时直接开好标签页并等待加载，避免 content script 未注入的问题
  if (wf.startUrl) {
    appendMessage('system', `📂 正在打开 ${wf.startUrl} ...`, { isLog: true })
    const resp = await sendMsg({
      type: 'OPEN_TAB_AND_WAIT',
      payload: { url: wf.startUrl },
    }) as { success: boolean; tabId?: number; error?: string }

    if (resp.success && resp.tabId) {
      targetTabId = resp.tabId
      // 创建任务标签组
      const groupId = await (async () => {
        const r = await sendMsg({
          type: 'CREATE_TAB_GROUP',
          payload: { tabIds: [resp.tabId!], title: `Agent: ${wf.name}`, color: 'blue' },
        }) as { success: boolean; groupId?: number }
        return r.success ? r.groupId : undefined
      })()
      if (groupId) taskTabGroupId = groupId
      appendMessage('system', `✓ 标签页已就绪 (tab ${resp.tabId})`, { isLog: true })

      // 更新 tabSelector 选中项
      const sel = el<HTMLSelectElement>('tabSelector')
      const existing = sel.querySelector<HTMLOptionElement>(`option[value="${resp.tabId}"]`)
      if (!existing) {
        const opt = document.createElement('option')
        opt.value = String(resp.tabId)
        opt.textContent = wf.startUrl.slice(0, 45)
        sel.appendChild(opt)
      }
      sel.value = String(resp.tabId)
    } else {
      appendMessage('assistant', `⚠️ 无法打开目标页面：${resp.error ?? '未知错误'}\n\n请手动打开 ${wf.startUrl}，然后在「目标页面」下拉框选中它，再点击「▶ 开始」。`)
      setLoopState('paused')
      return
    }
  }

  const firstStep = wf.steps[0]
  loopMessages = [
    { role: 'system', content: buildStepSystemPrompt(firstStep, wf, 0, settings.skills) + buildMemorySection() },
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
  const subSystemPrompt = `${settings.systemPrompt}\n\n## 子任务背景\n${context}${buildMemorySection()}`
  const subMessages: object[] = [
    { role: 'system', content: subSystemPrompt },
    { role: 'user', content: task },
  ]

  appendMessage('system', `🤖 子代理启动: ${task.slice(0, 80)}`, { isLog: true })

  const abortCtrl = loopAbortController ?? new AbortController()
  let finalText = ''
  let iterations = 0
  const MAX_SUB_ITER = 30

  while (iterations < MAX_SUB_ITER && !abortCtrl.signal.aborted) {
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
      if (abortCtrl.signal.aborted) break

      appendMessage('system', `  ↳ [子代理] ${toolCall.name}(${formatToolArgs(toolCall.arguments)})`, { isLog: true })

      const result = await executeTool(toolCall.name, toolCall.arguments, parentCtx)

      let resultText: string
      if (result.interventionRequest) {
        setLoopState('waiting_user')
        const answer = await showIntervention(result.interventionRequest)
        setLoopState('running')
        resultText = answer
      } else {
        resultText = formatToolResult(result)
        if (result.screenshotDataUrl) {
          appendMessage('assistant', '📸 [子代理截图]', { imageDataUrl: result.screenshotDataUrl })
        }
        if (toolCall.name === 'log_record' && currentWorkflow) {
          renderWorkspaceTab(currentWorkflow)
        }
      }

      const compressed = compressForHistory(toolCall.name, resultText)
      if (settings.apiFormat === 'anthropic') {
        subMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: compressed }] })
      } else {
        subMessages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: compressed })
      }

      // 子消息窗口裁剪
      if (subMessages.length > MAX_LOOP_MESSAGES) {
        subMessages.splice(2, 2)  // 删除最旧的 tool 交换对
      }
    }
  }

  const summary = finalText || '子代理已完成任务（无文本输出）'
  appendMessage('system', `🤖 子代理完成: ${summary.slice(0, 100)}`, { isLog: true })
  return summary
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
  const wfId = workspaceActiveWfId ?? currentWorkflow?.id
  if (!wfId) return
  const wf = settings.workflows.find((w) => w.id === wfId)
  if (wf) {
    const sel = el<HTMLSelectElement>('workspaceWfSelector')
    if (sel && !sel.value) sel.value = wfId
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

    return `<div class="cand-card">
      <div class="cand-header">
        <span class="cand-name">${escHtml(name)}</span>
        ${status ? `<span class="cand-status" style="color:${statusColor};border-color:${statusColor}">${escHtml(status)}</span>` : ''}
        <span class="cand-time">${time}</span>
      </div>
      ${otherFields ? `<div class="ws-fields" style="margin-top:5px;display:flex;flex-wrap:wrap;gap:6px">${otherFields}</div>` : ''}
    </div>`
  }).join('')
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
      // 刷新持久记忆缓存（用户可能在步骤间手动修改了记忆）
      _cachedPersistentMemory = await loadPersistentMemory(currentWorkflow.id)
      const nextStep = currentWorkflow.steps[currentStepIndex]
      const resumeSystemPrompt = buildStepSystemPrompt(nextStep, currentWorkflow, currentStepIndex, settings.skills)
        + buildMemorySection()
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
