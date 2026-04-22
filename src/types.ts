// ============================================================
// types.ts — runtime-only shared types
// ============================================================

export type MessageType =
  | 'CONTENT_SCRIPT_READY'
  | 'DEBUG_DOM'
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

export interface SnapshotViewport {
  innerWidth: number
  innerHeight: number
  scrollX: number
  scrollY: number
  devicePixelRatio: number
}

export interface SnapshotDocument {
  scrollWidth: number
  scrollHeight: number
}

export interface ElementRect {
  top: number
  left: number
  width: number
  height: number
}

export interface PageSnapshot {
  url: string
  title: string
  viewport: SnapshotViewport
  document: SnapshotDocument
  clickables: ClickableElement[]
  text?: string
  html?: string
}

export interface ClickableElement {
  ref: string
  tag: string
  role?: string
  text: string
  ariaLabel?: string
  href?: string
  name?: string
  type?: string
  viewport: ElementRect
  document: ElementRect
  inViewport: boolean
  framePath?: string
  shadowDepth?: number
  detectedBy: 'selector' | 'cursor' | 'tabindex' | 'onclick'
}
