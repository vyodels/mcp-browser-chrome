import type { ActionResult, AgentAction } from '../../types'
import type {
  BrowserActionRequest,
  BrowserActionResponse,
  DragRequest,
  EvaluateRequest,
  FillFormField,
  FillFormResponse,
  InteractionRiskInfo,
  RunCodeRequest,
  UploadedFilePayload,
} from '../shared/protocol'
import { randomDelay, throttleAction } from '../../rateLimit'
import { safeSerialize } from '../shared/ai'
import { absoluteClientRect } from './dom'
import { queryElements, resolveLocator } from './locators'
import { buildSnapshot, buildSnapshotSummary, isVisible } from './snapshot'
import { normalizeFrameRef } from './state'

function targetInfo(el: Element, ref?: string) {
  return {
    ref,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim().slice(0, 120),
  }
}

type InteractionPoint = {
  view: Window
  clientX: number
  clientY: number
  screenX: number
  screenY: number
}

type InteractionTarget = {
  point: InteractionPoint
  eventTarget: Element
  activationTarget: Element
}

type ClickAttempt = {
  target: Element
  mode: 'resolved_target' | 'direct_root' | 'direct_ancestor'
}

type ClickObservation = {
  changed: boolean
  reason?: string
}

const HIGH_RISK_CLICK_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /打招呼|继续沟通|立即沟通|发消息|发送(?:消息|简历|联系方式)?|立即发送/u,
    reason: '该动作可能直接发起站内沟通或发送消息',
  },
  {
    pattern: /求简历|索要简历|发送简历|索要联系方式|换电话|换微信|获取电话|获取微信/u,
    reason: '该动作可能直接请求简历或联系方式',
  },
]

function interactionLabel(el: Element) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return [
      el.value,
      el.placeholder,
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('title') ?? '',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  }

  return [
    (el.textContent ?? ''),
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function detectHighRiskClickAction(el: Element): InteractionRiskInfo | undefined {
  const label = interactionLabel(el)
  if (!label) return undefined

  for (const rule of HIGH_RISK_CLICK_RULES) {
    if (rule.pattern.test(label)) {
      return {
        level: 'high',
        kind: 'one_click_side_effect',
        reason: rule.reason,
        targetText: label,
      }
    }
  }

  return undefined
}

function createInteractionPointForRatio(el: Element, xRatio: number, yRatio: number): InteractionPoint {
  const rect = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView ?? window
  const width = rect.width > 1 ? rect.width : 1
  const height = rect.height > 1 ? rect.height : 1
  const clientX = rect.left + width * xRatio
  const clientY = rect.top + height * yRatio

  return {
    view,
    clientX,
    clientY,
    screenX: clientX + (view.screenX ?? 0),
    screenY: clientY + (view.screenY ?? 0),
  }
}

function createInteractionPoint(el: Element): InteractionPoint {
  return createInteractionPointForRatio(
    el,
    0.3 + Math.random() * 0.4,
    0.3 + Math.random() * 0.4,
  )
}

function isNativeActivatableElement(el: Element) {
  return el instanceof HTMLAnchorElement
    || el instanceof HTMLButtonElement
    || el instanceof HTMLInputElement
    || el instanceof HTMLLabelElement
    || el instanceof HTMLOptionElement
    || (el instanceof HTMLElement && el.tagName.toLowerCase() === 'summary')
}

function hasJavascriptLikeHref(el: Element) {
  if (!(el instanceof HTMLAnchorElement)) return false
  const href = (el.getAttribute('href') ?? '').trim().toLowerCase()
  return !href || href === '#' || href.startsWith('javascript:')
}

function shouldUseNativeClick(el: Element) {
  if (!isNativeActivatableElement(el)) return false
  if (hasJavascriptLikeHref(el)) return false
  return true
}

function findActivationTarget(root: Element, eventTarget: Element) {
  const activatable = eventTarget.closest('a[href],button,input,label,summary,option,[role="button"],[role="link"]')
  if (activatable && (activatable === root || root.contains(activatable))) {
    return activatable
  }
  return root
}

function findEventTargetAtPoint(root: Element, point: InteractionPoint): Element | null {
  const doc = root.ownerDocument
  const fromPoint = typeof doc.elementsFromPoint === 'function'
    ? doc.elementsFromPoint(point.clientX, point.clientY)
    : [doc.elementFromPoint(point.clientX, point.clientY)].filter((element): element is Element => Boolean(element))

  for (const candidate of fromPoint) {
    if (candidate === root || root.contains(candidate)) {
      return candidate
    }
  }

  return null
}

function resolveInteractionTarget(root: Element): InteractionTarget {
  const pointCandidates: Array<[number, number]> = [
    [0.5, 0.5],
    [0.35, 0.5],
    [0.65, 0.5],
    [0.5, 0.35],
    [0.5, 0.65],
  ]

  for (const [xRatio, yRatio] of pointCandidates) {
    const point = createInteractionPointForRatio(root, xRatio, yRatio)
    const eventTarget = findEventTargetAtPoint(root, point)
    if (!eventTarget) continue
    return {
      point,
      eventTarget,
      activationTarget: findActivationTarget(root, eventTarget),
    }
  }

  const point = createInteractionPoint(root)
  return {
    point,
    eventTarget: root,
    activationTarget: root,
  }
}

function createMouseLikeInit(point: InteractionPoint, options: { button?: number; buttons?: number; detail?: number } = {}): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: point.view,
    clientX: point.clientX,
    clientY: point.clientY,
    screenX: point.screenX,
    screenY: point.screenY,
    button: options.button ?? 0,
    buttons: options.buttons ?? 0,
    detail: options.detail ?? 0,
  }
}

