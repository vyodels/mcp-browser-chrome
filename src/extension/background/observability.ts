import type { WaitForDownloadRequest } from '../shared/protocol'

interface DownloadRecord {
  id: number
  url?: string
  filename?: string
  state?: string
  bytesReceived?: number
  totalBytes?: number
  createdAt: number
  completedAt?: number
  error?: string
}

interface DownloadWaiter {
  matcher: WaitForDownloadRequest
  resolve: (value: unknown) => void
  timer: number
}

const downloadsById = new Map<number, DownloadRecord>()
const downloadWaiters = new Set<DownloadWaiter>()
let initialized = false

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

function notifyDownloadWaiters(record: DownloadRecord) {
  for (const waiter of Array.from(downloadWaiters)) {
    if (!matchesString(record.url, waiter.matcher.urlPattern, waiter.matcher.isRegex)) continue
    if (!matchesString(record.filename, waiter.matcher.filenamePattern, waiter.matcher.isRegex)) continue
    clearTimeout(waiter.timer)
    downloadWaiters.delete(waiter)
    waiter.resolve({
      success: true,
      matched: true,
      download: record,
    })
  }
}

export function initializeObservability() {
  if (initialized) return
  initialized = true

  chrome.downloads.onCreated.addListener((item) => {
    const record: DownloadRecord = {
      id: item.id,
      url: item.url,
      filename: item.filename,
      state: item.state,
      bytesReceived: item.bytesReceived,
      totalBytes: item.totalBytes,
      createdAt: Date.now(),
    }
    downloadsById.set(item.id, record)
    notifyDownloadWaiters(record)
  })

  chrome.downloads.onChanged.addListener((delta) => {
    const current = downloadsById.get(delta.id)
    if (!current) return
    if (delta.filename?.current) current.filename = delta.filename.current
    if (delta.state?.current) current.state = delta.state.current
    if (delta.error?.current) current.error = delta.error.current
    if (typeof delta.totalBytes?.current === 'number') current.totalBytes = delta.totalBytes.current
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      current.completedAt = Date.now()
    }
    notifyDownloadWaiters(current)
  })
}

export function waitForDownload(req: WaitForDownloadRequest = {}) {
  const existing = Array.from(downloadsById.values()).find((record) => (
    matchesString(record.url, req.urlPattern, req.isRegex) &&
    matchesString(record.filename, req.filenamePattern, req.isRegex)
  ))

  if (existing) {
    return Promise.resolve({ success: true, matched: true, download: existing })
  }

  const timeoutMs = Math.max(100, Number(req.timeoutMs) || 10_000)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      downloadWaiters.delete(waiter)
      resolve({ success: false, matched: false, error: '等待下载事件超时' })
    }, timeoutMs) as unknown as number
    const waiter: DownloadWaiter = {
      matcher: req,
      resolve,
      timer,
    }
    downloadWaiters.add(waiter)
  })
}
