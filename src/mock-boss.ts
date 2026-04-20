import './mock/zhipin/mock-boss.css'

import { installMockBridge } from './extension/content/mockBridge'
import {
  BOSS_MOCK_DEFAULT_STAGE,
  getBossMockScenario,
} from './mock/zhipin/dataPack'
import type {
  BossLifecycleStage,
  BossMockConversation,
  BossMockConversationCard,
  BossMockConversationMessage,
  BossMockGeekProfile,
  BossMockJob,
  BossMockPageId,
  BossMockQuickAction,
  ChatTag,
} from './mock/zhipin/types'

interface BossMockState {
  scenarioId: BossLifecycleStage
  page: BossMockPageId
  selectedJobId: string
  selectedGeekId: string
  selectedConversationId: string | null
  activeChatTag: ChatTag
  greetDraft: string
  modal: null | {
    title: string
    actionId: BossMockQuickAction['id'] | 'send_greet'
  }
}

const STORAGE_KEY = 'bossMockConfig'
let appRootEl!: HTMLElement
let state!: BossMockState

function renderBootstrapError(error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  const host = document.getElementById('app') ?? document.body
  host.innerHTML = `<pre style="padding:24px;white-space:pre-wrap;color:#b91c1c;">${escapeHtml(message)}</pre>`
}

function bootstrap() {
  const appRoot = document.getElementById('app')
  if (!appRoot) {
    throw new Error('找不到 mock 页面挂载节点 #app')
  }

  appRootEl = appRoot

  const params = new URLSearchParams(location.search)
  const initialScenarioId = (params.get('scenario') as BossLifecycleStage | null) ?? BOSS_MOCK_DEFAULT_STAGE
  const initialScenario = getBossMockScenario(initialScenarioId)
  const initialConversation = initialScenario.conversations[0] ?? null
  const initialPage = (params.get('page') as BossMockPageId | null) ?? initialScenario.defaultPage

  state = {
    scenarioId: initialScenario.id,
    page: initialPage,
    selectedJobId: initialScenario.primaryJobId,
    selectedGeekId: initialScenario.primaryGeekId,
    selectedConversationId: initialConversation?.conversationId ?? null,
    activeChatTag: '全部',
    greetDraft: initialScenario.greetDraft,
    modal: null,
  }

  installMockBridge()
}

function storageLocal() {
  try {
    const chromeApi = Reflect.get(globalThis, 'chrome')
    if (!chromeApi || typeof chromeApi !== 'object') return null

    const storageApi = Reflect.get(chromeApi, 'storage')
    if (!storageApi || typeof storageApi !== 'object') return null

    const localApi = Reflect.get(storageApi, 'local')
    return localApi && typeof localApi === 'object' ? localApi : null
  } catch {
    return null
  }
}

function currentScenario() {
  return getBossMockScenario(state.scenarioId)
}

function allGeeks() {
  return currentScenario().geeks
}

function currentJob(): BossMockJob {
  return currentScenario().jobs.find((job) => job.jobId === state.selectedJobId) ?? currentScenario().jobs[0]
}

function currentGeek(): BossMockGeekProfile {
  return allGeeks().find((geek) => geek.geekId === state.selectedGeekId) ?? allGeeks()[0]
}

function visibleConversations(): BossMockConversation[] {
  const list = currentScenario().conversations
  if (state.activeChatTag === '全部') return list
  return list.filter((conversation) => conversation.tags.includes(state.activeChatTag))
}

function currentConversation(): BossMockConversation | null {
  const list = visibleConversations()
  return list.find((conversation) => conversation.conversationId === state.selectedConversationId) ?? list[0] ?? null
}

function syncSelections() {
  const scenario = currentScenario()
  if (!scenario.jobs.some((job) => job.jobId === state.selectedJobId)) {
    state.selectedJobId = scenario.primaryJobId
  }

  if (!scenario.geeks.some((geek) => geek.geekId === state.selectedGeekId)) {
    state.selectedGeekId = scenario.primaryGeekId
  }

  const conversations = visibleConversations()
  if (conversations.length === 0) {
    state.selectedConversationId = null
    return
  }

  if (!conversations.some((conversation) => conversation.conversationId === state.selectedConversationId)) {
    state.selectedConversationId = conversations[0].conversationId
    state.selectedGeekId = conversations[0].geekId
    state.selectedJobId = conversations[0].jobId
  }
}

