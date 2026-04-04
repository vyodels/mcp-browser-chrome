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

// ---- 工作区 Schema（每个工作流独立） ----
export type WorkspaceFieldType = 'text' | 'status' | 'number' | 'date' | 'tags' | 'url'

export interface WorkspaceField {
  id: string
  name: string
  type: WorkspaceFieldType
  options?: string[]         // status 类型的枚举值
  required?: boolean
  aiProposed?: boolean       // AI 提议的字段（待用户确认）
}

export interface WorkspaceSchema {
  fields: WorkspaceField[]
}

export interface WorkspaceRecord {
  id: string
  workflowId: string
  data: Record<string, string>   // fieldId → value
  createdAt: number
  updatedAt: number
}

export interface Workflow {
  id: string
  name: string
  description: string
  context?: string           // 全局背景/要求，注入每一步 system prompt
  startUrl?: string
  workspace?: WorkspaceSchema    // 该工作流的数据 schema
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
  workspaceRecords: WorkspaceRecord[]
  memoryEntries: MemoryEntry[]         // Layer 1 持久记忆
  maxConcurrentAgents: number          // 最大并发子 agent 数（默认 10）
  subAgentTimeoutMs: number            // 子 agent 超时（ms，默认 24h）
}

export interface SavedPrompt {
  id: string
  title: string
  content: string
  createdAt: number
}

export type SkillStatus = 'active' | 'disabled' | 'pending_review'
export type SkillSource = 'builtin' | 'user' | 'ai_generated'

export interface Skill {
  id: string
  name: string
  description: string
  trigger: string
  instructions: string
  status: SkillStatus
  source?: SkillSource       // 来源标记
  createdAt: number
  lastUsed?: number
  aiContext?: string         // AI 生成时的上下文说明（为什么生成这个 skill）
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

// 候选人追踪（BOSS招聘工作流专用）
export type CandidateStatus =
  | 'screening'
  | 'contacted'
  | 'resume_received'
  | 'interview_scheduled'
  | 'passed'
  | 'rejected'

export interface CandidateEntry {
  id: string
  name: string
  status: CandidateStatus
  position?: string
  company?: string
  experience?: string
  education?: string
  salary?: string
  phone?: string
  notes?: string
  resumeFile?: string
  interviewTime?: string
  tags?: string[]
  workflowId?: string
  taskName?: string
  createdAt: number
  updatedAt: number
}

// 用户介入请求（ask_user 工具触发）
export interface InterventionRequest {
  question: string
  options?: string[]
  placeholder?: string
}

// AI 提议 schema 演进（evolve_schema 工具触发）
export interface SchemaProposal {
  workflowId: string
  workflowName: string
  field: WorkspaceField
  reason: string
}

// ---- 分层记忆系统 ----
export type MemoryLayer = 'persistent' | 'session'

export interface MemoryEntry {
  key: string
  value: string
  layer: MemoryLayer
  workflowId?: string   // 关联工作流（空=全局）
  createdAt: number
  updatedAt: number
}

// AI 生成的 Skill 待审批通知
export interface SkillProposal {
  skill: Skill
  context: string    // AI 说明为什么生成这个 skill
}
