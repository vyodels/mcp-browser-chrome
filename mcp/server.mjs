#!/usr/bin/env node

import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SOCKET_PATH = process.env.MCP_BROWSER_CHROME_SOCKET || path.join(os.tmpdir(), 'browser-mcp.sock')
const SERVER_INFO = { name: 'browser-mcp', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'
const BRIDGE_TIMEOUT_MS = Number(process.env.MCP_BROWSER_CHROME_BRIDGE_TIMEOUT_MS || 8000)
const BRIDGE_TIMEOUT_GRACE_MS = 1500
const BRIDGE_RETRY_DELAYS_MS = [150, 500, 1200]
const DEBUG_TOOLS_ENABLED = process.env.MCP_BROWSER_CHROME_DEBUG_TOOLS === '1'

const DEFAULT_TOOL_DEFS = [
  ['browser_list_tabs', 'List open tabs across Chrome windows. Pass currentWindowOnly=true to restrict results to the focused window.', { currentWindowOnly: { type: 'boolean' } }],
  ['browser_get_active_tab', 'Get the active Chrome tab.', {}],
  ['browser_snapshot', 'Read a structured page snapshot with viewport/document metadata and clickable element coordinates.', { tabId: { type: 'number' }, includeHtml: { type: 'boolean' }, includeText: { type: 'boolean' }, maxTextLength: { type: 'number' }, maxHtmlLength: { type: 'number' }, clickableLimit: { type: 'number' } }],
  ['browser_query_elements', 'Query matching elements by ref, selector, text, or role.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' } }],
  ['browser_get_element', 'Return the first matching element.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, visibleOnly: { type: 'boolean' } }],
  ['browser_debug_dom', 'Read a debug DOM snapshot with HTML.', { tabId: { type: 'number' } }],
  ['browser_wait_for_element', 'Wait until an element appears.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_wait_for_text', 'Wait until page text contains the target string.', { tabId: { type: 'number' }, text: { type: 'string' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_wait_for_navigation', 'Wait for the target tab to finish navigation.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_wait_for_disappear', 'Wait until a matching element disappears.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_wait_for_url', 'Wait until the tab URL contains the given pattern string. Useful after login redirects or form submissions.', { tabId: { type: 'number' }, pattern: { type: 'string' }, timeoutMs: { type: 'number' } }],
]

const DEBUG_TOOL_DEFS = [
  ['browser_reload_extension', 'Debug-only: reload the browser-mcp Chrome extension so new dist files take effect.', {}],
  ['browser_select_tab', 'Debug-only: activate and focus a Chrome tab by tabId.', { tabId: { type: 'number' } }],
  ['browser_open_tab', 'Debug-only: open or navigate a tab for local fixture setup.', { tabId: { type: 'number' }, windowId: { type: 'number' }, url: { type: 'string' }, active: { type: 'boolean' }, newWindow: { type: 'boolean' } }],
]

const TOOLS = [
  ...DEFAULT_TOOL_DEFS,
  ...(DEBUG_TOOLS_ENABLED ? DEBUG_TOOL_DEFS : []),
].map(([name, description, properties]) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties,
    additionalProperties: false,
  },
}))

let stdinBuffer = ''
let transportMode = 'unknown'
let toolCallQueue = Promise.resolve()

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (transportMode === 'newline') {
    process.stdout.write(`${body.toString('utf8')}\n`)
    return
  }

  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

