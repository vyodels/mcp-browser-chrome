import type {
  BrowserActionRequest,
  BrowserCommand,
  WaitForDownloadRequest,
} from '../shared/protocol'
import { safeSerialize } from '../shared/ai'
import {
  normalizePublicFrameRef,
  publicFrameRefFromFrameId,
  isMockPageUrl,
  relayToContentScript,
  resolveTab,
} from './contentBridge'
import { createNativeHostBridge } from './nativeHost'
import {
  initializeObservability,
  waitForDownload,
} from './observability'

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

type NavigationFrameRecord = chrome.webNavigation.GetAllFrameResultDetails

function tryParseUrl(url?: string): URL | null {
  if (!url) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isSameOriginAsTab(tabUrl?: string, frameUrl?: string) {
  const tabParsed = tryParseUrl(tabUrl)
  const frameParsed = tryParseUrl(frameUrl)
  if (!tabParsed || !frameParsed) return false
  return tabParsed.origin === frameParsed.origin
}

function buildPublicFramePath(
  frame: NavigationFrameRecord,
  frameMap: Map<number, NavigationFrameRecord>
) {
  if (frame.frameId === 0) return []

  const path: string[] = []
  let cursor: NavigationFrameRecord | undefined = frame
  while (cursor && cursor.frameId !== 0) {
    path.unshift(publicFrameRefFromFrameId(cursor.frameId))
    cursor = cursor.parentFrameId >= 0 ? frameMap.get(cursor.parentFrameId) : undefined
  }
  return path
}

async function listBrowserFrames(tab: chrome.tabs.Tab, includeMainFrame = true) {
  if (!tab.id) return []
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) ?? []
  const frameMap = new Map(frames.map((frame) => [frame.frameId, frame]))
  return frames
    .filter((frame) => includeMainFrame || frame.frameId !== 0)
    .map((frame) => ({
      ref: publicFrameRefFromFrameId(frame.frameId),
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      parentRef: frame.parentFrameId >= 0 ? publicFrameRefFromFrameId(frame.parentFrameId) : undefined,
      path: buildPublicFramePath(frame, frameMap),
      url: frame.url ?? '',
      sameOrigin: isSameOriginAsTab(tab.url, frame.url),
      isMainFrame: frame.frameId === 0,
      documentId: frame.documentId,
      lifecycle: frame.documentLifecycle,
      errorOccurred: frame.errorOccurred === true,
    }))
}

function isMessageChannelClosedError(error?: string) {
  if (!error) return false
  return error.includes('message channel closed before a response was received')
    || error.includes('The message port closed before a response was received')
    || error.includes('A listener indicated an asynchronous response')
}

function summarizeFramesForComparison(
  frames: Array<{ frameId: number; url?: string; documentId?: string }>
) {
  return frames
    .map((frame) => `${frame.frameId}:${frame.documentId ?? ''}:${frame.url ?? ''}`)
    .sort()
    .join('|')
}

async function waitForSurfaceChange(
  tabId: number,
  before: {
    tabUrl?: string
    framesSummary: string
  },
  timeoutMs = 2000
) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    await sleep(120)
    const currentTab = await chrome.tabs.get(tabId).catch(() => null)
    if (!currentTab?.id) continue
    const currentFrames = await listBrowserFrames(currentTab, true)
    const currentSummary = summarizeFramesForComparison(currentFrames)
    if ((currentTab.url ?? '') !== (before.tabUrl ?? '') || currentSummary !== before.framesSummary) {
      return {
        changed: true,
        tab: currentTab,
        frames: currentFrames,
      }
    }
  }

  const currentTab = await chrome.tabs.get(tabId).catch(() => null)
  return {
    changed: false,
    tab: currentTab ?? undefined,
    frames: currentTab?.id ? await listBrowserFrames(currentTab, true) : [],
  }
}

function decorateInteractiveElementsFrame<T extends { frameRef?: string }>(
  items: T[] | undefined,
  frameRef?: string
) {
  if (!items || !frameRef || frameRef === '@main') return items
  return items.map((item) => (item.frameRef ? item : { ...item, frameRef }))
}

