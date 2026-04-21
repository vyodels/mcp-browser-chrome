#!/usr/bin/env node

import { createConnection } from 'node:net'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SOCKET_PATH = process.env.MCP_BROWSER_CHROME_SOCKET || path.join(os.tmpdir(), 'browser-mcp.sock')
const SERVER_INFO = { name: 'browser-mcp', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'
const BRIDGE_TIMEOUT_MS = Number(process.env.MCP_BROWSER_CHROME_BRIDGE_TIMEOUT_MS || 8000)
const BRIDGE_RETRY_DELAYS_MS = [150, 500, 1200]

const TOOLS = [
  ['browser_tabs', 'List, create, close, or select a browser tab.', {
    action: { type: 'string', enum: ['list', 'current', 'new', 'close', 'select'] },
    tabId: { type: 'number' },
    url: { type: 'string' },
    active: { type: 'boolean' },
    scope: {
      type: 'string',
      enum: ['current_window', 'all_windows'],
      description: 'Optional tab listing scope for action=list. Defaults to current_window.',
    },
  }],
  ['browser_navigate', 'Navigate a tab to a URL.', { tabId: { type: 'number' }, url: { type: 'string' } }],
  ['browser_navigate_back', 'Go back to the previous page in the tab history.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_navigate_forward', 'Go forward to the next page in the tab history.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_reload', 'Reload the target tab.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_snapshot', 'Capture accessibility-style snapshot of the current page.', { tabId: { type: 'number' }, target: { type: 'string' }, frameRef: { type: 'string' }, depth: { type: 'number' } }],
  ['browser_frames', 'List same-origin frames discovered in the page.', { tabId: { type: 'number' }, includeMainFrame: { type: 'boolean' } }],
  ['browser_debug_dom', 'Read a debug DOM snapshot with HTML slices and truncation metadata.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, includeHtml: { type: 'boolean' }, textOffset: { type: 'number' }, maxTextLength: { type: 'number' }, htmlOffset: { type: 'number' }, maxHtmlLength: { type: 'number' }, interactiveLimit: { type: 'number' } }],
  ['browser_query_elements', 'Query matching elements by text, role, ref, or selector.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' } }],
  ['browser_get_element', 'Return the first matching element.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, visibleOnly: { type: 'boolean' } }],
  ['browser_click', 'Perform a conservative click on a web page. Real sites block aggressive fallback by default, and one-click side-effect actions such as 打招呼/发送/求简历 require allowDangerousAction=true.', {
    tabId: { type: 'number' },
    frameRef: { type: 'string' },
    target: { type: 'string' },
    doubleClick: { type: 'boolean' },
    text: { type: 'string' },
    role: { type: 'string' },
    index: { type: 'number' },
    allowDangerousAction: { type: 'boolean' },
    fallbackMode: { type: 'string', enum: ['conservative', 'aggressive'] },
  }],
  ['browser_hover', 'Hover over the target element.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, target: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' } }],
  ['browser_type', 'Type text into editable element.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, slowly: { type: 'boolean' } }],
  ['browser_select_option', 'Select value(s) on a select element.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, target: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }],
  ['browser_press_key', 'Press a key on the keyboard.', { tabId: { type: 'number' }, key: { type: 'string' } }],
  ['browser_scroll', 'Scroll the page.', { tabId: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] }, pixels: { type: 'number' } }],
  ['browser_wait_for', 'Wait for text to appear, disappear, or a specified time to pass.', { tabId: { type: 'number' }, time: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_take_screenshot', 'Take a screenshot of the current viewport or a specific element. Real sites block fullPage by default.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, target: { type: 'string' }, type: { type: 'string', enum: ['png', 'jpeg', 'webp'] }, filename: { type: 'string' }, fullPage: { type: 'boolean' }, quality: { type: 'number' } }],
  ['browser_evaluate', 'Safely evaluate a small read-only expression on page or element without entering browser debug mode.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, target: { type: 'string' }, expression: { type: 'string' }, function: { type: 'string' }, args: { type: 'array', items: {} } }],
  ['browser_run_code', 'Run a read-only return expression through the stealth-safe evaluation path.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, code: { type: 'string' }, args: { type: 'array', items: {} } }],
  ['browser_console_messages', 'Return passively captured page errors with pagination. Does not monkey-patch page console.', { tabId: { type: 'number' }, cursor: { type: 'number' }, limit: { type: 'number' }, level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] }, levels: { type: 'array', items: { type: 'string' } }, text: { type: 'string' } }],
  ['browser_network_requests', 'Return passive PerformanceResourceTiming-based network records with pagination and filters.', { tabId: { type: 'number' }, cursor: { type: 'number' }, limit: { type: 'number' }, filter: { type: 'string' }, isRegex: { type: 'boolean' }, resourceTypes: { type: 'array', items: { type: 'string' } }, statuses: { type: 'array', items: { type: 'number' } }, methods: { type: 'array', items: { type: 'string' } }, includeRequestHeaders: { type: 'boolean' }, includeResponseHeaders: { type: 'boolean' }, includeRequestBody: { type: 'boolean' }, includeResponseBody: { type: 'boolean' } }],
  ['browser_get_network_request', 'Get one passive network record by requestId.', { tabId: { type: 'number' }, requestId: { type: 'string' }, includeRequestHeaders: { type: 'boolean' }, includeResponseHeaders: { type: 'boolean' }, includeRequestBody: { type: 'boolean' }, includeResponseBody: { type: 'boolean' } }],
  ['browser_file_upload', 'Upload one or multiple files to a file input.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, target: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }],
  ['browser_drag', 'Perform drag and drop between two elements.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, startTarget: { type: 'string' }, endTarget: { type: 'string' } }],
  ['browser_fill_form', 'Fill multiple form fields in one request.', { tabId: { type: 'number' }, frameRef: { type: 'string' }, elements: { type: 'array', items: { type: 'object' } } }],
  ['browser_cookie_list', 'List cookies. Values are masked by default.', { url: { type: 'string' }, domain: { type: 'string' }, name: { type: 'string' }, includeValue: { type: 'boolean' }, allowSensitive: { type: 'boolean' } }],
  ['browser_cookie_set', 'Set a cookie.', { url: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, domain: { type: 'string' }, path: { type: 'string' }, secure: { type: 'boolean' }, httpOnly: { type: 'boolean' }, sameSite: { type: 'string' }, expirationDate: { type: 'number' } }],
  ['browser_cookie_delete', 'Delete one cookie.', { url: { type: 'string' }, domain: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' } }],
  ['browser_cookie_clear', 'Clear all matching cookies.', { url: { type: 'string' }, domain: { type: 'string' } }],
  ['browser_wait_for_url', 'Wait until the tab URL contains the given pattern.', { tabId: { type: 'number' }, pattern: { type: 'string' }, timeoutMs: { type: 'number' } }],
  ['browser_wait_for_request', 'Wait for a matching passive resource timing record. Returns after the resource is completed.', { tabId: { type: 'number' }, pattern: { type: 'string' }, isRegex: { type: 'boolean' }, method: { type: 'string' }, resourceType: { type: 'string' }, status: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_wait_for_response', 'Wait for a matching passive resource timing record. Returns after the resource is completed.', { tabId: { type: 'number' }, pattern: { type: 'string' }, isRegex: { type: 'boolean' }, method: { type: 'string' }, resourceType: { type: 'string' }, status: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_wait_for_download', 'Wait for a download event.', { urlPattern: { type: 'string' }, filenamePattern: { type: 'string' }, isRegex: { type: 'boolean' }, timeoutMs: { type: 'number' } }],
  ['browser_handle_dialog', 'Request dialog handling. Real sites are blocked by stealth policy and will return alternatives.', { tabId: { type: 'number' }, action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' } }],
  ['browser_resize', 'Resize the browser window that owns the target tab.', { tabId: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }],
  ['browser_emulate', 'Apply a stealth-safe emulation fallback. Currently only window resize is applied; debug-only overrides are ignored.', { tabId: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, deviceScaleFactor: { type: 'number' }, mobile: { type: 'boolean' }, touch: { type: 'boolean' }, userAgent: { type: 'string' }, locale: { type: 'string' }, colorScheme: { type: 'string', enum: ['dark', 'light', 'no-preference'] }, timezoneId: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' }, reset: { type: 'boolean' } }],
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

const MIME_BY_EXT = {
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

async function prepareToolArguments(name, args = {}) {
  if (name !== 'browser_file_upload') return args
  const paths = Array.isArray(args.paths) ? args.paths.filter((value) => typeof value === 'string') : []
  if (!paths.length) {
    return { ...args, files: [] }
  }

  const files = await Promise.all(paths.map(async (filePath) => {
    const stat = await fs.stat(filePath)
    const buffer = await fs.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    return {
      name: path.basename(filePath),
      type: MIME_BY_EXT[ext] || 'application/octet-stream',
      lastModified: stat.mtimeMs,
      contentBase64: buffer.toString('base64'),
    }
  }))

  return {
    ...args,
    files,
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

function callBridgeOnce(name, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH)
    let buffer = ''
    const requestId = randomUUID()
    let settled = false

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

    socket.setTimeout(BRIDGE_TIMEOUT_MS)

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
      fail(new Error(`Bridge call timed out after ${BRIDGE_TIMEOUT_MS}ms via ${SOCKET_PATH}`))
    })
  })
}

async function callBridge(name, args = {}) {
  let lastError = null

  for (let attempt = 0; attempt <= BRIDGE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await callBridgeOnce(name, args)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === BRIDGE_RETRY_DELAYS_MS.length || !isRetryableBridgeError(lastError.message)) {
        break
      }
      await sleep(BRIDGE_RETRY_DELAYS_MS[attempt])
    }
  }

  throw new Error(
    `${lastError?.message ?? `Bridge call failed for ${name}`}. ` +
    'If Chrome is open, reload the browser-mcp extension once and keep a normal webpage tab available.'
  )
}

async function handleToolCall(id, params) {
  const name = params?.name
  const originalArgs = params?.arguments ?? {}
  if (!name || !TOOLS.find((tool) => tool.name === name)) {
    sendResult(id, {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    })
    return
  }

  try {
    const args = await prepareToolArguments(name, originalArgs)
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
      await handleToolCall(id, params)
      return
    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

process.stdin.on('data', extractMessages)
process.stdin.resume()
