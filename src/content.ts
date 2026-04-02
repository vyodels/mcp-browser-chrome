// ============================================================
// content.ts — 注入每个页面
// 负责：页面快照、元素操作、DOM 调试
// ============================================================
import type { AgentAction, ActionResult, InteractiveElement, PageSnapshot } from './types'
import { simulateMouseMove, randomDelay, configureRateLimit } from './rateLimit'

// ref → Element 映射
const refMap = new Map<string, Element>()
let refCounter = 0

// ---- 页面快照 ----
function takeSnapshot(includeHtml = false): PageSnapshot {
  refMap.clear()
  refCounter = 0

  const interactive: InteractiveElement[] = []
  const selectors = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="menuitem"]', '[contenteditable="true"]',
  ]

  document.querySelectorAll<HTMLElement>(selectors.join(',')).forEach((el) => {
    if (!isVisible(el)) return
    const ref = `@e${++refCounter}`
    refMap.set(ref, el)
    const rect = el.getBoundingClientRect()
    interactive.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type,
      text: (el.textContent ?? '').trim().slice(0, 80),
      placeholder: (el as HTMLInputElement).placeholder,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      href: (el as HTMLAnchorElement).href,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    })
  })

  return {
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 6000),
    interactiveElements: interactive,
    html: includeHtml
      ? document.documentElement.outerHTML.slice(0, 30000)
      : undefined,
  }
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

// ---- 动作执行器 ----
async function executeAction(action: AgentAction): Promise<ActionResult> {
  try {
    switch (action.action) {
      case 'click': {
        const el = resolveElement(action.ref)
        simulateMouseMove(el)
        await randomDelay(100, 300)
        ;(el as HTMLElement).click()
        await randomDelay(300, 600)
        return { success: true, message: `点击 ${action.ref} 成功`, snapshot: takeSnapshot() }
      }

      case 'fill': {
        const el = resolveElement(action.ref)
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
          throw new Error(`${action.ref} 不是输入框`)
        }
        simulateMouseMove(el)
        await randomDelay(100, 200)
        el.focus()
        el.value = ''
        // 逐字符输入，模拟人工打字
        const text = action.value ?? ''
        for (const char of text) {
          el.value += char
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          await randomDelay(30, 120)
        }
        el.dispatchEvent(new Event('blur', { bubbles: true }))
        return { success: true, message: `填写 ${action.ref} 完成`, snapshot: takeSnapshot() }
      }

      case 'select': {
        const el = resolveElement(action.ref)
        if (!(el instanceof HTMLSelectElement)) throw new Error(`${action.ref} 不是 select`)
        simulateMouseMove(el)
        el.value = action.value ?? ''
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true, message: `选择 ${action.value} 完成`, snapshot: takeSnapshot() }
      }

      case 'press': {
        const key = action.key ?? 'Enter'
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
        return { success: true, message: `按键 ${key} 完成`, snapshot: takeSnapshot() }
      }

      case 'scroll': {
        const pixels = action.pixels ?? 400
        const dir = action.direction === 'up' ? -1 : 1
        window.scrollBy({ top: dir * pixels, behavior: 'smooth' })
        await randomDelay(500, 800)
        return { success: true, message: `滚动 ${action.direction} ${pixels}px`, snapshot: takeSnapshot() }
      }

      case 'wait': {
        const ms = action.ms ?? 1000
        await randomDelay(ms, ms + 500)
        return { success: true, message: `等待 ${ms}ms 完成`, snapshot: takeSnapshot() }
      }

      case 'navigate': {
        if (action.url) location.href = action.url
        return { success: true, message: `导航到 ${action.url}` }
      }

      case 'screenshot': {
        const resp = await new Promise<{ success: boolean; dataUrl?: string; error?: string }>(
          (resolve) => chrome.runtime.sendMessage({ type: 'TAKE_SCREENSHOT' }, resolve)
        )
        if (!resp?.success) throw new Error(resp?.error ?? '截图失败')
        return { success: true, message: '截图完成', screenshotDataUrl: resp.dataUrl, snapshot: takeSnapshot() }
      }

      default:
        throw new Error(`未知动作: ${(action as AgentAction).action}`)
    }
  } catch (e) {
    return {
      success: false,
      message: String(e),
      snapshot: takeSnapshot(true), // 失败时附带 HTML 供调试
    }
  }
}

function resolveElement(ref?: string): Element {
  if (!ref) throw new Error('未指定元素 ref')
  const el = refMap.get(ref)
  if (!el) throw new Error(`找不到元素 ${ref}，请重新获取页面快照`)
  return el
}

// ---- 消息监听 ----
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_PAGE_CONTENT':
      sendResponse({ success: true, snapshot: takeSnapshot() })
      break

    case 'DEBUG_DOM':
      sendResponse({ success: true, snapshot: takeSnapshot(true) })
      break

    case 'EXECUTE_ACTION':
      executeAction(message.payload as AgentAction).then(sendResponse)
      return true // async

    case 'CONFIGURE_RATE_LIMIT':
      configureRateLimit(message.payload.max, message.payload.delay)
      sendResponse({ success: true })
      break
  }
  return false
})