function decorateFrameScopedResponse(response: unknown, frameRef?: string) {
  const normalizedFrameRef = normalizePublicFrameRef(frameRef)
  if (!normalizedFrameRef || normalizedFrameRef === '@main' || !response || typeof response !== 'object') {
    return response
  }

  const next = { ...(response as Record<string, unknown>) }
  if (Array.isArray(next.matches)) {
    next.matches = decorateInteractiveElementsFrame(next.matches as Array<{ frameRef?: string }>, normalizedFrameRef)
  }
  if (next.snapshot && typeof next.snapshot === 'object') {
    const snapshot = { ...(next.snapshot as Record<string, unknown>) }
    if (Array.isArray(snapshot.interactiveElements)) {
      snapshot.interactiveElements = decorateInteractiveElementsFrame(
        snapshot.interactiveElements as Array<{ frameRef?: string }>,
        normalizedFrameRef
      )
    }
    next.snapshot = snapshot
  }
  return next
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runInTab<T>(tabId: number, func: (...args: any[]) => T, args: unknown[] = []): Promise<T> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  })
  return result.result as T
}

async function captureVisible(windowId: number, format: 'png' | 'jpeg' | 'webp' = 'png', quality?: number) {
  const chromeFormat = format === 'webp' ? 'png' : format
  return new Promise<string>((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, {
      format: chromeFormat,
      quality: chromeFormat === 'png' ? undefined : quality,
    }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        reject(new Error(chrome.runtime.lastError?.message ?? '截图失败'))
      } else {
        resolve(dataUrl)
      }
    })
  })
}

async function blobToDataUrl(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
  return `data:${blob.type};base64,${base64}`
}

async function dataUrlToBitmap(dataUrl: string) {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return createImageBitmap(blob)
}

async function canvasToDataUrl(canvas: OffscreenCanvas, format: 'png' | 'jpeg' | 'webp' = 'png', quality?: number) {
  const blob = await canvas.convertToBlob({
    type: format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp',
    quality: format === 'png' ? undefined : quality,
  })
  return blobToDataUrl(blob)
}

async function cropDataUrl(dataUrl: string, rect: { top: number; left: number; width: number; height: number }, dpr: number, format: 'png' | 'jpeg' | 'webp', quality?: number) {
  const bitmap = await dataUrlToBitmap(dataUrl)
  const sx = Math.max(0, Math.floor(rect.left * dpr))
  const sy = Math.max(0, Math.floor(rect.top * dpr))
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.ceil(rect.width * dpr)))
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.ceil(rect.height * dpr)))
  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建截图裁剪上下文')
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvasToDataUrl(canvas, format, quality)
}

async function saveDataUrl(filename: string, dataUrl: string) {
  return new Promise<number>((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
      if (chrome.runtime.lastError || typeof id !== 'number') {
        reject(new Error(chrome.runtime.lastError?.message ?? '下载失败'))
      } else {
        resolve(id)
      }
    })
  })
}

async function captureFullPage(tab: chrome.tabs.Tab, options: {
  format: 'png' | 'jpeg' | 'webp'
  quality?: number
  pageMetrics?: {
    viewportWidth: number
    viewportHeight: number
    scrollWidth: number
    scrollHeight: number
    scrollX: number
    scrollY: number
    devicePixelRatio: number
  }
}) {
  if (!tab.id || !tab.windowId) throw new Error('目标 tab 不可用')
  const metrics = options.pageMetrics ?? await runInTab(tab.id, () => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio || 1,
  }))
  const dpr = metrics.devicePixelRatio || 1
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(metrics.scrollWidth * dpr)),
    Math.max(1, Math.ceil(metrics.scrollHeight * dpr))
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建全页截图画布')

  const positions: number[] = []
  for (let y = 0; y < metrics.scrollHeight; y += metrics.viewportHeight) {
    positions.push(y)
  }

  try {
    await runInTab(tab.id, () => {
      document.documentElement.style.scrollBehavior = 'auto'
      document.body.style.scrollBehavior = 'auto'
    })
    for (const y of positions) {
      await runInTab(tab.id, (scrollY: number) => window.scrollTo(0, scrollY), [y])
      await sleep(120)
      const dataUrl = await captureVisible(tab.windowId, options.format, options.quality)
      const bitmap = await dataUrlToBitmap(dataUrl)
      const visibleHeight = Math.min(metrics.viewportHeight, metrics.scrollHeight - y)
      const drawHeight = Math.max(1, Math.floor(visibleHeight * dpr))
      ctx.drawImage(bitmap, 0, 0, bitmap.width, drawHeight, 0, Math.floor(y * dpr), bitmap.width, drawHeight)
    }
  } finally {
    await runInTab(tab.id, (x: number, y: number) => {
      window.scrollTo(x, y)
      document.documentElement.style.scrollBehavior = ''
      document.body.style.scrollBehavior = ''
    }, [metrics.scrollX, metrics.scrollY]).catch(() => undefined)
  }

  return canvasToDataUrl(canvas, options.format, options.quality)
}

