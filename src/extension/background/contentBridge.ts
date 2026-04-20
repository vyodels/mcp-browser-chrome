function isMockPageUrl(url?: string): boolean {
  return !!url && url.startsWith(chrome.runtime.getURL('mock-boss.html'))
}

function canUseTabAsBrowserSurface(url?: string): boolean {
  return !!url && (/^(https?|file):\/\//.test(url) || isMockPageUrl(url))
}

function sendTabMessage<T>(tabId: number, payload: object): Promise<{ ok: true; response: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? '发送消息失败' })
      } else {
        resolve({ ok: true, response: response as T })
      }
    })
  })
}

async function ensureContentScript(tab: chrome.tabs.Tab): Promise<{ success: true } | { success: false; error: string }> {
  if (!tab.id) return { success: false, error: '没有可用的标签页 ID' }
  if (isMockPageUrl(tab.url)) {
    return { success: true }
  }
  if (!canUseTabAsBrowserSurface(tab.url)) {
    return { success: false, error: '当前页面不支持扩展注入（如 chrome://、扩展页、新标签页），请切换到普通网页后再试' }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '内容脚本注入失败' }
  }
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
  payload: object
): Promise<{ success: true; response: T } | { success: false; error: string }> {
  if (!tab.id) return { success: false, error: '没有活跃标签页' }
  if (isMockPageUrl(tab.url)) {
    return relayToMockPage<T>(tab.id, payload)
  }

  const firstTry = await sendTabMessage<T>(tab.id, payload)
  if (firstTry.ok) return { success: true, response: firstTry.response }
  if (!firstTry.error.includes('Receiving end does not exist')) {
    return { success: false, error: firstTry.error }
  }

  const injected = await ensureContentScript(tab)
  if (!injected.success) return injected

  await new Promise((resolve) => setTimeout(resolve, 300))
  const secondTry = await sendTabMessage<T>(tab.id, payload)
  if (secondTry.ok) return { success: true, response: secondTry.response }
  return { success: false, error: secondTry.error }
}
