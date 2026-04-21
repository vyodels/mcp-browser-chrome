import type { A11yNode, A11ySnapshot, InteractiveElement, PageSnapshot } from '../../types'
import type { A11ySnapshotRequest, SnapshotRequest } from '../shared/protocol'
import { sliceText } from '../shared/ai'
import { absoluteClientRect, findElementLocation, listFrames, queryAllElements } from './dom'
import { getElementByRef, getFrameByRef, registerElementRef, resetRefState } from './state'

const DEFAULT_TEXT_LENGTH = 6000
const DEFAULT_HTML_LENGTH = 30000
const DEFAULT_INTERACTIVE_LIMIT = 200
const DEFAULT_A11Y_MAX_NODES = 220
const DEFAULT_A11Y_MAX_DEPTH = 12

function normalizeFrameRef(frameRef?: string): string | undefined {
  return frameRef === 'main' ? '@main' : frameRef
}

type FrameScope = {
  frameRef?: string
  documentNode: Document
}

function resolveFrameScope(frameRef?: string): FrameScope {
  const normalizedFrameRef = normalizeFrameRef(frameRef)
  if (!normalizedFrameRef) {
    return { frameRef: undefined, documentNode: document }
  }

  if (normalizedFrameRef !== '@main') {
    listFrames(true)
  }

  const documentNode = getFrameByRef(normalizedFrameRef)
  if (!documentNode) {
    throw new Error(`找不到 frameRef=${normalizedFrameRef} 对应的 frame，请先重新获取 frames`)
  }

  return {
    frameRef: normalizedFrameRef,
    documentNode,
  }
}

function resolveElementRefInFrame(ref: string, frameRef?: string): Element | null {
  const element = getElementByRef(ref)
  if (!element) return null
  if (!frameRef) return element

  const location = findElementLocation(element)
  if (frameRef === '@main') {
    return location?.frameRef ? null : element
  }

  return location?.frameRef === frameRef ? element : null
}

const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
]

export function deriveRole(el: Element): string | undefined {
  const explicitRole = el.getAttribute('role')
  if (explicitRole) return explicitRole

  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'summary') return 'button'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  if (tag === 'input') {
    const input = el as HTMLInputElement
    if (input.type === 'checkbox') return 'checkbox'
    if (input.type === 'radio') return 'radio'
    if (input.type === 'range') return 'slider'
    return 'textbox'
  }
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'main') return 'main'
  if (tag === 'nav') return 'navigation'
  if (tag === 'section') return 'region'
  if (tag === 'form') return 'form'
  if (tag === 'img') return 'img'
  if (tag === 'li') return 'listitem'
  if (tag === 'ul' || tag === 'ol') return 'list'
  return undefined
}

export function accessibleName(el: Element): string {
  const toText = (value: unknown) => {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
    return ''
  }

  const direct = [
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    (el as HTMLInputElement).placeholder,
    (el as HTMLInputElement).value,
    el.textContent,
  ].map(toText).find((value) => value.trim())
  return (direct ?? '').replace(/\s+/g, ' ').trim()
}

export function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false

  const rect = absoluteClientRect(el)
  if (rect.width > 0 && rect.height > 0) return true

  const clientRects = Array.from(el.getClientRects())
  if (clientRects.some((clientRect) => clientRect.width > 0 || clientRect.height > 0)) {
    return true
  }

  if (el.offsetWidth > 0 || el.offsetHeight > 0) return true

  return !!accessibleName(el)
}