function updateUrlAndStorage() {
  const url = new URL(location.href)
  url.searchParams.set('scenario', state.scenarioId)
  url.searchParams.set('page', state.page)
  history.replaceState(null, '', url)
  const localStorageApi = storageLocal()
  if (localStorageApi) {
    void localStorageApi.set({
      [STORAGE_KEY]: {
        enabled: true,
        scenarioId: state.scenarioId,
        page: state.page,
      },
    })
  }
}

function setScenario(nextScenarioId: BossLifecycleStage, nextPage?: BossMockPageId) {
  const nextScenario = getBossMockScenario(nextScenarioId)
  state.scenarioId = nextScenario.id
  state.page = nextPage ?? nextScenario.defaultPage
  state.selectedJobId = nextScenario.primaryJobId
  state.selectedGeekId = nextScenario.primaryGeekId
  state.selectedConversationId = nextScenario.conversations[0]?.conversationId ?? null
  state.activeChatTag = '全部'
  state.greetDraft = nextScenario.greetDraft
  state.modal = null
  syncSelections()
  updateUrlAndStorage()
  safeRender()
}

function openPage(page: BossMockPageId, overrides?: Partial<Pick<BossMockState, 'selectedGeekId' | 'selectedJobId' | 'selectedConversationId'>>) {
  state.page = page
  if (overrides?.selectedGeekId) state.selectedGeekId = overrides.selectedGeekId
  if (overrides?.selectedJobId) state.selectedJobId = overrides.selectedJobId
  if (overrides?.selectedConversationId !== undefined) state.selectedConversationId = overrides.selectedConversationId
  syncSelections()
  updateUrlAndStorage()
  safeRender()
}

function chatTagCount(tag: ChatTag): number | null {
  const dashboard = currentScenario().dashboard
  switch (tag) {
    case '新招呼':
      return dashboard.newGreetings
    case '沟通中':
      return dashboard.inProgress
    case '已获取简历':
      return dashboard.resumeReceived
    case '已交换电话':
      return dashboard.phoneExchanged
    case '已交换微信':
      return dashboard.wechatExchanged
    default:
      return null
  }
}

function escapeHtml(value: string) {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
}

function renderMessage(message: BossMockConversationMessage) {
  if (message.type === 'system_note') {
    return `<div class="message-item"><div class="item-system"><div class="text"><span>${escapeHtml(message.text)}</span></div></div></div>`
  }

  if (message.type === 'card') {
    return renderCardMessage(message)
  }

  return `
    <div class="message-item">
      ${message.time ? `<div class="message-time"><span class="time">${escapeHtml(message.time)}</span></div>` : ''}
      <div class="${message.sender === 'boss' ? 'item-myself clearfix' : 'item-friend clearfix'}">
        <div class="text">
          ${message.readStatus ? `<i class="status status-read">${escapeHtml(message.readStatus)}</i>` : ''}
          <span>${escapeHtml(message.text)}</span>
        </div>
      </div>
    </div>
  `
}