function dispatchPointerEvent(el: Element, type: string, point: InteractionPoint, options: { button?: number; buttons?: number; detail?: number } = {}) {
  const init = createMouseLikeInit(point, options)
  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent(type, {
      ...init,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: (options.buttons ?? 0) === 0 ? 0 : 0.5,
    }))
    return
  }

  el.dispatchEvent(new MouseEvent(type, init))
}

function dispatchMouseEvent(el: Element, type: string, point: InteractionPoint, options: { button?: number; buttons?: number; detail?: number } = {}) {
  el.dispatchEvent(new MouseEvent(type, createMouseLikeInit(point, options)))
}

function findJavascriptHrefAnchor(...elements: Array<Element | null | undefined>) {
  for (const element of elements) {
    if (!element) continue
    const anchor = element.closest('a[href]')
    if (anchor && hasJavascriptLikeHref(anchor)) {
      return anchor
    }
  }
  return null
}

function dispatchSafeClickEvent(eventTarget: Element, activationTarget: Element, point: InteractionPoint, detail = 1) {
  const javascriptAnchor = findJavascriptHrefAnchor(eventTarget, activationTarget)
  if (javascriptAnchor) {
    javascriptAnchor.addEventListener('click', (event) => {
      event.preventDefault()
    }, { capture: true, once: true })
  }

  dispatchMouseEvent(eventTarget, 'click', point, { button: 0, buttons: 0, detail })
}

function dispatchHoverSequence(el: Element, point: InteractionPoint) {
  dispatchPointerEvent(el, 'pointerover', point)
  dispatchMouseEvent(el, 'mouseover', point)
  dispatchPointerEvent(el, 'pointermove', point)
  dispatchMouseEvent(el, 'mousemove', point)
}

async function dispatchPressSequence(el: Element, point: InteractionPoint, detail = 1) {
  dispatchPointerEvent(el, 'pointerdown', point, { button: 0, buttons: 1, detail })
  dispatchMouseEvent(el, 'mousedown', point, { button: 0, buttons: 1, detail })
  await randomDelay(18, 60)
  dispatchPointerEvent(el, 'pointerup', point, { button: 0, buttons: 0, detail })
  dispatchMouseEvent(el, 'mouseup', point, { button: 0, buttons: 0, detail })
}

function triggerClickFallback(target: InteractionTarget, detail = 1) {
  if (shouldUseNativeClick(target.activationTarget)) {
    ;(target.activationTarget as HTMLElement).click()
    return
  }

  dispatchSafeClickEvent(target.eventTarget, target.activationTarget, target.point, detail)
}

async function performResolvedTargetClick(el: Element, options: { clickCount?: number; includeHover?: boolean } = {}) {
  const clickCount = options.clickCount ?? 1
  await prepareForInteraction(el, { focus: false, scrollBehavior: 'auto' })
  const target = resolveInteractionTarget(el)

  if (options.includeHover !== false) {
    dispatchHoverSequence(target.eventTarget, target.point)
    await randomDelay(24, 90)
  }

  await dispatchPressSequence(target.eventTarget, target.point, clickCount)
  await randomDelay(12, 45)
  triggerClickFallback(target, clickCount)
  return target
}

async function performDirectElementClick(el: Element, options: { clickCount?: number; includeHover?: boolean } = {}) {
  const clickCount = options.clickCount ?? 1
  await prepareForInteraction(el, { focus: false, scrollBehavior: 'auto' })
  const point = createInteractionPointForRatio(el, 0.5, 0.5)

  if (options.includeHover !== false) {
    dispatchHoverSequence(el, point)
    await randomDelay(24, 90)
  }

  await dispatchPressSequence(el, point, clickCount)
  await randomDelay(12, 45)

  if (shouldUseNativeClick(el)) {
    ;(el as HTMLElement).click()
  } else {
    dispatchSafeClickEvent(el, el, point, clickCount)
  }

  return {
    point,
    eventTarget: el,
    activationTarget: el,
  }
}

