// ============================================================
// settings.ts — 设置页面逻辑（带侧边栏导航）
// ============================================================
import { loadSettings, saveSettings } from './store'
import { TOOL_DEFINITIONS } from './tools'
import type { SavedPrompt, ApiFormat, Workflow, WorkflowStep, InterventionType, Skill, SkillStatus } from '../types'

let allSkills: Skill[] = []

async function init() {
  const settings = await loadSettings()
  allSkills = settings.skills ?? []

  // ----- 侧边栏导航 -----
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section!
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      document.querySelectorAll<HTMLElement>('.section-panel').forEach((p) => {
        p.classList.toggle('active', p.dataset.section === section)
      })
    })
  })

  // ----- API -----
  ;(document.getElementById('baseUrl') as HTMLInputElement).value = settings.baseUrl
  ;(document.getElementById('apiKey') as HTMLInputElement).value = settings.apiKey
  ;(document.getElementById('apiFormat') as HTMLSelectElement).value = settings.apiFormat
  ;(document.getElementById('model') as HTMLInputElement).value = settings.model
  ;(document.getElementById('systemPrompt') as HTMLTextAreaElement).value = settings.systemPrompt
  setupRange('delayMin', 'delayMinVal', settings.actionDelay[0], (v) => `${v}ms`)
  setupRange('delayMax', 'delayMaxVal', settings.actionDelay[1], (v) => `${v}ms`)
  setupRange('maxActions', 'maxActionsVal', settings.maxActionsPerMinute, (v) => `${v} 次/分`)

  // ----- 快捷 Prompts -----
  renderPrompts(settings.prompts)
  document.getElementById('addPromptBtn')!.addEventListener('click', () => {
    addPromptRow({ id: genId(), title: '', content: '', createdAt: Date.now() })
  })

  // ----- Skills -----
  renderSkills(settings.skills ?? [])
  document.getElementById('addSkillBtn')!.addEventListener('click', () => {
    const sk: Skill = {
      id: genId(), name: '新 Skill', description: '', trigger: '',
      instructions: '', status: 'active', createdAt: Date.now(),
    }
    addSkillCard(sk, true)
    allSkills = collectSkills()
  })

  // ----- 工作流 -----
  renderWorkflows(settings.workflows ?? [])
  document.getElementById('addWorkflowBtn')!.addEventListener('click', () => {
    const wf: Workflow = {
      id: genId(), name: '新工作流', description: '', context: '', startUrl: '',
      steps: [], createdAt: Date.now(),
    }
    addWorkflowCard(wf, true)
  })

  // ----- 工具链 -----
  renderTools()

  // ----- 保存 -----
  document.getElementById('saveBtn')!.addEventListener('click', async () => {
    allSkills = collectSkills()

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
      prompts: collectPrompts(),
      skills: allSkills,
      workflows: collectWorkflows(),
    })

    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }, () => void chrome.runtime.lastError)

    const toast = document.getElementById('toast')!
    toast.classList.add('show')
    setTimeout(() => toast.classList.remove('show'), 2000)
  })
}

// ============================================================
// Range sliders
// ============================================================
function setupRange(id: string, valId: string, initial: number, fmt: (v: number) => string) {
  const input = document.getElementById(id) as HTMLInputElement
  const val = document.getElementById(valId)!
  input.value = String(initial)
  val.textContent = fmt(initial)
  input.addEventListener('input', () => { val.textContent = fmt(parseInt(input.value)) })
}

// ============================================================
// Prompts
// ============================================================
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
    <input class="prompt-title" placeholder="标题" value="${escAttr(p.title)}" style="max-width:110px"/>
    <input class="prompt-content" placeholder="Prompt 内容" value="${escAttr(p.content)}"/>
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

// ============================================================
// Skills
// ============================================================
function renderSkills(skills: Skill[]) {
  const list = document.getElementById('skillsList')!
  list.innerHTML = ''
  skills.forEach((sk) => addSkillCard(sk, false))
}

