import type { BrowserActionRequest, BrowserCommand, SnapshotRequest } from '../shared/protocol'
import { createNativeHostBridge } from './nativeHost'
import { relayToContentScript, resolveTab } from './contentBridge'

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

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

function handleTabRelay(message: { targetTabId?: number; payload?: object }, sendResponse: (value: unknown) => void) {
  withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
    const result = await relayToContentScript(tab, message.payload ?? {})
    if (!result.success) {
      sendResponse({ success: false, error: result.error })
      return
    }
    sendResponse(result.response)
  })
}

async function waitForNavigation(tabId: number, timeoutMs = 10_000): Promise<{
  success: boolean
  matched: boolean
  elapsedMs: number
  tabId: number
  url?: string
  title?: string
  error?: string
}> {
  const start = Date.now()

  return withTimeout(new Promise<{
    success: boolean
    matched: boolean
    elapsedMs: number
    tabId: number
    url?: string
    title?: string
  }>((resolve) => {
    const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve({
          success: true,
          matched: true,
          elapsedMs: Date.now() - start,
          tabId,
          url: tab.url ?? '',
          title: tab.title ?? '',
        })
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated)
  }), timeoutMs, '等待导航超时').catch((error) => ({
    success: false,
    matched: false,
    elapsedMs: Date.now() - start,
    tabId,
    error: error instanceof Error ? error.message : String(error),
  }))
}