function buildCookieUrl(cookie: { domain: string; path: string; secure?: boolean }) {
  const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`
}

function maskCookieValue(value: string) {
  if (!value) return ''
  if (value.length <= 8) return `${value.slice(0, 1)}***${value.slice(-1)}`
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

function toLocator(target: unknown) {
  if (typeof target !== 'string' || !target.trim()) return {}
  const trimmed = target.trim()
  return trimmed.startsWith('@') ? { ref: trimmed } : { selector: trimmed }
}

async function executeBrowserCommand(command: BrowserCommand): Promise<unknown> {
  const args = command.arguments ?? {}

  switch (command.name) {
    case 'browser_tabs': {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'list') {
        const scopeResult = parseTabListScope(args.scope)
        if ('error' in scopeResult) return { success: false, error: scopeResult.error }
        const tabs = await listTabs(scopeResult.scope)
        return { success: true, action, tabs: tabs.map((tab) => serializeTab(tab)), scope: scopeResult.scope }
      }
      if (action === 'current') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        const tab = tabs[0]
        if (!tab?.id) return { success: false, error: '没有活跃标签页' }
        return { success: true, action, tab: serializeTab(tab) }
      }
      if (action === 'new') {
        const created = await chrome.tabs.create({
          url: typeof args.url === 'string' ? args.url : 'about:blank',
          active: args.active === true,
        })
        return { success: true, action, tab: serializeTab(created) }
      }
      if (action === 'close') {
        const target = await resolveCommandTab(args.tabId, command.name)
        if (!target.success) return target
        await chrome.tabs.remove(target.tab.id!)
        return { success: true, action, tabId: target.tab.id }
      }
      if (action === 'select') {
        const target = await resolveCommandTab(args.tabId, command.name)
        if (!target.success) return target
        await chrome.tabs.update(target.tab.id!, { active: true })
        if (target.tab.windowId) await chrome.windows.update(target.tab.windowId, { focused: true })
        return { success: true, action, tabId: target.tab.id }
      }
      return { success: false, error: `browser_tabs 不支持 action=${action}` }
    }

    case 'browser_navigate': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success || typeof args.url !== 'string') {
        return target.success ? { success: false, error: '缺少目标标签页或 URL' } : target
      }
      const targetTabId = target.tab.id!
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

    case 'browser_navigate_back': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      await chrome.scripting.executeScript({ target: { tabId: target.tab.id! }, func: () => history.back() })
      return waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_navigate_forward': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      await chrome.scripting.executeScript({ target: { tabId: target.tab.id! }, func: () => history.forward() })
      return waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_reload': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      await chrome.tabs.reload(target.tab.id!)
      return waitForNavigation(target.tab.id!, Number(args.timeoutMs) || 10_000)
    }

    case 'browser_snapshot': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
        target.tab,
        {
          type: 'BROWSER_A11Y_SNAPSHOT',
          payload: {
            maxNodes: args.depth ? Number(args.depth) * 20 : undefined,
            maxDepth: args.depth,
            frameRef,
            ...toLocator(args.target),
          },
        },
        { frameRef }
      )
      if (!result.success) return { success: false, error: result.error }
      return { ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: target.tab.id! }
    }

    case 'browser_frames': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      if (isMockPageUrl(target.tab.url)) {
        const result = await relayToContentScript(target.tab, {
          type: 'GET_FRAMES',
          payload: { includeMainFrame: args.includeMainFrame !== false },
        })
        if (!result.success) return { success: false, error: result.error }
        return { ...(result.response as object), tabId: target.tab.id! }
      }
      const frames = await listBrowserFrames(target.tab, args.includeMainFrame !== false)
      return { success: true, frames, tabId: target.tab.id! }
    }

    case 'browser_debug_dom': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(target.tab, {
        type: 'BROWSER_SNAPSHOT',
        payload: {
          frameRef,
          includeHtml: true,
          textOffset: args.textOffset,
          maxTextLength: args.maxTextLength,
          htmlOffset: args.htmlOffset,
          maxHtmlLength: args.maxHtmlLength,
          interactiveLimit: args.interactiveLimit,
        },
      }, { frameRef })
      if (!result.success) return { success: false, error: result.error }
      return { ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: target.tab.id! }
    }

    case 'browser_query_elements':
    case 'browser_get_element': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const payload = command.name === 'browser_get_element' ? { ...args, limit: 1 } : args
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const result = await relayToContentScript(target.tab, { type: 'QUERY_ELEMENTS', payload }, { frameRef })
      if (!result.success) return { success: false, error: result.error }
      return { ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: target.tab.id! }
    }

    case 'browser_wait_for': {
      if (typeof args.time === 'number' && Number.isFinite(args.time)) {
        const waitedMs = Math.max(0, args.time * 1000)
        await sleep(waitedMs)
        return { success: true, waitedMs }
      }
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      if (typeof args.text === 'string') {
        const result = await relayToContentScript(target.tab, { type: 'WAIT_FOR_TEXT', payload: { text: args.text, timeoutMs: args.timeoutMs, pollIntervalMs: args.pollIntervalMs } })
        if (!result.success) return { success: false, error: result.error }
        return { ...(result.response as object), tabId: target.tab.id! }
      }
      if (typeof args.textGone === 'string') {
        const result = await relayToContentScript(target.tab, { type: 'WAIT_FOR_DISAPPEAR', payload: { text: args.textGone, timeoutMs: args.timeoutMs, pollIntervalMs: args.pollIntervalMs } })
        if (!result.success) return { success: false, error: result.error }
        return { ...(result.response as object), tabId: target.tab.id! }
      }
      return { success: false, error: 'browser_wait_for 需要 time、text 或 textGone 之一' }
    }

    case 'browser_click':
    case 'browser_hover':
    case 'browser_type':
    case 'browser_select_option':
    case 'browser_press_key':
    case 'browser_scroll':
    case 'browser_take_screenshot':
    case 'browser_file_upload': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const navigationSensitive = command.name === 'browser_click' || command.name === 'browser_press_key'
      const beforeSurface = navigationSensitive
        ? {
            tabUrl: target.tab.url,
            framesSummary: summarizeFramesForComparison(await listBrowserFrames(target.tab, true)),
          }
        : undefined
      const actionMap: Record<string, BrowserActionRequest['action']> = {
        browser_click: args.doubleClick === true ? 'double_click' : 'click',
        browser_hover: 'hover',
        browser_type: 'fill',
        browser_select_option: 'select',
        browser_press_key: 'press',
        browser_scroll: 'scroll',
        browser_take_screenshot: 'screenshot',
        browser_file_upload: 'upload_file',
      }
      const payload: Record<string, unknown> = {
        frameRef,
        ...toLocator(args.target),
        text: args.text,
        role: args.role,
        index: args.index,
        action: actionMap[command.name],
        value: args.text,
        values: Array.isArray(args.values) ? args.values : undefined,
        key: args.key,
        direction: args.direction,
        pixels: args.pixels,
        files: Array.isArray(args.files) ? args.files : undefined,
        fullPage: args.fullPage,
        format: args.type,
        quality: args.quality,
        filename: args.filename,
        allowDangerousAction: args.allowDangerousAction === true,
        fallbackMode: typeof args.fallbackMode === 'string'
          ? args.fallbackMode
          : (isMockPageUrl(target.tab.url) ? 'aggressive' : 'conservative'),
      }
      const result = await relayToContentScript(target.tab, { type: 'EXECUTE_ACTION', payload }, { frameRef })
      if (!result.success) {
        if (navigationSensitive && beforeSurface && target.tab.id && isMessageChannelClosedError(result.error)) {
          const surface = await waitForSurfaceChange(target.tab.id, beforeSurface)
          if (surface.changed) {
            return {
              success: true,
              message: '动作已触发页面跳转，消息通道在导航过程中关闭',
              navigationDetected: true,
              url: surface.tab?.url ?? '',
              title: surface.tab?.title ?? '',
              frames: surface.frames,
              tabId: target.tab.id,
            }
          }
        }
        return { success: false, error: result.error }
      }
      return { ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: target.tab.id! }
    }

    case 'browser_drag': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const result = await relayToContentScript(target.tab, {
        type: 'DRAG',
        payload: {
          from: {
            frameRef,
            ...toLocator(args.startTarget),
          },
          to: {
            frameRef,
            ...toLocator(args.endTarget),
          },
        },
      }, { frameRef })
      if (!result.success) return { success: false, error: result.error }
      return { ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: target.tab.id! }
    }

    case 'browser_fill_form': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const result = await relayToContentScript(target.tab, {
        type: 'FILL_FORM',
        payload: {
          frameRef,
          elements: args.elements,
        },
      }, { frameRef })
      if (!result.success) return { success: false, error: result.error }
      return { ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: target.tab.id! }
    }

    case 'browser_evaluate': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      const result = await relayToContentScript(target.tab, {
        type: 'EVALUATE',
        payload: {
          frameRef,
          ...toLocator(args.target),
          function: args.function,
          expression: args.expression,
          args: args.args,
        },
      }, { frameRef })
      if (!result.success) return { success: false, error: result.error }
      return safeSerialize(result.response)
    }

    case 'browser_run_code': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const code = typeof args.code === 'string' ? args.code : ''
      if (!code) return { success: false, error: '缺少 code 参数' }
      const frameRef = typeof args.frameRef === 'string' ? args.frameRef : undefined
      try {
        const result = await relayToContentScript(target.tab, {
          type: 'RUN_CODE',
          payload: {
            frameRef,
            code,
            args: Array.isArray(args.args) ? args.args : [],
          },
        }, { frameRef })
        if (!result.success) return { success: false, error: result.error }
        return safeSerialize(result.response)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    case 'browser_console_messages': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const result = await relayToContentScript(target.tab, {
        type: 'GET_CONSOLE_MESSAGES',
        payload: {
          cursor: args.cursor,
          limit: args.limit,
          levels: args.level ? [args.level] : args.levels,
          text: args.text,
        },
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.tab.id! }
    }

    case 'browser_network_requests': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const result = await relayToContentScript(target.tab, {
        type: 'GET_NETWORK_REQUESTS',
        payload: args,
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.tab.id! }
    }

    case 'browser_get_network_request': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const result = await relayToContentScript(target.tab, {
        type: 'GET_NETWORK_REQUEST',
        payload: args,
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.tab.id! }
    }

    case 'browser_cookie_list': {
      const query: chrome.cookies.GetAllDetails = {}
      if (typeof args.url === 'string') query.url = args.url
      if (typeof args.domain === 'string') query.domain = args.domain
      if (typeof args.name === 'string') query.name = args.name
      const cookies = await chrome.cookies.getAll(query)
      const allowSensitive = args.includeValue === true && args.allowSensitive === true
      return {
        success: true,
        count: cookies.length,
        sensitiveValuesExposed: allowSensitive,
        cookies: cookies.map((cookie) => ({
          name: cookie.name,
          value: allowSensitive ? cookie.value : undefined,
          valueMasked: allowSensitive ? undefined : maskCookieValue(cookie.value),
          valueLength: cookie.value.length,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          session: cookie.session,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate,
        })),
      }
    }

    case 'browser_cookie_set': {
      const cookie = await chrome.cookies.set({
        url: String(args.url),
        name: String(args.name),
        value: String(args.value ?? ''),
        domain: typeof args.domain === 'string' ? args.domain : undefined,
        path: typeof args.path === 'string' ? args.path : undefined,
        secure: args.secure === true,
        httpOnly: args.httpOnly === true,
        sameSite: typeof args.sameSite === 'string' ? args.sameSite as chrome.cookies.SameSiteStatus : undefined,
        expirationDate: typeof args.expirationDate === 'number' ? args.expirationDate : undefined,
      })
      return { success: true, cookie }
    }

    case 'browser_cookie_delete': {
      const listQuery: chrome.cookies.GetAllDetails = { name: String(args.name) }
      if (typeof args.url === 'string') listQuery.url = args.url
      if (typeof args.domain === 'string') listQuery.domain = args.domain
      const cookies = await chrome.cookies.getAll(listQuery)
      const exactMatches = cookies.filter((cookie) => !args.path || cookie.path === args.path)
      if (exactMatches.length > 1) {
        return {
          success: false,
          error: '匹配到多个 cookie，请补充更精确的 url/domain/path 后再删除，避免误伤登录态',
          matches: exactMatches.map((cookie) => ({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
          })),
        }
      }
      const targetCookie = exactMatches[0]
      if (!targetCookie) return { success: false, error: '没有匹配到要删除的 cookie' }
      await chrome.cookies.remove({ url: typeof args.url === 'string' ? args.url : buildCookieUrl(targetCookie), name: targetCookie.name })
      return { success: true, removed: { name: targetCookie.name, domain: targetCookie.domain, path: targetCookie.path } }
    }

    case 'browser_cookie_clear': {
      const listQuery: chrome.cookies.GetAllDetails = {}
      if (typeof args.url === 'string') listQuery.url = args.url
      if (typeof args.domain === 'string') listQuery.domain = args.domain
      if (!listQuery.url && !listQuery.domain) {
        return { success: false, error: 'browser_cookie_clear 需要显式传入 url 或 domain，避免误清空其它站点登录态' }
      }
      const cookies = await chrome.cookies.getAll(listQuery)
      await Promise.all(cookies.map((cookie) => chrome.cookies.remove({ url: buildCookieUrl(cookie), name: cookie.name })))
      return { success: true, cleared: cookies.length }
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

    case 'browser_wait_for_request':
    case 'browser_wait_for_response': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const result = await relayToContentScript(target.tab, {
        type: command.name === 'browser_wait_for_request' ? 'WAIT_FOR_NETWORK_REQUEST' : 'WAIT_FOR_NETWORK_RESPONSE',
        payload: args,
      })
      if (!result.success) return { success: false, error: result.error }
      return { ...(result.response as object), tabId: target.tab.id! }
    }

    case 'browser_wait_for_download':
      initializeObservability()
      return waitForDownload(args as WaitForDownloadRequest)

    case 'browser_handle_dialog': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      if (isMockPageUrl(target.tab.url)) {
        return {
          success: false,
          error: 'mock 页面暂未实现原生 JS dialog 桥接，请改用页面内 mock 按钮或表单控件模拟',
          alternatives: ['在 mock 页面直接操作 DOM 弹层', '在真实页面用 browser_get_element + browser_click 处理站点自定义弹层'],
        }
      }
      return {
        success: false,
        error: '为避免通过覆写 alert/confirm/prompt 暴露自动化痕迹，真实站点默认禁用 browser_handle_dialog',
        alternatives: ['优先处理页面内自定义弹层', '对原生 JS dialog 改为人工接管', '如需测试原生 dialog，请在离线 mock 页面中建专用流程'],
      }
    }

    case 'browser_resize': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success || !target.tab.windowId) return target.success ? { success: false, error: '目标标签页没有 windowId' } : target
      await chrome.windows.update(target.tab.windowId, {
        width: Number(args.width),
        height: Number(args.height),
      })
      return { success: true, tabId: target.tab.id, windowId: target.tab.windowId, width: Number(args.width), height: Number(args.height) }
    }

    case 'browser_emulate': {
      const target = await resolveCommandTab(args.tabId, command.name)
      if (!target.success) return target
      const unsupported = [
        typeof args.deviceScaleFactor === 'number' ? 'deviceScaleFactor' : null,
        args.mobile === true ? 'mobile' : null,
        args.touch === true ? 'touch' : null,
        typeof args.userAgent === 'string' ? 'userAgent' : null,
        typeof args.locale === 'string' ? 'locale' : null,
        typeof args.colorScheme === 'string' ? 'colorScheme' : null,
        typeof args.timezoneId === 'string' ? 'timezoneId' : null,
        typeof args.latitude === 'number' ? 'latitude/longitude' : null,
      ].filter(Boolean)

      const applied: Record<string, unknown> = {}
      if (typeof args.width === 'number' || typeof args.height === 'number') {
        if (!target.tab.windowId) {
          return { success: false, error: '目标标签页没有 windowId，无法使用 resize 作为 emulate 的安全降级路径' }
        }
        await chrome.windows.update(target.tab.windowId, {
          width: typeof args.width === 'number' ? args.width : undefined,
          height: typeof args.height === 'number' ? args.height : undefined,
        })
        applied.width = typeof args.width === 'number' ? args.width : target.tab.width
        applied.height = typeof args.height === 'number' ? args.height : target.tab.height
      }

      if (args.reset === true && unsupported.length === 0 && Object.keys(applied).length === 0) {
        return {
          success: true,
          tabId: target.tab.id,
          mode: 'stealth_noop',
          message: 'stealth 模式下没有残留的 debug emulation 状态可清理',
        }
      }

      return {
        success: true,
        tabId: target.tab.id,
        mode: Object.keys(applied).length > 0 ? 'resize_fallback' : 'stealth_noop',
        applied,
        ignored: unsupported,
        message: unsupported.length > 0
          ? '已使用安全降级路径，仅保留窗口尺寸调整；其余 emulate 参数因需要浏览器 debug 能力而被忽略'
          : '已使用安全降级路径调整窗口尺寸',
      }
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
      const content = typeof args.content === 'string' ? args.content : JSON.stringify(args.content ?? {}, null, 2)
      const mimeTypes: Record<string, string> = { json: 'application/json', csv: 'text/csv', txt: 'text/plain' }
      const dataUrl = `data:${mimeTypes[format] ?? 'text/plain'};charset=utf-8,${encodeURIComponent(content)}`
      const downloadId = await saveDataUrl(filename, dataUrl)
      return { success: true, filename, format, downloadId }
    }
  }

  return { success: false, error: `暂不支持的命令: ${command.name}` }
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
          const frameRef = typeof (message.payload as { frameRef?: unknown } | undefined)?.frameRef === 'string'
            ? (message.payload as { frameRef?: string }).frameRef
            : undefined
          const result = await relayToContentScript<{ success: boolean; snapshot?: unknown; error?: string }>(
            tab,
            { type: 'BROWSER_SNAPSHOT', payload: message.payload },
            { frameRef }
          )
          if (!result.success) {
            sendResponse({ success: false, error: result.error })
            return
          }
          sendResponse({ ...(decorateFrameScopedResponse(result.response, frameRef) as object), tabId: tab.id })
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
          const frameRef = typeof (message.payload as { frameRef?: unknown } | undefined)?.frameRef === 'string'
            ? (message.payload as { frameRef?: string }).frameRef
            : undefined
          const result = await relayToContentScript(tab, { type: message.type, payload: message.payload }, { frameRef })
          if (!result.success) sendResponse({ success: false, error: result.error })
          else sendResponse(decorateFrameScopedResponse(result.response, frameRef))
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
          try {
            const payload = (message.payload ?? {}) as {
              targetRect?: { top: number; left: number; width: number; height: number }
              fullPage?: boolean
              format?: 'png' | 'jpeg' | 'webp'
              quality?: number
              filename?: string
              pageMetrics?: {
                viewportWidth: number
                viewportHeight: number
                scrollWidth: number
                scrollHeight: number
                scrollX: number
                scrollY: number
                devicePixelRatio: number
              }
            }
            const format = payload.format ?? 'png'
            if (payload.fullPage && !isMockPageUrl(tab.url)) {
              sendResponse({
                success: false,
                error: '真实站点默认禁用 fullPage 截图，因为它需要滚动页面并可能触发曝光埋点或风控。请改用当前视口截图或元素截图',
                alternatives: ['browser_take_screenshot(fullPage=false)', 'browser_take_screenshot + target 元素截图'],
              })
              return
            }
            let dataUrl = payload.fullPage
              ? await captureFullPage(tab, {
                format,
                quality: payload.quality,
                pageMetrics: payload.pageMetrics,
              })
              : await captureVisible(tab.windowId, format, payload.quality)

            if (!payload.fullPage && payload.targetRect) {
              dataUrl = await cropDataUrl(
                dataUrl,
                payload.targetRect,
                payload.pageMetrics?.devicePixelRatio ?? 1,
                format,
                payload.quality
              )
            }

            if (payload.filename) {
              const downloadId = await saveDataUrl(payload.filename, dataUrl)
              sendResponse({ success: true, dataUrl, filename: payload.filename, downloadId })
            } else {
              sendResponse({ success: true, dataUrl })
            }
          } catch (error) {
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
          }
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