export function collectInteractiveElements(limit = DEFAULT_INTERACTIVE_LIMIT, frameRef?: string): { all: InteractiveElement[]; sliced: InteractiveElement[] } {
  resetRefState()

  const interactive: InteractiveElement[] = []

  for (const { element, framePath, frameRef: elementFrameRef } of queryAllElements(INTERACTIVE_SELECTORS.join(','), { frameRef })) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) continue

    const ref = registerElementRef(element)
    const rect = absoluteClientRect(element)
    interactive.push({
      ref,
      tag: element.tagName.toLowerCase(),
      role: deriveRole(element),
      type: (element as HTMLInputElement).type,
      text: (element.textContent ?? '').trim().slice(0, 120),
      name: accessibleName(element).slice(0, 120),
      placeholder: (element as HTMLInputElement).placeholder,
      ariaLabel: element.getAttribute('aria-label') ?? undefined,
      href: (element as HTMLAnchorElement).href,
      frameRef: elementFrameRef,
      framePath,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    })
  }

  return {
    all: interactive,
    sliced: interactive.slice(0, limit),
  }
}

export function buildSnapshot(req: SnapshotRequest = {}): PageSnapshot {
  const frameScope = resolveFrameScope(req.frameRef)
  const rootDocument = frameScope.documentNode
  const bodyText = rootDocument.body?.innerText ?? ''
  const htmlSource = rootDocument.documentElement?.outerHTML ?? ''
  const textSlice = sliceText(bodyText, req.textOffset ?? 0, req.maxTextLength, DEFAULT_TEXT_LENGTH, 20_000)
  const htmlSlice = req.includeHtml
    ? sliceText(htmlSource, req.htmlOffset ?? 0, req.maxHtmlLength, DEFAULT_HTML_LENGTH, 80_000)
    : null
  const interactiveLimit = req.interactiveLimit ?? DEFAULT_INTERACTIVE_LIMIT
  const interactive = collectInteractiveElements(interactiveLimit, frameScope.frameRef)

  return {
    url: rootDocument.location?.href ?? location.href,
    title: rootDocument.title || document.title,
    text: textSlice.content,
    textInfo: textSlice.info,
    interactiveElements: interactive.sliced,
    interactiveInfo: {
      total: interactive.all.length,
      limit: interactiveLimit,
      returned: interactive.sliced.length,
      truncated: interactive.all.length > interactive.sliced.length,
    },
    html: htmlSlice?.content,
    htmlInfo: htmlSlice?.info,
    summary: {
      mode: 'dom',
      url: rootDocument.location?.href ?? location.href,
      title: rootDocument.title || document.title,
      interactiveCount: interactive.all.length,
      textLength: textSlice.info.totalLength,
      htmlLength: htmlSlice?.info.totalLength,
      textTruncated: textSlice.info.truncated,
      htmlTruncated: htmlSlice?.info.truncated ?? false,
    },
  }
}

export function buildSnapshotSummary(snapshot: PageSnapshot) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    interactiveCount: snapshot.interactiveInfo?.total ?? snapshot.interactiveElements.length,
    textLength: snapshot.textInfo?.totalLength ?? snapshot.text.length,
    htmlLength: snapshot.htmlInfo?.totalLength,
  }
}

function isA11yRelevant(element: Element, includeHidden: boolean) {
  if (!(element instanceof HTMLElement)) return false
  if (!includeHidden && !isVisible(element)) return false
  if (deriveRole(element)) return true
  if ((element.textContent ?? '').replace(/\s+/g, ' ').trim()) return true
  return false
}

