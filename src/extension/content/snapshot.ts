import type { ClickableElement, ElementRect, PageSnapshot } from '../../types'
import type { SnapshotRequest } from '../shared/protocol'
import { registerElementRef, resetRefState } from './state'

const DEFAULT_TEXT_LENGTH = 6000
const DEFAULT_HTML_LENGTH = 30000
const DEFAULT_CLICKABLE_LIMIT = 500
const TEXT_SNIPPET_LIMIT = 120

const CLICKABLE_SELECTORS = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[contenteditable="true"]',
  '[tabindex]',
  '[onclick]',
]

type DetectReason = ClickableElement['detectedBy']

interface FrameContext {
  framePath?: string
  shadowDepth: number
  viewportOffsetTop: number
  viewportOffsetLeft: number
  documentOffsetTop: number
  documentOffsetLeft: number
}

interface WalkEntry extends FrameContext {
  element: Element
  view: Window
}

interface ClickableCandidate extends Omit<ClickableElement, 'ref'> {
  element: HTMLElement
}

function getViewForElement(el: Element): Window {
  return el.ownerDocument.defaultView ?? window
}

function toRect(top: number, left: number, width: number, height: number): ElementRect {
  return { top, left, width, height }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getElementLabel(el: Element): string {
  const input = el as HTMLInputElement
  const textarea = el as HTMLTextAreaElement
  const parts = [
    el.textContent ?? '',
    input.value ?? '',
    input.placeholder ?? '',
    textarea.placeholder ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
  ]

  return normalizeWhitespace(parts.filter(Boolean).join(' ')).slice(0, TEXT_SNIPPET_LIMIT)
}

export function deriveRole(el: Element): string | undefined {
  const explicitRole = el.getAttribute('role')
  if (explicitRole) return explicitRole

  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const input = el as HTMLInputElement
    if (input.type === 'checkbox') return 'checkbox'
    if (input.type === 'radio') return 'radio'
    if (['button', 'submit', 'reset'].includes(input.type)) return 'button'
    return 'textbox'
  }

  return undefined
}

export function normalizedElementText(el: Element): string {
  return [
    getElementLabel(el),
    (el as HTMLAnchorElement).href ?? '',
    el.getAttribute('name') ?? '',
    deriveRole(el) ?? '',
  ].join(' ').toLowerCase()
}

function hasAriaHiddenAncestor(el: Element): boolean {
  let node: Element | null = el

  while (node) {
    if (node.getAttribute('aria-hidden') === 'true') return true
    const root = node.getRootNode()
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
  }

  return false
}

function isVisibleInView(el: HTMLElement, view: Window): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = view.getComputedStyle(el)
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    style.pointerEvents !== 'none' &&
    !hasAriaHiddenAncestor(el)
  )
}

export function isVisible(el: HTMLElement): boolean {
  return isVisibleInView(el, getViewForElement(el))
}

function isFrameElement(el: Element): el is HTMLIFrameElement {
  return el.tagName.toLowerCase() === 'iframe'
}

function detectClickableReason(el: HTMLElement, view: Window): DetectReason | null {
  const structuralSelectors = CLICKABLE_SELECTORS.filter((selector) => selector !== '[tabindex]' && selector !== '[onclick]')
  if (structuralSelectors.some((selector) => el.matches(selector))) return 'selector'
  if (el.hasAttribute('tabindex')) return 'tabindex'
  if (el.hasAttribute('onclick')) return 'onclick'

  const style = view.getComputedStyle(el)
  const parentCursor = el.parentElement ? view.getComputedStyle(el.parentElement).cursor : ''
  if (style.cursor === 'pointer' && parentCursor !== 'pointer') {
    return 'cursor'
  }

  if (typeof el.onclick === 'function' || typeof el.onmousedown === 'function') {
    return 'onclick'
  }

  return null
}

function inViewport(rect: ElementRect): boolean {
  return rect.width > 0 &&
    rect.height > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth &&
    rect.top + rect.height > 0 &&
    rect.left + rect.width > 0
}

