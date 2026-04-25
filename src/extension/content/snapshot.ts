import type { ClickableElement, ClickablePoint, ElementPoint, ElementRect, InaccessibleFrameRegion, PageSnapshot } from '../../types'
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
type HitTestState = NonNullable<ClickableElement['hitTestState']>
type ClickPoint = ClickablePoint

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

interface FrameEntry extends FrameContext {
  element: HTMLIFrameElement
  view: Window
  framePath: string
}

interface ClickableCandidate extends Omit<ClickableElement, 'ref'> {
  element: HTMLElement
}

type InaccessibleFrameCandidate = InaccessibleFrameRegion

const HIT_TEST_MAX_GRID = 6
const HIT_TEST_MIN_CELL_SIZE = 40
const LANDING_ZONE_INSET_RATIO = 0.3

function computeCssPath(el: Element): string {
  const segments: string[] = []
  let node: Element | null = el
  while (node && segments.length < 8) {
    const current: Element = node
    const parent: HTMLElement | null = current.parentElement
    const tag = current.tagName.toLowerCase()
    if (!parent) {
      segments.unshift(tag)
      break
    }
    const siblings: Element[] = []
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children.item(i)
      if (child && child.tagName === current.tagName) siblings.push(child)
    }
    segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag)
    node = parent
  }
  return segments.join('>')
}

function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0xcbf29ce4 >>> 0
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x01000193) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.slice(0, 16)
}

function computeElementSignature(el: Element, host: string): string {
  return fnv1a64(`${host}|${deriveRole(el) ?? ''}|${getElementText(el).slice(0, 40)}|${computeCssPath(el)}`)
}

function getViewForElement(el: Element): Window {
  return el.ownerDocument.defaultView ?? window
}

function asElement(value: unknown): Element | null {
  return value && typeof value === 'object' && (value as Node).nodeType === Node.ELEMENT_NODE
    ? value as Element
    : null
}

function getShadowHost(root: Node): Element | null {
  return asElement((root as ShadowRoot).host)
}

function getFrameContentOffset(frame: HTMLIFrameElement): { top: number; left: number } {
  const rect = frame.getBoundingClientRect()
  return {
    top: rect.top + frame.clientTop,
    left: rect.left + frame.clientLeft,
  }
}

function getComposedParent(el: Element): Element | null {
  const root = el.getRootNode()
  const frameElement = el.ownerDocument.defaultView?.frameElement
  return asElement((el as Element & { assignedSlot?: Element | null }).assignedSlot)
    ?? el.parentElement
    ?? getShadowHost(root)
    ?? asElement(frameElement)
}

function isSameHitTarget(root: Element, candidate: Element | null): boolean {
  let node = candidate
  while (node) {
    if (node === root) return true
    node = getComposedParent(node)
  }

  node = root
  while (node) {
    if (node === candidate) return true
    node = getComposedParent(node)
  }

  return false
}

function deepElementFromPoint(view: Window, x: number, y: number): Element | null {
  let currentView = view
  let pointX = x
  let pointY = y

  while (true) {
    const element = currentView.document.elementFromPoint(pointX, pointY)
    if (!element) return null
    if (!isFrameElement(element)) return element

    try {
      const childWindow = element.contentWindow
      if (!childWindow) return element
      const { top, left } = getFrameContentOffset(element)
      currentView = childWindow
      pointX -= left
      pointY -= top
    } catch {
      return element
    }
  }
}

function intersectRects(left: ElementRect, right: ElementRect): ElementRect | undefined {
  const top = Math.max(left.top, right.top)
  const leftEdge = Math.max(left.left, right.left)
  const bottom = Math.min(left.top + left.height, right.top + right.height)
  const rightEdge = Math.min(left.left + left.width, right.left + right.width)
  const width = rightEdge - leftEdge
  const height = bottom - top
  if (width <= 0 || height <= 0) return undefined
  return toRect(top, leftEdge, width, height)
}

function insetRect(rect: ElementRect): ElementRect {
  const insetX = Math.max(0, Math.min(rect.width / 2 - 1, Math.max(1, rect.width * LANDING_ZONE_INSET_RATIO)))
  const insetY = Math.max(0, Math.min(rect.height / 2 - 1, Math.max(1, rect.height * LANDING_ZONE_INSET_RATIO)))
  const width = Math.max(1, rect.width - insetX * 2)
  const height = Math.max(1, rect.height - insetY * 2)
  return toRect(rect.top + insetY, rect.left + insetX, width, height)
}

function getViewportBounds(): ElementRect {
  return toRect(0, 0, window.innerWidth, window.innerHeight)
}

function randomBetween(min: number, max: number): number {
  if (max <= min) return min
  return min + Math.random() * (max - min)
}

function toPoint(x: number, y: number): ElementPoint {
  return { x, y }
}

