import type { ActionResult, AgentAction } from '../../types'
import type { BrowserActionRequest, BrowserActionResponse } from '../shared/protocol'
import { configureRateLimit, randomDelay, throttleAction } from '../../rateLimit'
import { resolveLocator } from './locators'
import { buildSnapshot } from './snapshot'

function dispatchMouseEvent(el: Element, type: string, init: MouseEventInit) {
  el.dispatchEvent(new MouseEvent(type, init))
}

function dispatchPointerSequence(el: Element) {
  const rect = el.getBoundingClientRect()
  const clientX = rect.left + rect.width * (0.25 + Math.random() * 0.5)
  const clientY = rect.top + rect.height * (0.25 + Math.random() * 0.5)
  const init: MouseEventInit = { bubbles: true, cancelable: true, clientX, clientY }

  dispatchMouseEvent(el, 'pointerover', init)
  dispatchMouseEvent(el, 'mouseover', init)
  dispatchMouseEvent(el, 'mousemove', init)
  dispatchMouseEvent(el, 'pointerdown', init)
  dispatchMouseEvent(el, 'mousedown', init)
  if (el instanceof HTMLElement) el.focus()
  dispatchMouseEvent(el, 'pointerup', init)
  dispatchMouseEvent(el, 'mouseup', init)
}

function applyInputValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  descriptor?.set?.call(el, nextValue)
}

function targetInfo(el: Element, ref?: string) {
  return {
    ref,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim().slice(0, 120),
  }
}

export async function executeBrowserAction(action: BrowserActionRequest): Promise<BrowserActionResponse> {
  try {
    switch (action.action) {
      case 'hover': {
        const el = resolveLocator(action)
        await throttleAction()
        dispatchPointerSequence(el)
        return { success: true, message: '悬停完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'click': {
        const el = resolveLocator(action)
        await throttleAction()
        dispatchPointerSequence(el)
        await randomDelay(40, 180)
        ;(el as HTMLElement).click()
        await randomDelay(250, 700)
        return { success: true, message: '点击成功', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'double_click': {
        const el = resolveLocator(action)
        await throttleAction()
        dispatchPointerSequence(el)
        await randomDelay(40, 100)
        ;(el as HTMLElement).click()
        await randomDelay(60, 160)
        ;(el as HTMLElement).click()
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
        await randomDelay(200, 600)
        return { success: true, message: '双击成功', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'fill': {
        const el = resolveLocator(action)
        const isEditable = el instanceof HTMLElement && el.isContentEditable
        if (!isEditable && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          throw new Error('目标元素不是输入框或可编辑区域')
        }
        await throttleAction()
        dispatchPointerSequence(el)
        await randomDelay(40, 120)
        if (isEditable) {
          const htmlEl = el as HTMLElement
          htmlEl.focus()
          const sel = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(htmlEl)
          sel?.removeAllRanges()
          sel?.addRange(range)
          document.execCommand('delete', false, undefined)
          const text = action.value ?? ''
          for (const char of text) {
            document.execCommand('insertText', false, char)
            htmlEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }))
            await randomDelay(25, 110)
          }
          htmlEl.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          const inputEl = el as HTMLInputElement | HTMLTextAreaElement
          applyInputValue(inputEl, '')
          inputEl.dispatchEvent(new Event('input', { bubbles: true }))
          const text = action.value ?? ''
          for (const char of text) {
            applyInputValue(inputEl, `${inputEl.value}${char}`)
            inputEl.dispatchEvent(new Event('input', { bubbles: true }))
            await randomDelay(25, 110)
          }
          inputEl.dispatchEvent(new Event('change', { bubbles: true }))
          inputEl.dispatchEvent(new Event('blur', { bubbles: true }))
        }
        return { success: true, message: '输入完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'clear': {
        const el = resolveLocator(action)
        const isEditable = el instanceof HTMLElement && el.isContentEditable
        if (!isEditable && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          throw new Error('目标元素不是输入框或可编辑区域')
        }
        await throttleAction()
        dispatchPointerSequence(el)
        if (isEditable) {
          const htmlEl = el as HTMLElement
          htmlEl.focus()
          const sel = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(htmlEl)
          sel?.removeAllRanges()
          sel?.addRange(range)
          document.execCommand('delete', false, undefined)
          htmlEl.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          const inputEl = el as HTMLInputElement | HTMLTextAreaElement
          applyInputValue(inputEl, '')
          inputEl.dispatchEvent(new Event('input', { bubbles: true }))
          inputEl.dispatchEvent(new Event('change', { bubbles: true }))
        }
        return { success: true, message: '输入框已清空', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'select': {
        const el = resolveLocator(action)
        if (!(el instanceof HTMLSelectElement)) throw new Error('目标元素不是 select')
        await throttleAction()
        dispatchPointerSequence(el)
        el.value = action.value ?? ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true, message: '选项选择完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'press': {
        await throttleAction()
        const key = action.key ?? 'Enter'
        const eventInit = { key, bubbles: true }
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', eventInit))
        document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', eventInit))
        return { success: true, message: `按键 ${key} 完成`, snapshot: buildSnapshot() }
      }

      case 'scroll': {
        await throttleAction()
        const pixels = action.pixels ?? 400
        const dir = action.direction === 'up' ? -1 : 1
        window.scrollBy({ top: dir * pixels, behavior: 'smooth' })
        await randomDelay(400, 900)
        return { success: true, message: '滚动完成', snapshot: buildSnapshot() }
      }

      case 'scroll_element': {
        const el = resolveLocator(action)
        await throttleAction()
        const pixels = action.pixels ?? 400
        const dir = action.direction === 'up' ? -1 : 1
        el.scrollBy({ top: dir * pixels, behavior: 'smooth' })
        await randomDelay(400, 900)
        return { success: true, message: '元素内滚动完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'wait': {
        const ms = action.ms ?? 1000
        await new Promise((resolve) => setTimeout(resolve, ms))
        return { success: true, message: `等待 ${ms}ms 完成`, snapshot: buildSnapshot() }
      }

      case 'navigate': {
        if (action.url) location.href = action.url
        return { success: true, message: `导航到 ${action.url}`, navigationDetected: true }
      }

      case 'focus': {
        const el = resolveLocator(action)
        await throttleAction()
        if (el instanceof HTMLElement) el.focus()
        return { success: true, message: '聚焦完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'blur': {
        const el = resolveLocator(action)
        if (el instanceof HTMLElement) el.blur()
        return { success: true, message: '失焦完成', target: targetInfo(el, action.ref), snapshot: buildSnapshot() }
      }

      case 'screenshot': {
        const resp = await new Promise<{ success: boolean; dataUrl?: string; error?: string }>(
          (resolve) => chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, resolve)
        )
        if (!resp?.success) throw new Error(resp?.error ?? '截图失败')
        return { success: true, message: '截图完成', screenshotDataUrl: resp.dataUrl, snapshot: buildSnapshot() }
      }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
      snapshot: buildSnapshot({ includeHtml: true }),
    }
  }
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

export { configureRateLimit }