function interactionScope(root: Element) {
  return root.closest('[data-id],[data-key],[data-index],[role="tab"],[role="option"],li,tr,[class*="item"],[class*="card"],[class*="row"],[class*="wrap"],[class*="wrapper"]')
    ?? root
}

function elementSignature(el: Element) {
  const rect = el.getBoundingClientRect()
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const className = el instanceof HTMLElement ? el.className : ''
  return [
    el.isConnected ? '1' : '0',
    className,
    el.getAttribute('aria-expanded') ?? '',
    el.getAttribute('aria-selected') ?? '',
    el.getAttribute('aria-pressed') ?? '',
    el.getAttribute('aria-current') ?? '',
    el.childElementCount,
    text,
    Math.round(rect.top),
    Math.round(rect.left),
    Math.round(rect.width),
    Math.round(rect.height),
  ].join('|')
}

function pageSignature(doc: Document, scope: Element) {
  return {
    href: doc.location?.href ?? '',
    title: doc.title,
    bodyTextLength: doc.body?.innerText.length ?? 0,
    bodyChildCount: doc.body?.childElementCount ?? 0,
    scope: elementSignature(scope),
  }
}

async function waitForClickObservation(scope: Element, timeoutMs = 1800): Promise<ClickObservation> {
  const doc = scope.ownerDocument
  const baseline = pageSignature(doc, scope)
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    await randomDelay(40, 70)
    const current = pageSignature(doc, scope)
    if (current.href !== baseline.href) return { changed: true, reason: 'url_changed' }
    if (current.title !== baseline.title) return { changed: true, reason: 'title_changed' }
    if (current.scope !== baseline.scope) return { changed: true, reason: 'scope_changed' }
    if (current.bodyTextLength !== baseline.bodyTextLength) return { changed: true, reason: 'body_text_changed' }
    if (current.bodyChildCount !== baseline.bodyChildCount) return { changed: true, reason: 'body_structure_changed' }
  }

  return { changed: false }
}

function classNameMatchesContainerHint(el: Element) {
  if (!(el instanceof HTMLElement)) return false
  return /(item|card|row|wrap|wrapper|title|entry|cell|tab|box|btn|button)/i.test(el.className)
}

function isExplicitActionTarget(el: Element) {
  if (isNativeActivatableElement(el)) return true
  const role = el.getAttribute('role') ?? ''
  return role === 'button' || role === 'link'
}

function isAncestorClickFallbackCandidate(candidate: Element, root: Element) {
  if (candidate === root || !(candidate instanceof HTMLElement)) return false
  if (!isVisible(candidate)) return false

  const tag = candidate.tagName.toLowerCase()
  const rect = candidate.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  const area = Math.max(0, rect.width) * Math.max(0, rect.height)
  const rootArea = Math.max(0, rootRect.width) * Math.max(0, rootRect.height)
  const role = candidate.getAttribute('role') ?? ''

  if (area <= 0) return false
  if (area < rootArea && !candidate.hasAttribute('data-id')) return false

  return candidate.hasAttribute('data-id')
    || candidate.hasAttribute('data-key')
    || candidate.hasAttribute('data-index')
    || candidate.hasAttribute('onclick')
    || tag === 'li'
    || tag === 'tr'
    || role === 'button'
    || role === 'link'
    || classNameMatchesContainerHint(candidate)
}

function collectClickAttempts(
  root: Element,
  resolvedTarget: InteractionTarget,
  options: { allowAggressiveFallback?: boolean } = {},
): ClickAttempt[] {
  const attempts: ClickAttempt[] = []
  const seen = new Set<Element>()

  const push = (target: Element, mode: ClickAttempt['mode']) => {
    if (seen.has(target)) return
    seen.add(target)
    attempts.push({ target, mode })
  }

  push(resolvedTarget.eventTarget, 'resolved_target')

  if (!options.allowAggressiveFallback) {
    return attempts
  }

  if (resolvedTarget.activationTarget !== resolvedTarget.eventTarget) {
    push(resolvedTarget.activationTarget, 'resolved_target')
  }

  push(root, 'direct_root')

  if (isExplicitActionTarget(root) || isExplicitActionTarget(resolvedTarget.activationTarget)) {
    return attempts
  }

  let current = root.parentElement
  let depth = 0
  while (current && depth < 5) {
    if (isAncestorClickFallbackCandidate(current, root)) {
      push(current, 'direct_ancestor')
    }
    current = current.parentElement
    depth += 1
  }

  return attempts
}

