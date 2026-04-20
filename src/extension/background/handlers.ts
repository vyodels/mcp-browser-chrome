import type { BrowserActionRequest, BrowserCommand, SnapshotRequest } from '../shared/protocol'
import { relayToContentScript, resolveTab } from './contentBridge'
import { createNativeHostBridge } from './nativeHost'

type TabListScope = 'current_window' | 'all_windows'
type ResolvedTabOptions = {
  requireExplicit?: boolean
  actionLabel?: string
  fallbackTabId?: number
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
      }
    )
  })
}

async function withResolvedTab(
  targetTabId: number | undefined,
  sendResponse: (value: unknown) => void,
  run: (tab: chrome.tabs.Tab) => void | Promise<void>,
  options: ResolvedTabOptions = {}
) {
  const resolvedTargetTabId = typeof targetTabId === 'number' ? targetTabId : options.fallbackTabId
  if (options.requireExplicit && typeof resolvedTargetTabId !== 'number') {
    sendResponse({
      success: false,
      error: `${options.actionLabel ?? '页面操作'} 缺少 tabId。为避免干扰当前正在使用的标签页，请显式传入目标 tabId`,
    })
    return
  }

  const tab = await resolveTab(resolvedTargetTabId)
  if (!tab?.id) {
    sendResponse({ success: false, error: '没有活跃标签页' })
    return
  }
  await run(tab)
}

function handleTabRelay(
  message: { targetTabId?: number; payload?: object },
  sendResponse: (value: unknown) => void,
  options: ResolvedTabOptions = {}
) {
  withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
    const result = await relayToContentScript(tab, message.payload ?? {})
    if (!result.success) {
      sendResponse({ success: false, error: result.error })
      return
    }
    sendResponse(result.response)
  }, options)
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

function parseTabListScope(rawScope: unknown): { scope: TabListScope } | { error: string } {
  if (rawScope === undefined) {
    return { scope: 'current_window' }
  }
  if (rawScope === 'current_window' || rawScope === 'all_windows') {
    return { scope: rawScope }
  }
  return { error: 'scope 必须是 current_window 或 all_windows' }
}

function serializeTab(tab: chrome.tabs.Tab) {
  return {
    id: tab.id,
    url: tab.url ?? '',
    title: tab.title ?? '',
    favIconUrl: tab.favIconUrl,
    active: !!tab.active,
    groupId: tab.groupId,
    windowId: tab.windowId,
  }
}

async function listTabs(scope: TabListScope): Promise<chrome.tabs.Tab[]> {
  if (scope === 'all_windows') {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
    return windows.flatMap((window) => window.tabs ?? [])
  }

  return chrome.tabs.query({ currentWindow: true })
}

async function resolveCommandTab(rawTabId: unknown, commandName: string): Promise<
  { success: true; tab: chrome.tabs.Tab } | { success: false; error: string }
> {
  if (typeof rawTabId !== 'number' || !Number.isFinite(rawTabId)) {
    return {
      success: false,
      error: `${commandName} 缺少 tabId。为避免干扰当前正在使用的标签页，请显式传入目标 tabId`,
    }
  }

  const tab = await resolveTab(rawTabId)
  if (!tab?.id) {
    return { success: false, error: `找不到 tabId=${rawTabId} 对应的标签页` }
  }

  return { success: true, tab }
}

