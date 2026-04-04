import type { InteractiveElement } from '../../types'
import type { ElementLocator, QueryElementsRequest } from '../shared/protocol'
import { buildSnapshot, isVisible } from './snapshot'
import { getElementByRef } from './state'

function deriveRole(el: Element): string | undefined {
  const explicitRole = el.getAttribute('role')
  if (explicitRole) return explicitRole

  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'input') {
    const input = el as HTMLInputElement
    if (input.type === 'checkbox') return 'checkbox'
    if (input.type === 'radio') return 'radio'
    return 'textbox'
  }
  if (tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  return undefined
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

function matchesLocator(el: Element, locator: QueryElementsRequest): boolean {
  if (locator.visibleOnly !== false && el instanceof HTMLElement && !isVisible(el)) return false
  if (locator.role && deriveRole(el) !== locator.role) return false

  if (locator.text) {
    const haystack = normalizedText(el)
    if (!haystack.includes(locator.text.trim().toLowerCase())) return false
  }

  return true
}

export function queryElements(locator: QueryElementsRequest): InteractiveElement[] {
  if (locator.ref) {
    buildSnapshot()
    const direct = getElementByRef(locator.ref)
    if (!direct || !matchesLocator(direct, locator)) return []
    return buildSnapshot().interactiveElements.filter((item) => item.ref === locator.ref).slice(0, 1)
  }

  if (locator.selector) {
    return queryElementsBySource(Array.from(document.querySelectorAll(locator.selector)), locator)
  }

  return queryElementsBySource(Array.from(document.querySelectorAll('*')), locator)
}

function queryElementsBySource(source: Element[], locator: QueryElementsRequest): InteractiveElement[] {
  const snapshot = buildSnapshot()
  const byRef = new Map(snapshot.interactiveElements.map((item) => [item.ref, item]))
  const limit = locator.limit ?? 20
  const matches: InteractiveElement[] = []

  for (const el of source) {
    if (!(el instanceof HTMLElement)) continue
    if (!matchesLocator(el, locator)) continue

    const match = snapshot.interactiveElements.find((item) => byRef.get(item.ref) && (
      (item.href && item.href === (el as HTMLAnchorElement).href) ||
      item.text === (el.textContent ?? '').trim().slice(0, 120) ||
      item.placeholder === (el as HTMLInputElement).placeholder
    ))

    if (match) {
      matches.push(match)
    }

    if (matches.length >= limit) break
  }

  return matches
}

export function resolveLocator(locator: ElementLocator): Element {
  if (locator.ref) {
    const el = getElementByRef(locator.ref)
    if (el) return el
    buildSnapshot()
    const retried = getElementByRef(locator.ref)
    if (retried) return retried
    throw new Error(`找不到元素 ${locator.ref}，请重新获取页面快照`)
  }

  if (locator.selector) {
    const nodes = Array.from(document.querySelectorAll(locator.selector))
    const picked = pickByIndex(nodes, locator.index)
    if (picked) return picked
    throw new Error(`找不到 selector=${locator.selector} 对应元素`)
  }

  const text = locator.text?.trim().toLowerCase()
  const all = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (!(el instanceof HTMLElement) || !isVisible(el)) return false
    if (locator.role && deriveRole(el) !== locator.role) return false
    if (!text) return true
    return normalizedText(el).includes(text)
  })

  const picked = pickByIndex(all, locator.index)
  if (picked) return picked

  throw new Error('找不到符合定位条件的元素')
}

function pickByIndex(source: Element[], index = 0): Element | null {
  if (index < 0 || index >= source.length) return null
  return source[index] ?? null
}