function addSkillCard(sk: Skill, openByDefault: boolean) {
  const list = document.getElementById('skillsList')!
  const card = document.createElement('div')
  card.className = 'skill-card'
  card.dataset.id = sk.id

  card.innerHTML = `
    <div class="skill-header">
      <span class="skill-status-dot skill-status-dot--${sk.status}"></span>
      <span class="skill-name">${escHtml(sk.name)}</span>
      <span class="skill-desc skill-desc-preview">${escHtml(sk.description || '无描述')}</span>
      <span class="skill-toggle-icon">▸</span>
    </div>
    <div class="skill-body${openByDefault ? ' open' : ''}">
      <div class="skill-field">
        <label>名称</label>
        <input class="sk-name" value="${escAttr(sk.name)}" placeholder="Skill 名称"/>
      </div>
      <div class="skill-field">
        <label>描述</label>
        <input class="sk-desc" value="${escAttr(sk.description)}" placeholder="一句话描述用途"/>
      </div>
      <div class="skill-field">
        <label>触发关键词</label>
        <input class="sk-trigger" value="${escAttr(sk.trigger)}" placeholder="操作失败|找不到元素（竖线分隔）"/>
        <p class="hint" style="margin-top:3px">工作流步骤引用此 Skill 时，关键词用于自动匹配建议。</p>
      </div>
      <div class="skill-field">
        <label>指令（注入 system prompt）</label>
        <textarea class="sk-instructions" rows="5">${escHtml(sk.instructions)}</textarea>
      </div>
      <div class="skill-footer">
        <div class="status-toggle">
          <button class="status-opt active-opt ${sk.status === 'active' ? 'selected' : ''}" data-val="active">启用</button>
          <button class="status-opt disabled-opt ${sk.status === 'disabled' ? 'selected' : ''}" data-val="disabled">停用</button>
        </div>
        <button class="remove-btn sk-remove">删除 Skill</button>
      </div>
    </div>
  `

  // 展开/收起
  const header = card.querySelector<HTMLElement>('.skill-header')!
  const body = card.querySelector<HTMLElement>('.skill-body')!
  const toggleIcon = card.querySelector<HTMLElement>('.skill-toggle-icon')!
  const descPreview = card.querySelector<HTMLElement>('.skill-desc-preview')!
  header.addEventListener('click', () => {
    const open = body.classList.toggle('open')
    toggleIcon.textContent = open ? '▾' : '▸'
  })

  // 名称实时同步到 header
  const nameInput = card.querySelector<HTMLInputElement>('.sk-name')!
  nameInput.addEventListener('input', () => {
    card.querySelector<HTMLElement>('.skill-name')!.textContent = nameInput.value || '未命名'
  })
  const descInput = card.querySelector<HTMLInputElement>('.sk-desc')!
  descInput.addEventListener('input', () => {
    descPreview.textContent = descInput.value || '无描述'
  })

  // textarea 自动高度
  autoResizeTextarea(card.querySelector<HTMLTextAreaElement>('.sk-instructions')!)

  // 状态切换
  card.querySelectorAll<HTMLButtonElement>('.status-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      card.querySelectorAll('.status-opt').forEach((b) => b.classList.remove('selected'))
      btn.classList.add('selected')
      const dot = card.querySelector<HTMLElement>('.skill-status-dot')!
      dot.className = `skill-status-dot skill-status-dot--${btn.dataset.val}`
    })
  })

  // 删除
  card.querySelector('.sk-remove')!.addEventListener('click', () => {
    card.remove()
    allSkills = collectSkills()
  })

  if (openByDefault) toggleIcon.textContent = '▾'
  list.appendChild(card)
}

function collectSkills(): Skill[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.skill-card')).map((card) => {
    const selectedStatus = card.querySelector<HTMLElement>('.status-opt.selected')
    return {
      id: card.dataset.id ?? genId(),
      name: (card.querySelector('.sk-name') as HTMLInputElement).value.trim() || '未命名',
      description: (card.querySelector('.sk-desc') as HTMLInputElement).value.trim(),
      trigger: (card.querySelector('.sk-trigger') as HTMLInputElement).value.trim(),
      instructions: (card.querySelector('.sk-instructions') as HTMLTextAreaElement).value.trim(),
      status: (selectedStatus?.dataset.val ?? 'active') as SkillStatus,
      createdAt: Date.now(),
    }
  })
}

// ============================================================
// Workflows
// ============================================================
const INTERVENTION_LABELS: Record<string, string> = {
  none: '自动', optional: '可选介入', required: '必须介入',
}

function renderWorkflows(workflows: Workflow[]) {
  const list = document.getElementById('workflowsList')!
  list.innerHTML = ''
  workflows.forEach((wf) => addWorkflowCard(wf, false))
}

function buildSkillOptions(selectedIds: string[] = []): string {
  if (allSkills.length === 0) return '<option value="">（暂无 Skills）</option>'
  return '<option value="">引用 Skill…</option>' +
    allSkills
      .filter((s) => s.status === 'active')
      .map((s) => `<option value="${escAttr(s.id)}" ${selectedIds.includes(s.id) ? 'selected' : ''}>${escHtml(s.name)}</option>`)
      .join('')
}

