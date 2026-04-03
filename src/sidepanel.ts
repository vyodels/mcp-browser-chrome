// ============================================================
// sidepanel.ts — 侧边栏主逻辑 v2
// Agent Loop 控制 + Tool Calling + 工作流执行 + Apple 风格 UI
// ============================================================
import { loadSettings, saveSettings } from './store'
import { chatWithTools } from './openai'
import { TOOL_DEFINITIONS, executeTool, formatToolResult } from './tools'
import { createTaskTabGroup, getAllTabs } from './tabManager'
import { buildStepSystemPrompt } from './workflow'
import type { Settings, LoopState, InterventionRequest, Workflow, ActivityEntry, ActivityType } from './types'
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
let currentLogFilter: ActivityType | 'all' = 'all'

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

const ACTIVITY_ICONS: Record<ActivityType, string> = {
  download: '📥', navigate: '🌐', candidate: '👤', note: '📝',
}

function renderActivityLog(filter: ActivityType | 'all' = 'all') {
  loadSettings().then((s) => {
    const logEl = el('activityLog')
    const entries = filter === 'all'
      ? (s.activityLog ?? [])
      : (s.activityLog ?? []).filter((e) => e.type === filter)
    if (entries.length === 0) {
      logEl.innerHTML = '<div class="log-empty">暂无活动记录</div>'
      return
    }
    logEl.innerHTML = entries.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      return `<div class="log-entry">
        <span class="log-icon">${ACTIVITY_ICONS[e.type] ?? '📌'}</span>
        <div class="log-content">
          <div class="log-title">${escHtml(e.title)}</div>
          ${e.detail ? `<div class="log-detail">${escHtml(e.detail)}</div>` : ''}
          ${e.taskName ? `<div class="log-detail" style="color:var(--accent)">${escHtml(e.taskName)}</div>` : ''}
          <div class="log-time">${time}</div>
        </div>
      </div>`
    }).join('')
  })
}

// ============================================================
// Agent Loop 核心
// ============================================================
async function runAgentLoop(initialUserMessage?: string) {
  if (loopState === 'running') return
  setLoopState('running')

  const ctx = {
    targetTabId,
    taskName,
    tabGroupId: taskTabGroupId,
    sendMsg,
    logActivity: addActivityEntry,
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
            // 自动进入下一步
            const nextStep = currentWorkflow.steps[currentStepIndex]
            const newSystemPrompt = buildStepSystemPrompt(nextStep, currentWorkflow, currentStepIndex)
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
  if (settings.apiFormat === 'anthropic') {
    loopMessages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCall.id, content }],
    })
  } else {
    loopMessages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content })
  }
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
        <button class="wf-toggle-btn">▸ 查看步骤</button>
        <button class="btn-primary btn-run-wf" data-id="${wf.id}">▶ 开始执行</button>
      </div>
      <div class="wf-steps-list">${stepsHtml}</div>
    `
    list.appendChild(card)

    const toggleBtn = card.querySelector<HTMLButtonElement>('.wf-toggle-btn')!
    const stepsList = card.querySelector<HTMLElement>('.wf-steps-list')!
    toggleBtn.addEventListener('click', () => {
      const open = stepsList.style.display === 'flex'
      stepsList.style.display = open ? 'none' : 'flex'
      toggleBtn.textContent = open ? '▸ 查看步骤' : '▾ 收起步骤'
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
    { role: 'system', content: buildStepSystemPrompt(firstStep, wf, 0) },
    { role: 'user', content: `请开始执行第一步：${firstStep.name}` },
  ]

  await runAgentLoop()
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
// 标签切换
// ============================================================
function switchTab(tab: string) {
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
    panel.style.display = panel.dataset.tab === tab ? 'flex' : 'none'
  })
  if (tab === 'log') renderActivityLog(currentLogFilter)
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

  // 活动记录过滤
  document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      currentLogFilter = (btn.dataset.filter ?? 'all') as ActivityType | 'all'
      renderActivityLog(currentLogFilter)
    })
  })

  el('clearLogBtn')?.addEventListener('click', async () => {
    await saveSettings({ activityLog: [] })
    renderActivityLog(currentLogFilter)
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
      const nextStep = currentWorkflow.steps[currentStepIndex]
      loopMessages = [
        { role: 'system', content: buildStepSystemPrompt(nextStep, currentWorkflow, currentStepIndex) },
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

  // 设置更新监听
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATED') {
      loadSettings().then((s) => {
        settings = s
        renderWorkflowList()
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
