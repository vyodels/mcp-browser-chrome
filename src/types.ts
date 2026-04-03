// ============================================================
// types.ts — 全局类型定义
// ============================================================

export type ApiFormat = 'openai' | 'anthropic'

// ---- 工作流 ----
export type InterventionType = 'none' | 'optional' | 'required'

export interface WorkflowStep {
  id: string
  name: string
  instructions: string       // 给 AI 的详细指令
  intervention: InterventionType
  completionHint: string     // AI 判断此步完成的依据
  skillIds?: string[]        // 引用的 Skill ID，其 instructions 会注入本步骤
}

export interface Workflow {
  id: string
  name: string
  description: string
  context?: string           // 全局背景/要求（如候选人标准），注入每一步 system prompt
  startUrl?: string
  steps: WorkflowStep[]
  createdAt: number
}

// ---- 设置 ----
export interface Settings {
  baseUrl: string
  apiKey: string
  apiFormat: ApiFormat
  model: string
  systemPrompt: string
  actionDelay: [number, number]
  maxActionsPerMinute: number
  prompts: SavedPrompt[]
  skills: Skill[]
  workflows: Workflow[]
  activityLog: ActivityEntry[]
  candidates: CandidateEntry[]
}

export interface SavedPrompt {
  id: string
  title: string
  content: string
  createdAt: number
}

export type SkillStatus = 'active' | 'disabled' | 'error'

export interface Skill {
  id: string
  name: string
  description: string
  trigger: string
  instructions: string
  status: SkillStatus
  createdAt: number
  lastUsed?: number
}

export interface TabInfo {
  id: number
  url: string
  title: string
  favIconUrl?: string
}

// ---- 消息总线 ----
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
  | 'CONFIGURE_RATE_LIMIT'
  | 'GET_ACTIVE_TAB'
  | 'EXECUTE_ACTION_IN_TAB'
  | 'OPEN_TAB'
  | 'OPEN_TAB_AND_WAIT'
  | 'NAVIGATE_TAB'
  | 'CREATE_TAB_GROUP'
  | 'CLOSE_TAB_GROUP'
  | 'DOWNLOAD_DATA'
  | 'GET_ALL_TABS'

export interface Message {
  type: MessageType
  payload?: unknown
  targetTabId?: number
}

// ---- 页面内容快照 ----
export interface PageSnapshot {
  url: string
  title: string
  text: string
  interactiveElements: InteractiveElement[]
  html?: string
}

export interface InteractiveElement {
  ref: string
  tag: string
  type?: string
  text?: string
  placeholder?: string
  ariaLabel?: string
  href?: string
  rect: DOMRect | { top: number; left: number; width: number; height: number }
}

// ---- AI 动作（保留供 content.ts 内部使用）----
export type ActionType =
  | 'click'
  | 'fill'
  | 'select'
  | 'scroll'
  | 'press'
  | 'wait'
  | 'navigate'
  | 'screenshot'

export interface AgentAction {
  action: ActionType
  ref?: string
  value?: string
  key?: string
  url?: string
  direction?: 'up' | 'down'
  pixels?: number
  ms?: number
}

export interface ActionResult {
  success: boolean
  message: string
  snapshot?: PageSnapshot
  screenshotDataUrl?: string
}

// ---- Chat ----
export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  imageDataUrl?: string
  timestamp: number
  toolCallId?: string      // tool result 消息关联的 call id
  toolName?: string        // 显示日志用
  isToolLog?: boolean      // UI 中以工具调用日志样式显示
}

// ---- Tool Calling ----
export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolCallResponse {
  id: string
  name: string
  result: string           // 序列化后的结果字符串
  error?: string
}

// Agent Loop 状态
export type LoopState = 'idle' | 'running' | 'paused' | 'waiting_user' | 'completed' | 'error'

// 活动记录
export type ActivityType = 'download' | 'navigate' | 'candidate' | 'note'

export interface ActivityEntry {
  id: string
  timestamp: number
  type: ActivityType
  title: string
  detail?: string
  taskName?: string
}

// 候选人追踪
export type CandidateStatus =
  | 'screening'           // 筛选中
  | 'contacted'           // 已发起沟通
  | 'resume_received'     // 已收到简历
  | 'interview_scheduled' // 已预约面试
  | 'passed'              // 通过
  | 'rejected'            // 淘汰

export interface CandidateEntry {
  id: string
  name: string
  status: CandidateStatus
  position?: string       // 应聘/当前职位
  company?: string        // 当前公司
  experience?: string     // 工作年限
  education?: string      // 学历
  salary?: string         // 期望薪资
  phone?: string
  notes?: string          // 备注：沟通情况、匹配分析
  resumeFile?: string     // 简历文件名
  interviewTime?: string  // 面试时间
  tags?: string[]
  workflowId?: string
  taskName?: string
  createdAt: number
  updatedAt: number
}

// 用户介入请求（ask_user 工具触发）
export interface InterventionRequest {
  question: string
  options?: string[]       // 若有选项则显示按钮，否则文本输入
  placeholder?: string
}
