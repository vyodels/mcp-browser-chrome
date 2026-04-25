import type { ClickableElement } from '../../types'

export const NATIVE_HOST_NAME = 'com.vyodels.browser_mcp'

export interface ElementLocator {
  ref?: string
  selector?: string
  text?: string
  role?: string
  index?: number
}

export interface SnapshotRequest {
  includeHtml?: boolean
  includeText?: boolean
  maxTextLength?: number
  maxHtmlLength?: number
  clickableLimit?: number
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

export interface SnapshotSummary {
  url: string
  title: string
  clickableCount: number
}

export interface QueryElementsResponse {
  success: boolean
  matches: ClickableElement[]
  snapshotSummary: SnapshotSummary
  error?: string
}

export interface WaitForConditionResponse {
  success: boolean
  matched: boolean
  elapsedMs: number
  matches?: ClickableElement[]
  snapshotSummary: SnapshotSummary
  error?: string
}

export type BrowserCommandName =
  | 'browser_list_tabs'
  | 'browser_get_active_tab'
  | 'browser_reload_extension'
  | 'browser_select_tab'
  | 'browser_open_tab'
  | 'browser_snapshot'
  | 'browser_query_elements'
  | 'browser_get_element'
  | 'browser_debug_dom'
  | 'browser_wait_for_element'
  | 'browser_wait_for_text'
  | 'browser_wait_for_navigation'
  | 'browser_wait_for_disappear'
  | 'browser_get_cookies'
  | 'browser_locate_download'
  | 'browser_wait_for_url'
  | 'browser_screenshot'

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
