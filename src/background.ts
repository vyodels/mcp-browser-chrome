// ============================================================
// background.ts — Service Worker
// 负责：侧边栏开启、tab 消息中转、截图
// ============================================================

// 开启侧边栏
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id! })
})

// 所有 tab 默认启用侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true })
})

// 解析目标 tab：若传了 targetTabId 则用那个 tab，否则取当前激活 tab
function resolveTab(targetTabId?: number): Promise<chrome.tabs.Tab | null> {
  if (targetTabId) {
    return chrome.tabs.get(targetTabId).catch(() => null)
  }
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0] ?? null)
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

    case 'EXECUTE_ACTION_IN_TAB':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
        chrome.tabs.sendMessage(tab.id, message.payload, sendResponse)
      })
      return true

    case 'GET_PAGE_CONTENT':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
        chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' }, (resp) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message })
          } else {
            sendResponse({ ...resp, tabId: tab.id })
          }
        })
      })
      return true

    case 'CONFIGURE_RATE_LIMIT':
      resolveTab(message.targetTabId).then((tab) => {
        if (!tab?.id) { sendResponse({ success: false }); return }
        chrome.tabs.sendMessage(tab.id, message, () => {
          if (chrome.runtime.lastError) sendResponse({ success: false })
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
  }
  return false
})
