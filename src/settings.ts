// ============================================================
// settings.ts — 设置页面逻辑
// ============================================================
import { loadSettings, saveSettings } from './store'
import type { SavedPrompt, ApiFormat } from './types'

async function init() {
  const settings = await loadSettings()

  // Fields
  ;(document.getElementById('baseUrl') as HTMLInputElement).value = settings.baseUrl
  ;(document.getElementById('apiKey') as HTMLInputElement).value = settings.apiKey
  ;(document.getElementById('apiFormat') as HTMLSelectElement).value = settings.apiFormat
  ;(document.getElementById('model') as HTMLInputElement).value = settings.model
  ;(document.getElementById('systemPrompt') as HTMLTextAreaElement).value = settings.systemPrompt

  // Range sliders
  setupRange('delayMin', 'delayMinVal', settings.actionDelay[0], (v) => `${v}ms`)
  setupRange('delayMax', 'delayMaxVal', settings.actionDelay[1], (v) => `${v}ms`)
  setupRange('maxActions', 'maxActionsVal', settings.maxActionsPerMinute, (v) => `${v} 次/分`)

  // Prompts
  renderPrompts(settings.prompts)
  document.getElementById('addPromptBtn')!.addEventListener('click', () => {
    addPromptRow({ id: genId(), title: '', content: '', createdAt: Date.now() })
  })

  // Save
  document.getElementById('saveBtn')!.addEventListener('click', async () => {
    const prompts = collectPrompts()

    await saveSettings({
      baseUrl: (document.getElementById('baseUrl') as HTMLInputElement).value.trim(),
      apiKey: (document.getElementById('apiKey') as HTMLInputElement).value.trim(),
      apiFormat: (document.getElementById('apiFormat') as HTMLSelectElement).value as ApiFormat,
      model: (document.getElementById('model') as HTMLInputElement).value.trim(),
      systemPrompt: (document.getElementById('systemPrompt') as HTMLTextAreaElement).value.trim(),
      actionDelay: [
        parseInt((document.getElementById('delayMin') as HTMLInputElement).value),
        parseInt((document.getElementById('delayMax') as HTMLInputElement).value),
      ],
      maxActionsPerMinute: parseInt((document.getElementById('maxActions') as HTMLInputElement).value),
      prompts,
    })

    // Notify sidepanel (ignore error if sidepanel is not open)
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }, () => void chrome.runtime.lastError)

    const toast = document.getElementById('toast')!
    toast.classList.add('show')
    setTimeout(() => toast.classList.remove('show'), 2000)
  })
}

function setupRange(id: string, valId: string, initial: number, fmt: (v: number) => string) {
  const input = document.getElementById(id) as HTMLInputElement
  const val = document.getElementById(valId)!
  input.value = String(initial)
  val.textContent = fmt(initial)
  input.addEventListener('input', () => { val.textContent = fmt(parseInt(input.value)) })
}

function renderPrompts(prompts: SavedPrompt[]) {
  const list = document.getElementById('promptsList')!
  list.innerHTML = ''
  prompts.forEach((p) => addPromptRow(p))
}

function addPromptRow(p: SavedPrompt) {
  const list = document.getElementById('promptsList')!
  const row = document.createElement('div')
  row.className = 'prompt-row'
  row.dataset.id = p.id
  row.innerHTML = `
    <input class="prompt-title" placeholder="标题" value="${escHtml(p.title)}" style="max-width:110px"/>
    <input class="prompt-content" placeholder="Prompt 内容" value="${escHtml(p.content)}"/>
    <button class="remove-btn">删除</button>`
  row.querySelector('.remove-btn')!.addEventListener('click', () => row.remove())
  list.appendChild(row)
}

function collectPrompts(): SavedPrompt[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.prompt-row')).map((row) => ({
    id: row.dataset.id ?? genId(),
    title: (row.querySelector('.prompt-title') as HTMLInputElement).value.trim(),
    content: (row.querySelector('.prompt-content') as HTMLInputElement).value.trim(),
    createdAt: Date.now(),
  })).filter((p) => p.title || p.content)
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function genId(): string { return Math.random().toString(36).slice(2) }

// Settings page is opened as a chrome options page
chrome.runtime.openOptionsPage = chrome.runtime.openOptionsPage ?? (() => {})

init()
