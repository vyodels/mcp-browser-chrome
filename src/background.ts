// ============================================================
// background.ts — Service Worker
// 负责：侧边栏开启、tab 消息中转、chatgpt.com 会话代理
// ============================================================
import { loadSettings } from './store'
import type { Settings } from './types'

// 开启侧边栏
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id! })
})

// 所有 tab 默认启用侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true })
})

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'OPEN_SETTINGS':
      chrome.runtime.openOptionsPage()
      break

    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse({ tab: tabs[0] })
      })
      return true // async

    // chatgpt.com 会话模式中转
    case 'CHATGPT_SESSION_REQUEST':
      handleChatGPTSession(message.payload, sendResponse)
      return true // async

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
})

// ---- ChatGPT session 代理 ----
// 在已登录 chatgpt.com 的 tab 中注入脚本调用内部 API
async function handleChatGPTSession(
  payload: { messages: { role: string; content: string }[]; model: string },
  sendResponse: (r: { success: boolean; content?: string; error?: string }) => void
) {
  const settings: Settings = await loadSettings()
  if (settings.authMode !== 'chatgpt') {
    sendResponse({ success: false, error: '未启用 ChatGPT 会话模式' })
    return
  }

  // 查找或创建 chatgpt.com tab
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' })
  let targetTab = tabs[0]

  if (!targetTab) {
    // 后台静默打开
    targetTab = await chrome.tabs.create({
      url: 'https://chatgpt.com/',
      active: false,
    })
    // 等待加载
    await new Promise<void>((resolve) => {
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === targetTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener)
          resolve()
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
    })
  }

  // 注入脚本调用 ChatGPT 内部 API
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id! },
      func: async (msgs: { role: string; content: string }[], model: string) => {
        // 获取 session token
        const sessionResp = await fetch('https://chatgpt.com/api/auth/session')
        if (!sessionResp.ok) return { success: false, error: '未登录 ChatGPT' }
        const session = await sessionResp.json() as { accessToken?: string }
        if (!session.accessToken) return { success: false, error: '未登录 ChatGPT，请先登录 chatgpt.com' }

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({
            model,
            messages: msgs,
            max_tokens: 2048,
          }),
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          return { success: false, error: `API 错误: ${(e as { error?: { message?: string } }).error?.message ?? resp.status}` }
        }
        const json = await resp.json() as { choices?: { message?: { content?: string } }[] }
        return { success: true, content: json.choices?.[0]?.message?.content ?? '' }
      },
      args: [payload.messages, payload.model],
    })

    const result = results[0]?.result as { success: boolean; content?: string; error?: string } | undefined
    if (result) {
      sendResponse(result)
    } else {
      sendResponse({ success: false, error: '脚本执行失败' })
    }
  } catch (e) {
    sendResponse({ success: false, error: String(e) })
  }
}
