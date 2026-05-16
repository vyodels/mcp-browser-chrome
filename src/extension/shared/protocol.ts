import type { ClickableElement } from '../../types'

export const NATIVE_HOST_NAME = 'com.vyodels.browser_mcp'

export interface ElementLocator {
  ref?: string
  selector?: string
  text?: string
  role?: string
  index?: number
}

export interface TargetPolicyRequest {
  tabId?: number
  expectedHost?: string
  expectedOrigin?: string
  targetPolicy?: 'strict' | 'compat'
}

export interface SnapshotRequest extends TargetPolicyRequest {
  includeHtml?: boolean
  includeText?: boolean
  maxTextLength?: number
  maxHtmlLength?: number
  clickableLimit?: number
}

export interface QueryElementsRequest extends ElementLocator, TargetPolicyRequest {
  limit?: number
  visibleOnly?: boolean
}

export interface WaitForElementRequest extends QueryElementsRequest {
  timeoutMs?: number
  pollIntervalMs?: number
}

export interface WaitForTextRequest extends TargetPolicyRequest {
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
  // Debug-only tab management commands are not exposed by default MCP tools/list.
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
  | 'browser_wait_for_url'

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