function addWorkflowCard(wf: Workflow, openByDefault: boolean) {
  const list = document.getElementById('workflowsList')!
  const card = document.createElement('div')
  card.className = 'wf-card'
  card.dataset.id = wf.id

  card.innerHTML = `
    <div class="wf-card-header">
      <span class="wf-expand-icon">▸</span>
      <input class="wf-card-name" value="${escAttr(wf.name)}" placeholder="工作流名称"/>
      <span class="wf-step-count">${wf.steps.length} 步</span>
    </div>
    <div class="wf-card-body${openByDefault ? ' open' : ''}">
      <div class="wf-field">
        <label>描述</label>
        <input class="wf-desc" value="${escAttr(wf.description ?? '')}" placeholder="一句话描述工作流用途"/>
      </div>
      <div class="wf-field">
        <label>起始 URL（可选）</label>
        <input class="wf-url" value="${escAttr(wf.startUrl ?? '')}" placeholder="https://..."/>
      </div>
      <div class="wf-field">
        <label>全局背景与要求（注入每一步 system prompt）</label>
        <textarea class="wf-context wf-context-area" placeholder="在此填写招聘标准、候选人要求、数据格式、注意事项等。所有步骤都会读到这段内容。">${escHtml(wf.context ?? '')}</textarea>
      </div>
      <div>
        <div class="steps-section-label">步骤列表</div>
        <div class="steps-list-editor wf-steps-container"></div>
        <button class="add-step-btn">＋ 添加步骤</button>
      </div>
      <div class="wf-footer-actions">
        <button class="wf-action-btn wf-copy-btn">⎘ 复制工作流</button>
        <button class="wf-action-btn wf-action-btn--danger wf-remove-btn">删除</button>
      </div>
    </div>
  `

  // 展开/收起
  const header = card.querySelector<HTMLElement>('.wf-card-header')!
  const body = card.querySelector<HTMLElement>('.wf-card-body')!
  const icon = card.querySelector<HTMLElement>('.wf-expand-icon')!
  header.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const open = body.classList.toggle('open')
    icon.textContent = open ? '▾' : '▸'
  })
  if (openByDefault) icon.textContent = '▾'

  // 名称同步 step count
  const nameInput = card.querySelector<HTMLInputElement>('.wf-card-name')!
  nameInput.addEventListener('input', () => void 0)

  // Context textarea 自动高度
  autoResizeTextarea(card.querySelector<HTMLTextAreaElement>('.wf-context')!)

  // 渲染步骤
  wf.steps.forEach((step) => addStepCard(card, step, false))

  // 添加步骤
  card.querySelector('.add-step-btn')!.addEventListener('click', () => {
    const step: WorkflowStep = {
      id: genId(), name: '新步骤',
      instructions: '', intervention: 'none', completionHint: '',
    }
    addStepCard(card, step, true)
    updateStepCount(card)
  })

  // 复制工作流
  card.querySelector('.wf-copy-btn')!.addEventListener('click', () => {
    const copy = cloneWorkflowFromCard(card)
    copy.id = genId()
    copy.name = copy.name + '（副本）'
    copy.createdAt = Date.now()
    addWorkflowCard(copy, true)
    card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  // 删除工作流
  card.querySelector('.wf-remove-btn')!.addEventListener('click', () => {
    if (confirm(`确认删除工作流「${nameInput.value || '未命名'}」？`)) card.remove()
  })

  list.appendChild(card)
}

function addStepCard(wfCard: HTMLElement, step: WorkflowStep, openByDefault: boolean) {
  const container = wfCard.querySelector<HTMLElement>('.wf-steps-container')!
  const idx = container.children.length + 1

  const card = document.createElement('div')
  card.className = 'step-card'
  card.dataset.id = step.id

  const interventionBadgeClass = `intervention--${step.intervention}`
  card.innerHTML = `
    <div class="step-card-header">
      <span class="step-num-badge">${idx}</span>
      <input class="step-name-input" value="${escAttr(step.name)}" placeholder="步骤名称"/>
      <span class="step-intervention-badge ${interventionBadgeClass}">${INTERVENTION_LABELS[step.intervention] ?? step.intervention}</span>
    </div>
    <div class="step-card-body${openByDefault ? ' open' : ''}">
      <div class="step-field">
        <label>介入方式</label>
        <select class="step-intervention-sel">
          <option value="none" ${step.intervention === 'none' ? 'selected' : ''}>自动 — 无需用户介入</option>
          <option value="optional" ${step.intervention === 'optional' ? 'selected' : ''}>可选介入 — 完成后提示用户可继续</option>
          <option value="required" ${step.intervention === 'required' ? 'selected' : ''}>必须介入 — 完成后等待用户确认</option>
        </select>
      </div>
      <div class="step-field">
        <label>引用 Skill（可选）</label>
        <select class="step-skill-sel">
          ${buildSkillOptions(step.skillIds)}
        </select>
        <p class="hint" style="margin-top:3px">选中的 Skill 的指令会自动注入本步骤 system prompt。</p>
      </div>
      <div class="step-field">
        <label>给 AI 的详细指令</label>
        <textarea class="step-instructions" rows="6">${escHtml(step.instructions)}</textarea>
      </div>
      <div class="step-field">
        <label>完成判定条件</label>
        <input class="step-hint" value="${escAttr(step.completionHint ?? '')}" placeholder="AI 判断此步完成的依据，如「页面出现确认按钮」"/>
      </div>
      <div class="step-actions">
        <span style="font-size:11px;color:var(--text3)">第 ${idx} 步</span>
        <button class="remove-btn step-remove-btn">删除步骤</button>
      </div>
    </div>
  `

  // 展开/收起
  const header = card.querySelector<HTMLElement>('.step-card-header')!
  const body = card.querySelector<HTMLElement>('.step-card-body')!
  header.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    body.classList.toggle('open')
  })

  // 名称同步 badge
  const nameInput = card.querySelector<HTMLInputElement>('.step-name-input')!

  // 介入方式同步 badge
  const intSel = card.querySelector<HTMLSelectElement>('.step-intervention-sel')!
  const badge = card.querySelector<HTMLElement>('.step-intervention-badge')!
  intSel.addEventListener('change', () => {
    badge.className = `step-intervention-badge intervention--${intSel.value}`
    badge.textContent = INTERVENTION_LABELS[intSel.value] ?? intSel.value
  })
  void nameInput

  // textarea 自动高度
  autoResizeTextarea(card.querySelector<HTMLTextAreaElement>('.step-instructions')!)

  // 删除步骤
  card.querySelector('.step-remove-btn')!.addEventListener('click', () => {
    card.remove()
    renumberSteps(wfCard)
    updateStepCount(wfCard)
  })

  container.appendChild(card)
}

