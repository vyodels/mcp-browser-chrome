// 仅保留当前 browser-mcp 主链路仍在使用的共享类型。

export type MessageType =
  | 'CONTENT_SCRIPT_PING'
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
  | 'BROWSER_A11Y_SNAPSHOT'
  | 'GET_CONSOLE_MESSAGES'
  | 'FILL_FORM'
  | 'DRAG'
  | 'UPLOAD_FILE'
  | 'EVALUATE'
  | 'RUN_CODE'
  | 'GET_FRAMES'
  | 'GET_NETWORK_REQUESTS'
  | 'GET_NETWORK_REQUEST'
  | 'WAIT_FOR_NETWORK_REQUEST'
  | 'WAIT_FOR_NETWORK_RESPONSE'

export interface Message {
  type: MessageType
  payload?: unknown
  targetTabId?: number
}

export interface PageSnapshot {
  url: string
  title: string
  text: string
  textInfo?: {
    offset: number
    returnedLength: number
    totalLength: number
    truncated: boolean
    nextOffset?: number
  }
  interactiveElements: InteractiveElement[]
  interactiveInfo?: {
    total: number
    limit: number
    returned: number
    truncated: boolean
  }
  html?: string
  htmlInfo?: {
    offset: number
    returnedLength: number
    totalLength: number
    truncated: boolean
    nextOffset?: number
  }
  summary?: {
    mode: 'dom' | 'a11y'
    url: string
    title: string
    interactiveCount: number
    textLength: number
    htmlLength?: number
    textTruncated: boolean
    htmlTruncated: boolean
  }
}

export interface A11yNode {
  id: string
  role: string
  name?: string
  value?: string | number | boolean
  description?: string
  ref?: string
  level?: number
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  disabled?: boolean
  pressed?: boolean
  href?: string
  children?: A11yNode[]
  omittedChildren?: number
}

export interface A11ySnapshot {
  url: string
  title: string
  tree: A11yNode
  lines: string[]
  summary: {
    role: 'document'
    nodeCount: number
    returnedNodeCount: number
    maxNodes: number
    maxDepth: number
    truncated: boolean
  }
}

export interface FrameRecord {
  ref: string
  path: string[]
  url: string
  title?: string
  sameOrigin: boolean
  isMainFrame?: boolean
  frameId?: number
  parentFrameId?: number
  parentRef?: string
  documentId?: string
  lifecycle?: string
  errorOccurred?: boolean
}

export interface ConsoleMessageRecord {
  id: string
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  args?: unknown[]
  timestamp: number
  location?: string
}

export interface InteractiveElement {
  ref: string
  frameRef?: string
  tag: string
  role?: string
  type?: string
  text?: string
  name?: string
  placeholder?: string
  ariaLabel?: string
  href?: string
  framePath?: string[]
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
  | 'double_click'
  | 'hover'
  | 'scroll_element'
  | 'upload_file'

export interface AgentAction {
  action: ActionType
  ref?: string
  value?: string
  values?: string[]
  key?: string
  url?: string
  direction?: 'up' | 'down'
  pixels?: number
  ms?: number
  files?: Array<{
    name: string
    type?: string
    lastModified?: number
    contentBase64: string
  }>
}

export interface ActionResult {
  success: boolean
  message: string
  snapshot?: PageSnapshot
  screenshotDataUrl?: string
}