function buildSafeRects(
  hitCells: ElementRect[],
  hitCount: number,
): ElementRect[] | undefined {
  if (hitCount === 0) return undefined

  return hitCells.map((cell) => insetRect(cell))
}

function buildClickPoint(
  el: HTMLElement,
  hitCells: ElementRect[],
  safeRects: ElementRect[] | undefined,
  viewport: ElementRect,
  documentRect: ElementRect,
): ClickPoint | undefined {
  const documentTopOffset = documentRect.top - viewport.top
  const documentLeftOffset = documentRect.left - viewport.left
  const zones = safeRects ?? []
  if (!zones.length && !hitCells.length) return undefined

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const selected = zones[Math.floor(Math.random() * zones.length)] ?? zones[0]
    if (!selected) break

    const viewportX = randomBetween(selected.left, selected.left + selected.width)
    const viewportY = randomBetween(selected.top, selected.top + selected.height)
    const candidate = deepElementFromPoint(window, viewportX, viewportY)
    if (candidate && isSameHitTarget(el, candidate)) {
      return {
        viewport: toPoint(viewportX, viewportY),
        document: toPoint(viewportX + documentLeftOffset, viewportY + documentTopOffset),
      }
    }
  }

  for (const cell of hitCells) {
    const viewportX = cell.left + cell.width / 2
    const viewportY = cell.top + cell.height / 2
    const candidate = deepElementFromPoint(window, viewportX, viewportY)
    if (candidate && isSameHitTarget(el, candidate)) {
      return {
        viewport: toPoint(viewportX, viewportY),
        document: toPoint(viewportX + documentLeftOffset, viewportY + documentTopOffset),
      }
    }
  }

  return undefined
}

function computeHitTestMetadata(
  el: HTMLElement,
  viewport: ElementRect,
  documentRect: ElementRect,
): { hitTestState?: HitTestState; clickPoint?: ClickPoint } {
  if (!inViewport(viewport)) return {}

  const visibleViewport = intersectRects(viewport, getViewportBounds())
  if (!visibleViewport) return {}

  const columns = Math.max(1, Math.min(HIT_TEST_MAX_GRID, Math.ceil(visibleViewport.width / HIT_TEST_MIN_CELL_SIZE)))
  const rows = Math.max(1, Math.min(HIT_TEST_MAX_GRID, Math.ceil(visibleViewport.height / HIT_TEST_MIN_CELL_SIZE)))
  const hitCells: ElementRect[] = []
  let sampleCount = 0

  for (let row = 0; row < rows; row += 1) {
    const top = visibleViewport.top + visibleViewport.height * row / rows
    const bottom = visibleViewport.top + visibleViewport.height * (row + 1) / rows
    for (let column = 0; column < columns; column += 1) {
      const left = visibleViewport.left + visibleViewport.width * column / columns
      const right = visibleViewport.left + visibleViewport.width * (column + 1) / columns
      const cell = toRect(top, left, right - left, bottom - top)
      const candidate = deepElementFromPoint(window, left + cell.width / 2, top + cell.height / 2)
      sampleCount += 1
      if (candidate && isSameHitTarget(el, candidate)) hitCells.push(cell)
    }
  }

  if (sampleCount === 0) return {}

  const hitCount = hitCells.length
  const safeRects = buildSafeRects(hitCells, hitCount)
  return {
    hitTestState: hitCount === 0 ? 'covered' : (hitCount === sampleCount ? 'top' : 'partial'),
    clickPoint: buildClickPoint(el, hitCells, safeRects, viewport, documentRect),
  }
}

function toRect(top: number, left: number, width: number, height: number): ElementRect {
  return { top, left, width, height }
}

function parseBooleanAttribute(value: string | null): boolean | undefined {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function isButtonLikeInput(input: HTMLInputElement): boolean {
  return ['button', 'submit', 'reset'].includes(input.type)
}

function isValueBearingInput(input: HTMLInputElement): boolean {
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'password', 'hidden', 'image'].includes(input.type)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getElementText(el: Element): string {
  const input = el as HTMLInputElement
  const parts = [
    el.textContent ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
  ]

  if (el.tagName.toLowerCase() === 'input' && isButtonLikeInput(input)) {
    parts.unshift(input.value ?? '')
  }

  return normalizeWhitespace(parts.filter(Boolean).join(' ')).slice(0, TEXT_SNIPPET_LIMIT)
}

function getElementValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') {
    return (el as HTMLTextAreaElement).value
  }
  if (tag === 'select') {
    return (el as HTMLSelectElement).value
  }
  if (tag === 'input') {
    const input = el as HTMLInputElement
    if (!isValueBearingInput(input)) return undefined
    return input.value
  }
  return undefined
}

