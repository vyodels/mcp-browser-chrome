import type { BrowserCommand, SnapshotRequest } from '../shared/protocol'
import { relayToContentScript, resolveTab } from './contentBridge'
import { createNativeHostBridge } from './nativeHost'

const DEFAULT_DOWNLOAD_LOCATE_LIMIT = 10
const DEFAULT_DOWNLOAD_LOCATE_WAIT_MS = 0
const DEFAULT_DOWNLOAD_LOCATE_POLL_MS = 500
const MAX_DOWNLOAD_LOCATE_WAIT_MS = 3_000

type DownloadState = 'in_progress' | 'interrupted' | 'complete'

type DownloadSourceMatch = {
  input: string
  field: 'url' | 'finalUrl' | 'referrer'
  mode: 'exact' | 'regex'
  value: string
}

type DownloadSourceCriteria = {
  sourceUrls: string[]
  sourceUrlRegexes: string[]
  finalUrls: string[]
  finalUrlRegexes: string[]
  referrers: string[]
  referrerRegexes: string[]
  required: boolean
}

type DownloadFileNameMatch = {
  input: string
  mode: 'exact' | 'chrome_collision_suffix'
  value: string
}

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

async function getFocusedWindowId(): Promise<number | undefined> {
  const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
  return focusedWindow?.id
}

async function getFocusedActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const focusedWindowId = await getFocusedWindowId()
  const tabs = await chrome.tabs.query(focusedWindowId ? { active: true, windowId: focusedWindowId } : { active: true, currentWindow: true })
  return tabs[0]
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function parseReusableTabUrl(rawUrl: string): { href: string; origin: string } | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return undefined
    parsed.hash = ''
    return { href: parsed.href, origin: parsed.origin }
  } catch {
    return undefined
  }
}

function tabUrlReuseScore(tab: chrome.tabs.Tab, target: { href: string; origin: string }, focusedWindowId?: number): number {
  if (!tab.url) return -1
  const current = parseReusableTabUrl(tab.url)
  if (!current) return -1

  let score = -1
  if (current.href === target.href) {
    score = 100
  } else if (current.origin === target.origin) {
    score = 50
  }
  if (score < 0) return score
  if (focusedWindowId && tab.windowId === focusedWindowId) score += 10
  if (tab.active) score += 5
  return score
}

async function findReusableTabForUrl(url: string, requestedWindowId?: number): Promise<{ tab: chrome.tabs.Tab; reason: 'exact_url' | 'same_origin' } | undefined> {
  const target = parseReusableTabUrl(url)
  if (!target) return undefined

  const focusedWindowId = requestedWindowId ?? await getFocusedWindowId()
  const tabs = await chrome.tabs.query(requestedWindowId ? { windowId: requestedWindowId } : {})
  const candidates = tabs
    .map((tab) => ({ tab, score: tabUrlReuseScore(tab, target, focusedWindowId) }))
    .filter((candidate) => candidate.score >= 0 && candidate.tab.id)
    .sort((a, b) => b.score - a.score || (a.tab.index ?? 0) - (b.tab.index ?? 0))
  const best = candidates[0]
  if (!best) return undefined
  return {
    tab: best.tab,
    reason: best.score >= 100 ? 'exact_url' : 'same_origin',
  }
}