function renderCardMessage(message: BossMockConversationCard) {
  const rootClass =
    message.sender === 'system'
      ? 'item-system clearfix'
      : message.sender === 'boss'
        ? 'item-myself clearfix'
        : 'item-friend'

  const iconClass =
    message.variant === 'resume_consent' || message.variant === 'resume_file'
      ? 'message-dialog-icon-resume'
      : message.variant === 'contact_card_wechat' || message.variant === 'contact_request'
        ? 'message-dialog-icon-weixin'
        : 'message-dialog-icon-contact'

  if (message.variant === 'position_header') {
    return `<div class="message-item"><div class="message-position-header">${escapeHtml(message.title)}</div></div>`
  }

  if (message.variant === 'priority_hint') {
    return `
      <div class="message-item">
        <div class="item-system">
          <div class="message-priority-hint">
            <span>${escapeHtml(message.title)}</span>
            <button type="button" class="ghost-btn">${escapeHtml(message.buttons[0] ?? '知道了')}</button>
          </div>
        </div>
      </div>
    `
  }

  const numberMarkup = message.number
    ? `<span class="number">${escapeHtml(message.number)}</span>`
    : ''

  return `
    <div class="message-item">
      ${message.time ? `<div class="message-time"><span class="time">${escapeHtml(message.time)}</span></div>` : ''}
      <div class="${rootClass}">
        <div class="text ${message.sender === 'system' ? 'reset-message-text' : ''}">
          ${numberMarkup}
          <div class="message-card-wrap ${message.variant === 'resume_file' || message.variant === 'resume_consent' ? 'boss-green' : 'green'}">
            <div class="message-card-top-wrap">
              <div class="message-card-top-icon-content">
                <span class="message-dialog-icon ${iconClass}"></span>
              </div>
              <div class="message-card-top-content">
                <div class="message-card-top-title-wrap">
                  <h3 class="message-card-top-title message-card-top-text">${escapeHtml(message.title).split('\n').join('<br>')}</h3>
                </div>
                ${message.description ? `<p class="dialog-exchange-content">${escapeHtml(message.description)}</p>` : ''}
              </div>
            </div>
            ${message.buttons.length > 0 ? `<div class="message-card-buttons">${message.buttons.map((button) => `<span class="card-btn">${escapeHtml(button)}</span>`).join('')}</div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `
}

function renderSidebar() {
  const items: Array<{ id: BossMockPageId; label: string }> = [
    { id: 'jobs', label: '职位管理' },
    { id: 'recommend', label: '推荐牛人' },
    { id: 'greet', label: '打招呼页' },
    { id: 'chat', label: `沟通 ${currentScenario().dashboard.totalCommunications}` },
    { id: 'resume', label: '在线简历' },
  ]

  return `
    <aside class="mock-sidebar">
      <div class="mock-logo">BOSS Mock</div>
      <div class="mock-stage-badge">${escapeHtml(currentScenario().label)}</div>
      <nav class="mock-menu">
        ${items
          .map(
            (item) => `
              <button
                type="button"
                class="menu-item ${state.page === item.id ? 'active' : ''}"
                data-page="${item.id}">
                ${escapeHtml(item.label)}
              </button>
            `
          )
          .join('')}
      </nav>
      <div class="mock-sidebar-footer">
        <div class="footer-title">页面级 mock 包</div>
        <div class="footer-desc">${escapeHtml(currentScenario().description)}</div>
      </div>
    </aside>
  `
}

function renderJobsPage() {
  const selectedJob = currentJob()
  const jobs = currentScenario().jobs
  return `
    <div class="page-shell">
      <header class="page-header">
        <div>
          <div class="page-name">职位管理</div>
          <div class="page-subtitle">包含 JD 标题、详情、状态与看板数据</div>
        </div>
        <div class="dashboard-strip">
          <div class="dashboard-card"><span>开放中</span><strong>${jobs.filter((job) => job.status === '开放中').length}</strong></div>
          <div class="dashboard-card"><span>待开放</span><strong>${jobs.filter((job) => job.status === '待开放').length}</strong></div>
          <div class="dashboard-card"><span>已关闭</span><strong>${jobs.filter((job) => job.status === '已关闭').length}</strong></div>
        </div>
      </header>
      <div class="split-layout">
        <section class="panel jobs-list-panel">
          ${jobs
            .map((job) => {
              const meta = job.internshipDays
                ? `${job.city} · ${job.internshipDays} · ${job.internshipDuration ?? ''} · ${job.education} · ${job.salary} · ${job.employmentType}`
                : `${job.city} · ${job.experience} · ${job.education} · ${job.salary} · ${job.employmentType}`
              return `
                <button type="button" class="job-card ${job.jobId === selectedJob.jobId ? 'selected' : ''}" data-job-id="${job.jobId}">
                  <div class="job-card-title-row">
                    <div class="job-card-title">${escapeHtml(job.title)}</div>
                    <span class="job-card-label">${job.label}</span>
                  </div>
                  <div class="job-card-meta">${escapeHtml(meta)}</div>
                  <div class="job-card-stats">
                    <span><strong>${job.stats.viewed}</strong> 看过我</span>
                    <span><strong>${job.stats.communicated}</strong> 沟通过</span>
                    <span><strong>${job.stats.interested}</strong> 感兴趣</span>
                  </div>
                  <div class="job-card-bottom">
                    <span class="job-status ${job.status === '开放中' ? 'open' : job.status === '待开放' ? 'pending' : 'closed'}">${escapeHtml(job.status)}</span>
                    <span>${escapeHtml(job.expireAt)}</span>
                  </div>
                </button>
              `
            })
            .join('')}
        </section>
        <section class="panel job-detail-panel">
          <div class="detail-title-row">
            <div>
              <div class="detail-title">${escapeHtml(selectedJob.title)}</div>
              <div class="detail-subtitle">${escapeHtml(selectedJob.jd.subtitle)}</div>
            </div>
            <button type="button" class="primary-btn" data-page="recommend">查看推荐牛人</button>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">职位亮点</div>
            <div class="tag-list">
              ${selectedJob.jd.highlights.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
            </div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">岗位职责</div>
            <ul class="detail-list">
              ${selectedJob.jd.responsibilities.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">任职要求</div>
            <ul class="detail-list">
              ${selectedJob.jd.requirements.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
            </ul>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">关键词</div>
            <div class="tag-list">
              ${selectedJob.jd.tags.map((tag) => `<span class="soft-tag">${escapeHtml(tag)}</span>`).join('')}
            </div>
          </div>
        </section>
      </div>
    </div>
  `
}

function renderRecommendPage() {
  const scenario = currentScenario()
  const primaryJob = scenario.jobs.find((job) => job.jobId === scenario.primaryJobId) ?? scenario.jobs[0]
  return `
    <div class="page-shell">
      <header class="page-header">
        <div>
          <div class="page-name">推荐牛人</div>
          <div class="page-subtitle">包含职位上下文、候选人卡片、详情入口（查看在线简历）和打招呼跳转</div>
        </div>
        <div class="recommend-job-chip">${escapeHtml(primaryJob.title)} _ ${escapeHtml(primaryJob.city)} ${escapeHtml(primaryJob.salary)}</div>
      </header>
      <div class="recommend-filter-bar panel">
        <div class="recommend-filter-title">筛选</div>
        <div class="tag-list">
          <span class="soft-tag active">推荐</span>
          <span class="soft-tag">精选</span>
          <span class="soft-tag">最新</span>
          <span class="soft-tag">软件/信息技术项目</span>
          <span class="soft-tag">市场/公关项目</span>
        </div>
      </div>
      <section class="recommend-grid">
        ${scenario.recommendedGeeks
          .map((candidate) => {
            const geek = allGeeks().find((item) => item.geekId === candidate.geekId)
            if (!geek) return ''
            return `
              <article class="recommend-card">
                <div class="recommend-top-row">
                  <div class="salary-chip">${escapeHtml(candidate.salaryExpectation)}</div>
                  <div class="stage-chip">${escapeHtml(candidate.stageTag)}</div>
                </div>
                <div class="recommend-name-row">
                  <div class="recommend-name">${escapeHtml(geek.name)}</div>
                  <div class="recommend-basic">${geek.age}岁 ${escapeHtml(geek.graduationLabel)} ${escapeHtml(geek.educationLabel)} ${escapeHtml(geek.activeLabel)}</div>
                </div>
                <div class="recommend-line"><strong>${escapeHtml(candidate.expectationType)}</strong> ${escapeHtml(candidate.targetCity)} ${escapeHtml(candidate.targetPosition)}</div>
                <div class="recommend-line"><strong>学历</strong> ${escapeHtml(candidate.educationText)}</div>
                <div class="tag-list compact">
                  ${candidate.skillHighlights.map((tag) => `<span class="tag compact">${escapeHtml(tag)}</span>`).join('')}
                </div>
                <div class="experience-preview">
                  ${candidate.experiencePreview.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
                </div>
                <div class="card-actions">
                  <button type="button" class="ghost-btn" data-page="resume" data-geek-id="${candidate.geekId}">详情</button>
                  <button type="button" class="primary-btn" data-action="open-greet" data-geek-id="${candidate.geekId}" data-job-id="${primaryJob.jobId}">打招呼</button>
                </div>
              </article>
            `
          })
          .join('')}
      </section>
    </div>
  `
}

function renderGreetPage() {
  const geek = currentGeek()
  const job = currentJob()
  return `
    <div class="page-shell">
      <header class="page-header">
        <div>
          <div class="page-name">打招呼页</div>
          <div class="page-subtitle">从推荐牛人页点击“打招呼”进入，保留职位上下文和默认招呼语</div>
        </div>
      </header>
      <div class="split-layout narrow">
        <section class="panel greet-summary-panel">
          <div class="detail-section-title">候选人摘要</div>
          <div class="greet-name">${escapeHtml(geek.name)}</div>
          <div class="greet-meta">${geek.age}岁 · ${escapeHtml(geek.educationLabel)} · ${escapeHtml(geek.activeLabel)}</div>
          <div class="detail-list-plain">
            <div>期望：${escapeHtml(geek.expectedPosition)} ${escapeHtml(geek.expectedSalary)}</div>
            <div>最近关注：${escapeHtml(geek.recentFocus)}</div>
            <div>当前：${escapeHtml(geek.currentCompany ?? '-')}${geek.currentRole ? ` · ${escapeHtml(geek.currentRole)}` : ''}</div>
          </div>
          <div class="tag-list compact">
            ${geek.highlightTags.map((tag) => `<span class="tag compact">${escapeHtml(tag)}</span>`).join('')}
          </div>
          <div class="card-actions">
            <button type="button" class="ghost-btn" data-page="resume" data-geek-id="${geek.geekId}">查看在线简历</button>
            <button type="button" class="ghost-btn" data-page="recommend">返回推荐页</button>
          </div>
        </section>
        <section class="panel greet-editor-panel">
          <div class="detail-section-title">沟通职位</div>
          <div class="job-inline-title">${escapeHtml(job.title)}</div>
          <div class="greet-textarea-wrap">
            <textarea id="greetDraft" class="greet-textarea" placeholder="请输入打招呼内容">${escapeHtml(state.greetDraft)}</textarea>
          </div>
          <div class="card-actions">
            <button type="button" class="ghost-btn" data-page="recommend">取消</button>
            <button type="button" class="primary-btn" data-action="send-greet">发送招呼</button>
          </div>
        </section>
      </div>
    </div>
  `
}

function renderChatPage() {
  const scenario = currentScenario()
  const conversation = currentConversation()
  const geek = conversation ? allGeeks().find((item) => item.geekId === conversation.geekId) ?? currentGeek() : currentGeek()
  const job = conversation
    ? scenario.jobs.find((item) => item.jobId === conversation.jobId) ?? currentJob()
    : currentJob()
  const tags: ChatTag[] = ['全部', '新招呼', '沟通中', '已获取简历', '已交换电话', '已交换微信', '我发起', '牛人发起']

  return `
    <div class="page-shell chat-shell">
      <header class="page-header">
        <div>
          <div class="page-name">沟通</div>
          <div class="page-subtitle">候选人列表、沟通详情、状态筛选和动作看板都在这一页</div>
        </div>
        <div class="dashboard-strip">
          <div class="dashboard-card"><span>新招呼</span><strong>${scenario.dashboard.newGreetings}</strong></div>
          <div class="dashboard-card"><span>沟通中</span><strong>${scenario.dashboard.inProgress}</strong></div>
          <div class="dashboard-card"><span>已收简历</span><strong>${scenario.dashboard.resumeReceived}</strong></div>
          <div class="dashboard-card"><span>已交换电话</span><strong>${scenario.dashboard.phoneExchanged}</strong></div>
          <div class="dashboard-card"><span>已交换微信</span><strong>${scenario.dashboard.wechatExchanged}</strong></div>
        </div>
      </header>
      <div class="chat-filter-bar panel">
        ${tags
          .map((tag) => {
            const count = chatTagCount(tag)
            return `<button type="button" class="filter-pill ${state.activeChatTag === tag ? 'active' : ''}" data-chat-tag="${tag}">${escapeHtml(tag)}${count !== null ? `(${count})` : ''}</button>`
          })
          .join('')}
      </div>
      <div class="chat-layout">
        <section class="panel chat-list-panel">
          ${visibleConversations()
            .map((item) => {
              const listGeek = allGeeks().find((geekItem) => geekItem.geekId === item.geekId)
              const listJob = scenario.jobs.find((jobItem) => jobItem.jobId === item.jobId)
              return `
                <button type="button" class="chat-list-item ${conversation?.conversationId === item.conversationId ? 'selected' : ''}" data-conversation-id="${item.conversationId}">
                  <div class="chat-list-head">
                    <span>${escapeHtml(item.previewDate)}</span>
                    ${item.unreadCount > 0 ? `<span class="unread-dot">${item.unreadCount}</span>` : ''}
                  </div>
                  <div class="chat-list-name">${escapeHtml(listGeek?.name ?? item.geekId)}</div>
                  <div class="chat-list-job">${escapeHtml(listJob?.title ?? item.jobId)}</div>
                  <div class="chat-list-preview">${escapeHtml(item.previewText)}</div>
                </button>
              `
            })
            .join('')}
          ${visibleConversations().length === 0 ? '<div class="empty-state">当前筛选下没有联系人</div>' : ''}
        </section>
        <section class="panel chat-main-panel">
          ${
            conversation
              ? `
                <div class="base-info-content">
                  <div class="base-info-single-container">
                    <div class="base-info-single-top">
                      <div class="base-info-single-top-detail">
                        <div class="base-info-single-detial">
                          <div class="base-info-item name-contet"><span class="base-name">${escapeHtml(geek.name)}</span></div>
                          <div class="high-light-orange active-time"><span>${escapeHtml(geek.activeLabel)}</span></div>
                          <div>${geek.age}岁</div>
                          <div>${escapeHtml(geek.experienceLabel)}</div>
                          <div>${escapeHtml(geek.educationLabel)}</div>
                        </div>
                        <div class="resume-btn-content">
                          <button type="button" class="btn resume-btn-online" data-page="resume" data-geek-id="${geek.geekId}">在线简历</button>
                          <button type="button" class="btn resume-btn-file">${escapeHtml(geek.attachmentResumeName ?? '附件简历')}</button>
                        </div>
                      </div>
                    </div>
                    <div class="base-info-single-main">
                      <div class="experience-columns">
                        <div class="column">
                          <div class="column-title">最近经历</div>
                          ${geek.onlineResume.workExperience
                            .slice(0, 2)
                            .map((section) => `<div class="experience-line">${escapeHtml(section.title)}</div>`)
                            .join('')}
                        </div>
                        <div class="column">
                          <div class="column-title">教育</div>
                          ${geek.onlineResume.education
                            .slice(0, 1)
                            .map((section) => `<div class="experience-line">${escapeHtml(section.title)}</div>`)
                            .join('')}
                        </div>
                      </div>
                      <div class="focus-row">
                        <span>沟通职位： ${escapeHtml(job.title)}</span>
                        <span>最近关注： ${escapeHtml(geek.recentFocus)}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="messages-container">
                  ${conversation.messages.map((message) => renderMessage(message)).join('')}
                </div>
                <div class="quick-actions-row">
                  ${scenario.quickActions
                    .map(
                      (action) => `
                        <button type="button" class="quick-action-btn" data-quick-action="${action.id}">
                          ${escapeHtml(action.label)}
                        </button>
                      `
                    )
                    .join('')}
                </div>
                <div class="composer-row">
                  <textarea class="chat-composer" placeholder="发送 mock 沟通消息（仅页面展示，不会写回真实站点）"></textarea>
                  <button type="button" class="primary-btn">发送</button>
                </div>
              `
              : '<div class="empty-state large">未选中联系人</div>'
          }
        </section>
      </div>
    </div>
  `
}

function renderResumePage() {
  const geek = currentGeek()
  return `
    <div class="page-shell">
      <header class="page-header">
        <div>
          <div class="page-name">在线简历</div>
          <div class="page-subtitle">完整简历 mock 数据页，可从推荐牛人页和沟通页进入</div>
        </div>
        <div class="card-actions">
          <button type="button" class="ghost-btn" data-page="chat" data-geek-id="${geek.geekId}">返回沟通页</button>
          <button type="button" class="ghost-btn" data-page="recommend" data-geek-id="${geek.geekId}">返回推荐页</button>
        </div>
      </header>
      <div class="resume-layout">
        <section class="panel resume-summary-panel">
          <div class="resume-name-row">
            <div>
              <div class="resume-name">${escapeHtml(geek.name)}</div>
              <div class="resume-basic">${geek.age}岁 · ${escapeHtml(geek.educationLabel)} · ${escapeHtml(geek.experienceLabel)} · ${escapeHtml(geek.currentStatus)}</div>
            </div>
            <div class="tag-list compact">
              ${geek.highlightTags.map((tag) => `<span class="tag compact">${escapeHtml(tag)}</span>`).join('')}
            </div>
          </div>
          <div class="resume-section">
            <div class="resume-section-title">个人概述</div>
            <p>${escapeHtml(geek.onlineResume.summary)}</p>
          </div>
          <div class="resume-section">
            <div class="resume-section-title">求职期望</div>
            <div class="tag-list compact">
              ${geek.onlineResume.expectation.map((item) => `<span class="soft-tag">${escapeHtml(item)}</span>`).join('')}
            </div>
          </div>
          <div class="resume-section">
            <div class="resume-section-title">技能</div>
            <div class="tag-list compact">
              ${geek.onlineResume.skills.map((item) => `<span class="tag compact">${escapeHtml(item)}</span>`).join('')}
            </div>
          </div>
          <div class="resume-section">
            <div class="resume-section-title">自我评价</div>
            <p>${escapeHtml(geek.onlineResume.selfEvaluation)}</p>
          </div>
        </section>
        <section class="panel resume-detail-panel">
          ${[
            { title: '工作经历', sections: geek.onlineResume.workExperience },
            { title: '项目经历', sections: geek.onlineResume.projectExperience },
            { title: '教育经历', sections: geek.onlineResume.education },
          ]
            .map(
              (block) => `
                <div class="resume-section">
                  <div class="resume-section-title">${escapeHtml(block.title)}</div>
                  ${block.sections
                    .map(
                      (section) => `
                        <div class="resume-block">
                          <div class="resume-block-title">${escapeHtml(section.title)}</div>
                          <ul class="detail-list">
                            ${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                          </ul>
                        </div>
                      `
                    )
                    .join('')}
                </div>
              `
            )
            .join('')}
          <div class="resume-section">
            <div class="resume-section-title">证书与补充信息</div>
            <div class="tag-list compact">
              ${(geek.onlineResume.certificates.length > 0 ? geek.onlineResume.certificates : ['暂无附加证书']).map((item) => `<span class="soft-tag">${escapeHtml(item)}</span>`).join('')}
            </div>
          </div>
        </section>
      </div>
    </div>
  `
}

function renderModal() {
  if (!state.modal) return ''
  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-title">${escapeHtml(state.modal.title)}</div>
        <div class="modal-actions">
          <button type="button" class="ghost-btn" data-action="close-modal">取消</button>
          <button type="button" class="primary-btn" data-action="confirm-modal">确定</button>
        </div>
      </div>
    </div>
  `
}

function render() {
  syncSelections()
  const content =
    state.page === 'jobs'
      ? renderJobsPage()
      : state.page === 'recommend'
        ? renderRecommendPage()
        : state.page === 'greet'
          ? renderGreetPage()
          : state.page === 'resume'
            ? renderResumePage()
            : renderChatPage()

  appRootEl.innerHTML = `
    <div class="mock-root">
      ${renderSidebar()}
      <main class="mock-main">
        ${content}
      </main>
      ${renderModal()}
    </div>
  `
}

function safeRender() {
  try {
    render()
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    appRootEl.innerHTML = `<pre style="padding:24px;white-space:pre-wrap;color:#b91c1c;">${escapeHtml(message)}</pre>`
  }
}

function handleQuickAction(action: BossMockQuickAction) {
  state.modal = {
    title: action.confirmTitle ?? `确认执行「${action.label}」吗？`,
    actionId: action.id,
  }
  safeRender()
}

function confirmModal() {
  if (!state.modal) return
  const actionId = state.modal.actionId
  state.modal = null

  if (actionId === 'send_greet') {
    const nextStage: BossLifecycleStage = state.scenarioId === 'fresh' ? 'greeted' : state.scenarioId
    setScenario(nextStage, 'chat')
    return
  }

  const action = currentScenario().quickActions.find((item) => item.id === actionId)
  if (action?.nextStage) {
    setScenario(action.nextStage, 'chat')
    return
  }

  safeRender()
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  if (!target) return

  const page = target.closest<HTMLElement>('[data-page]')?.dataset.page as BossMockPageId | undefined
  if (page) {
    const geekId = target.closest<HTMLElement>('[data-geek-id]')?.dataset.geekId
    const jobId = target.closest<HTMLElement>('[data-job-id]')?.dataset.jobId
    openPage(page, {
      selectedGeekId: geekId ?? state.selectedGeekId,
      selectedJobId: jobId ?? state.selectedJobId,
    })
    return
  }

  const jobId = target.closest<HTMLElement>('[data-job-id]')?.dataset.jobId
  if (jobId && target.closest('.job-card')) {
    state.selectedJobId = jobId
    safeRender()
    return
  }

  const conversationId = target.closest<HTMLElement>('[data-conversation-id]')?.dataset.conversationId
  if (conversationId) {
    const conversation = currentScenario().conversations.find((item) => item.conversationId === conversationId)
    if (conversation) {
      state.selectedConversationId = conversation.conversationId
      state.selectedGeekId = conversation.geekId
      state.selectedJobId = conversation.jobId
      safeRender()
    }
    return
  }

  const chatTag = target.closest<HTMLElement>('[data-chat-tag]')?.dataset.chatTag as ChatTag | undefined
  if (chatTag) {
    state.activeChatTag = chatTag
    state.selectedConversationId = null
    safeRender()
    return
  }

  const scenarioId = target.closest<HTMLElement>('[data-stage]')?.dataset.stage as BossLifecycleStage | undefined
  if (scenarioId) {
    setScenario(scenarioId)
    return
  }

  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'open-greet') {
    const geekId = target.closest<HTMLElement>('[data-geek-id]')?.dataset.geekId
    const jobIdForGreet = target.closest<HTMLElement>('[data-job-id]')?.dataset.jobId
    openPage('greet', {
      selectedGeekId: geekId ?? state.selectedGeekId,
      selectedJobId: jobIdForGreet ?? state.selectedJobId,
    })
    return
  }

  if (action === 'send-greet') {
    state.modal = {
      title: '确定向牛人发送打招呼消息吗？',
      actionId: 'send_greet',
    }
    safeRender()
    return
  }

  if (action === 'close-modal') {
    state.modal = null
    safeRender()
    return
  }

  if (action === 'confirm-modal') {
    confirmModal()
    return
  }

  const quickActionId = target.closest<HTMLElement>('[data-quick-action]')?.dataset.quickAction as BossMockQuickAction['id'] | undefined
  if (quickActionId) {
    const quickAction = currentScenario().quickActions.find((item) => item.id === quickActionId)
    if (quickAction) {
      handleQuickAction(quickAction)
    }
  }
})

document.addEventListener('input', (event) => {
  const target = event.target as HTMLElement | null
  if (!(target instanceof HTMLTextAreaElement)) return
  if (target.id !== 'greetDraft') return
  state.greetDraft = target.value
})

try {
  bootstrap()

  const localStorageApi = storageLocal()
  if (localStorageApi) {
    void localStorageApi.set({
      [STORAGE_KEY]: {
        enabled: true,
        scenarioId: state.scenarioId,
        page: state.page,
      },
    })
  }

  safeRender()
} catch (error) {
  renderBootstrapError(error)
}