async function executeBrowserCommand(command: BrowserCommand): Promise<unknown> {
  const args = command.arguments ?? {}

  switch (command.name) {
    case 'browser_list_tabs': {
      const scopeResult = parseTabListScope(args.scope)
      if ('error' in scopeResult) return { success: false, error: scopeResult.error }
      const tabs = await listTabs(scopeResult.scope)
      return {
        success: true,
        scope: scopeResult.scope,
        tabs: tabs.map((tab) => serializeTab(tab)),
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
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const tabId = target.tab.id!
      const tab = await chrome.tabs.get(tabId)
      await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return { success: true, tabId }
    }

    case 'browser_open_tab': {
      const created = await chrome.tabs.create({
        url: typeof args.url === 'string' ? args.url : 'about:blank',
        active: args.active === true,
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
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const tabId = target.tab.id!
      await chrome.tabs.remove(tabId)
      return { success: true, tabId }
    }

    case 'browser_navigate': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success || typeof args.url !== 'string') {
        return target.success ? { success: false, error: '缺少目标标签页或 URL' } : target
      }
      const resolvedTab = target.tab
      const targetTabId = resolvedTab.id!
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
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      await chrome.scripting.executeScript({
        target: { tabId: target.tab.id! },
        func: () => history.back(),
      })
      return await waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_go_forward': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      await chrome.scripting.executeScript({
        target: { tabId: target.tab.id! },
        func: () => history.forward(),
      })
      return await waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_reload': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      await chrome.tabs.reload(target.tab.id!)
      return await waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_snapshot': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target.tab,
        { type: 'BROWSER_SNAPSHOT', payload: args as SnapshotRequest }
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.tab.id! }
    }

    case 'browser_debug_dom': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target.tab,
        { type: 'DEBUG_DOM' }
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.tab.id! }
    }

    case 'browser_query_elements':
    case 'browser_get_element': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const payload = command.name === 'browser_get_element'
        ? { ...args, limit: 1 }
        : args
      const result = await relayToContentScript<{
        success: boolean
        matches?: unknown[]
        snapshotSummary?: unknown
        error?: string
      }>(target.tab, { type: 'QUERY_ELEMENTS', payload })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response ?? {}), tabId: target.tab.id! }
    }

    case 'browser_wait_for_element':
    case 'browser_wait_for_text':
    case 'browser_wait_for_disappear': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const typeMap: Record<string, string> = {
        browser_wait_for_element: 'WAIT_FOR_ELEMENT',
        browser_wait_for_text: 'WAIT_FOR_TEXT',
        browser_wait_for_disappear: 'WAIT_FOR_DISAPPEAR',
      }
      const result = await relayToContentScript(target.tab, {
        type: typeMap[command.name],
        payload: args,
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.tab.id! }
    }

    case 'browser_wait_for_navigation': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      return await waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_wait': {
      const ms = Math.max(0, Number(args.ms) || 1000)
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { success: true, waitedMs: ms }
    }

    case 'browser_click':
    case 'browser_double_click':
    case 'browser_hover':
    case 'browser_fill':
    case 'browser_clear':
    case 'browser_select_option':
    case 'browser_press_key':
    case 'browser_scroll':
    case 'browser_scroll_element':
    case 'browser_screenshot': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const actionMap: Record<string, BrowserActionRequest['action']> = {
        browser_click: 'click',
        browser_double_click: 'double_click',
        browser_hover: 'hover',
        browser_fill: 'fill',
        browser_clear: 'clear',
        browser_select_option: 'select',
        browser_press_key: 'press',
        browser_scroll: 'scroll',
        browser_scroll_element: 'scroll_element',
        browser_screenshot: 'screenshot',
      }
      const result = await relayToContentScript(target.tab, {
        type: 'EXECUTE_ACTION',
        payload: {
          ...(args as Record<string, unknown>),
          action: actionMap[command.name],
        },
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.tab.id! }
    }

    case 'browser_execute_script': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const script = typeof args.script === 'string' ? args.script : ''
      if (!script) return { success: false, error: '缺少 script 参数' }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: target.tab.id! },
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
          func: (code: string) => {
            try {
              // Use indirect eval so the script runs against the page global scope
              // without triggering the bundler's direct eval warning.
              const value = globalThis.eval(code)
              if (value && typeof (value as Promise<unknown>).then === 'function') {
                return (value as Promise<unknown>)
                  .then((v) => ({ success: true, result: JSON.parse(JSON.stringify(v ?? null)) }))
                  .catch((e: Error) => ({ success: false, error: e.message }))
              }
              return { success: true, result: JSON.parse(JSON.stringify(value ?? null)) }
            } catch (e) {
              return { success: false, error: e instanceof Error ? e.message : String(e) }
            }
          },
          args: [script],
        })
        return results?.[0]?.result ?? { success: true, result: null }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
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
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          session: c.session,
          expirationDate: c.expirationDate,
        })),
      }
    }

    case 'browser_wait_for_url': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      const timeoutMs = Number(args.timeoutMs) || 10_000
      const tabId = target.tab.id!
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
        `等待 URL 包含 "${pattern}" 超时`
      ).catch((error) => ({
        success: false,
        matched: false,
        elapsedMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      }))
    }

    case 'browser_handle_dialog': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const dialogAction = args.action === 'dismiss' ? 'dismiss' : 'accept'
      const promptText = typeof args.promptText === 'string' ? args.promptText : ''
      await chrome.scripting.executeScript({
        target: { tabId: target.tab.id! },
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
        func: (action: string, promptValue: string) => {
          const origAlert = window.alert.bind(window)
          const origConfirm = window.confirm.bind(window)
          const origPrompt = window.prompt.bind(window)
          ;(window as Window & typeof globalThis).alert = () => undefined
          ;(window as Window & typeof globalThis).confirm = () => action === 'accept'
          ;(window as Window & typeof globalThis).prompt = () => (action === 'accept' ? promptValue : null)
          setTimeout(() => {
            ;(window as Window & typeof globalThis).alert = origAlert
            ;(window as Window & typeof globalThis).confirm = origConfirm
            ;(window as Window & typeof globalThis).prompt = origPrompt
          }, 10_000)
        },
        args: [dialogAction, promptText],
      })
      return { success: true, action: dialogAction, message: `对话框处理器已就绪（${dialogAction}），10秒后自动还原` }
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
  const nativeHostBridge = createNativeHostBridge(executeBrowserCommand)
  nativeHostBridge.start()

  // Per Chrome extension lifecycle docs, an active connectNative port keeps the MV3 worker alive.
  chrome.runtime.onStartup.addListener(() => nativeHostBridge.start())
  chrome.runtime.onInstalled.addListener(() => nativeHostBridge.start())
  chrome.tabs.onActivated.addListener(() => nativeHostBridge.start())
  chrome.tabs.onUpdated.addListener(() => nativeHostBridge.start())
  chrome.windows.onFocusChanged.addListener(() => nativeHostBridge.start())

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    nativeHostBridge.start()

    switch (message.type) {
      case 'CONTENT_SCRIPT_READY':
        sendResponse({ success: true })
        return false

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
        ;(async () => {
          const scopeResult = parseTabListScope(message.payload?.scope)
          if ('error' in scopeResult) {
            sendResponse({ success: false, error: scopeResult.error })
            return
          }
          const tabs = await listTabs(scopeResult.scope)
          sendResponse({
            success: true,
            scope: scopeResult.scope,
            tabs: tabs.map((tab) => serializeTab(tab)),
          })
        })().catch((error) => {
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
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
        }, { requireExplicit: true, actionLabel: 'BROWSER_SNAPSHOT' })
        return true

      case 'EXECUTE_ACTION_IN_TAB':
        handleTabRelay(message as { targetTabId?: number; payload?: object }, sendResponse, {
          requireExplicit: true,
          actionLabel: 'EXECUTE_ACTION_IN_TAB',
        })
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
        }, { requireExplicit: true, actionLabel: 'GET_PAGE_CONTENT' })
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
        }, { requireExplicit: true, actionLabel: message.type })
        return true

      case 'TAKE_SCREENSHOT':
        withResolvedTab(message.targetTabId, sendResponse, async (tab) => {
          if (!tab.windowId) { sendResponse({ success: false, error: '没有活跃标签页' }); return }
          const windowTabs = await chrome.tabs.query({ windowId: tab.windowId, active: true })
          const activeTab = windowTabs[0]
          if (activeTab?.id !== tab.id) {
            sendResponse({
              success: false,
              error: '目标 tab 当前不可见，后台静默模式下不执行截图。请传入当前可见的目标 tabId，或显式激活该标签页后再截图',
            })
            return
          }
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message })
            } else {
              sendResponse({ success: true, dataUrl })
            }
          })
        }, { fallbackTabId: sender.tab?.id, actionLabel: 'TAKE_SCREENSHOT' })
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
        }, { requireExplicit: true, actionLabel: 'NAVIGATE_TAB' })
        return true
      }

      case 'OPEN_TAB_AND_WAIT': {
        const { url, groupId, active } = message.payload as { url: string; groupId?: number; active?: boolean }
        chrome.tabs.create({ url, active: active === true }, (tab) => {
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
