import type { A11ySnapshot, ConsoleMessageRecord, InteractiveElement, PageSnapshot } from '../../types'

export const NATIVE_HOST_NAME = 'com.vyodels.browser_mcp'

export interface ElementLocator {
  ref?: string
  frameRef?: string
  selector?: string
  text?: string
  role?: string
  index?: number
}

export interface PagingRequest {
  cursor?: number
  limit?: number
}

export interface SnapshotRequest {
  frameRef?: string
  includeHtml?: boolean
  textOffset?: number
  maxTextLength?: number
  htmlOffset?: number
  maxHtmlLength?: number
  interactiveLimit?: number
}

export interface A11ySnapshotRequest extends ElementLocator {
  maxNodes?: number
  maxDepth?: number
  includeHidden?: boolean
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
  | 'double_click'
  | 'hover'
  | 'fill'
  | 'clear'
  | 'select'
  | 'press'
  | 'scroll'
  | 'scroll_element'
  | 'wait'
  | 'navigate'
  | 'focus'
  | 'blur'
  | 'screenshot'
  | 'upload_file'

export interface UploadedFilePayload {
  name: string
  type?: string
  lastModified?: number
  contentBase64: string
}

export interface BrowserActionRequest extends ElementLocator {
  action: BrowserActionName
  value?: string
  values?: string[]
  key?: string
  url?: string
  direction?: 'up' | 'down'
  pixels?: number
  ms?: number
  files?: UploadedFilePayload[]
  fullPage?: boolean
  format?: 'png' | 'jpeg' | 'webp'
  quality?: number
  filename?: string
  allowDangerousAction?: boolean
  fallbackMode?: 'conservative' | 'aggressive'
}

export interface InteractionRiskInfo {
  level: 'high'
  kind: 'one_click_side_effect'
  reason: string
  targetText?: string
}

export interface FillFormField extends ElementLocator {
  value?: string
  values?: string[]
  clear?: boolean
}

export interface FillFormRequest {
  frameRef?: string
  elements: FillFormField[]
}

export interface DragRequest {
  from: ElementLocator
  to: ElementLocator
}

export interface EvaluateRequest extends ElementLocator {
  expression?: string
  function?: string
  args?: unknown[]
}

export interface RunCodeRequest {
  frameRef?: string
  code: string
  args?: unknown[]
}

export interface FramesRequest {
  includeMainFrame?: boolean
}

export interface ConsoleMessagesRequest extends PagingRequest {
  levels?: Array<'log' | 'info' | 'warn' | 'error' | 'debug'>
  text?: string
}

export interface NetworkRequestsRequest extends PagingRequest {
  filter?: string
  isRegex?: boolean
  resourceTypes?: string[]
  statuses?: number[]
  methods?: string[]
  includeRequestHeaders?: boolean
  includeResponseHeaders?: boolean
  includeRequestBody?: boolean
  includeResponseBody?: boolean
}

export interface GetNetworkRequestRequest {
  requestId: string
  includeRequestHeaders?: boolean
  includeResponseHeaders?: boolean
  includeRequestBody?: boolean
  includeResponseBody?: boolean
}

export interface WaitForNetworkEventRequest {
  pattern?: string
  isRegex?: boolean
  method?: string
  resourceType?: string
  status?: number
  timeoutMs?: number
}

export interface WaitForDownloadRequest {
  urlPattern?: string
  filenamePattern?: string
  isRegex?: boolean
  timeoutMs?: number
}

export interface BrowserCookieListRequest {
  url?: string
  domain?: string
  name?: string
}

export interface BrowserCookieSetRequest {
  url: string
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: chrome.cookies.SameSiteStatus
  expirationDate?: number
}

export interface BrowserCookieDeleteRequest {
  url?: string
  domain?: string
  name: string
  path?: string
}

export interface BrowserCookieClearRequest {
  url?: string
  domain?: string
}

export interface SnapshotSummary {
  url: string
  title: string
  interactiveCount: number
  textLength?: number
  htmlLength?: number
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
  filename?: string
  downloadId?: number
  error?: string
  risk?: InteractionRiskInfo
  requiresExplicitApproval?: boolean
}

export interface FillFormResponse {
  success: boolean
  fields: Array<{
    success: boolean
    locator: ElementLocator
    target?: {
      ref?: string
      tag?: string
      text?: string
    }
    error?: string
  }>
  snapshotSummary: SnapshotSummary
  error?: string
}

export interface ConsoleMessagesResponse {
  success: boolean
  installed: boolean
  captureMode?: string
  limitations?: string[]
  pageInfo: {
    cursor: number
    limit: number
    returned: number
    total: number
    hasMore: boolean
    nextCursor?: number
  }
  summary: {
    total: number
    levels: Record<string, number>
  }
  messages: ConsoleMessageRecord[]
  error?: string
}

export interface A11ySnapshotResponse {
  success: boolean
  snapshot: A11ySnapshot
  error?: string
}

export type BrowserCommandName =
  | 'browser_tabs'
  | 'browser_navigate'
  | 'browser_navigate_back'
  | 'browser_navigate_forward'
  | 'browser_reload'
  | 'browser_snapshot'
  | 'browser_frames'
  | 'browser_query_elements'
  | 'browser_get_element'
  | 'browser_debug_dom'
  | 'browser_click'
  | 'browser_hover'
  | 'browser_type'
  | 'browser_select_option'
  | 'browser_press_key'
  | 'browser_scroll'
  | 'browser_wait_for'
  | 'browser_evaluate'
  | 'browser_run_code'
  | 'browser_cookie_list'
  | 'browser_cookie_set'
  | 'browser_cookie_delete'
  | 'browser_cookie_clear'
  | 'browser_wait_for_url'
  | 'browser_wait_for_request'
  | 'browser_wait_for_response'
  | 'browser_wait_for_download'
  | 'browser_handle_dialog'
  | 'browser_take_screenshot'
  | 'browser_console_messages'
  | 'browser_network_requests'
  | 'browser_get_network_request'
  | 'browser_file_upload'
  | 'browser_drag'
  | 'browser_fill_form'
  | 'browser_resize'
  | 'browser_emulate'
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