async function performSemanticClick(
  root: Element,
  options: { clickCount?: number; includeHover?: boolean; allowAggressiveFallback?: boolean } = {},
) {
  const resolvedTarget = await performResolvedTargetClick(root, options)
  const scope = interactionScope(root)
  let observation = await waitForClickObservation(scope)
  const attempts = collectClickAttempts(root, resolvedTarget, {
    allowAggressiveFallback: options.allowAggressiveFallback,
  })

  if (observation.changed) {
    return {
      target: resolvedTarget,
      observation,
      attemptedTargets: attempts.slice(0, 1),
    }
  }

  const completed: ClickAttempt[] = attempts.slice(0, 1)

  for (const attempt of attempts.slice(1)) {
    const shouldUseDirectClick = attempt.mode !== 'resolved_target'
      || attempt.target === root
      || hasJavascriptLikeHref(attempt.target)

    if (shouldUseDirectClick) {
      await performDirectElementClick(attempt.target, options)
    } else {
      await performResolvedTargetClick(attempt.target, options)
    }

    completed.push(attempt)
    observation = await waitForClickObservation(interactionScope(attempt.target))
    if (observation.changed) {
      return {
        target: resolvedTarget,
        observation,
        attemptedTargets: completed,
      }
    }
  }

  return {
    target: resolvedTarget,
    observation,
    attemptedTargets: completed,
  }
}

async function performSemanticDoubleClick(el: Element) {
  await prepareForInteraction(el, { focus: false, scrollBehavior: 'auto' })
  const target = resolveInteractionTarget(el)

  dispatchHoverSequence(target.eventTarget, target.point)
  await randomDelay(24, 90)
  await dispatchPressSequence(target.eventTarget, target.point, 1)
  await randomDelay(12, 40)
  triggerClickFallback(target, 1)
  await randomDelay(40, 110)
  await dispatchPressSequence(target.eventTarget, target.point, 2)
  await randomDelay(12, 40)
  triggerClickFallback(target, 2)
  dispatchMouseEvent(target.eventTarget, 'dblclick', target.point, { button: 0, buttons: 0, detail: 2 })
}

function emitInputEvent(el: HTMLElement, data: string | null, inputType: string) {
  try {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data,
      inputType,
    }))
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function focusElement(el: Element) {
  if (!(el instanceof HTMLElement)) return
  try {
    el.focus({ preventScroll: true })
  } catch {
    el.focus()
  }
}

function isReasonablyInViewport(el: Element) {
  const rect = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView ?? window
  return rect.bottom > 0
    && rect.right > 0
    && rect.top < view.innerHeight
    && rect.left < view.innerWidth
}

function scrollIntoViewIfNeeded(el: Element, behavior: ScrollBehavior = 'smooth') {
  if (!(el instanceof HTMLElement)) return
  if (isReasonablyInViewport(el)) return
  el.scrollIntoView({
    block: 'center',
    inline: 'center',
    behavior,
  })
}

async function prepareForInteraction(el: Element, options: { focus?: boolean; scrollBehavior?: ScrollBehavior } = {}) {
  await throttleAction()
  scrollIntoViewIfNeeded(el, options.scrollBehavior ?? 'smooth')
  await randomDelay(120, 280)
  if (options.focus !== false) {
    focusElement(el)
  }
}

function applyInputValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  descriptor?.set?.call(el, nextValue)
}

function setSelection(input: HTMLInputElement | HTMLTextAreaElement, start: number, end = start) {
  try {
    input.setSelectionRange(start, end)
  } catch {
    // Ignore non-text input types.
  }
}

function isWritableInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (!(el instanceof HTMLInputElement)) return false
  if (el.readOnly || el.disabled) return false
  return !['checkbox', 'radio', 'range', 'file', 'button', 'submit', 'reset'].includes(el.type)
}

function ensureWritableElement(el: Element) {
  const isEditable = el instanceof HTMLElement && el.isContentEditable
  if (!isEditable && !isWritableInput(el)) {
    throw new Error('目标元素不是可输入文本的输入框或可编辑区域')
  }
  return { isEditable }
}

function clearContentEditable(el: HTMLElement) {
  focusElement(el)
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  selection?.removeAllRanges()
  selection?.addRange(range)
  if (!document.execCommand('delete', false, undefined)) {
    range.deleteContents()
  }
  emitInputEvent(el, null, 'deleteContentBackward')
}

async function insertIntoContentEditable(el: HTMLElement, value: string) {
  clearContentEditable(el)
  for (const char of value) {
    if (!document.execCommand('insertText', false, char)) {
      document.execCommand('insertHTML', false, char)
    }
    emitInputEvent(el, char, 'insertText')
    await randomDelay(40, 130)
  }
}

function clearInputValue(input: HTMLInputElement | HTMLTextAreaElement) {
  applyInputValue(input, '')
  setSelection(input, 0)
  emitInputEvent(input, null, 'deleteContentBackward')
}

async function insertIntoInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  clearInputValue(input)
  for (const char of value) {
    const nextValue = `${input.value}${char}`
    applyInputValue(input, nextValue)
    setSelection(input, nextValue.length)
    emitInputEvent(input, char, 'insertText')
    await randomDelay(40, 130)
  }
}

