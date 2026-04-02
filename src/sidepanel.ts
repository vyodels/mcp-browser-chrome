// ============================================================
// sidepanel.ts — 侧边栏主逻辑
// ============================================================
import type { ChatMessage, Skill, AgentAction, ActionResult, PageSnapshot } from './types'
import { loadSettings, saveSettings } from './store'
import { chat, parseActions } from './openai'
import { throttleAction } from './rateLimit'

// ---- State ----
let chatHistory: ChatMessage[] = []
let pendingScreenshot: string | null = null
let isStreaming = false
let lastSnapshot: PageSnapshot | null = null
let lastError: string | null = null

// ---- Rate limit config ----
function applyRateLimitConfig(settings: import('./types').Settings) {
  chrome.runtime.sendMessage({
    type: 'CONFIGURE_RATE_LIMIT',
    payload: { max: settings.maxActionsPerMinute, delay: settings.actionDelay },
  })
}

// ---- Init ----
async function init() {
  const settings = await loadSettings()
  applyRateLimitConfig(settings)
  ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model

  renderQuickPrompts()
  renderSkills()

  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = (tab as HTMLElement).dataset.tab!
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'))
      tab.classList.add('active')
      document.getElementById(`panel-${name}`)!.classList.add('active')
    })
  })

  document.getElementById('sendBtn')!.addEventListener('click', sendMessage)
  document.getElementById('pageBtn')!.addEventListener('click', readPage)
  document.getElementById('screenshotBtn')!.addEventListener('click', takeScreenshot)
  document.getElementById('clearBtn')!.addEventListener('click', clearChat)
  document.getElementById('settingsBtn')!.addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' })
  )

  const input = document.getElementById('userInput') as HTMLTextAreaElement
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  })

  document.getElementById('addSkillBtn')!.addEventListener('click', () =>
    (document.getElementById('skillModal') as HTMLElement).classList.add('open')
  )
  document.getElementById('skillModalCancel')!.addEventListener('click', closeSkillModal)
  document.getElementById('skillModalSave')!.addEventListener('click', saveSkill)

  document.getElementById('snapshotBtn')!.addEventListener('click', debugSnapshot)
  document.getElementById('fullDomBtn')!.addEventListener('click', debugFullDom)
  document.getElementById('analyzeBtn')!.addEventListener('click', aiAnalyzeDebug)
  document.getElementById('fixBtn')!.addEventListener('click', aiFixDebug)
}