function getElementPlaceholder(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase()
  if (tag === 'input') {
    return (el as HTMLInputElement).placeholder || undefined
  }
  if (tag === 'textarea') {
    return (el as HTMLTextAreaElement).placeholder || undefined
  }
  return undefined
}

function getElementState(el: HTMLElement) {
  const ariaDisabled = parseBooleanAttribute(el.getAttribute('aria-disabled'))
  const ariaReadonly = parseBooleanAttribute(el.getAttribute('aria-readonly'))
  const ariaChecked = parseBooleanAttribute(el.getAttribute('aria-checked'))
  const ariaSelected = parseBooleanAttribute(el.getAttribute('aria-selected'))
  const ariaExpanded = parseBooleanAttribute(el.getAttribute('aria-expanded'))
  const tag = el.tagName.toLowerCase()

  let readonly = ariaReadonly
  let checked = ariaChecked
  let selected = ariaSelected

  if (tag === 'input') {
    const input = el as HTMLInputElement
    if (readonly === undefined && isValueBearingInput(input)) readonly = input.readOnly
    if (checked === undefined && ['checkbox', 'radio'].includes(input.type)) checked = input.checked
  } else if (tag === 'textarea') {
    if (readonly === undefined) readonly = (el as HTMLTextAreaElement).readOnly
  } else if (tag === 'option') {
    if (selected === undefined) selected = (el as HTMLOptionElement).selected
  }

  return {
    value: getElementValue(el),
    placeholder: getElementPlaceholder(el),
    disabled: ariaDisabled ?? el.matches(':disabled'),
    readonly,
    checked,
    selected,
    expanded: ariaExpanded,
    focused: el.matches(':focus'),
  }
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
    getElementText(el),
    getElementValue(el) ?? '',
    getElementPlaceholder(el) ?? '',
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

function resolveFrameUrl(frame: HTMLIFrameElement, view: Window): URL | undefined {
  const src = frame.getAttribute('src')
  if (!src || src === 'about:blank') return undefined
  try {
    return new URL(src, view.location.href)
  } catch {
    return undefined
  }
}

function isCrossOriginFrame(frame: HTMLIFrameElement, view: Window): boolean {
  const url = resolveFrameUrl(frame, view)
  return !!url && url.origin !== window.location.origin
}

function buildInaccessibleFrame(
  frame: HTMLIFrameElement,
  view: Window,
  context: FrameContext,
  framePath: string,
): InaccessibleFrameCandidate {
  const rect = frame.getBoundingClientRect()
  const viewport = toRect(
    context.viewportOffsetTop + rect.top,
    context.viewportOffsetLeft + rect.left,
    rect.width,
    rect.height,
  )
  const documentRect = toRect(
    context.documentOffsetTop + rect.top + view.scrollY,
    context.documentOffsetLeft + rect.left + view.scrollX,
    rect.width,
    rect.height,
  )
  const frameUrl = resolveFrameUrl(frame, view)
  return {
    framePath,
    reason: 'cross_origin',
    host: frameUrl?.host,
    name: frame.getAttribute('name') || undefined,
    title: frame.getAttribute('title') || undefined,
    viewport,
    document: documentRect,
    inViewport: inViewport(viewport),
  }
}

function walkDocument(
  view: Window,
  baseContext: FrameContext,
  visitor: (entry: WalkEntry) => void,
  onInaccessibleFrame?: (entry: FrameEntry) => void,
) {
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

    const frameIndex = nextFrameIndex++
    const frameOffset = getFrameContentOffset(element)
    const framePath = context.framePath ? `${context.framePath}.${frameIndex}` : String(frameIndex)

    if (isCrossOriginFrame(element, view)) {
      onInaccessibleFrame?.({ element, view, ...context, framePath })
      return
    }

    try {
      const childDocument = element.contentDocument
      const childWindow = element.contentWindow
      if (!childDocument || !childWindow) return

      walkDocument(childWindow, {
        framePath,
        shadowDepth: 0,
        viewportOffsetTop: context.viewportOffsetTop + frameOffset.top,
        viewportOffsetLeft: context.viewportOffsetLeft + frameOffset.left,
        documentOffsetTop: context.documentOffsetTop + frameOffset.top + view.scrollY,
        documentOffsetLeft: context.documentOffsetLeft + frameOffset.left + view.scrollX,
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

function sortByViewportPosition<T extends { inViewport: boolean; viewport: ElementRect }>(items: T[]) {
  items.sort((left, right) => {
    if (left.inViewport !== right.inViewport) return left.inViewport ? -1 : 1
    if (left.viewport.top !== right.viewport.top) return left.viewport.top - right.viewport.top
    if (left.viewport.left !== right.viewport.left) return left.viewport.left - right.viewport.left
    return 0
  })
}

function collectSnapshotArtifacts(limit = DEFAULT_CLICKABLE_LIMIT): {
  clickables: ClickableElement[]
  inaccessibleFrames: InaccessibleFrameRegion[]
} {
  const candidates: ClickableCandidate[] = []
  const inaccessibleFrames: InaccessibleFrameCandidate[] = []
  const host = window.location.host

  walkDocument(window, {
    shadowDepth: 0,
    viewportOffsetTop: 0,
    viewportOffsetLeft: 0,
    documentOffsetTop: 0,
    documentOffsetLeft: 0,
  }, ({ element, view, framePath, shadowDepth, viewportOffsetTop, viewportOffsetLeft, documentOffsetTop, documentOffsetLeft }) => {
    if (!(element instanceof (view as Window & typeof globalThis).HTMLElement)) return
    const htmlElement = element as HTMLElement
    if (!isVisibleInView(htmlElement, view)) return

    const detectedBy = detectClickableReason(htmlElement, view)
    if (!detectedBy) return

    const rect = htmlElement.getBoundingClientRect()
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
    const { hitTestState, clickPoint } = computeHitTestMetadata(htmlElement, viewport, documentRect)
    const state = getElementState(htmlElement)

    candidates.push({
      element: htmlElement,
      signature: computeElementSignature(htmlElement, host),
      hitTestState,
      clickPoint,
      tag: htmlElement.tagName.toLowerCase(),
      role: deriveRole(htmlElement),
      text: getElementText(htmlElement),
      value: state.value,
      placeholder: state.placeholder,
      ariaLabel: htmlElement.getAttribute('aria-label') ?? undefined,
      href: htmlElement.tagName.toLowerCase() === 'a' ? (htmlElement as HTMLAnchorElement).href : undefined,
      download: htmlElement.tagName.toLowerCase() === 'a' ? ((htmlElement as HTMLAnchorElement).download || undefined) : undefined,
      name: htmlElement.getAttribute('name') ?? undefined,
      type: htmlElement.tagName.toLowerCase() === 'input' ? (htmlElement as HTMLInputElement).type : undefined,
      accept: htmlElement.tagName.toLowerCase() === 'input' ? ((htmlElement as HTMLInputElement).accept || undefined) : undefined,
      multiple: htmlElement.tagName.toLowerCase() === 'input' ? (htmlElement as HTMLInputElement).multiple : undefined,
      disabled: state.disabled,
      readonly: state.readonly,
      checked: state.checked,
      selected: state.selected,
      expanded: state.expanded,
      focused: state.focused,
      viewport,
      document: documentRect,
      inViewport: inViewport(viewport),
      framePath,
      shadowDepth: shadowDepth > 0 ? shadowDepth : undefined,
      detectedBy,
    })
  }, ({ element, view, framePath, viewportOffsetTop, viewportOffsetLeft, documentOffsetTop, documentOffsetLeft }) => {
    inaccessibleFrames.push(buildInaccessibleFrame(element, view, {
      viewportOffsetTop,
      viewportOffsetLeft,
      documentOffsetTop,
      documentOffsetLeft,
      shadowDepth: 0,
    }, framePath))
  })

  candidates.sort((left, right) => {
    if (left.inViewport !== right.inViewport) return left.inViewport ? -1 : 1
    const hitTestPriority: Record<string, number> = { top: 0, partial: 1, covered: 2, undefined: 3 }
    const leftPriority = hitTestPriority[left.hitTestState ?? 'undefined']
    const rightPriority = hitTestPriority[right.hitTestState ?? 'undefined']
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    if (left.viewport.top !== right.viewport.top) return left.viewport.top - right.viewport.top
    if (left.viewport.left !== right.viewport.left) return left.viewport.left - right.viewport.left
    return left.tag.localeCompare(right.tag)
  })

  sortByViewportPosition(inaccessibleFrames)
  resetRefState()
  return {
    clickables: candidates.slice(0, limit).map(({ element, ...candidate }) => ({
      ref: registerElementRef(element),
      ...candidate,
    })),
    inaccessibleFrames,
  }
}

export function buildSnapshot(req: SnapshotRequest = {}): PageSnapshot {
  const textLength = req.maxTextLength ?? DEFAULT_TEXT_LENGTH
  const htmlLength = req.maxHtmlLength ?? DEFAULT_HTML_LENGTH
  const clickableLimit = req.clickableLimit ?? DEFAULT_CLICKABLE_LIMIT
  const { clickables, inaccessibleFrames } = collectSnapshotArtifacts(clickableLimit)

  return {
    url: location.href,
    title: document.title,
    viewport: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
      screenX: window.screenX,
      screenY: window.screenY,
      visualViewport: window.visualViewport
        ? {
            scale: window.visualViewport.scale,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : undefined,
    },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
    clickables,
    inaccessibleFrames,
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
