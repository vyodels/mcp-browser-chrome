import type { InteractiveElement, PageSnapshot } from '../../types'

export const NATIVE_HOST_NAME = 'com.vyodels.mcp_browser_chrome'
export const HOST_SOCKET_PATH_ENV = 'MCP_BROWSER_CHROME_SOCKET'
export const DEFAULT_HOST_SOCKET_PATH = '/tmp/mcp-browser-chrome.sock'

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
  tabId?: number
  message: string
  target?: {
    ref?: string
    tag?: string
    text?: string
  }
  snapshotSummary?: SnapshotSummary
  navigationDetected?: boolean
  snapshot?: PageSnapshot
  screenshotDataUrl?: string
  error?: string
}

export type BrowserCommandName =
  | 'browser_list_tabs'
  | 'browser_get_active_tab'
  | 'browser_select_tab'
  | 'browser_open_tab'
  | 'browser_close_tab'
  | 'browser_navigate'
  | 'browser_go_back'
  | 'browser_reload'
  | 'browser_snapshot'
  | 'browser_query_elements'
  | 'browser_get_element'
  | 'browser_debug_dom'
  | 'browser_click'
  | 'browser_hover'
  | 'browser_fill'
  | 'browser_clear'
  | 'browser_select_option'
  | 'browser_press_key'
  | 'browser_scroll'
  | 'browser_wait'
  | 'browser_wait_for_element'
  | 'browser_wait_for_text'
  | 'browser_wait_for_navigation'
  | 'browser_wait_for_disappear'
  | 'browser_screenshot'
  | 'browser_download_file'
  | 'browser_save_text'
  | 'browser_save_json'
  | 'browser_save_csv'

export interface BrowserCommand {
  name: BrowserCommandName
  arguments?: Record<string, unknown>
}

export interface NativeBridgeRequest {
  id: string
  type: 'browser_command'
  command: BrowserCommand
}

export interface NativeBridgeResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: {
    message: string
  }
}
