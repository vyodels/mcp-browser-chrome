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

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'OPEN_SETTINGS':
      chrome.runtime.openOptionsPage()
      break

    case 'EXECUTE_ACTION_IN_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) {
          sendResponse({ success: false, error: '没有活跃标签页' })
          return
        }
        chrome.tabs.sendMessage(tabs[0].id, message.payload, sendResponse)
      })
      return true

    case 'GET_PAGE_CONTENT':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) {
          sendResponse({ success: false, error: '没有活跃标签页' })
          return
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_CONTENT' }, sendResponse)
      })
      return true

    case 'CONFIGURE_RATE_LIMIT':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) { sendResponse({ success: false }); return }
        chrome.tabs.sendMessage(tabs[0].id, message, sendResponse)
      })
      return true

    case 'TAKE_SCREENSHOT':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.windowId) {
          sendResponse({ success: false, error: '没有活跃标签页' })
          return
        }
        chrome.tabs.captureVisibleTab(
          tabs[0].windowId,
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
