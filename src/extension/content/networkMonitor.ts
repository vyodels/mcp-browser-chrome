import { paginateItems } from '../shared/ai'
import type {
  GetNetworkRequestRequest,
  NetworkRequestsRequest,
  WaitForNetworkEventRequest,
} from '../shared/protocol'

type PassiveNetworkRecord = {
  id: string
  url: string
  method: 'UNKNOWN'
  resourceType: string
  initiatorType?: string
  status: 'completed'
  startedAt: number
  updatedAt: number
  completedAt: number
  durationMs: number
  transferSize?: number
  encodedBodySize?: number
  decodedBodySize?: number
  nextHopProtocol?: string
}

type NetworkWaiter = {
  matcher: WaitForNetworkEventRequest
  resolve: (value: unknown) => void
  timer: number
}

const MAX_REQUESTS = 400
const recordsById = new Map<string, PassiveNetworkRecord>()
const orderedIds: string[] = []
const seenKeys = new Set<string>()
const waiters = new Set<NetworkWaiter>()
let observer: PerformanceObserver | null = null
let sequence = 0

function matchesString(value: string | undefined, pattern: string | undefined, isRegex?: boolean) {
  if (!pattern) return true
  if (!value) return false
  if (!isRegex) return value.includes(pattern)
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return value.includes(pattern)
  }
}

function normalizeResourceType(initiatorType: string) {
  switch (initiatorType) {
    case 'xmlhttprequest':
      return 'xhr'
    case 'fetch':
      return 'fetch'
    case 'img':
      return 'image'
    case 'link':
      return 'stylesheet'
    case 'script':
      return 'script'
    case 'css':
      return 'stylesheet'
    case 'iframe':
      return 'document'
    default:
      return initiatorType || 'other'
  }
}

function buildTimingKey(entry: PerformanceResourceTiming) {
  return [
    entry.name,
    entry.initiatorType,
    entry.startTime.toFixed(3),
    entry.responseEnd.toFixed(3),
    entry.duration.toFixed(3),
  ].join('|')
}

function toPublicRecord(record: PassiveNetworkRecord, options: {
  includeRequestHeaders?: boolean
  includeResponseHeaders?: boolean
  includeRequestBody?: boolean
  includeResponseBody?: boolean
}) {
  return {
    id: record.id,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    initiatorType: record.initiatorType,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    transferSize: record.transferSize,
    encodedBodySize: record.encodedBodySize,
    decodedBodySize: record.decodedBodySize,
    nextHopProtocol: record.nextHopProtocol,
    requestHeaders: options.includeRequestHeaders ? null : undefined,
    responseHeaders: options.includeResponseHeaders ? null : undefined,
    requestBodyPreview: options.includeRequestBody ? null : undefined,
    responseBodyPreview: options.includeResponseBody ? null : undefined,
  }
}

function matchesRecord(record: PassiveNetworkRecord, matcher: WaitForNetworkEventRequest | NetworkRequestsRequest) {
  let pattern: string | undefined
  if ('pattern' in matcher) pattern = matcher.pattern
  if ('filter' in matcher) pattern = matcher.filter
  if (!matchesString(record.url, pattern, matcher.isRegex)) return false
  if ('method' in matcher && matcher.method && record.method !== matcher.method) return false
  if ('resourceType' in matcher && matcher.resourceType && record.resourceType !== matcher.resourceType) return false
  if ('methods' in matcher && matcher.methods?.length && !matcher.methods.includes(record.method)) return false
  if ('resourceTypes' in matcher && matcher.resourceTypes?.length && !matcher.resourceTypes.includes(record.resourceType)) return false
  if ('status' in matcher && matcher.status !== undefined) return false
  if ('statuses' in matcher && matcher.statuses?.length) return false
  return true
}

function pushRecord(record: PassiveNetworkRecord) {
  recordsById.set(record.id, record)
  orderedIds.push(record.id)

  if (orderedIds.length > MAX_REQUESTS) {
    const removed = orderedIds.splice(0, orderedIds.length - MAX_REQUESTS)
    for (const id of removed) recordsById.delete(id)
  }

  for (const waiter of Array.from(waiters)) {
    if (!matchesRecord(record, waiter.matcher)) continue
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.resolve({
      success: true,
      matched: true,
      captureMode: 'passive_resource_timing',
      limitations: [
        '该模式基于 PerformanceResourceTiming，只能在资源完成后看到记录',
        '不包含请求头、响应头、状态码和响应体',
      ],
      request: toPublicRecord(record, {}),
    })
  }
}

