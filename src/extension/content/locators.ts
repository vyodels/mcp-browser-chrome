import type { InteractiveElement } from '../../types'
import type { ElementLocator, QueryElementsRequest } from '../shared/protocol'
import { absoluteClientRect, findElementLocation, listFrames, queryAllElements } from './dom'
import { accessibleName, buildSnapshot, deriveRole, isVisible } from './snapshot'
import { getElementByRef, getFrameByRef, registerElementRef } from './state'

type LocatedElement = {
  element: Element
  framePath: string[]
  frameRef?: string
}

type TextMatchCandidate = {
  item: LocatedElement
  element: HTMLElement
  domOrder: number
}

export type TextMatchSortSignal = {
  exactAccessibleName: boolean
  exactTextContent: boolean
  hasMatchingDescendant: boolean
  isLowQualityRoot: boolean
  isInteractive: boolean
  isSemantic: boolean
  haystackLength: number
  area: number
  domOrder: number
}

const LOW_QUALITY_TEXT_TAGS = new Set(['html', 'body'])
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'label', 'option', 'select', 'summary', 'textarea'])
const SEMANTIC_TAGS = new Set([
  'a',
  'article',
  'aside',
  'button',
  'caption',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'legend',
  'li',
  'main',
  'nav',
  'option',
  'section',
  'summary',
])

function normalizeFrameRef(frameRef?: string): string | undefined {
  return frameRef === 'main' ? '@main' : frameRef
}

function resolveRequestedFrameRef(frameRef?: string): string | undefined {
  const normalizedFrameRef = normalizeFrameRef(frameRef)
  if (!normalizedFrameRef || normalizedFrameRef === '@main') {
    return normalizedFrameRef
  }

  listFrames(true)
  if (!getFrameByRef(normalizedFrameRef)) {
    throw new Error(`找不到 frameRef=${normalizedFrameRef} 对应的 frame，请先重新获取 frames`)
  }

  return normalizedFrameRef
}

function matchesFrameRef(actualFrameRef: string | undefined, requestedFrameRef?: string): boolean {
  if (!requestedFrameRef) return true
  if (requestedFrameRef === '@main') return !actualFrameRef
  return actualFrameRef === requestedFrameRef
}

