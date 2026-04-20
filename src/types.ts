// 仅保留当前 browser-mcp 主链路仍在使用的共享类型。

export type MessageType =
  | 'GET_PAGE_CONTENT'
  | 'EXECUTE_ACTION'
  | 'TAKE_SCREENSHOT'
  | 'OPEN_SETTINGS'
  | 'DEBUG_DOM'
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
  | 'QUERY_ELEMENTS'
  | 'WAIT_FOR_ELEMENT'
  | 'WAIT_FOR_TEXT'
  | 'WAIT_FOR_DISAPPEAR'
  | 'BROWSER_SNAPSHOT'

export interface Message {
  type: MessageType
  payload?: unknown
  targetTabId?: number
}

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