function enqueueToolCall(id, params) {
  toolCallQueue = toolCallQueue.then(
    () => handleToolCall(id, params),
    () => handleToolCall(id, params)
  )
  void toolCallQueue.catch((error) => {
    process.stderr.write(`[browser-mcp] serialized tool call failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

function extractMessages(chunk) {
  stdinBuffer += chunk.toString('utf8')

  if (transportMode === 'unknown') {
    const trimmed = stdinBuffer.trimStart()
    if (!trimmed) return
    transportMode = trimmed.startsWith('{') ? 'newline' : 'content-length'
  }

  if (transportMode === 'newline') {
    while (true) {
      const newlineIndex = stdinBuffer.indexOf('\n')
      if (newlineIndex < 0) return

      const line = stdinBuffer.slice(0, newlineIndex).trim()
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1)
      if (!line) continue

      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }

      void handleMessage(message)
    }
  }

  while (true) {
    let headerEnd = stdinBuffer.indexOf('\r\n\r\n')
    let separatorLength = 4
    if (headerEnd < 0) {
      headerEnd = stdinBuffer.indexOf('\n\n')
      separatorLength = 2
    }
    if (headerEnd < 0) return
    const header = stdinBuffer.slice(0, headerEnd)
    const lengthLine = header
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith('content-length:'))
    if (!lengthLine) {
      stdinBuffer = ''
      return
    }

    const length = Number(lengthLine.split(':')[1].trim())
    const bodyStart = headerEnd + separatorLength
    if (stdinBuffer.length < bodyStart + length) return

    const body = stdinBuffer.slice(bodyStart, bodyStart + length)
    stdinBuffer = stdinBuffer.slice(bodyStart + length)

    let message
    try {
      message = JSON.parse(body)
    } catch {
      continue
    }

    void handleMessage(message)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableBridgeError(message) {
  return [
    'Native host unavailable',
    'ENOENT',
    'ECONNREFUSED',
    'timed out',
    'timeout',
  ].some((fragment) => message.includes(fragment))
}

function resolveBridgeTimeoutMs(name, args = {}) {
  const requestedTimeout = Number(args.timeoutMs)
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) return BRIDGE_TIMEOUT_MS
  return Math.max(BRIDGE_TIMEOUT_MS, requestedTimeout + BRIDGE_TIMEOUT_GRACE_MS)
}

function retryDelaysForBridgeCall(name) {
  return BRIDGE_RETRY_DELAYS_MS
}

function callBridgeOnce(name, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH)
    let buffer = ''
    const requestId = randomUUID()
    let settled = false
    const bridgeTimeoutMs = resolveBridgeTimeoutMs(name, args)

    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
      socket.destroy()
    }

    const succeed = (result) => {
      if (settled) return
      settled = true
      resolve(result)
      socket.end()
    }

    socket.setTimeout(bridgeTimeoutMs)

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: requestId, type: 'browser_command', command: { name, arguments: args } })}\n`)
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue

        let parsed
        try {
          parsed = JSON.parse(line)
        } catch (error) {
          fail(error)
          return
        }

        if (parsed.id !== requestId) continue
        if (parsed.ok === false) {
          fail(new Error(parsed.error?.message ?? 'Bridge call failed'))
        } else {
          succeed(parsed.result)
        }
        return
      }
    })

    socket.on('error', (error) => {
      fail(new Error(`Native host unavailable at ${SOCKET_PATH}: ${error.message}`))
    })

    socket.on('timeout', () => {
      fail(new Error(`Bridge call timed out after ${bridgeTimeoutMs}ms via ${SOCKET_PATH}`))
    })
  })
}

async function callBridge(name, args = {}) {
  let lastError = null
  const retryDelays = retryDelaysForBridgeCall(name)

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await callBridgeOnce(name, args)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === retryDelays.length || !isRetryableBridgeError(lastError.message)) {
        break
      }
      await sleep(retryDelays[attempt])
    }
  }

  throw new Error(
    `${lastError?.message ?? `Bridge call failed for ${name}`}. ` +
    'If Chrome is open, reload the browser-mcp extension once and keep a normal webpage tab available.'
  )
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  if (!name || !TOOLS.find((tool) => tool.name === name)) {
    sendResult(id, {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    })
    return
  }

  try {
    const result = await callBridge(name, args)
    sendResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    })
  } catch (error) {
    sendResult(id, {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    })
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  const { id, method, params } = message
  if (!method) return

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
      return
    case 'notifications/initialized':
      return
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      sendResult(id, { tools: TOOLS })
      return
    case 'tools/call':
      enqueueToolCall(id, params)
      return
    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

process.stdin.on('data', extractMessages)
process.stdin.resume()