function renumberSteps(wfCard: HTMLElement) {
  wfCard.querySelectorAll<HTMLElement>('.step-num-badge').forEach((badge, i) => {
    badge.textContent = String(i + 1)
  })
  wfCard.querySelectorAll<HTMLElement>('.step-actions span').forEach((span, i) => {
    span.textContent = `第 ${i + 1} 步`
  })
}

function updateStepCount(wfCard: HTMLElement) {
  const count = wfCard.querySelectorAll('.step-card').length
  const badge = wfCard.querySelector<HTMLElement>('.wf-step-count')
  if (badge) badge.textContent = `${count} 步`
}

function cloneWorkflowFromCard(card: HTMLElement): Workflow {
  const steps: WorkflowStep[] = Array.from(card.querySelectorAll<HTMLElement>('.step-card')).map((sc) => {
    const skillSel = sc.querySelector<HTMLSelectElement>('.step-skill-sel')
    const skillId = skillSel?.value
    return {
      id: genId(),
      name: (sc.querySelector('.step-name-input') as HTMLInputElement).value.trim(),
      instructions: (sc.querySelector('.step-instructions') as HTMLTextAreaElement).value.trim(),
      intervention: (sc.querySelector('.step-intervention-sel') as HTMLSelectElement).value as InterventionType,
      completionHint: (sc.querySelector('.step-hint') as HTMLInputElement).value.trim(),
      skillIds: skillId ? [skillId] : [],
    }
  })
  return {
    id: card.dataset.id ?? genId(),
    name: (card.querySelector('.wf-card-name') as HTMLInputElement).value.trim() || '未命名工作流',
    description: (card.querySelector('.wf-desc') as HTMLInputElement).value.trim(),
    context: (card.querySelector('.wf-context') as HTMLTextAreaElement).value.trim(),
    startUrl: (card.querySelector('.wf-url') as HTMLInputElement).value.trim(),
    steps,
    createdAt: Date.now(),
  }
}

function collectWorkflows(): Workflow[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.wf-card')).map((card) => cloneWorkflowFromCard(card))
}

// ============================================================
// Tools panel (read-only)
// ============================================================
function renderTools() {
  const list = document.getElementById('toolsList')!
  list.innerHTML = TOOL_DEFINITIONS.map((tool) => {
    const params = Object.keys(tool.parameters.properties ?? {}).join(', ')
    const required = tool.parameters.required ?? []
    return `<div class="tool-card">
      <div class="tool-header">
        <span class="tool-name">${tool.name}</span>
        <span class="tool-badge">内置</span>
      </div>
      <div class="tool-desc">${escHtml(tool.description)}</div>
      ${params ? `<div class="tool-params">参数：${params}${required.length ? `（必填：${required.join(', ')}）` : ''}</div>` : ''}
    </div>`
  }).join('')
}

// ============================================================
// Helpers
// ============================================================
function autoResizeTextarea(ta: HTMLTextAreaElement) {
  if (!ta) return
  const resize = () => {
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight + 'px'
  }
  ta.addEventListener('input', resize)
  // 初始化
  setTimeout(resize, 0)
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function genId(): string { return Math.random().toString(36).slice(2) }

init()
