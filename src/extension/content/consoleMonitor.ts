import type { ConsoleMessageRecord } from '../../types'
import type { ConsoleMessagesRequest, ConsoleMessagesResponse } from '../shared/protocol'
import { paginateItems, safeSerialize } from '../shared/ai'

const MAX_CONSOLE_MESSAGES = 250

let monitorInstalled = false
const messageBuffer: ConsoleMessageRecord[] = []
let sequence = 0

function pushMessage(record: ConsoleMessageRecord) {
  messageBuffer.push(record)
  if (messageBuffer.length > MAX_CONSOLE_MESSAGES) {
    messageBuffer.splice(0, messageBuffer.length - MAX_CONSOLE_MESSAGES)
  }
}

function nextId() {
  sequence += 1
  return `console_${Date.now()}_${sequence}`
}

function normalizeErrorPayload(value: unknown) {
  return safeSerialize(value, {
    depth: 3,
    maxArrayLength: 8,
    maxStringLength: 600,
  })
}

export function ensureConsoleMonitor() {
  if (monitorInstalled) return
  monitorInstalled = true

  window.addEventListener('error', (event) => {
    pushMessage({
      id: nextId(),
      level: 'error',
      text: [event.message, event.filename, event.lineno, event.colno]
        .filter((part) => part !== undefined && part !== '')
        .join(' ')
        .slice(0, 3000),
      args: event.error ? [normalizeErrorPayload(event.error)] : undefined,
      timestamp: Date.now(),
      location: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    })
  }, true)

  window.addEventListener('unhandledrejection', (event) => {
    pushMessage({
      id: nextId(),
      level: 'error',
      text: 'Unhandled promise rejection',
      args: [normalizeErrorPayload(event.reason)],
      timestamp: Date.now(),
    })
  })
}

export function getConsoleMessages(req: ConsoleMessagesRequest = {}): ConsoleMessagesResponse {
  ensureConsoleMonitor()

  const levels = req.levels?.length ? new Set(req.levels) : null
  const textNeedle = req.text?.trim().toLowerCase()
  const filtered = messageBuffer.filter((message) => {
    if (levels && !levels.has(message.level)) return false
    if (textNeedle && !message.text.toLowerCase().includes(textNeedle)) return false
    return true
  })
  const { items, pageInfo } = paginateItems(filtered, req.cursor, req.limit, 50, 200)
  const levelsSummary = filtered.reduce<Record<string, number>>((acc, message) => {
    acc[message.level] = (acc[message.level] ?? 0) + 1
    return acc
  }, {})

  return {
    success: true,
    installed: monitorInstalled,
    captureMode: 'passive_error_events',
    limitations: [
      '默认不劫持页面 console，只被动采集 error 和 unhandledrejection 事件',
      'log/info/debug/warn 级别的页面 console 输出在 stealth 模式下默认不可见',
    ],
    pageInfo,
    summary: {
      total: filtered.length,
      levels: levelsSummary,
    },
    messages: items,
  }
}
