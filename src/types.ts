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
}

export interface Workflow {
  id: string
  name: string
  description: string
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

// 用户介入请求（ask_user 工具触发）
export interface InterventionRequest {
  question: string
  options?: string[]       // 若有选项则显示按钮，否则文本输入
  placeholder?: string
}
