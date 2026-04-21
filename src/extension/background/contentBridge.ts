export function isMockPageUrl(url?: string): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL('mock-boss.html'))
}

export function normalizePublicFrameRef(frameRef?: string): string | undefined {
  if (!frameRef) return undefined
  if (frameRef === 'main' || frameRef === '@main') return '@main'
  return frameRef
}

export function publicFrameRefFromFrameId(frameId: number): string {
  return frameId === 0 ? '@main' : `@frame:${frameId}`
}

export function frameIdFromPublicFrameRef(frameRef?: string): number | undefined {
  const normalized = normalizePublicFrameRef(frameRef)
  if (!normalized) return undefined
  if (normalized === '@main') return 0
  const match = /^@frame:(\d+)$/.exec(normalized)
  if (!match) return undefined
  return Number(match[1])
}

function canUseTabAsBrowserSurface(url?: string): boolean {
  return !!url && (/^(https?|file):\/\//.test(url) || isMockPageUrl(url))
}

async function ensureContentScriptInFrame(
  tabId: number,
  frameId: number
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['content.js'],
    })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '目标子 frame 内容脚本注入失败',
    }
  }
}

function sanitizePayloadForTargetFrame(value: unknown, targetFrameRef?: string): unknown {
  if (!targetFrameRef || value == null) return value
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayloadForTargetFrame(item, targetFrameRef))
  }
  if (typeof value !== 'object') return value

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
    if (key === 'frameRef' && entryValue === targetFrameRef) {
      return [key, undefined]
    }
    return [key, sanitizePayloadForTargetFrame(entryValue, targetFrameRef)]
  })
  return Object.fromEntries(entries)
}

function sendTabMessage<T>(
  tabId: number,
  payload: object,
  frameId?: number
): Promise<{ ok: true; response: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const callback = (response: unknown) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? '发送消息失败' })
      } else {
        resolve({ ok: true, response: response as T })
      }
    }

    if (typeof frameId === 'number') {
      chrome.tabs.sendMessage(tabId, payload, { frameId }, callback)
      return
    }

    chrome.tabs.sendMessage(tabId, payload, callback)
  })
}

function isReceivingEndMissing(error: string): boolean {
  return error.includes('Receiving end does not exist')
}

export async function resolveTab(targetTabId?: number): Promise<chrome.tabs.Tab | null> {
  if (targetTabId) {
    return chrome.tabs.get(targetTabId).catch(() => null)
  }

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const active = activeTabs[0]
  if (active && canUseTabAsBrowserSurface(active.url)) return active

  const all = await chrome.tabs.query({ currentWindow: true })
  return all.find((tab) => canUseTabAsBrowserSurface(tab.url)) ?? active ?? null
}

async function relayToMockPage<T>(
  tabId: number,
  payload: object
): Promise<{ success: true; response: T } | { success: false; error: string }> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      func: async (message: object) => {
        const bridge = (window as Window & typeof globalThis & {
          __BROWSER_MCP_MOCK_BRIDGE__?: {
            handleMessage?: (payload: object) => Promise<unknown>
          }
        }).__BROWSER_MCP_MOCK_BRIDGE__

        if (!bridge?.handleMessage) {
          return {
            __mockBridgeError: 'mock 页面桥接器未就绪，请重新加载当前 mock 页面后再试',
          }
        }

        return bridge.handleMessage(message)
      },
      args: [payload],
    })

    if (result && typeof result === 'object' && '__mockBridgeError' in result) {
      return { success: false, error: String(result.__mockBridgeError) }
    }

    return { success: true, response: result as T }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'mock 页面消息转发失败',
    }
  }
}

export async function relayToContentScript<T>(
  tab: chrome.tabs.Tab,
  payload: object,
  options: { frameRef?: string } = {}
): Promise<{ success: true; response: T } | { success: false; error: string }> {
  if (!tab.id) return { success: false, error: '没有活跃标签页' }
  const normalizedFrameRef = normalizePublicFrameRef(options.frameRef)
  const frameId = frameIdFromPublicFrameRef(normalizedFrameRef)
  const targetFrameId = typeof frameId === 'number' ? frameId : 0
  const routedPayload = frameId && frameId !== 0
    ? sanitizePayloadForTargetFrame(payload, normalizedFrameRef) as object
    : payload

  if (isMockPageUrl(tab.url)) {
    if (normalizedFrameRef && normalizedFrameRef !== '@main') {
      return { success: false, error: 'mock 页面暂不支持子 frame 定向消息' }
    }
    return relayToMockPage<T>(tab.id, payload)
  }

  const firstTry = await sendTabMessage<T>(tab.id, routedPayload, targetFrameId)
  if (firstTry.ok) return { success: true, response: firstTry.response }
  if (!isReceivingEndMissing(firstTry.error)) {
    return { success: false, error: firstTry.error }
  }

  if (!canUseTabAsBrowserSurface(tab.url)) {
    return { success: false, error: '当前页面不支持内容脚本能力（如 chrome://、扩展页、新标签页）' }
  }

  if (targetFrameId !== 0) {
    const injected = await ensureContentScriptInFrame(tab.id, targetFrameId)
    if (!injected.success) {
      return { success: false, error: injected.error }
    }

    await new Promise((resolve) => setTimeout(resolve, 120))
    const secondTry = await sendTabMessage<T>(tab.id, routedPayload, targetFrameId)
    if (secondTry.ok) return { success: true, response: secondTry.response }
    return { success: false, error: secondTry.error }
  }

  return {
    success: false,
    error: '目标标签页内容脚本未就绪。为避免额外注入导致页面可探测面增大，当前不会自动重注入，请手动刷新目标页面后重试',
  }
}
