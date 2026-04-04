import { relayToContentScript, resolveTab } from './contentBridge'

async function withResolvedTab(
  targetTabId: number | undefined,
  sendResponse: (value: unknown) => void,
  run: (tab: chrome.tabs.Tab) => void | Promise<void>
) {
  const tab = await resolveTab(targetTabId)
  if (!tab?.id) {
    sendResponse({ success: false, error: '没有活跃标签页' })
    return
  }
  await run(tab)
}

function handleTabRelay(message: chrome.runtime.MessageSender & { targetTabId?: number; payload?: object }, sendResponse: (value: unknown) => void) {
  withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
    const result = await relayToContentScript(tab, message.payload ?? {})
    if (!result.success) {
      sendResponse({ success: false, error: result.error })
      return
    }
    sendResponse(result.response)
  })
}

export function registerBackgroundHandlers() {
  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ tabId: tab.id! })
  })

  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setOptions({ enabled: true })
  })

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
            tabs: tabs.map((tab) => ({
              id: tab.id,
              url: tab.url ?? '',
              title: tab.title ?? '',
              favIconUrl: tab.favIconUrl,
              groupId: tab.groupId,
            })),
          })
        })
        return true

      case 'EXECUTE_ACTION_IN_TAB':
        handleTabRelay(message as { targetTabId?: number; payload?: object }, sendResponse)
        return true

      case 'GET_PAGE_CONTENT':
        withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
          const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
            tab,
            { type: 'GET_PAGE_CONTENT' }
          )
          if (!result.success) {
            sendResponse({ success: false, error: result.error })
            return
          }
          sendResponse({ ...result.response, tabId: tab.id })
        })
        return true

      case 'QUERY_ELEMENTS':
      case 'WAIT_FOR_ELEMENT':
      case 'WAIT_FOR_TEXT':
      case 'WAIT_FOR_DISAPPEAR':
      case 'CONFIGURE_RATE_LIMIT':
        withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
          const result = await relayToContentScript(tab, { type: message.type, payload: message.payload })
          if (!result.success) sendResponse({ success: false, error: result.error })
          else sendResponse(result.response)
        })
        return true

      case 'TAKE_SCREENSHOT':
        withResolvedTab(message.targetTabId, sendResponse, (tab) => {
          if (!tab.windowId) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message })
            } else {
              sendResponse({ success: true, dataUrl })
            }
          })
        })
        return true

      case 'NAVIGATE_TAB': {
        const { url, targetTabId: navTabId } = message.payload as { url: string; targetTabId?: number }
        withResolvedTab(navTabId, sendResponse, (tab) => {
          const tabId = tab.id!
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

      case 'OPEN_TAB_AND_WAIT': {
        const { url, groupId } = message.payload as { url: string; groupId?: number }
        chrome.tabs.create({ url, active: true }, (tab) => {
          if (chrome.runtime.lastError || !tab?.id) {
            sendResponse({ success: false, error: chrome.runtime.lastError?.message ?? '创建标签页失败' })
            return
          }
          const newTabId = tab.id
          const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
            if (updatedId === newTabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated)
              if (groupId !== undefined && groupId >= 0) {
                chrome.tabs.group({ tabIds: newTabId, groupId }, () => sendResponse({ success: true, tabId: newTabId }))
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
          if (chrome.runtime.lastError || !tab?.id) {
            sendResponse({ success: false, error: chrome.runtime.lastError?.message })
            return
          }
          if (groupId !== undefined && groupId >= 0) {
            chrome.tabs.group({ tabIds: tab.id, groupId }, () => sendResponse({ success: true, tabId: tab.id }))
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
          chrome.tabGroups.update(groupId, { title, color: color ?? 'blue' }, () => sendResponse({ success: true, groupId }))
        })
        return true
      }

      case 'CLOSE_TAB_GROUP': {
        const { groupId } = message.payload as { groupId: number }
        chrome.tabs.query({ groupId }, (tabs) => {
          const ids = tabs.map((tab) => tab.id!).filter(Boolean)
          if (ids.length) chrome.tabs.remove(ids, () => sendResponse({ success: true }))
          else sendResponse({ success: true })
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
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' }, (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message })
          } else {
            sendResponse({ success: true, downloadId })
          }
        })
        return true
      }
    }
    return false
  })
}