async function moveTabToOwnWindowIfNeeded(tab: chrome.tabs.Tab, focused: boolean): Promise<chrome.tabs.Tab> {
  if (!tab.id) throw new Error('Cannot detach tab without a tab id')
  if (!tab.windowId) return tab

  const windowTabs = await chrome.tabs.query({ windowId: tab.windowId })
  if (windowTabs.length <= 1) {
    if (focused) await chrome.windows.update(tab.windowId, { focused: true })
    return await chrome.tabs.get(tab.id)
  }

  const createdWindow = await chrome.windows.create({ tabId: tab.id, focused })
  return createdWindow.tabs?.[0] ?? await chrome.tabs.get(tab.id)
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
  const target = typeof targetTabId === 'number'
    ? await chrome.tabs.get(targetTabId).catch(() => null)
    : await getFocusedActiveTab()
  if (!target?.id || !target.windowId) {
    return { success: false, error: '没有活跃标签页' }
  }
  const [windowActiveTab] = await chrome.tabs.query({ active: true, windowId: target.windowId })
  if (!target.active || windowActiveTab?.id !== target.id) {
    return {
      success: false,
      error: 'browser_screenshot 只能截取目标窗口当前活跃标签页；请先显式调用 browser_select_tab 激活目标页',
      tabId: target.id,
      windowId: target.windowId,
      target: describeTargetTab(target),
    }
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
  const current = await chrome.tabs.get(tabId).catch(() => null)
  if (current?.status === 'complete') {
    return {
      success: true,
      matched: true,
      elapsedMs: 0,
      tabId,
      url: current.url ?? '',
      title: current.title ?? '',
    }
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseStringList(...values: unknown[]): string[] {
  const results: string[] = []
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = asTrimmedString(item)
        if (normalized) results.push(normalized)
      }
      continue
    }
    const normalized = asTrimmedString(value)
    if (normalized) results.push(normalized)
  }
  return [...new Set(results)]
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function asNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function chromeDownloadFilenameRegex(fileName: string): string {
  const leafName = basename(fileName)
  const dot = leafName.lastIndexOf('.')
  if (dot <= 0 || dot === leafName.length - 1) {
    return `(^|[\\\\/])${escapeRegExp(leafName)}$`
  }

  const stem = leafName.slice(0, dot)
  const extension = leafName.slice(dot)
  const alreadyDisambiguated = / \(\d+\)$/.test(stem)
  const escapedStem = escapeRegExp(stem)
  const suffix = alreadyDisambiguated ? '' : '(?: \\(\\d+\\))?'
  return `(^|[\\\\/])${escapedStem}${suffix}${escapeRegExp(extension)}$`
}

function fileNameMatch(item: chrome.downloads.DownloadItem, expectedFileName: string | undefined): DownloadFileNameMatch | undefined {
  if (!expectedFileName) return undefined
  const expected = basename(expectedFileName)
  const actual = basename(item.filename)
  if (actual === expected) {
    return { input: expected, mode: 'exact', value: actual }
  }

  const dot = expected.lastIndexOf('.')
  if (dot <= 0 || dot === expected.length - 1) return undefined
  const stem = expected.slice(0, dot)
  const extension = expected.slice(dot)
  if (new RegExp(`^${escapeRegExp(stem)} \\(\\d+\\)${escapeRegExp(extension)}$`).test(actual)) {
    return { input: expected, mode: 'chrome_collision_suffix', value: actual }
  }
  return undefined
}

function normalizeExtension(value: string): string {
  return value.trim().replace(/^\./, '').toLowerCase()
}

function parseExpectedExtensions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item === 'string' ? normalizeExtension(item) : '')
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(normalizeExtension)
      .filter(Boolean)
  }
  return []
}

function parseDownloadStates(value: unknown): DownloadState[] {
  const allowed = new Set(['in_progress', 'interrupted', 'complete'])
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : [])
  return values
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item): item is DownloadState => allowed.has(item))
}