async function fillElement(el: Element, value: string) {
  const { isEditable } = ensureWritableElement(el)
  await prepareForInteraction(el)

  if (isEditable) {
    await insertIntoContentEditable(el as HTMLElement, value)
    return
  }

  await insertIntoInput(el as HTMLInputElement | HTMLTextAreaElement, value)
}

async function clearElement(el: Element) {
  const { isEditable } = ensureWritableElement(el)
  await prepareForInteraction(el)

  if (isEditable) {
    clearContentEditable(el as HTMLElement)
    return
  }

  clearInputValue(el as HTMLInputElement | HTMLTextAreaElement)
}

function decodeBase64File(file: UploadedFilePayload): File {
  const binary = atob(file.contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], file.name, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified ?? Date.now(),
  })
}

function resolveFileInput(el: Element) {
  if (el instanceof HTMLInputElement && el.type === 'file') return el
  if (el instanceof HTMLElement) {
    const nested = el.querySelector('input[type="file"]')
    if (nested instanceof HTMLInputElement) return nested
  }
  throw new Error('目标元素不是 file input，也不包含 file input')
}

async function uploadFiles(el: Element, files: UploadedFilePayload[]) {
  await prepareForInteraction(el)
  const input = resolveFileInput(el)
  const dt = new DataTransfer()
  for (const file of files) dt.items.add(decodeBase64File(file))
  input.files = dt.files
  emitInputEvent(input, null, 'insertFromPaste')
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function performScreenshot(action: BrowserActionRequest) {
  const targetRect = action.ref || action.selector || action.text || action.role
    ? absoluteClientRect(resolveLocator(action))
    : undefined
  const pageMetrics = {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0
    ),
    scrollHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0
    ),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio || 1,
  }
  const resp = await new Promise<{ success: boolean; dataUrl?: string; error?: string; filename?: string; downloadId?: number }>(
    (resolve) => chrome.runtime.sendMessage({
      type: 'TAKE_SCREENSHOT',
      payload: {
        targetRect: targetRect ? {
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height,
        } : undefined,
        fullPage: action.fullPage === true,
        format: action.format,
        quality: action.quality,
        filename: action.filename,
        pageMetrics,
      },
    }, resolve)
  )
  if (!resp?.success) throw new Error(resp?.error ?? '截图失败')
  return resp
}

function listTabbableElements(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter((element) => {
    if (element.hidden) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

function advanceFocus(backward = false) {
  const active = document.activeElement as HTMLElement | null
  const tabbables = listTabbableElements(document)
  if (tabbables.length === 0) return false
  const currentIndex = active ? tabbables.indexOf(active) : -1
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + (backward ? -1 : 1) + tabbables.length) % tabbables.length
  focusElement(tabbables[nextIndex]!)
  return true
}

function insertPrintableChar(key: string) {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? active.value.length
    const end = active.selectionEnd ?? start
    const nextValue = `${active.value.slice(0, start)}${key}${active.value.slice(end)}`
    applyInputValue(active, nextValue)
    setSelection(active, start + key.length)
    emitInputEvent(active, key, 'insertText')
    return true
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    document.execCommand('insertText', false, key)
    emitInputEvent(active, key, 'insertText')
    return true
  }
  return false
}

function deleteFromActive(mode: 'backspace' | 'delete') {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? active.value.length
    const end = active.selectionEnd ?? start
    if (start !== end) {
      const nextValue = `${active.value.slice(0, start)}${active.value.slice(end)}`
      applyInputValue(active, nextValue)
      setSelection(active, start)
    } else if (mode === 'backspace' && start > 0) {
      const nextValue = `${active.value.slice(0, start - 1)}${active.value.slice(end)}`
      applyInputValue(active, nextValue)
      setSelection(active, start - 1)
    } else if (mode === 'delete' && start < active.value.length) {
      const nextValue = `${active.value.slice(0, start)}${active.value.slice(start + 1)}`
      applyInputValue(active, nextValue)
      setSelection(active, start)
    }
    emitInputEvent(active, null, mode === 'backspace' ? 'deleteContentBackward' : 'deleteContentForward')
    return true
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    document.execCommand(mode === 'backspace' ? 'delete' : 'forwardDelete', false, undefined)
    emitInputEvent(active, null, mode === 'backspace' ? 'deleteContentBackward' : 'deleteContentForward')
    return true
  }
  return false
}

function submitOrInsertLine() {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement) {
    insertPrintableChar('\n')
    return true
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    document.execCommand('insertLineBreak', false, undefined)
    emitInputEvent(active, '\n', 'insertLineBreak')
    return true
  }
  if (active instanceof HTMLInputElement && active.form) {
    active.form.requestSubmit()
    return true
  }
  if (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement) {
    active.click()
    return true
  }
  return false
}