// ---- Chat ----
async function sendMessage() {
  if (isStreaming) return
  const input = document.getElementById('userInput') as HTMLTextAreaElement
  const text = input.value.trim()
  if (!text) return

  input.value = ''
  input.style.height = 'auto'

  const userMsg = appendMessage('user', text, pendingScreenshot ?? undefined)
  chatHistory.push(userMsg)
  pendingScreenshot = null
  ;(input as HTMLTextAreaElement).placeholder = '告诉我你想做什么...'

  setStatus('busy', '正在思考...')
  setLoading(true)

  try {
    const settings = await loadSettings()
    const skill = matchSkill(text, settings.skills)

    let contextText = text
    if (skill) {
      contextText = `[使用 Skill: ${skill.name}]\n${skill.instructions}\n\n用户请求：${text}`
      setStatus('busy', `执行 Skill: ${skill.name}`)
    }

    if (lastSnapshot) {
      contextText += `\n\n【当前页面快照】\nURL: ${lastSnapshot.url}\n标题: ${lastSnapshot.title}\n交互元素:\n${
        lastSnapshot.interactiveElements
          .slice(0, 30)
          .map((el) => `  ${el.ref} [${el.tag}] "${el.text ?? el.placeholder ?? el.ariaLabel ?? ''}"`)
          .join('\n')
      }`
    }

    const assistantBubble = appendStreamingMessage()
    isStreaming = true
    let fullReply = ''

    await chat(chatHistory, contextText, settings, userMsg.imageDataUrl, (delta) => {
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

async function executeActions(actions: AgentAction[]) {
  for (const action of actions) {
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

    if (!result.success) {
      lastError = result.message
      appendMessage('assistant', `⚠️ 操作失败：${result.message}\n\n切换到「🔧 调试」标签让 AI 分析并修复。`)
      break
    }
  }
  lastError = null  // all actions succeeded
}

// ---- Page actions ----
function readPage() {
  setStatus('busy', '读取页面...')
  chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' }, (resp) => {
    if (resp?.success) {
      lastSnapshot = resp.snapshot as PageSnapshot
      const snap = lastSnapshot!
      appendMessage('assistant', `📄 已读取页面\n\n**${snap.title}**\n${snap.url}\n\n找到 ${snap.interactiveElements.length} 个交互元素`)
      setStatus('ready', '页面已读取')
    } else {
      setStatus('error', '读取失败')
    }
  })
}

function takeScreenshot() {
  setStatus('busy', '截图中...')
  chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, (resp) => {
    if (resp?.success) {
      pendingScreenshot = resp.dataUrl as string
      ;(document.getElementById('userInput') as HTMLTextAreaElement).placeholder = '📸 截图已附加，输入你的问题...'
      ;(document.getElementById('userInput') as HTMLTextAreaElement).focus()
      setStatus('ready', '截图已附加')
    } else {
      setStatus('error', '截图失败')
    }
  })
}

// ---- Skills ----
function matchSkill(text: string, skills: Skill[]): Skill | null {
  for (const skill of skills) {
    if (skill.status !== 'active') continue
    if (skill.trigger.split('|').some((k) => text.includes(k.trim()))) return skill
  }
  return null
}

async function renderSkills() {
  const settings = await loadSettings()
  const list = document.getElementById('skillsList')!
  list.innerHTML = ''

  if (settings.skills.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有 Skills，点击下方按钮创建</div>'
    return
  }

  settings.skills.forEach((skill) => {
    const card = document.createElement('div')
    card.className = `skill-card ${skill.status}`
    card.innerHTML = `
      <div class="skill-header">
        <span class="skill-name">${skill.name}</span>
        <span class="skill-badge ${skill.status}">${skill.status === 'active' ? '启用' : skill.status === 'disabled' ? '停用' : '错误'}</span>
      </div>
      <div class="skill-desc">${skill.description}</div>
      <div class="skill-trigger">触发词: ${skill.trigger}</div>
      <div class="skill-actions">
        <button class="skill-btn" data-id="${skill.id}" data-action="toggle">${skill.status === 'active' ? '停用' : '启用'}</button>
        <button class="skill-btn danger" data-id="${skill.id}" data-action="delete">删除</button>
      </div>`
    list.appendChild(card)
  })

  list.querySelectorAll('.skill-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const el = e.target as HTMLElement
      const id = el.dataset.id!
      const action = el.dataset.action!
      const s = await loadSettings()
      if (action === 'delete') {
        await saveSettings({ skills: s.skills.filter((sk) => sk.id !== id) })
      } else if (action === 'toggle') {
        await saveSettings({
          skills: s.skills.map((sk) =>
            sk.id === id ? { ...sk, status: (sk.status === 'active' ? 'disabled' : 'active') as Skill['status'] } : sk
          ),
        })
      }
      renderSkills()
    })
  })
}

async function saveSkill() {
  const name = (document.getElementById('skillName') as HTMLInputElement).value.trim()
  const desc = (document.getElementById('skillDesc') as HTMLInputElement).value.trim()
  const trigger = (document.getElementById('skillTrigger') as HTMLInputElement).value.trim()
  const instructions = (document.getElementById('skillInstructions') as HTMLTextAreaElement).value.trim()
  if (!name || !instructions) { alert('名称和 AI 指令不能为空'); return }
  if (!trigger) { alert('触发词不能为空，否则 Skill 永远不会被激活'); return }

  const settings = await loadSettings()
  await saveSettings({
    skills: [...settings.skills, {
      id: genId(), name, description: desc, trigger, instructions,
      status: 'active' as const, createdAt: Date.now(),
    }],
  })
  closeSkillModal()
  renderSkills()
}

function closeSkillModal() {
  ;(document.getElementById('skillModal') as HTMLElement).classList.remove('open')
  ;['skillName', 'skillDesc', 'skillTrigger'].forEach((id) => ((document.getElementById(id) as HTMLInputElement).value = ''))
  ;(document.getElementById('skillInstructions') as HTMLTextAreaElement).value = ''
}

// ---- Debug ----
function debugSnapshot() {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' }, (resp) => {
    if (resp?.success) {
      lastSnapshot = resp.snapshot as PageSnapshot
      const snap = lastSnapshot!
      ;(document.getElementById('debugInfo') as HTMLElement).textContent =
        `URL: ${snap.url}\n标题: ${snap.title}\n\n交互元素 (${snap.interactiveElements.length}):\n` +
        snap.interactiveElements.map((el) => `  ${el.ref} <${el.tag}> "${el.text ?? el.placeholder ?? ''}"`).join('\n')
    }
  })
}

function debugFullDom() {
  chrome.runtime.sendMessage(
    { type: 'EXECUTE_ACTION_IN_TAB', payload: { type: 'DEBUG_DOM' } },
    (resp) => {
      if (resp?.success) {
        lastSnapshot = resp.snapshot as PageSnapshot
        ;(document.getElementById('debugInfo') as HTMLElement).textContent =
          (lastSnapshot!.html ?? '').slice(0, 5000) + '\n...(截断)'
      }
    }
  )
}