async function executeBrowserCommand(command: BrowserCommand): Promise<unknown> {
  const args = command.arguments ?? {}

  switch (command.name) {
    case 'browser_list_tabs': {
      const tabs = await chrome.tabs.query({ currentWindow: true })
      return {
        success: true,
        tabs: tabs.map((tab) => ({
          id: tab.id,
          url: tab.url ?? '',
          title: tab.title ?? '',
          favIconUrl: tab.favIconUrl,
          active: !!tab.active,
          groupId: tab.groupId,
          windowId: tab.windowId,
        })),
      }
    }

    case 'browser_get_active_tab': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs[0]
      if (!tab?.id) return { success: false, error: '没有活跃标签页' }
      return {
        success: true,
        tab: {
          id: tab.id,
          url: tab.url ?? '',
          title: tab.title ?? '',
          favIconUrl: tab.favIconUrl,
          active: true,
          groupId: tab.groupId,
          windowId: tab.windowId,
        },
      }
    }

    case 'browser_select_tab': {
      const tabId = Number(args.tabId)
      const tab = await chrome.tabs.get(tabId)
      await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return { success: true, tabId }
    }

    case 'browser_open_tab': {
      const created = await chrome.tabs.create({
        url: typeof args.url === 'string' ? args.url : 'about:blank',
        active: args.active !== false,
      })
      return {
        success: true,
        tabId: created.id,
        tab: {
          id: created.id,
          url: created.url ?? '',
          title: created.title ?? '',
          groupId: created.groupId,
          windowId: created.windowId,
        },
      }
    }

    case 'browser_close_tab': {
      const tabId = Number(args.tabId)
      await chrome.tabs.remove(tabId)
      return { success: true, tabId }
    }

    case 'browser_navigate': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id || typeof args.url !== 'string') return { success: false, error: '缺少目标标签页或 URL' }
      const targetTabId = target.id
      const nextUrl = args.url
      const navResult = await new Promise<{ success: boolean; tabId?: number; error?: string }>((resolve) => {
        const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedId === targetTabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated)
            resolve({ success: true, tabId: targetTabId })
          }
        }
        chrome.tabs.onUpdated.addListener(onUpdated)
        chrome.tabs.update(targetTabId, { url: nextUrl }, (updated) => {
          if (chrome.runtime.lastError || !updated) {
            chrome.tabs.onUpdated.removeListener(onUpdated)
            resolve({ success: false, error: chrome.runtime.lastError?.message ?? '导航失败' })
          }
        })
      })
      return navResult
    }

    case 'browser_go_back': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        func: () => history.back(),
      })
      return await waitForNavigation(target.id, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_reload': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      await chrome.tabs.reload(target.id)
      return await waitForNavigation(target.id, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_snapshot': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target,
        { type: 'BROWSER_SNAPSHOT', payload: args as SnapshotRequest }
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.id }
    }

    case 'browser_debug_dom': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target,
        { type: 'DEBUG_DOM' }
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.id }
    }

    case 'browser_query_elements':
    case 'browser_get_element': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      const payload = command.name === 'browser_get_element'
        ? { ...args, limit: 1 }
        : args
      const result = await relayToContentScript<{
        success: boolean
        matches?: unknown[]
        snapshotSummary?: unknown
        error?: string
      }>(target, { type: 'QUERY_ELEMENTS', payload })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.id }
    }

    case 'browser_wait_for_element':
    case 'browser_wait_for_text':
    case 'browser_wait_for_disappear': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      const typeMap: Record<string, string> = {
        browser_wait_for_element: 'WAIT_FOR_ELEMENT',
        browser_wait_for_text: 'WAIT_FOR_TEXT',
        browser_wait_for_disappear: 'WAIT_FOR_DISAPPEAR',
      }
      const result = await relayToContentScript(target, {
        type: typeMap[command.name],
        payload: args,
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.id }
    }

    case 'browser_wait_for_navigation': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      return await waitForNavigation(target.id, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_wait': {
      const ms = Math.max(0, Number(args.ms) || 1000)
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { success: true, waitedMs: ms }
    }

    case 'browser_click':
    case 'browser_hover':
    case 'browser_fill':
    case 'browser_clear':
    case 'browser_select_option':
    case 'browser_press_key':
    case 'browser_scroll':
    case 'browser_screenshot': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      const actionMap: Record<string, BrowserActionRequest['action']> = {
        browser_click: 'click',
        browser_hover: 'hover',
        browser_fill: 'fill',
        browser_clear: 'clear',
        browser_select_option: 'select',
        browser_press_key: 'press',
        browser_scroll: 'scroll',
        browser_screenshot: 'screenshot',
      }
      const result = await relayToContentScript(target, {
        type: 'EXECUTE_ACTION',
        payload: {
          ...(args as Record<string, unknown>),
          action: actionMap[command.name],
        },
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.id }
    }

    case 'browser_download_file':
    case 'browser_save_text':
    case 'browser_save_json':
    case 'browser_save_csv': {
      const filename = typeof args.filename === 'string' ? args.filename : 'browser-output.txt'
      const format = command.name === 'browser_save_json'
        ? 'json'
        : command.name === 'browser_save_csv'
          ? 'csv'
          : command.name === 'browser_download_file'
            ? (typeof args.format === 'string' ? args.format : 'txt')
            : 'txt'
      const content = typeof args.content === 'string'
        ? args.content
        : JSON.stringify(args.content ?? {}, null, 2)
      const mimeTypes: Record<string, string> = {
        json: 'application/json',
        csv: 'text/csv',
        txt: 'text/plain',
      }
      const mime = mimeTypes[format] ?? 'text/plain'
      const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
      const downloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
          if (chrome.runtime.lastError || typeof id !== 'number') {
            reject(new Error(chrome.runtime.lastError?.message ?? '下载失败'))
          } else {
            resolve(id)
          }
        })
      })
      return { success: true, filename, format, downloadId }
    }
  }
}

export function registerBackgroundHandlers() {
  createNativeHostBridge(executeBrowserCommand).start()

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

      case 'BROWSER_SNAPSHOT':
        withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
          const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
            tab,
            { type: 'BROWSER_SNAPSHOT', payload: message.payload }
          )
          if (!result.success) {
            sendResponse({ success: false, error: result.error })
            return
          }
          sendResponse({ ...result.response, tabId: tab.id })
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