function dispatchKeyboardFallback(key: string) {
  const active = document.activeElement
  if (!active) return false
  active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  active.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  return true
}

async function pressKey(key: string) {
  await throttleAction()
  await randomDelay(80, 220)
  const normalizedKey = key.trim()
  const lowered = normalizedKey.toLowerCase()

  if (normalizedKey.length === 1 && insertPrintableChar(normalizedKey)) {
    return { success: true, message: `输入按键 ${normalizedKey} 完成`, mode: 'text_insert' }
  }
  if (lowered === 'backspace' && deleteFromActive('backspace')) {
    return { success: true, message: '退格完成', mode: 'input_delete' }
  }
  if (lowered === 'delete' && deleteFromActive('delete')) {
    return { success: true, message: '删除完成', mode: 'input_delete' }
  }
  if (lowered === 'enter' && submitOrInsertLine()) {
    return { success: true, message: '回车完成', mode: 'semantic_enter' }
  }
  if (lowered === 'tab' && advanceFocus(false)) {
    return { success: true, message: 'Tab 切换焦点完成', mode: 'focus_navigation' }
  }
  if (lowered === 'shift+tab' && advanceFocus(true)) {
    return { success: true, message: 'Shift+Tab 切换焦点完成', mode: 'focus_navigation' }
  }
  if (lowered === 'escape') {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    return { success: true, message: 'Escape 完成', mode: 'blur_active_element' }
  }
  if (dispatchKeyboardFallback(normalizedKey)) {
    return { success: true, message: `按键 ${normalizedKey} 已使用降级事件路径触发`, mode: 'synthetic_key_fallback' }
  }
  return { success: false, message: `按键 ${normalizedKey} 没有可用目标`, mode: 'no_active_target' }
}