async function aiAnalyzeDebug() {
  if (!lastSnapshot) { debugSnapshot(); await new Promise((r) => setTimeout(r, 600)) }
  setStatus('busy', 'AI 分析中...')
  try {
    const settings = await loadSettings()
    const result = await chat(
      [],
      `请分析以下页面快照，指出结构特点、可能导致操作失败的原因及建议：\n\n${JSON.stringify(lastSnapshot, null, 2).slice(0, 4000)}`,
      settings
    )
    ;(document.getElementById('debugResult') as HTMLElement).textContent = result
    setStatus('ready', '分析完成')
  } catch (e) { setStatus('error', String(e)) }
}

async function aiFixDebug() {
  if (!lastSnapshot) { debugSnapshot(); await new Promise((r) => setTimeout(r, 600)) }
  setStatus('busy', 'AI 修复中...')
  try {
    const settings = await loadSettings()
    const result = await chat(
      [],
      `以下是页面快照${lastError ? `和错误信息「${lastError}」` : ''}。\n请分析失败原因，并用 \`\`\`json\n[动作列表]\n\`\`\` 格式返回修正操作：\n\n${JSON.stringify(lastSnapshot, null, 2).slice(0, 4000)}`,
      settings
    )
    ;(document.getElementById('debugResult') as HTMLElement).textContent = result
    setStatus('ready', '修复建议已生成')
    const actions = parseActions(result)
    if (actions.length > 0) {
      appendMessage('assistant', `🔧 调试器生成了 ${actions.length} 个修复动作，请查看调试面板结果。`)
      document.querySelector<HTMLElement>('.tab[data-tab="chat"]')!.click()
    }
  } catch (e) { setStatus('error', String(e)) }
}

// ---- Quick Prompts ----
async function renderQuickPrompts() {
  const settings = await loadSettings()
  const container = document.getElementById('quickPrompts')!
  container.innerHTML = ''
  settings.prompts.forEach((p) => {
    const chip = document.createElement('button')
    chip.className = 'prompt-chip'
    chip.textContent = p.title
    chip.addEventListener('click', () => {
      ;(document.getElementById('userInput') as HTMLTextAreaElement).value = p.content
    })
    container.appendChild(chip)
  })
}

// ---- UI helpers ----
function appendMessage(role: 'user' | 'assistant', content: string, imageDataUrl?: string): ChatMessage {
  const msg: ChatMessage = { id: genId(), role, content, timestamp: Date.now(), imageDataUrl }
  const container = document.getElementById('chatMessages')!
  container.querySelector('.empty-state')?.remove()
  const div = document.createElement('div')
  div.className = `message ${role}`
  div.innerHTML = `<div class="message-bubble">${formatContent(content)}${imageDataUrl ? `<img src="${imageDataUrl}" alt="截图"/>` : ''}</div><div class="message-time">${formatTime(msg.timestamp)}</div>`
  container.appendChild(div)
  scrollToBottom()
  return msg
}

function appendStreamingMessage(): HTMLElement {
  const container = document.getElementById('chatMessages')!
  container.querySelector('.empty-state')?.remove()
  const div = document.createElement('div')
  div.className = 'message assistant'
  div.innerHTML = `<div class="message-bubble streaming"></div><div class="message-time">${formatTime(Date.now())}</div>`
  container.appendChild(div)
  scrollToBottom()
  return div.querySelector('.message-bubble')!
}

function updateStreamingMessage(el: HTMLElement, content: string) {
  el.textContent = content; scrollToBottom()
}

function finalizeStreamingMessage(el: HTMLElement, content: string) {
  el.classList.remove('streaming'); el.innerHTML = formatContent(content)
}

function clearChat() {
  chatHistory = []; lastSnapshot = null; lastError = null
  document.getElementById('chatMessages')!.innerHTML = '<div class="empty-state">对话已清空 ✨<br/>可以重新开始了。</div>'
}

function setStatus(state: 'ready' | 'busy' | 'error', text: string) {
  document.getElementById('statusDot')!.className = `status-dot ${state === 'ready' ? '' : state}`
  document.getElementById('statusText')!.textContent = text
}

function setLoading(loading: boolean) {
  ;(document.getElementById('sendBtn') as HTMLButtonElement).disabled = loading
}

function scrollToBottom() {
  const c = document.getElementById('chatMessages')!; c.scrollTop = c.scrollHeight
}

function formatContent(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code style="background:#ffffff18;padding:1px 4px;border-radius:3px">$1</code>')
    .replace(/\n/g, '<br/>')
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function genId(): string { return Math.random().toString(36).slice(2) }

// ---- Listen for settings changes from options page ----
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SETTINGS_UPDATED') {
    loadSettings().then((settings) => {
      ;(document.getElementById('modelBadge') as HTMLElement).textContent = settings.model
      applyRateLimitConfig(settings)
      renderQuickPrompts()
      renderSkills()
    })
  }
})

init()