function walkDocument(view: Window, baseContext: FrameContext, visitor: (entry: WalkEntry) => void) {
  let nextFrameIndex = 0

  const walkContainer = (container: Document | ShadowRoot, context: FrameContext) => {
    for (const child of Array.from(container.children)) {
      walkElement(child, context)
    }
  }

  const walkElement = (element: Element, context: FrameContext) => {
    visitor({ element, view, ...context })

    for (const child of Array.from(element.children)) {
      walkElement(child, context)
    }

    if (element.shadowRoot) {
      walkContainer(element.shadowRoot, { ...context, shadowDepth: context.shadowDepth + 1 })
    }

    if (!isFrameElement(element)) return

    try {
      const childDocument = element.contentDocument
      const childWindow = element.contentWindow
      if (!childDocument || !childWindow) return

      const frameIndex = nextFrameIndex++
      const frameRect = element.getBoundingClientRect()
      const framePath = context.framePath ? `${context.framePath}.${frameIndex}` : String(frameIndex)
      walkDocument(childWindow, {
        framePath,
        shadowDepth: 0,
        viewportOffsetTop: context.viewportOffsetTop + frameRect.top,
        viewportOffsetLeft: context.viewportOffsetLeft + frameRect.left,
        documentOffsetTop: context.documentOffsetTop + frameRect.top + view.scrollY,
        documentOffsetLeft: context.documentOffsetLeft + frameRect.left + view.scrollX,
      }, visitor)
    } catch {
      // Cross-origin iframes are intentionally skipped in read-only MVP mode.
    }
  }

  walkContainer(view.document, baseContext)
}

export function queryDeepElements(selector: string): Element[] {
  const matches: Element[] = []
  walkDocument(window, {
    shadowDepth: 0,
    viewportOffsetTop: 0,
    viewportOffsetLeft: 0,
    documentOffsetTop: 0,
    documentOffsetLeft: 0,
  }, ({ element }) => {
    if (element.matches(selector)) {
      matches.push(element)
    }
  })

  return matches
}

function collectClickableCandidates(): ClickableCandidate[] {
  const candidates: ClickableCandidate[] = []

  walkDocument(window, {
    shadowDepth: 0,
    viewportOffsetTop: 0,
    viewportOffsetLeft: 0,
    documentOffsetTop: 0,
    documentOffsetLeft: 0,
  }, ({ element, view, framePath, shadowDepth, viewportOffsetTop, viewportOffsetLeft, documentOffsetTop, documentOffsetLeft }) => {
    if (!(element instanceof HTMLElement)) return
    if (!isVisibleInView(element, view)) return

    const detectedBy = detectClickableReason(element, view)
    if (!detectedBy) return

    const rect = element.getBoundingClientRect()
    const viewport = toRect(
      viewportOffsetTop + rect.top,
      viewportOffsetLeft + rect.left,
      rect.width,
      rect.height,
    )
    const documentRect = toRect(
      documentOffsetTop + rect.top + view.scrollY,
      documentOffsetLeft + rect.left + view.scrollX,
      rect.width,
      rect.height,
    )

    candidates.push({
      element,
      tag: element.tagName.toLowerCase(),
      role: deriveRole(element),
      text: getElementLabel(element),
      ariaLabel: element.getAttribute('aria-label') ?? undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      name: element.getAttribute('name') ?? undefined,
      type: element instanceof HTMLInputElement ? element.type : undefined,
      viewport,
      document: documentRect,
      inViewport: inViewport(viewport),
      framePath,
      shadowDepth: shadowDepth > 0 ? shadowDepth : undefined,
      detectedBy,
    })
  })

  candidates.sort((left, right) => {
    if (left.inViewport !== right.inViewport) return left.inViewport ? -1 : 1
    if (left.viewport.top !== right.viewport.top) return left.viewport.top - right.viewport.top
    if (left.viewport.left !== right.viewport.left) return left.viewport.left - right.viewport.left
    return left.tag.localeCompare(right.tag)
  })

  return candidates
}

export function collectClickableElements(limit = DEFAULT_CLICKABLE_LIMIT): ClickableElement[] {
  const candidates = collectClickableCandidates().slice(0, limit)
  resetRefState()

  return candidates.map(({ element, ...candidate }) => ({
    ref: registerElementRef(element),
    ...candidate,
  }))
}

export function buildSnapshot(req: SnapshotRequest = {}): PageSnapshot {
  const textLength = req.maxTextLength ?? DEFAULT_TEXT_LENGTH
  const htmlLength = req.maxHtmlLength ?? DEFAULT_HTML_LENGTH
  const clickableLimit = req.clickableLimit ?? DEFAULT_CLICKABLE_LIMIT

  return {
    url: location.href,
    title: document.title,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
    clickables: collectClickableElements(clickableLimit),
    text: req.includeText ? (document.body?.innerText ?? '').slice(0, textLength) : undefined,
    html: req.includeHtml ? document.documentElement.outerHTML.slice(0, htmlLength) : undefined,
  }
}

export function buildSnapshotSummary(snapshot: PageSnapshot) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    clickableCount: snapshot.clickables.length,
  }
}