function normalizedText(el: Element): string {
  const textBits = [
    el.textContent ?? '',
    (el as HTMLInputElement).value ?? '',
    (el as HTMLInputElement).placeholder ?? '',
    el.getAttribute('aria-label') ?? '',
    (el as HTMLAnchorElement).href ?? '',
  ]
  return textBits.join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizedTextContent(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizedNeedle(text?: string): string | undefined {
  const next = text?.trim().toLowerCase()
  return next ? next : undefined
}

function matchesLocator(el: Element, locator: QueryElementsRequest): boolean {
  if (locator.visibleOnly !== false && el instanceof HTMLElement && !isVisible(el)) return false
  if (locator.role && deriveRole(el) !== locator.role) return false

  const needle = normalizedNeedle(locator.text)
  if (needle) {
    const haystack = normalizedText(el)
    if (!haystack.includes(needle)) return false
  }

  return true
}

function isInteractiveElement(el: HTMLElement, role?: string): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true
  return ['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'switch', 'tab', 'textbox'].includes(role ?? '')
}

function isSemanticElement(el: HTMLElement, role?: string): boolean {
  if (role) return true
  return SEMANTIC_TAGS.has(el.tagName.toLowerCase())
}

function hasMatchingVisibleDescendant(el: HTMLElement, locator: QueryElementsRequest, needle?: string): boolean {
  if (!needle) return false

  for (const descendant of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
    if (!isVisible(descendant)) continue
    if (locator.role && deriveRole(descendant) !== locator.role) continue
    if (!normalizedText(descendant).includes(needle)) continue
    return true
  }

  return false
}

function buildTextMatchSortSignal(candidate: TextMatchCandidate, locator: QueryElementsRequest): TextMatchSortSignal {
  const needle = normalizedNeedle(locator.text)
  const role = deriveRole(candidate.element)
  const accessible = accessibleName(candidate.element).replace(/\s+/g, ' ').trim().toLowerCase()
  const textContent = normalizedTextContent(candidate.element)
  const haystack = normalizedText(candidate.element)
  const rect = absoluteClientRect(candidate.element)
  const area = Math.max(0, rect.width) * Math.max(0, rect.height)

  return {
    exactAccessibleName: Boolean(needle) && accessible === needle,
    exactTextContent: Boolean(needle) && textContent === needle,
    hasMatchingDescendant: hasMatchingVisibleDescendant(candidate.element, locator, needle),
    isLowQualityRoot: LOW_QUALITY_TEXT_TAGS.has(candidate.element.tagName.toLowerCase()),
    isInteractive: isInteractiveElement(candidate.element, role),
    isSemantic: isSemanticElement(candidate.element, role),
    haystackLength: haystack.length,
    area: Number.isFinite(area) ? area : Number.MAX_SAFE_INTEGER,
    domOrder: candidate.domOrder,
  }
}

export function compareTextMatchSignals(a: TextMatchSortSignal, b: TextMatchSortSignal): number {
  if (a.exactAccessibleName !== b.exactAccessibleName) return a.exactAccessibleName ? -1 : 1
  if (a.exactTextContent !== b.exactTextContent) return a.exactTextContent ? -1 : 1
  if (a.hasMatchingDescendant !== b.hasMatchingDescendant) return a.hasMatchingDescendant ? 1 : -1
  if (a.isLowQualityRoot !== b.isLowQualityRoot) return a.isLowQualityRoot ? 1 : -1
  if (a.isInteractive !== b.isInteractive) return a.isInteractive ? -1 : 1
  if (a.isSemantic !== b.isSemantic) return a.isSemantic ? -1 : 1
  if (a.haystackLength !== b.haystackLength) return a.haystackLength - b.haystackLength
  if (a.area !== b.area) return a.area - b.area
  return a.domOrder - b.domOrder
}

function sortTextMatchCandidates(candidates: TextMatchCandidate[], locator: QueryElementsRequest): TextMatchCandidate[] {
  if (!normalizedNeedle(locator.text)) return candidates

  return candidates
    .map((candidate) => ({
      candidate,
      signal: buildTextMatchSortSignal(candidate, locator),
    }))
    .sort((left, right) => compareTextMatchSignals(left.signal, right.signal))
    .map((entry) => entry.candidate)
}

function ensureElementRef(element: HTMLElement): string {
  return registerElementRef(element)
}

function synthesizeInteractiveElement(item: LocatedElement): InteractiveElement {
  const element = item.element as HTMLElement
  const ref = ensureElementRef(element)
  const rect = absoluteClientRect(element)
  return {
    ref,
    tag: element.tagName.toLowerCase(),
    role: deriveRole(element),
    type: (element as HTMLInputElement).type,
    text: (element.textContent ?? '').trim().slice(0, 120),
    name: accessibleName(element).slice(0, 120),
    placeholder: (element as HTMLInputElement).placeholder,
    ariaLabel: element.getAttribute('aria-label') ?? undefined,
    href: (element as HTMLAnchorElement).href || undefined,
    frameRef: item.frameRef,
    framePath: item.framePath,
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
  }
}

function interactiveMatchesSnapshot(snapshotMatches: InteractiveElement[], element: Element) {
  return snapshotMatches.find((item) => getElementByRef(item.ref) === element)
    ?? snapshotMatches.find((item) => (
      item.href && item.href === (element as HTMLAnchorElement).href
    ))
    ?? snapshotMatches.find((item) => (
      item.text === (element.textContent ?? '').trim().slice(0, 120) &&
      item.tag === element.tagName.toLowerCase()
    ))
    ?? null
}

function findLocatedElementByRef(ref: string, frameRef?: string): LocatedElement | null {
  const direct = getElementByRef(ref)
  if (!direct) return null

  const location = findElementLocation(direct)
  if (!location || !matchesFrameRef(location.frameRef, frameRef)) {
    return null
  }

  return {
    element: direct,
    framePath: location.framePath,
    frameRef: location.frameRef,
  }
}

function queryInteractiveSnapshotElements(locator: QueryElementsRequest, snapshot: ReturnType<typeof buildSnapshot>): InteractiveElement[] {
  const matches: InteractiveElement[] = []
  const limit = locator.limit ?? 20
  const frameRef = normalizeFrameRef(locator.frameRef)
  const selector = locator.selector?.trim()

  if (!selector) return matches

  for (const item of snapshot.interactiveElements) {
    const located = findLocatedElementByRef(item.ref, frameRef)
    const element = located?.element
    if (!(element instanceof HTMLElement)) continue
    if (!element.matches(selector)) continue
    if (!matchesLocator(element, locator)) continue

    const match = synthesizeInteractiveElement({
      element,
      framePath: located?.framePath ?? item.framePath ?? [],
      frameRef: located?.frameRef ?? item.frameRef,
    })
    if (!matches.some((candidate) => candidate.ref === match.ref)) {
      matches.push(match)
    }
    if (matches.length >= limit) break
  }

  return matches
}

export function queryElements(locator: QueryElementsRequest): InteractiveElement[] {
  const frameRef = resolveRequestedFrameRef(locator.frameRef)

  if (locator.ref) {
    buildSnapshot({ frameRef })
    const located = findLocatedElementByRef(locator.ref, frameRef)

    if (!located || !matchesLocator(located.element, locator)) return []
    return [synthesizeInteractiveElement(located)]
  }

  if (locator.selector) {
    const snapshot = buildSnapshot({ frameRef })
    const directMatches = queryElementsBySource(queryAllElements(locator.selector, { frameRef }), { ...locator, frameRef }, snapshot)
    if (directMatches.length > 0) return directMatches
    return queryInteractiveSnapshotElements({ ...locator, frameRef }, snapshot)
  }

  const snapshot = buildSnapshot({ frameRef })
  return queryElementsBySource(queryAllElements('*', { frameRef }), { ...locator, frameRef }, snapshot)
}

function queryElementsBySource(
  source: LocatedElement[],
  locator: QueryElementsRequest,
  snapshot: ReturnType<typeof buildSnapshot>,
): InteractiveElement[] {
  const limit = locator.limit ?? 20
  const matches: Array<{ candidate: TextMatchCandidate; match: InteractiveElement }> = []
  let domOrder = 0
  const shouldRankTextMatches = Boolean(normalizedNeedle(locator.text))

  for (const item of source) {
    const element = item.element
    if (!(element instanceof HTMLElement)) continue
    if (!matchesLocator(element, locator)) continue

    const match = interactiveMatchesSnapshot(snapshot.interactiveElements, element) ?? synthesizeInteractiveElement(item)
    if (!matches.some((candidate) => candidate.match.ref === match.ref)) {
      matches.push({
        candidate: { item, element, domOrder },
        match,
      })
      domOrder += 1
    }

    if (!shouldRankTextMatches && matches.length >= limit) break
  }

  const ordered = shouldRankTextMatches
    ? sortTextMatchCandidates(matches.map((entry) => entry.candidate), locator)
    : matches.map((entry) => entry.candidate)
  const matchByOrder = new Map(matches.map((entry) => [entry.candidate.domOrder, entry.match]))

  return ordered
    .slice(0, limit)
    .map((candidate) => matchByOrder.get(candidate.domOrder))
    .filter((match): match is InteractiveElement => Boolean(match))
}

export function resolveLocator(locator: ElementLocator): Element {
  const frameRef = resolveRequestedFrameRef(locator.frameRef)

  if (locator.ref) {
    const el = findLocatedElementByRef(locator.ref, frameRef)?.element
    if (el) return el
    buildSnapshot({ frameRef })
    const retried = findLocatedElementByRef(locator.ref, frameRef)?.element
    if (retried) return retried
    throw new Error(`找不到元素 ${locator.ref}，请重新获取页面快照`)
  }

  if (locator.selector) {
    const nodes = queryAllElements(locator.selector, { frameRef })
    const picked = pickByIndex(nodes, locator.index)
    if (picked) return picked.element
    const snapshotMatches = queryInteractiveSnapshotElements(
      {
        selector: locator.selector,
        index: locator.index,
        limit: (locator.index ?? 0) + 1,
        visibleOnly: true,
        frameRef,
      },
      buildSnapshot({ frameRef }),
    )
    const snapshotPicked = pickByIndex(snapshotMatches, locator.index)
    if (snapshotPicked) {
      const resolved = findLocatedElementByRef(snapshotPicked.ref, frameRef)?.element
      if (resolved) return resolved
    }
    throw new Error(`找不到 selector=${locator.selector} 对应元素`)
  }

  const text = locator.text?.trim().toLowerCase()
  const all = queryAllElements('*', { frameRef })
    .filter((item) => {
      const el = item.element
      if (!(el instanceof HTMLElement) || !isVisible(el)) return false
      if (locator.role && deriveRole(el) !== locator.role) return false
      if (!text) return true
      return normalizedText(el).includes(text)
    })

  const ranked = text
    ? sortTextMatchCandidates(
      all
        .filter((item): item is LocatedElement & { element: HTMLElement } => item.element instanceof HTMLElement)
        .map((item, domOrder) => ({
          item,
          element: item.element,
          domOrder,
        })),
      { ...locator, frameRef },
    ).map((candidate) => candidate.item)
    : all

  const picked = pickByIndex(ranked, locator.index)
  if (picked) return picked.element

  throw new Error('找不到符合定位条件的元素')
}

function pickByIndex<T>(source: T[], index = 0): T | null {
  if (index < 0 || index >= source.length) return null
  return source[index] ?? null
}