function selectOptions(el: HTMLSelectElement, values?: string[], value?: string) {
  if (values?.length) {
    const selected = new Set(values)
    Array.from(el.options).forEach((option) => {
      option.selected = selected.has(option.value) || selected.has(option.label)
    })
  } else {
    el.value = value ?? ''
  }
  emitInputEvent(el, null, 'insertReplacementText')
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function getEvaluationDocument(frameRef?: string): Document {
  const normalized = normalizeFrameRef(frameRef)
  if (!normalized || normalized === '@main') return document
  const target = resolveLocator({ frameRef: normalized, selector: 'html' })
  return target.ownerDocument
}

function evaluateDocumentExpression(expression: string, evaluationDocument: Document) {
  switch (expression) {
    case 'document.title':
      return evaluationDocument.title
    case 'location.href':
    case 'document.location.href':
      return evaluationDocument.location?.href ?? location.href
    case 'document.body.innerText':
      return evaluationDocument.body?.innerText ?? ''
    case 'document.body.textContent':
      return evaluationDocument.body?.textContent ?? ''
    case 'document.documentElement.outerHTML':
      return evaluationDocument.documentElement?.outerHTML ?? ''
    default:
      throw new Error('当前 stealth 模式下 browser_evaluate 仅支持 document.title/location.href/document.body.* 等安全读取表达式')
  }
}

function evaluateElementExpression(expression: string, element: Element) {
  const trimmed = expression.trim()
  const normalized = trimmed
    .replace(/^el\./, 'element.')
    .replace(/^target\./, 'element.')

  switch (normalized) {
    case 'element.textContent':
      return element.textContent ?? ''
    case 'element.innerText':
      return element instanceof HTMLElement ? element.innerText : (element.textContent ?? '')
    case 'element.outerHTML':
      return element.outerHTML
    case 'element.innerHTML':
      return element instanceof HTMLElement ? element.innerHTML : undefined
    case 'element.value':
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        return element.value
      }
      return undefined
    case 'element.href':
      return element instanceof HTMLAnchorElement ? element.href : undefined
    case 'element.tagName':
      return element.tagName
    case 'element.id':
      return element.id
    case 'element.className':
      return element instanceof HTMLElement ? element.className : undefined
  }

  const attrMatch = normalized.match(/^element\.getAttribute\((['"])(.+?)\1\)$/)
  if (attrMatch) {
    return element.getAttribute(attrMatch[2]!)
  }

  const dataMatch = normalized.match(/^element\.dataset\.([A-Za-z_$][A-Za-z0-9_$]*)$/)
  if (dataMatch && element instanceof HTMLElement) {
    return element.dataset[dataMatch[1]!] ?? undefined
  }

  throw new Error('当前 stealth 模式下 browser_evaluate 仅支持 element 的文本、值、href、属性和 dataset 安全读取')
}

function extractExpressionFromFunction(functionSource: string) {
  const trimmed = functionSource.trim()
  const arrow = trimmed.match(/^(?:\(\s*([A-Za-z_$][\w$]*)?\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*([\s\S]+)$/)
  if (arrow) {
    const param = arrow[1] || arrow[2] || ''
    const body = arrow[3]!.trim()
    const returnMatch = body.match(/^\{\s*return\s+([\s\S]+?);?\s*\}$/)
    const expression = (returnMatch ? returnMatch[1] : body).trim()
    return {
      expectsElement: Boolean(param),
      expression: expression.replace(new RegExp(`\\b${param}\\b`, 'g'), 'element'),
    }
  }

  const fn = trimmed.match(/^function\s*\(([^)]*)\)\s*\{\s*return\s+([\s\S]+?);?\s*\}$/)
  if (fn) {
    const param = fn[1]?.split(',')[0]?.trim() ?? ''
    return {
      expectsElement: Boolean(param),
      expression: fn[2]!.trim().replace(new RegExp(`\\b${param}\\b`, 'g'), 'element'),
    }
  }

  throw new Error('当前 stealth 模式下 browser_evaluate 仅支持无副作用的简单 return 函数')
}

export async function executeBrowserAction(action: BrowserActionRequest): Promise<BrowserActionResponse> {
  const frameRef = normalizeFrameRef(action.frameRef)

  try {
    switch (action.action) {
      case 'hover': {
        const el = resolveLocator(action)
        await prepareForInteraction(el, { focus: false, scrollBehavior: 'auto' })
        const target = resolveInteractionTarget(el)
        dispatchHoverSequence(target.eventTarget, target.point)
        return { success: true, message: '悬停完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'click': {
        const el = resolveLocator(action)
        const risk = detectHighRiskClickAction(el)
        if (risk && action.allowDangerousAction !== true) {
          return {
            success: false,
            message: '目标动作存在真实副作用，默认拒绝执行；如确需执行，请显式传入 allowDangerousAction=true',
            error: risk.reason,
            target: targetInfo(el, action.ref),
            risk,
            requiresExplicitApproval: true,
            snapshot: buildSnapshot({ frameRef }),
          }
        }

        const clickResult = await performSemanticClick(el, {
          allowAggressiveFallback: action.fallbackMode === 'aggressive',
        })
        await randomDelay(180, 420)
        return {
          success: clickResult.observation.changed,
          message: clickResult.observation.changed
            ? `点击成功${clickResult.observation.reason ? `，观测到 ${clickResult.observation.reason}` : ''}`
            : '点击已执行，但未观测到页面状态变化',
          error: clickResult.observation.changed ? undefined : '点击后未观测到页面状态变化，请检查是否被遮挡或页面要求更强的真实用户激活',
          target: targetInfo(el, action.ref),
          risk,
          snapshot: buildSnapshot({ frameRef }),
        }
      }

      case 'double_click': {
        const el = resolveLocator(action)
        await performSemanticDoubleClick(el)
        await randomDelay(200, 600)
        return { success: true, message: '双击成功', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'fill': {
        const el = resolveLocator(action)
        await fillElement(el, action.value ?? '')
        return { success: true, message: '输入完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'clear': {
        const el = resolveLocator(action)
        await clearElement(el)
        return { success: true, message: '输入框已清空', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'select': {
        const el = resolveLocator(action)
        if (!(el instanceof HTMLSelectElement)) throw new Error('目标元素不是 select')
        await prepareForInteraction(el)
        selectOptions(el, action.values, action.value)
        return { success: true, message: '选项选择完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'press': {
        const result = await pressKey(action.key ?? 'Enter')
        return {
          success: result.success,
          message: result.message,
          snapshot: buildSnapshot({ frameRef }),
          error: result.success ? undefined : result.message,
        }
      }

      case 'scroll': {
        await throttleAction()
        const pixels = action.pixels ?? 400
        const dir = action.direction === 'up' ? -1 : 1
        window.scrollBy({ top: dir * pixels, behavior: 'smooth' })
        await randomDelay(400, 900)
        return { success: true, message: '滚动完成', snapshot: buildSnapshot({ frameRef }) }
      }

      case 'scroll_element': {
        const el = resolveLocator(action)
        await throttleAction()
        const pixels = action.pixels ?? 400
        const dir = action.direction === 'up' ? -1 : 1
        el.scrollBy({ top: dir * pixels, behavior: 'smooth' })
        await randomDelay(400, 900)
        return { success: true, message: '元素内滚动完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'wait': {
        const ms = action.ms ?? 1000
        await new Promise((resolve) => setTimeout(resolve, ms))
        return { success: true, message: `等待 ${ms}ms 完成`, snapshot: buildSnapshot({ frameRef }) }
      }

      case 'navigate': {
        if (action.url) location.href = action.url
        return { success: true, message: `导航到 ${action.url}`, navigationDetected: true }
      }

      case 'focus': {
        const el = resolveLocator(action)
        await throttleAction()
        focusElement(el)
        return { success: true, message: '聚焦完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'blur': {
        const el = resolveLocator(action)
        if (el instanceof HTMLElement) el.blur()
        return { success: true, message: '失焦完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'upload_file': {
        const el = resolveLocator(action)
        await uploadFiles(el, action.files ?? [])
        return { success: true, message: '文件上传完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot({ frameRef }) }
      }

      case 'screenshot': {
        const resp = await performScreenshot(action)
        return {
          success: true,
          message: '截图完成',
          screenshotDataUrl: resp.dataUrl,
          filename: resp.filename,
          downloadId: resp.downloadId,
          snapshot: buildSnapshot({ frameRef }),
        }
      }
    }
  } catch (error) {
    let snapshot
    try {
      snapshot = buildSnapshot({ frameRef, includeHtml: true })
    } catch {
      snapshot = undefined
    }
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
      snapshot,
    }
  }
}

async function fillField(field: FillFormField) {
  const element = resolveLocator(field)
  if (field.clear) {
    await clearElement(element)
  }

  if (element instanceof HTMLSelectElement) {
    await prepareForInteraction(element)
    selectOptions(element, field.values, field.value)
  } else if (field.value !== undefined) {
    await fillElement(element, field.value)
  }

  return {
    success: true,
    locator: {
      ref: field.ref,
      selector: field.selector,
      text: field.text,
      role: field.role,
      index: field.index,
    },
    target: targetInfo(element, field.ref),
  }
}

export async function fillForm(fields: FillFormField[]): Promise<FillFormResponse> {
  const results: FillFormResponse['fields'] = []
  for (const field of fields) {
    try {
      results.push(await fillField(field))
    } catch (error) {
      results.push({
        success: false,
        locator: {
          ref: field.ref,
          selector: field.selector,
          text: field.text,
          role: field.role,
          index: field.index,
        },
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const snapshot = buildSnapshot({ frameRef: normalizeFrameRef(fields[0]?.frameRef) })
  return {
    success: results.every((item) => item.success),
    fields: results,
    snapshotSummary: buildSnapshotSummary(snapshot),
  }
}

export async function dragBetween(req: DragRequest) {
  const source = resolveLocator(req.from)
  const target = resolveLocator(req.to)
  await prepareForInteraction(source)
  const transfer = new DataTransfer()
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: transfer }))

  return {
    success: true,
    message: '拖拽已使用最小化合成事件路径触发',
    from: targetInfo(source, req.from.ref),
    to: targetInfo(target, req.to.ref),
    snapshotSummary: buildSnapshotSummary(buildSnapshot({ frameRef: normalizeFrameRef(req.from.frameRef ?? req.to.frameRef) })),
    mode: 'synthetic_drag_fallback',
  }
}

export async function evaluateInPage(req: EvaluateRequest) {
  const evaluationDocument = getEvaluationDocument(req.frameRef)
  const target = req.ref || req.selector || req.text || req.role ? resolveLocator(req) : null

  try {
    if (req.expression) {
      const result = target
        ? evaluateElementExpression(req.expression, target)
        : evaluateDocumentExpression(req.expression.trim(), evaluationDocument)
      return { success: true, result: safeSerialize(result) }
    }

    if (!req.function) {
      return { success: false, error: '缺少 expression 或 function 参数' }
    }

    const extracted = extractExpressionFromFunction(req.function)
    const result = extracted.expectsElement
      ? evaluateElementExpression(extracted.expression, target ?? resolveLocator(req))
      : evaluateDocumentExpression(extracted.expression, evaluationDocument)
    return { success: true, result: safeSerialize(result) }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      alternatives: ['browser_snapshot', 'browser_query_elements', 'browser_debug_dom'],
    }
  }
}

export async function runCode(req: RunCodeRequest) {
  const trimmedCode = req.code.trim()
  const returnMatch = trimmedCode.match(/^(?:return\s+)?([\s\S]+?);?$/)
  if (!returnMatch) {
    return {
      success: false,
      error: '当前 stealth 模式下 browser_run_code 仅支持只读 return 表达式',
      alternatives: ['browser_evaluate', 'browser_snapshot', 'browser_debug_dom'],
    }
  }

  return evaluateInPage({
    frameRef: req.frameRef,
    expression: returnMatch[1]!.trim(),
  })
}

export async function executeLegacyAction(action: AgentAction): Promise<ActionResult> {
  const result = await executeBrowserAction(action as BrowserActionRequest)
  return {
    success: result.success,
    message: result.message,
    snapshot: result.snapshot,
    screenshotDataUrl: result.screenshotDataUrl,
  }
}

export function queryElementsForAI(field: FillFormField) {
  return queryElements({ ...field, limit: 5 })
}

export { configureRateLimit } from '../../rateLimit'
