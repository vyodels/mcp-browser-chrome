import type { ClickableElement } from '../../types'
import type { QueryElementsRequest } from '../shared/protocol'
import { buildSnapshot, deriveRole, isVisible, normalizedElementText, queryDeepElements } from './snapshot'
import { getElementByRef } from './state'

function matchesLocator(el: Element, locator: QueryElementsRequest): boolean {
  if (locator.visibleOnly !== false && el instanceof HTMLElement && !isVisible(el)) return false
  if (locator.role && deriveRole(el) !== locator.role) return false

  if (locator.text) {
    const haystack = normalizedElementText(el)
    if (!haystack.includes(locator.text.trim().toLowerCase())) return false
  }

  return true
}

function applyIndexAndLimit(matches: ClickableElement[], locator: QueryElementsRequest): ClickableElement[] {
  const indexed = locator.index === undefined ? matches : (matches[locator.index] ? [matches[locator.index]!] : [])
  return indexed.slice(0, locator.limit ?? 20)
}

export function queryElements(locator: QueryElementsRequest): ClickableElement[] {
  const snapshot = buildSnapshot()
  const clickableByElement = new Map<Element, ClickableElement>()

  for (const item of snapshot.clickables) {
    const element = getElementByRef(item.ref)
    if (element) clickableByElement.set(element, item)
  }

  if (locator.ref) {
    const direct = getElementByRef(locator.ref)
    if (!direct || !matchesLocator(direct, locator)) return []
    const match = snapshot.clickables.find((item) => item.ref === locator.ref)
    return match ? [match] : []
  }

  const source = locator.selector
    ? queryDeepElements(locator.selector)
    : Array.from(clickableByElement.keys())

  const matches: ClickableElement[] = []
  const seen = new Set<string>()

  for (const el of source) {
    if (!matchesLocator(el, locator)) continue
    const match = clickableByElement.get(el)
    if (!match || seen.has(match.ref)) continue

    matches.push(match)
    seen.add(match.ref)
  }

  return applyIndexAndLimit(matches, locator)
}