function fileExtension(filePath: string): string {
  const name = basename(filePath)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function normalizeIsoTime(value: unknown): string | undefined {
  const raw = asTrimmedString(value)
  if (!raw) return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function parseDownloadSourceCriteria(args: Record<string, unknown>): DownloadSourceCriteria {
  const sourceUrls = parseStringList(
    args.sourceUrl,
    args.sourceUrls,
    args.sourceUrlCandidates,
    args.downloadUrl,
    args.downloadUrls,
    args.href,
  )
  const sourceUrlRegexes = parseStringList(args.sourceUrlRegex, args.sourceUrlRegexes, args.downloadUrlRegex, args.hrefRegex)
  const finalUrls = parseStringList(args.finalUrl, args.finalUrls)
  const finalUrlRegexes = parseStringList(args.finalUrlRegex, args.finalUrlRegexes)
  const referrers = parseStringList(args.referrer, args.referrers)
  const referrerRegexes = parseStringList(args.referrerRegex, args.referrerRegexes)
  const required = args.requireSourceCorrelation === true
    || sourceUrls.length > 0
    || sourceUrlRegexes.length > 0
    || finalUrls.length > 0
    || finalUrlRegexes.length > 0
    || referrers.length > 0
    || referrerRegexes.length > 0
  return {
    sourceUrls,
    sourceUrlRegexes,
    finalUrls,
    finalUrlRegexes,
    referrers,
    referrerRegexes,
    required,
  }
}

function regexMatches(value: string | undefined, pattern: string): boolean {
  if (!value) return false
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

function exactMatches(value: string | undefined, expected: string): boolean {
  return !!value && value === expected
}

function sourceMatch(
  item: chrome.downloads.DownloadItem,
  criteria: DownloadSourceCriteria,
): DownloadSourceMatch | undefined {
  for (const expected of criteria.sourceUrls) {
    if (exactMatches(item.url, expected)) return { input: expected, field: 'url', mode: 'exact', value: item.url }
    if (exactMatches(item.finalUrl, expected)) return { input: expected, field: 'finalUrl', mode: 'exact', value: item.finalUrl }
  }
  for (const pattern of criteria.sourceUrlRegexes) {
    if (regexMatches(item.url, pattern)) return { input: pattern, field: 'url', mode: 'regex', value: item.url }
    if (regexMatches(item.finalUrl, pattern)) return { input: pattern, field: 'finalUrl', mode: 'regex', value: item.finalUrl }
  }
  for (const expected of criteria.finalUrls) {
    if (exactMatches(item.finalUrl, expected)) return { input: expected, field: 'finalUrl', mode: 'exact', value: item.finalUrl }
  }
  for (const pattern of criteria.finalUrlRegexes) {
    if (regexMatches(item.finalUrl, pattern)) return { input: pattern, field: 'finalUrl', mode: 'regex', value: item.finalUrl }
  }
  for (const expected of criteria.referrers) {
    if (exactMatches(item.referrer, expected)) return { input: expected, field: 'referrer', mode: 'exact', value: item.referrer }
  }
  for (const pattern of criteria.referrerRegexes) {
    if (regexMatches(item.referrer, pattern)) return { input: pattern, field: 'referrer', mode: 'regex', value: item.referrer }
  }
  return undefined
}

function matchesDownloadSource(item: chrome.downloads.DownloadItem, criteria: DownloadSourceCriteria): boolean {
  if (!criteria.required) return true
  return !!sourceMatch(item, criteria)
}

function compactSourceCriteria(criteria: DownloadSourceCriteria) {
  return {
    sourceUrls: criteria.sourceUrls,
    sourceUrlRegexes: criteria.sourceUrlRegexes,
    finalUrls: criteria.finalUrls,
    finalUrlRegexes: criteria.finalUrlRegexes,
    referrers: criteria.referrers,
    referrerRegexes: criteria.referrerRegexes,
    required: criteria.required,
  }
}

function compactDownloadItem(item: chrome.downloads.DownloadItem) {
  return {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    referrer: item.referrer,
    filename: item.filename,
    fileName: basename(item.filename),
    extension: fileExtension(item.filename),
    mime: item.mime,
    state: item.state,
    exists: item.exists,
    danger: item.danger,
    paused: item.paused,
    canResume: item.canResume,
    error: item.error,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    fileSize: item.fileSize,
    startTime: item.startTime,
    endTime: item.endTime,
    estimatedEndTime: item.estimatedEndTime,
    byExtensionId: item.byExtensionId,
    byExtensionName: item.byExtensionName,
    incognito: item.incognito,
  }
}

function downloadIsSafe(item: chrome.downloads.DownloadItem): boolean {
  return !item.danger || item.danger === 'safe' || item.danger === 'accepted'
}

function matchesLocatedArtifact(
  item: chrome.downloads.DownloadItem,
  criteria: {
    expectedExtensions: string[]
    states: DownloadState[]
    requireExists: boolean
    requireComplete: boolean
    requireSafe: boolean
    source: DownloadSourceCriteria
  },
): boolean {
  if (criteria.states.length && !criteria.states.includes(item.state)) return false
  if (criteria.requireComplete && item.state !== 'complete') return false
  if (criteria.requireExists && item.exists !== true) return false
  if (criteria.requireSafe && !downloadIsSafe(item)) return false
  if (criteria.expectedExtensions.length && !criteria.expectedExtensions.includes(fileExtension(item.filename))) return false
  if (!matchesDownloadSource(item, criteria.source)) return false
  return true
}

async function locateDownload(args: Record<string, unknown>) {
  if (!chrome.downloads?.search) {
    return { success: false, found: false, located: false, error: 'chrome.downloads API unavailable; extension must include downloads permission' }
  }

  const downloadId = Number(args.downloadId)
  const hasDownloadId = Number.isInteger(downloadId) && downloadId > 0
  const fileName = asTrimmedString(args.fileName) ?? asTrimmedString(args.filename)
  const filenameRegex = asTrimmedString(args.filenameRegex)
  const url = asTrimmedString(args.url)
  const urlRegex = asTrimmedString(args.urlRegex)
  const queryText = asTrimmedString(args.query)
  const source = parseDownloadSourceCriteria(args)
  const startedAfter = normalizeIsoTime(args.startedAfter ?? args.since)
  const endedAfter = normalizeIsoTime(args.endedAfter)
  const expectedExtensions = parseExpectedExtensions(args.expectedExtensions)
  const states = parseDownloadStates(args.states ?? args.state)
  const requireExists = args.requireExists === true
  const requireComplete = args.requireComplete === true
  const requireSafe = args.requireSafe === true
  const requireUnique = args.requireUnique === true
  const allowAmbiguous = args.allowAmbiguous === true
  const limit = Math.min(Math.max(Math.floor(asPositiveNumber(args.limit, DEFAULT_DOWNLOAD_LOCATE_LIMIT)), 1), 50)
  const waitMs = Math.min(Math.floor(asNonNegativeNumber(args.waitMs, DEFAULT_DOWNLOAD_LOCATE_WAIT_MS)), MAX_DOWNLOAD_LOCATE_WAIT_MS)
  const pollIntervalMs = Math.min(Math.floor(asPositiveNumber(args.pollIntervalMs, DEFAULT_DOWNLOAD_LOCATE_POLL_MS)), 5_000)

  const hasSelector = hasDownloadId
    || !!fileName
    || !!filenameRegex
    || !!url
    || !!urlRegex
    || !!queryText
    || source.required
    || !!startedAfter
    || !!endedAfter

  if (!hasSelector) {
    return {
      success: false,
      found: false,
      located: false,
      error: 'browser_locate_download requires at least one selector: downloadId, fileName, filenameRegex, url, urlRegex, sourceUrl, finalUrl, referrer, query, startedAfter, or endedAfter',
    }
  }

  const hasStructuredSelector = hasDownloadId
    || !!fileName
    || !!filenameRegex
    || !!url
    || !!urlRegex
    || source.required
    || !!startedAfter
    || !!endedAfter

  const query: chrome.downloads.DownloadQuery = {
    limit,
    orderBy: ['-startTime'],
  }
  if (hasDownloadId) query.id = downloadId
  if (fileName) query.filenameRegex = chromeDownloadFilenameRegex(fileName)
  else if (filenameRegex) query.filenameRegex = filenameRegex
  if (url) query.url = url
  else if (
    source.sourceUrls.length === 1
    && !fileName
    && !filenameRegex
    && !queryText
    && !startedAfter
    && !endedAfter
  ) {
    query.url = source.sourceUrls[0]
  }
  if (urlRegex) query.urlRegex = urlRegex
  else if (
    source.sourceUrlRegexes.length === 1
    && !fileName
    && !filenameRegex
    && !queryText
    && !startedAfter
    && !endedAfter
  ) {
    query.urlRegex = source.sourceUrlRegexes[0]
  }
  if (queryText) query.query = [queryText]
  if (startedAfter) query.startedAfter = startedAfter
  if (endedAfter) query.endedAfter = endedAfter
  if (requireComplete) query.state = 'complete'
  else if (states.length === 1) query.state = states[0]

  const structuredQuery = queryText && hasStructuredSelector ? { ...query } : undefined
  if (structuredQuery) delete structuredQuery.query

  const startedAt = Date.now()
  let items: chrome.downloads.DownloadItem[] = []
  let locatedItem: chrome.downloads.DownloadItem | undefined
  let candidateItems: chrome.downloads.DownloadItem[] = []
  let ambiguous = false
  let queryFallbackUsed = false

  while (true) {
    items = await chrome.downloads.search(query)
    candidateItems = items.filter((item) => matchesLocatedArtifact(item, {
      expectedExtensions,
      states,
      requireExists,
      requireComplete,
      requireSafe,
      source,
    }))
    ambiguous = candidateItems.length > 1
    locatedItem = ambiguous && requireUnique && !allowAmbiguous ? undefined : candidateItems[0]

    if (!locatedItem && structuredQuery) {
      const fallbackItems = await chrome.downloads.search(structuredQuery)
      const fallbackCandidates = fallbackItems.filter((item) => matchesLocatedArtifact(item, {
        expectedExtensions,
        states,
        requireExists,
        requireComplete,
        requireSafe,
        source,
      }))
      const fallbackAmbiguous = fallbackCandidates.length > 1
      const fallbackLocated = fallbackAmbiguous && requireUnique && !allowAmbiguous ? undefined : fallbackCandidates[0]
      if (fallbackLocated || (items.length === 0 && fallbackItems.length > 0)) {
        queryFallbackUsed = true
        items = fallbackItems
        candidateItems = fallbackCandidates
        ambiguous = fallbackAmbiguous
        locatedItem = fallbackLocated
      }
    }

    if (locatedItem || Date.now() - startedAt >= waitMs) break
    await sleep(pollIntervalMs)
  }

  const matches = items.map(compactDownloadItem)
  const candidates = candidateItems.map((item) => ({
    ...compactDownloadItem(item),
    fileNameMatch: fileNameMatch(item, fileName),
    sourceCorrelation: sourceMatch(item, source),
  }))
  const located = locatedItem
    ? {
        ...compactDownloadItem(locatedItem),
        fileNameMatch: fileNameMatch(locatedItem, fileName),
        sourceCorrelation: sourceMatch(locatedItem, source),
      }
    : undefined
  return {
    success: true,
    found: matches.length > 0,
    located: !!located,
    ambiguous,
    artifact: located,
    candidates,
    matches,
    count: matches.length,
    candidateCount: candidateItems.length,
    elapsedMs: Date.now() - startedAt,
    sourceCorrelation: {
      expected: compactSourceCriteria(source),
      matched: locatedItem ? sourceMatch(locatedItem, source) : undefined,
      required: source.required,
      ambiguous,
    },
    criteria: {
      downloadId: hasDownloadId ? downloadId : undefined,
      fileName,
      requestedFilenameRegex: filenameRegex,
      filenameRegex: query.filenameRegex,
      url,
      urlRegex,
      source: compactSourceCriteria(source),
      query: queryText,
      startedAfter,
      endedAfter,
      expectedExtensions,
      states,
      requireExists,
      requireComplete,
      requireSafe,
      requireUnique,
      allowAmbiguous,
      limit,
      waitMs,
      pollIntervalMs,
      pathLocationEvidence: requireExists ? 'chrome.downloads.search.exists' : 'not_required',
      queryFallback: structuredQuery
        ? {
            attempted: true,
            used: queryFallbackUsed,
            reason: 'structured_selectors_without_free_text_query',
          }
        : undefined,
    },
  }
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
      const tab = await getFocusedActiveTab()
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
      const tab = await getFocusedActiveTab()
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
      const hasUrl = typeof args.url === 'string'
      const url = hasUrl ? String(args.url) : 'about:blank'
      const active = args.active !== false
      const newWindow = args.newWindow === true
      const targetTabId = positiveInteger(args.tabId)
      const requestedWindowId = positiveInteger(args.windowId)
      let created: chrome.tabs.Tab
      let reused = false
      let reuseReason: string | undefined

      if (newWindow) {
        if (targetTabId) {
          await chrome.tabs.update(targetTabId, hasUrl ? { url, active: true } : { active: true })
          created = await moveTabToOwnWindowIfNeeded(await chrome.tabs.get(targetTabId), active)
          reused = true
          reuseReason = 'tab_id'
        } else {
          const reusable = hasUrl ? await findReusableTabForUrl(url, requestedWindowId) : undefined
          if (reusable?.tab.id) {
            const updated = await chrome.tabs.update(reusable.tab.id, hasUrl ? { url, active: true } : { active: true })
            created = await moveTabToOwnWindowIfNeeded(updated, active)
            reused = true
            reuseReason = reusable.reason
          } else {
            const createdWindow = await chrome.windows.create({ url, focused: active, type: 'normal' })
            created = createdWindow.tabs?.[0] ?? (await chrome.tabs.query({ windowId: createdWindow.id }))[0]
            if (!created) {
              throw new Error('Failed to resolve tab from newly created Chrome window')
            }
          }
        }
      } else {
        const focusedWindowId = requestedWindowId ?? await getFocusedWindowId()
        created = targetTabId
          ? await chrome.tabs.update(targetTabId, { url, active })
          : await chrome.tabs.create({ url, active, ...(focusedWindowId ? { windowId: focusedWindowId } : {}) })
        reused = !!targetTabId
        reuseReason = targetTabId ? 'tab_id' : undefined
      }

      if (active && created.windowId) {
        await chrome.windows.update(created.windowId, { focused: true })
      }

      return {
        success: true,
        tabId: created.id,
        reused,
        reuseReason,
        newWindow,
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

    case 'browser_locate_download':
      return await locateDownload(args)

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
