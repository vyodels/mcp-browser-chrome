// ============================================================
// types.ts — 全局类型定义
// ============================================================

export type AuthMode = 'apikey' | 'chatgpt'

export interface Settings {
  authMode: AuthMode
  apiKey: string
  model: string
  systemPrompt: string
  actionDelay: [number, number] // [min, max] ms 随机延迟范围
  maxActionsPerMinute: number
  prompts: SavedPrompt[]
  skills: Skill[]
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
  trigger: string        // 关键词触发
  instructions: string  // 给 GPT 的指令
  status: SkillStatus
  createdAt: number
  lastUsed?: number
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

export interface Message {
  type: MessageType
  payload?: unknown
}

// ---- 页面内容快照 ----
export interface PageSnapshot {
  url: string
  title: string
  text: string          // 可读文本
  interactiveElements: InteractiveElement[]
  html?: string         // 调试模式下附带精简 HTML
}

export interface InteractiveElement {
  ref: string           // @e1, @e2 ...
  tag: string
  type?: string
  text?: string
  placeholder?: string
  ariaLabel?: string
  href?: string
  rect: DOMRect | { top: number; left: number; width: number; height: number }
}

// ---- AI 动作 ----
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
  ref?: string           // 目标元素 @eN
  value?: string         // fill / select 的值
  key?: string           // press 的键名
  url?: string           // navigate
  direction?: 'up' | 'down'
  pixels?: number
  ms?: number            // wait
}

export interface ActionResult {
  success: boolean
  message: string
  snapshot?: PageSnapshot
  screenshotDataUrl?: string
}

// ---- Chat ----
export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  imageDataUrl?: string   // 截图附件
  timestamp: number
}
