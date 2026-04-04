function canInjectContentScript(url?: string): boolean {
  return !!url && /^(https?|file):\/\//.test(url)
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
  if (!canInjectContentScript(tab.url)) {
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
  if (active && canInjectContentScript(active.url)) return active

  const all = await chrome.tabs.query({ currentWindow: true })
  return all.find((tab) => canInjectContentScript(tab.url)) ?? active ?? null
}

export async function relayToContentScript<T>(
  tab: chrome.tabs.Tab,
  payload: object
): Promise<{ success: true; response: T } | { success: false; error: string }> {
  if (!tab.id) return { success: false, error: '没有活跃标签页' }

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

