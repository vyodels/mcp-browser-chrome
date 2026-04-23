import type { BrowserCommand, SnapshotRequest } from '../shared/protocol'
import { relayToContentScript, resolveTab } from './contentBridge'
import { createNativeHostBridge } from './nativeHost'

function describeTargetTab(tab: chrome.tabs.Tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: !!tab.active,
    index: tab.index ?? 0,
  }
}

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
      },
    )
  })
}

async function captureTabScreenshot(targetTabId?: number) {
  const target = await resolveTab(targetTabId)
  if (!target?.id || !target.windowId) {
    return { success: false, error: '没有活跃标签页' }
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    chrome.tabs.captureVisibleTab(target.windowId, { format: 'png' }, (captured) => {
      if (chrome.runtime.lastError || !captured) {
        reject(new Error(chrome.runtime.lastError?.message ?? '截图失败'))
        return
      }
      resolve(captured)
    })
  }).catch((error) => error)

  if (dataUrl instanceof Error) {
    return { success: false, error: dataUrl.message }
  }

  return {
    success: true,
    tabId: target.id,
    windowId: target.windowId,
    target: describeTargetTab(target),
    screenshotDataUrl: dataUrl,
  }
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
      const currentWindowOnly = args.currentWindowOnly === true
      const tabs = await chrome.tabs.query(currentWindowOnly ? { currentWindow: true } : {})
      return {
        success: true,
        scope: currentWindowOnly ? 'current_window' : 'all_windows',
        tabs: tabs.map((tab) => ({
          id: tab.id,
          url: tab.url ?? '',
          title: tab.title ?? '',
          favIconUrl: tab.favIconUrl,
          active: !!tab.active,
          groupId: tab.groupId,
          windowId: tab.windowId,
          index: tab.index,
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

    case 'browser_reload_extension': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs[0]
      const target = tab?.id ? describeTargetTab(tab) : undefined
      setTimeout(() => chrome.runtime.reload(), 150)
      return {
        success: true,
        reloading: true,
        target,
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

    case 'browser_snapshot': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }

      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target,
        { type: 'BROWSER_SNAPSHOT', payload: args as SnapshotRequest },
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.id, target: describeTargetTab(target) }
    }

    case 'browser_debug_dom': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }

      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target,
        { type: 'DEBUG_DOM' },
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.id, target: describeTargetTab(target) }
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
      return { ...(result.response ?? {}), tabId: target.id, target: describeTargetTab(target) }
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
      return { ...(result.response as object), tabId: target.id, target: describeTargetTab(target) }
    }

    case 'browser_wait_for_navigation': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }
      return await waitForNavigation(target.id, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_get_cookies': {
      const query: chrome.cookies.GetAllDetails = {}
      if (typeof args.url === 'string') query.url = args.url
      if (typeof args.domain === 'string') query.domain = args.domain
      if (typeof args.name === 'string') query.name = args.name

      const cookies = await chrome.cookies.getAll(query)
      return {
        success: true,
        count: cookies.length,
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          session: cookie.session,
          expirationDate: cookie.expirationDate,
        })),
      }
    }

    case 'browser_wait_for_url': {
      const target = await resolveTab(typeof args.tabId === 'number' ? args.tabId : undefined)
      if (!target?.id) return { success: false, error: '没有活跃标签页' }

      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      const timeoutMs = Number(args.timeoutMs) || 10_000
      const tabId = target.id
      const start = Date.now()
      const current = await chrome.tabs.get(tabId)
      if (current.url?.includes(pattern)) {
        return { success: true, matched: true, url: current.url, elapsedMs: 0 }
      }

      return withTimeout(
        new Promise<{ success: boolean; matched: boolean; url?: string; elapsedMs: number }>((resolve) => {
          const onUpdated = (updatedId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
            if (updatedId !== tabId) return
            if (info.status === 'complete' && tab.url?.includes(pattern)) {
              chrome.tabs.onUpdated.removeListener(onUpdated)
              resolve({ success: true, matched: true, url: tab.url, elapsedMs: Date.now() - start })
            }
          }
          chrome.tabs.onUpdated.addListener(onUpdated)
        }),
        timeoutMs,
        `等待 URL 包含 "${pattern}" 超时`,
      ).catch((error) => ({
        success: false,
        matched: false,
        elapsedMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }))
    }

    case 'browser_screenshot':
      return await captureTabScreenshot(typeof args.tabId === 'number' ? args.tabId : undefined)
  }
}

export function registerBackgroundHandlers() {
  const nativeHostBridge = createNativeHostBridge(executeBrowserCommand)
  nativeHostBridge.start()

  // Per Chrome extension lifecycle docs, an active connectNative port keeps the MV3 worker alive.
  chrome.runtime.onStartup.addListener(() => nativeHostBridge.start())
  chrome.runtime.onInstalled.addListener(() => nativeHostBridge.start())
  chrome.tabs.onActivated.addListener(() => nativeHostBridge.start())
  chrome.tabs.onUpdated.addListener(() => nativeHostBridge.start())
  chrome.windows.onFocusChanged.addListener(() => nativeHostBridge.start())

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    nativeHostBridge.start()

    if (message.type === 'CONTENT_SCRIPT_READY') {
      sendResponse({ success: true })
      return false
    }

    return false
  })
}
