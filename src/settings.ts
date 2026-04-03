// ============================================================
// settings.ts — 设置页面逻辑
// ============================================================
import { loadSettings, saveSettings } from './store'
import type { SavedPrompt, ApiFormat, Workflow, WorkflowStep, InterventionType } from './types'

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

  // Workflows
  renderWorkflows(settings.workflows)
  document.getElementById('addWorkflowBtn')!.addEventListener('click', () => {
    const newWf: Workflow = {
      id: genId(), name: '新工作流', description: '',
      startUrl: '', steps: [], createdAt: Date.now(),
    }
    addWorkflowRow(newWf)
  })

  // Save
  document.getElementById('saveBtn')!.addEventListener('click', async () => {
    const prompts = collectPrompts()
    const workflows = collectWorkflows()

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
      workflows,
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

// ---- 工作流管理 ----

function renderWorkflows(workflows: Workflow[]) {
  const list = document.getElementById('workflowsList')!
  list.innerHTML = ''
  workflows.forEach((wf) => addWorkflowRow(wf))
}

function addWorkflowRow(wf: Workflow) {
  const list = document.getElementById('workflowsList')!
  const row = document.createElement('div')
  row.className = 'workflow-row'
  row.dataset.id = wf.id
  row.innerHTML = `
    <div class="wf-row-header">
      <input class="wf-title-input" placeholder="工作流名称" value="${escHtml(wf.name)}"/>
      <button class="wf-expand-btn">▸ 步骤(${wf.steps.length})</button>
      <button class="remove-btn wf-remove-btn">删除</button>
    </div>
    <div class="wf-meta-fields">
      <input class="wf-desc-input" placeholder="描述（可选）" value="${escHtml(wf.description ?? '')}"/>
      <input class="wf-url-input" placeholder="起始 URL（可选）" value="${escHtml(wf.startUrl ?? '')}"/>
    </div>
    <div class="wf-steps-editor">
      <div class="steps-list"></div>
      <button class="add-step-btn">＋ 添加步骤</button>
    </div>
  `
  // 渲染已有步骤
  wf.steps.forEach((step) => addStepRow(row, step))

  // 展开/收起步骤
  const expandBtn = row.querySelector<HTMLButtonElement>('.wf-expand-btn')!
  const stepsEditor = row.querySelector<HTMLElement>('.wf-steps-editor')!
  expandBtn.addEventListener('click', () => {
    const open = stepsEditor.style.display === 'block'
    stepsEditor.style.display = open ? 'none' : 'block'
    const count = row.querySelectorAll('.step-row').length
    expandBtn.textContent = open ? `▸ 步骤(${count})` : `▾ 步骤(${count})`
  })

  // 删除工作流
  row.querySelector('.wf-remove-btn')!.addEventListener('click', () => row.remove())

  // 添加步骤
  row.querySelector('.add-step-btn')!.addEventListener('click', () => {
    const newStep: WorkflowStep = {
      id: genId(), name: '新步骤',
      instructions: '', intervention: 'none', completionHint: '',
    }
    addStepRow(row, newStep)
    // 更新展开按钮计数
    const count = row.querySelectorAll('.step-row').length
    expandBtn.textContent = `▾ 步骤(${count})`
    stepsEditor.style.display = 'block'
  })

  list.appendChild(row)
}

function addStepRow(wfRow: HTMLElement, step: WorkflowStep) {
  const stepsList = wfRow.querySelector<HTMLElement>('.steps-list')!
  const stepNum = stepsList.children.length + 1
  const div = document.createElement('div')
  div.className = 'step-row'
  div.dataset.id = step.id
  div.innerHTML = `
    <div class="step-row-header">
      <span class="step-row-num">${stepNum}</span>
      <input class="step-name" placeholder="步骤名称" value="${escHtml(step.name)}"/>
      <select class="step-intervention">
        <option value="none"${step.intervention === 'none' ? ' selected' : ''}>无需介入</option>
        <option value="optional"${step.intervention === 'optional' ? ' selected' : ''}>可选介入</option>
        <option value="required"${step.intervention === 'required' ? ' selected' : ''}>必须介入</option>
      </select>
      <button class="remove-step-btn" title="删除步骤">✕</button>
    </div>
    <textarea class="step-instructions" placeholder="给 AI 的详细指令...">${escHtml(step.instructions)}</textarea>
    <input class="step-hint" placeholder="完成判定条件（如：页面出现确认按钮）" value="${escHtml(step.completionHint ?? '')}"/>
  `
  div.querySelector('.remove-step-btn')!.addEventListener('click', () => {
    div.remove()
    // 重新编号
    stepsList.querySelectorAll<HTMLElement>('.step-row-num').forEach((num, i) => {
      num.textContent = String(i + 1)
    })
  })
  stepsList.appendChild(div)
}

function collectWorkflows(): Workflow[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.workflow-row')).map((row) => {
    const steps: WorkflowStep[] = Array.from(row.querySelectorAll<HTMLElement>('.step-row')).map((sr) => ({
      id: sr.dataset.id ?? genId(),
      name: (sr.querySelector('.step-name') as HTMLInputElement).value.trim(),
      instructions: (sr.querySelector('.step-instructions') as HTMLTextAreaElement).value.trim(),
      intervention: (sr.querySelector('.step-intervention') as HTMLSelectElement).value as InterventionType,
      completionHint: (sr.querySelector('.step-hint') as HTMLInputElement).value.trim(),
    }))
    return {
      id: row.dataset.id ?? genId(),
      name: (row.querySelector('.wf-title-input') as HTMLInputElement).value.trim() || '未命名工作流',
      description: (row.querySelector('.wf-desc-input') as HTMLInputElement).value.trim(),
      startUrl: (row.querySelector('.wf-url-input') as HTMLInputElement).value.trim(),
      steps,
      createdAt: Date.now(),
    }
  })
}

// Settings page is opened as a chrome options page
chrome.runtime.openOptionsPage = chrome.runtime.openOptionsPage ?? (() => {})

init()