function buildA11yNode(
  element: Element,
  ctx: {
    includeHidden: boolean
    maxDepth: number
    maxNodes: number
    currentDepth: number
    nodeCount: number
    lines: string[]
  }
): A11yNode | null {
  if (!(element instanceof HTMLElement)) return null
  if (!isA11yRelevant(element, ctx.includeHidden)) return null
  if (ctx.currentDepth > ctx.maxDepth) return null
  if (ctx.nodeCount >= ctx.maxNodes) return null

  ctx.nodeCount += 1
  const role = deriveRole(element) ?? 'text'
  const name = accessibleName(element)
  const ref = registerElementRef(element)
  const tag = element.tagName.toLowerCase()
  const node: A11yNode = {
    id: ref,
    role,
    name: name || undefined,
    ref,
    href: (element as HTMLAnchorElement).href || undefined,
    level: /^h([1-6])$/.test(tag) ? Number(tag.slice(1)) : undefined,
    checked: element.getAttribute('aria-checked') === 'mixed'
      ? 'mixed'
      : element.getAttribute('aria-checked') === 'true'
        ? true
        : element.getAttribute('aria-checked') === 'false'
          ? false
          : undefined,
    selected: element.getAttribute('aria-selected') === 'true' ? true : undefined,
    expanded: element.getAttribute('aria-expanded') === 'true' ? true : undefined,
    disabled: (element as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true' ? true : undefined,
    pressed: element.getAttribute('aria-pressed') === 'true' ? true : undefined,
    value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value || undefined
      : undefined,
  }

  const summaryParts = [`- ${role}`]
  if (name) summaryParts.push(`"${name}"`)
  if (node.level) summaryParts.push(`[level=${node.level}]`)
  if (ref) summaryParts.push(`[ref=${ref}]`)
  ctx.lines.push(summaryParts.join(' '))

  const children: A11yNode[] = []
  const childElements = Array.from(element.children)
  for (const child of childElements) {
    if (ctx.nodeCount >= ctx.maxNodes) break
    const childNode = buildA11yNode(child, {
      ...ctx,
      currentDepth: ctx.currentDepth + 1,
    })
    if (childNode) children.push(childNode)
  }

  if (children.length > 0) node.children = children
  if (childElements.length > children.length) node.omittedChildren = childElements.length - children.length

  return node
}

function resolveSnapshotRoot(req: A11ySnapshotRequest, frameScope: FrameScope): Element | null {
  if (req.ref) {
    buildSnapshot(frameScope.frameRef ? { frameRef: frameScope.frameRef } : {})
    return resolveElementRefInFrame(req.ref, frameScope.frameRef)
  }
  if (req.selector) {
    return frameScope.documentNode.querySelector(req.selector)
  }
  if (req.text || req.role) {
    for (const { element } of queryAllElements('*', { frameRef: frameScope.frameRef })) {
      if (!(element instanceof HTMLElement)) continue
      if (req.role && deriveRole(element) !== req.role) continue
      if (req.text && !accessibleName(element).toLowerCase().includes(req.text.toLowerCase())) continue
      return element
    }
  }
  return frameScope.documentNode.body ?? frameScope.documentNode.documentElement
}

export function buildA11ySnapshot(req: A11ySnapshotRequest = {}): A11ySnapshot {
  resetRefState()
  const includeHidden = req.includeHidden === true
  const maxNodes = req.maxNodes ?? DEFAULT_A11Y_MAX_NODES
  const maxDepth = req.maxDepth ?? DEFAULT_A11Y_MAX_DEPTH
  const frameScope = resolveFrameScope(req.frameRef)
  const rootElement = resolveSnapshotRoot(req, frameScope)
    ?? frameScope.documentNode.body
    ?? frameScope.documentNode.documentElement
    ?? document.body

  const lines: string[] = []
  const ctx = {
    includeHidden,
    maxDepth,
    maxNodes,
    currentDepth: 0,
    nodeCount: 0,
    lines,
  }
  const rootNode = buildA11yNode(rootElement, ctx) ?? {
    id: '@document',
    role: 'document',
    name: frameScope.documentNode.title || document.title,
  }

  return {
    url: frameScope.documentNode.location?.href ?? location.href,
    title: frameScope.documentNode.title || document.title,
    tree: {
      id: '@document',
      role: 'document',
      name: frameScope.documentNode.title || document.title,
      children: [rootNode],
    },
    lines,
    summary: {
      role: 'document',
      nodeCount: ctx.nodeCount,
      returnedNodeCount: ctx.nodeCount,
      maxNodes,
      maxDepth,
      truncated: ctx.nodeCount >= maxNodes,
    },
  }
}

export function buildFrameSnapshot(includeMainFrame = true) {
  return {
    success: true,
    frames: listFrames(includeMainFrame),
  }
}
