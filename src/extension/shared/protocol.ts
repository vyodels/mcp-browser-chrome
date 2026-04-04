import type { InteractiveElement, PageSnapshot } from '../../types'

export interface ElementLocator {
  ref?: string
  selector?: string
  text?: string
  role?: string
  index?: number
}

export interface SnapshotRequest {
  includeHtml?: boolean
  maxTextLength?: number
  maxHtmlLength?: number
  interactiveLimit?: number
}

export interface QueryElementsRequest extends ElementLocator {
  limit?: number
  visibleOnly?: boolean
}

export interface WaitForElementRequest extends QueryElementsRequest {
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface WaitForTextRequest {
  text: string
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface WaitForDisappearRequest extends QueryElementsRequest {
  timeoutMs?: number
  pollIntervalMs?: number
}

export type BrowserActionName =
  | 'click'
  | 'hover'
  | 'fill'
  | 'clear'
  | 'select'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'navigate'
  | 'focus'
  | 'blur'
  | 'screenshot'

export interface BrowserActionRequest extends ElementLocator {
  action: BrowserActionName
  value?: string
  key?: string
  url?: string
  direction?: 'up' | 'down'
  pixels?: number
  ms?: number
}

export interface SnapshotSummary {
  url: string
  title: string
  interactiveCount: number
}

export interface QueryElementsResponse {
  success: boolean
  matches: InteractiveElement[]
  snapshotSummary: SnapshotSummary
  error?: string
}

export interface WaitForConditionResponse {
  success: boolean
  matched: boolean
  elapsedMs: number
  matches?: InteractiveElement[]
  snapshotSummary: SnapshotSummary
  error?: string
}

export interface BrowserActionResponse {
  success: boolean
  message: string
  target?: {
    ref?: string
    tag?: string
    text?: string
  }
  navigationDetected?: boolean
  snapshot?: PageSnapshot
  screenshotDataUrl?: string
  error?: string
}

