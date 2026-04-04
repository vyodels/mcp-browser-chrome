#!/usr/bin/env node

import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SOCKET_PATH = process.env.MCP_BROWSER_CHROME_SOCKET || path.join(os.tmpdir(), 'mcp-browser-chrome.sock')
const SERVER_INFO = { name: 'mcp-browser-chrome', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  ['browser_list_tabs', 'List tabs in the current Chrome window.', {}],
  ['browser_get_active_tab', 'Get the active Chrome tab.', {}],
  ['browser_select_tab', 'Activate and focus a Chrome tab by tabId.', { tabId: { type: 'number' } }],
  ['browser_open_tab', 'Open a tab with an optional URL.', { url: { type: 'string' }, active: { type: 'boolean' } }],
  ['browser_close_tab', 'Close a tab by tabId.', { tabId: { type: 'number' } }],
  ['browser_navigate', 'Navigate a tab to a URL.', { tabId: { type: 'number' }, url: { type: 'string' } }],
  ['browser_go_back', 'Navigate the target tab back in history.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_reload', 'Reload the target tab.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_snapshot', 'Read a structured page snapshot.', { tabId: { type: 'number' }, includeHtml: { type: 'boolean' }, maxTextLength: { type: 'number' }, maxHtmlLength: { type: 'number' }, interactiveLimit: { type: 'number' } }],
  ['browser_query_elements', 'Query matching elements by ref, selector, text, or role.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' } }],
  ['browser_get_element', 'Return the first matching element.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, visibleOnly: { type: 'boolean' } }],
  ['browser_debug_dom', 'Read a debug DOM snapshot with HTML.', { tabId: { type: 'number' } }],
  ['browser_click', 'Click a target element.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' } }],
  ['browser_hover', 'Hover a target element.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' } }],
  ['browser_fill', 'Fill a text input or textarea.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, value: { type: 'string' } }],
  ['browser_clear', 'Clear a text input or textarea.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' } }],
  ['browser_select_option', 'Select a value on a select element.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, value: { type: 'string' } }],
  ['browser_press_key', 'Press a keyboard key on the active element.', { tabId: { type: 'number' }, key: { type: 'string' } }],
  ['browser_scroll', 'Scroll the page.', { tabId: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] }, pixels: { type: 'number' } }],
  ['browser_wait', 'Wait for a number of milliseconds.', { ms: { type: 'number' } }],
  ['browser_wait_for_element', 'Wait until an element appears.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_wait_for_text', 'Wait until page text contains the target string.', { tabId: { type: 'number' }, text: { type: 'string' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_wait_for_navigation', 'Wait for the target tab to finish navigation.', { tabId: { type: 'number' }, timeoutMs: { type: 'number' } }],
  ['browser_wait_for_disappear', 'Wait until a matching element disappears.', { tabId: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, role: { type: 'string' }, index: { type: 'number' }, limit: { type: 'number' }, visibleOnly: { type: 'boolean' }, timeoutMs: { type: 'number' }, pollIntervalMs: { type: 'number' } }],
  ['browser_screenshot', 'Capture the visible tab as a screenshot.', { tabId: { type: 'number' } }],
  ['browser_download_file', 'Save provided content into a downloaded file.', { filename: { type: 'string' }, content: { type: 'string' }, format: { type: 'string', enum: ['txt', 'json', 'csv'] } }],
  ['browser_save_text', 'Save text content to a file.', { filename: { type: 'string' }, content: { type: 'string' } }],
  ['browser_save_json', 'Save JSON content to a file.', { filename: { type: 'string' }, content: { type: 'object' } }],
  ['browser_save_csv', 'Save CSV content to a file.', { filename: { type: 'string' }, content: { type: 'string' } }],
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

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
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

  while (true) {
    const headerEnd = stdinBuffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = stdinBuffer.slice(0, headerEnd)
    const lengthLine = header.split('\r\n').find((line) => line.toLowerCase().startsWith('content-length:'))
    if (!lengthLine) {
      stdinBuffer = ''
      return
    }

    const length = Number(lengthLine.split(':')[1].trim())
    const bodyStart = headerEnd + 4
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

function callBridge(name, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET_PATH)
    let buffer = ''
    const requestId = randomUUID()

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
          reject(error)
          socket.end()
          return
        }

        if (parsed.id !== requestId) continue
        if (parsed.ok === false) {
          reject(new Error(parsed.error?.message ?? 'Bridge call failed'))
        } else {
          resolve(parsed.result)
        }
        socket.end()
        return
      }
    })

    socket.on('error', (error) => {
      reject(new Error(`Native host unavailable at ${SOCKET_PATH}: ${error.message}`))
    })
  })
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
      await handleToolCall(id, params)
      return
    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

process.stdin.on('data', extractMessages)

