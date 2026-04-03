// ============================================================
// background.ts — Service Worker
// 负责：侧边栏开启、tab 消息中转、截图、标签组管理、文件下载
// ============================================================

// 开启侧边栏
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id! })
})

// 所有 tab 默认启用侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true })
})

// 解析目标 tab
function resolveTab(targetTabId?: number): Promise<chrome.tabs.Tab | null> {
  if (targetTabId) {
    return chrome.tabs.get(targetTabId).catch(() => null)
  }
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0] ?? null)
}

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
  if (!tab.id) {
    return { success: false, error: '没有可用的标签页 ID' }
  }

  if (!canInjectContentScript(tab.url)) {
    return {
      success: false,
      error: '当前页面不支持扩展注入（如 chrome://、扩展页、新标签页），请切换到普通网页后再试',
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '内容脚本注入失败',
    }
  }
}

async function relayToContentScript<T>(
  tab: chrome.tabs.Tab,
  payload: object
): Promise<{ success: true; response: T } | { success: false; error: string }> {
  if (!tab.id) {
    return { success: false, error: '没有活跃标签页' }
  }

  const firstTry = await sendTabMessage<T>(tab.id, payload)
  if (firstTry.ok) {
    return { success: true, response: firstTry.response }
  }

  if (!firstTry.error.includes('Receiving end does not exist')) {
    return { success: false, error: firstTry.error }
  }

  const injected = await ensureContentScript(tab)
  if (!injected.success) {
    return injected
  }

  const secondTry = await sendTabMessage<T>(tab.id, payload)
  if (secondTry.ok) {
    return { success: true, response: secondTry.response }
  }

  return { success: false, error: secondTry.error }
}

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'OPEN_SETTINGS':
      chrome.runtime.openOptionsPage()
      break

    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0]
        if (!tab?.id) { sendResponse({ success: false }); return }
        sendResponse({
          success: true,
          tab: { id: tab.id, url: tab.url ?? '', title: tab.title ?? '', favIconUrl: tab.favIconUrl },
        })
      })
      return true

    case 'GET_ALL_TABS':
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        sendResponse({
          success: true,
          tabs: tabs.map((t) => ({
            id: t.id,
            url: t.url ?? '',
            title: t.title ?? '',
            favIconUrl: t.favIconUrl,
            groupId: t.groupId,
          })),
        })
      })
      return true

    case 'EXECUTE_ACTION_IN_TAB':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
        relayToContentScript(tab, message.payload).then((result) => {
          if (!result.success) {
            sendResponse({ success: false, error: result.error })
            return
          }
          sendResponse(result.response)
        })
      })
      return true

    case 'GET_PAGE_CONTENT':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
        relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
          tab,
          { type: 'GET_PAGE_CONTENT' }
        ).then((result) => {
          if (!result.success) {
            sendResponse({ success: false, error: result.error })
            return
          }
          sendResponse({ ...result.response, tabId: tab.id })
        })
      })
      return true

    case 'CONFIGURE_RATE_LIMIT':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false }); return }
        relayToContentScript(tab, message).then((result) => {
          if (!result.success) sendResponse({ success: false, error: result.error })
          else sendResponse({ success: true })
        })
      })
      return true

    case 'TAKE_SCREENSHOT':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.windowId) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
        chrome.tabs.captureVisibleTab(
          tab.windowId,
          { format: 'png' },
          (dataUrl) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message })
            } else {
              sendResponse({ success: true, dataUrl })
            }
          }
        )
      })
      return true

    // 直接导航到 URL（不依赖 content script，background 层直接操作）
    case 'NAVIGATE_TAB': {
      const { url, targetTabId: navTabId } = message.payload as { url: string; targetTabId?: number }
      resolveTab(navTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
        const tabId = tab.id
        // 监听加载完成
        const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedId === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated)
            sendResponse({ success: true, tabId })
          }
        }
        chrome.tabs.onUpdated.addListener(onUpdated)
        chrome.tabs.update(tabId, { url }, (updated) => {
          if (chrome.runtime.lastError || !updated) {
            chrome.tabs.onUpdated.removeListener(onUpdated)
            sendResponse({ success: false, error: chrome.runtime.lastError?.message ?? '导航失败' })
          }
        })
      })
      return true
    }

    // 开新 tab 并等待页面加载完成（工作流启动用）
    case 'OPEN_TAB_AND_WAIT': {
      const { url: waitUrl, groupId: waitGroupId } = message.payload as { url: string; groupId?: number }
      chrome.tabs.create({ url: waitUrl, active: true }, (tab) => {
        if (chrome.runtime.lastError || !tab?.id) {
          sendResponse({ success: false, error: chrome.runtime.lastError?.message ?? '创建标签页失败' })
          return
        }
        const newTabId = tab.id
        const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedId === newTabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated)
            if (waitGroupId !== undefined && waitGroupId >= 0) {
              chrome.tabs.group({ tabIds: newTabId, groupId: waitGroupId }, () => {
                sendResponse({ success: true, tabId: newTabId })
              })
            } else {
              sendResponse({ success: true, tabId: newTabId })
            }
          }
        }
        chrome.tabs.onUpdated.addListener(onUpdated)
      })
      return true
    }

    case 'OPEN_TAB': {
      const { url, groupId } = message.payload as { url?: string; groupId?: number }
      chrome.tabs.create({ url: url || 'about:blank', active: false }, (tab) => {
        if (chrome.runtime.lastError || !tab.id) {
          sendResponse({ success: false, error: chrome.runtime.lastError?.message })
          return
        }
        if (groupId !== undefined && groupId >= 0) {
          chrome.tabs.group({ tabIds: tab.id, groupId }, () => {
            sendResponse({ success: true, tabId: tab.id })
          })
        } else {
          sendResponse({ success: true, tabId: tab.id })
        }
      })
      return true
    }

    case 'CREATE_TAB_GROUP': {
      const { tabIds, title, color } = message.payload as {
        tabIds: number[]
        title: string
        color?: chrome.tabGroups.ColorEnum
      }
      chrome.tabs.group({ tabIds }, (groupId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message })
          return
        }
        chrome.tabGroups.update(groupId, { title, color: color ?? 'blue' }, () => {
          sendResponse({ success: true, groupId })
        })
      })
      return true
    }

    case 'CLOSE_TAB_GROUP': {
      const { groupId: gid } = message.payload as { groupId: number }
      chrome.tabs.query({ groupId: gid }, (tabs) => {
        const ids = tabs.map((t) => t.id!).filter(Boolean)
        if (ids.length) {
          chrome.tabs.remove(ids, () => sendResponse({ success: true }))
        } else {
          sendResponse({ success: true })
        }
      })
      return true
    }

    case 'DOWNLOAD_DATA': {
      const { filename, content, format } = message.payload as {
        filename: string
        content: string
        format: string
      }
      const mimeTypes: Record<string, string> = {
        json: 'application/json',
        csv: 'text/csv',
        txt: 'text/plain',
      }
      const mime = mimeTypes[format] ?? 'text/plain'
      const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
      chrome.downloads.download(
        { url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message })
          } else {
            sendResponse({ success: true, downloadId })
          }
        }
      )
      return true
    }
  }
  return false
})
