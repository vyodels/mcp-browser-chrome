import type { InteractiveElement, PageSnapshot } from '../../types'
import type { SnapshotRequest } from '../shared/protocol'
import { registerElementRef, resetRefState } from './state'

const DEFAULT_TEXT_LENGTH = 6000
const DEFAULT_HTML_LENGTH = 30000
const DEFAULT_INTERACTIVE_LIMIT = 200

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

export function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

export function collectInteractiveElements(limit = DEFAULT_INTERACTIVE_LIMIT): InteractiveElement[] {
  resetRefState()

  const interactive: InteractiveElement[] = []
  document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTORS.join(',')).forEach((el) => {
    if (interactive.length >= limit || !isVisible(el)) return

    const ref = registerElementRef(el)
    const rect = el.getBoundingClientRect()
    interactive.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type,
      text: (el.textContent ?? '').trim().slice(0, 120),
      placeholder: (el as HTMLInputElement).placeholder,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      href: (el as HTMLAnchorElement).href,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    })
  })

  return interactive
}

export function buildSnapshot(req: SnapshotRequest = {}): PageSnapshot {
  const textLength = req.maxTextLength ?? DEFAULT_TEXT_LENGTH
  const htmlLength = req.maxHtmlLength ?? DEFAULT_HTML_LENGTH
  const interactiveLimit = req.interactiveLimit ?? DEFAULT_INTERACTIVE_LIMIT

  return {
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, textLength),
    interactiveElements: collectInteractiveElements(interactiveLimit),
    html: req.includeHtml ? document.documentElement.outerHTML.slice(0, htmlLength) : undefined,
  }
}

export function buildSnapshotSummary(snapshot: PageSnapshot) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    interactiveCount: snapshot.interactiveElements.length,
  }
}