function ingestEntries(entries: PerformanceResourceTiming[]) {
  for (const entry of entries) {
    const key = buildTimingKey(entry)
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    sequence += 1
    const completedAt = performance.timeOrigin + entry.responseEnd
    pushRecord({
      id: `req_${sequence}`,
      url: entry.name,
      method: 'UNKNOWN',
      resourceType: normalizeResourceType(entry.initiatorType),
      initiatorType: entry.initiatorType || undefined,
      status: 'completed',
      startedAt: performance.timeOrigin + entry.startTime,
      updatedAt: completedAt,
      completedAt,
      durationMs: entry.duration,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : undefined,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : undefined,
      decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : undefined,
      nextHopProtocol: entry.nextHopProtocol || undefined,
    })
  }
}

function ensureNetworkMonitor() {
  if (observer) return

  ingestEntries(
    performance.getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
  )

  if (typeof PerformanceObserver === 'undefined') return

  observer = new PerformanceObserver((list) => {
    ingestEntries(
      list.getEntries().filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    )
  })

  try {
    observer.observe({ type: 'resource', buffered: true })
  } catch {
    observer.observe({ entryTypes: ['resource'] })
  }
}

export function listNetworkRequests(req: NetworkRequestsRequest = {}) {
  ensureNetworkMonitor()

  const records = orderedIds
    .map((id) => recordsById.get(id))
    .filter((record): record is PassiveNetworkRecord => !!record)
    .filter((record) => matchesRecord(record, req))
    .reverse()

  const { items, pageInfo } = paginateItems(records, req.cursor, req.limit, 50, 200)
  const summary = records.reduce<{
    total: number
    byStatus: Record<string, number>
    byResourceType: Record<string, number>
  }>((acc, record) => {
    acc.total += 1
    acc.byStatus[record.status] = (acc.byStatus[record.status] ?? 0) + 1
    acc.byResourceType[record.resourceType] = (acc.byResourceType[record.resourceType] ?? 0) + 1
    return acc
  }, { total: 0, byStatus: {}, byResourceType: {} })

  return {
    success: true,
    captureMode: 'passive_resource_timing',
    pageInfo,
    summary,
    limitations: [
      '该模式不会启用浏览器 debug 协议，也不会抓取请求头、响应头、状态码和响应体',
      'request/response 等待基于资源完成时进入 Performance timeline，因此更接近 completed-resource wait',
    ],
    requests: items.map((record) => toPublicRecord(record, {
      includeRequestHeaders: req.includeRequestHeaders,
      includeResponseHeaders: req.includeResponseHeaders,
      includeRequestBody: req.includeRequestBody,
      includeResponseBody: req.includeResponseBody,
    })),
  }
}

export function getNetworkRequest(req: GetNetworkRequestRequest) {
  ensureNetworkMonitor()
  const record = recordsById.get(req.requestId)
  if (!record) {
    return { success: false, error: `找不到 requestId=${req.requestId}` }
  }

  return {
    success: true,
    captureMode: 'passive_resource_timing',
    limitations: [
      '不包含请求头、响应头、状态码和响应体',
    ],
    request: toPublicRecord(record, {
      includeRequestHeaders: req.includeRequestHeaders ?? true,
      includeResponseHeaders: req.includeResponseHeaders ?? true,
      includeRequestBody: req.includeRequestBody ?? true,
      includeResponseBody: req.includeResponseBody ?? true,
    }),
  }
}

export function waitForNetworkEvent(req: WaitForNetworkEventRequest = {}) {
  ensureNetworkMonitor()

  const existing = orderedIds
    .map((id) => recordsById.get(id))
    .filter((record): record is PassiveNetworkRecord => !!record)
    .reverse()
    .find((record) => matchesRecord(record, req))

  if (existing) {
    return Promise.resolve({
      success: true,
      matched: true,
      captureMode: 'passive_resource_timing',
      limitations: [
        '等待基于资源完成后生成的 PerformanceResourceTiming 记录',
      ],
      request: toPublicRecord(existing, {}),
    })
  }

  const timeoutMs = Math.max(100, Number(req.timeoutMs) || 10_000)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(waiter)
      resolve({ success: false, matched: false, error: '等待网络资源记录超时' })
    }, timeoutMs) as unknown as number
    const waiter: NetworkWaiter = {
      matcher: req,
      resolve,
      timer,
    }
    waiters.add(waiter)
  })
}
