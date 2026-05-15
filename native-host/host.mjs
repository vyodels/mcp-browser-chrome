#!/usr/bin/env node

import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOCKET_PATH = process.env.MCP_BROWSER_CHROME_SOCKET || path.join(os.tmpdir(), 'browser-mcp.sock')
const DEBUG_STANDALONE = process.argv.includes('--debug-standalone')
const LOG_PATH = path.join(os.tmpdir(), 'browser-mcp-native-host.log')
const RESPONSE_TIMEOUT_MS = Number(process.env.MCP_BROWSER_CHROME_NATIVE_RESPONSE_TIMEOUT_MS || 15000)
const DEBUG_TOOLS_ENABLED = process.env.MCP_BROWSER_CHROME_DEBUG_TOOLS === '1'

const DEFAULT_BROWSER_COMMANDS = [
  'browser_list_tabs',
  'browser_get_active_tab',
  'browser_snapshot',
  'browser_query_elements',
  'browser_get_element',
  'browser_debug_dom',
  'browser_wait_for_element',
  'browser_wait_for_text',
  'browser_wait_for_navigation',
  'browser_wait_for_disappear',
  'browser_wait_for_url',
]

const DEBUG_BROWSER_COMMANDS = [
  'browser_reload_extension',
  'browser_select_tab',
  'browser_open_tab',
]

const ALLOWED_BROWSER_COMMANDS = new Set([
  ...DEFAULT_BROWSER_COMMANDS,
  ...(DEBUG_TOOLS_ENABLED ? DEBUG_BROWSER_COMMANDS : []),
])

const pending = new Map()
let nativeBuffer = Buffer.alloc(0)
let shuttingDown = false
let forwardQueue = Promise.resolve()

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch {}
}

function writeNativeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  process.stdout.write(Buffer.concat([header, json]))
}

function writeSocketResponse(socket, message) {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(message)}\n`)
}

function enqueueForward(request, socket) {
  forwardQueue = forwardQueue.then(
    () => forwardNativeRequest(request, socket),
    () => forwardNativeRequest(request, socket)
  )
  void forwardQueue.catch((error) => {
    log(`forward queue failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function forwardNativeRequest(request, socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve()
      return
    }

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const timeout = setTimeout(() => {
      pending.delete(request.id)
      writeSocketResponse(socket, {
        id: request.id,
        ok: false,
        error: { message: `Native response timed out after ${RESPONSE_TIMEOUT_MS}ms` },
      })
      finish()
    }, RESPONSE_TIMEOUT_MS)

    pending.set(request.id, {
      socket,
      complete(parsed) {
        clearTimeout(timeout)
        writeSocketResponse(socket, parsed)
        finish()
      },
    })

    try {
      writeNativeMessage(request)
    } catch (error) {
      pending.delete(request.id)
      clearTimeout(timeout)
      writeSocketResponse(socket, {
        id: request.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      })
      finish()
    }
  })
}

function parseNativeMessages(chunk) {
  nativeBuffer = Buffer.concat([nativeBuffer, chunk])
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0)
    if (nativeBuffer.length < 4 + length) break
    const payload = nativeBuffer.subarray(4, 4 + length).toString('utf8')
    nativeBuffer = nativeBuffer.subarray(4 + length)

    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }

    const entry = pending.get(parsed.id)
    if (!entry) continue
    pending.delete(parsed.id)
    entry.complete(parsed)
  }
}

function normalizeCommand(message) {
  if (message?.type === 'browser_command' && message.command) return message

  return {
    id: message?.id ?? randomUUID(),
    type: 'browser_command',
    command: {
      name: message?.command?.name ?? message?.name,
      arguments: message?.command?.arguments ?? message?.arguments ?? {},
    },
  }
}

function isAllowedBrowserCommand(name) {
  return ALLOWED_BROWSER_COMMANDS.has(name)
}

function socketPermissionsHint() {
  const digest = createHash('sha1').update(SOCKET_PATH).digest('hex').slice(0, 8)
  return `${SOCKET_PATH}#${digest}`
}

function cleanupSocketFile() {
  if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH, { force: true })
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown requested')
  server.close(() => {
    cleanupSocketFile()
    log('server closed')
    process.exit(0)
  })
}

if (existsSync(SOCKET_PATH)) {
  rmSync(SOCKET_PATH, { force: true })
}

log(`process start debugStandalone=${DEBUG_STANDALONE} socket=${SOCKET_PATH}`)

const server = createServer((socket) => {
  let lineBuffer = ''
  log('socket client connected')

  socket.on('data', (chunk) => {
    lineBuffer += chunk.toString('utf8')
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).trim()
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      newlineIndex = lineBuffer.indexOf('\n')
      if (!line) continue

      let parsed
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        socket.write(`${JSON.stringify({ ok: false, error: { message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` } })}\n`)
        continue
      }

      const request = normalizeCommand(parsed)
      if (!request.command?.name) {
        socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { message: 'Missing command name' } })}\n`)
        continue
      }

      if (!isAllowedBrowserCommand(request.command.name)) {
        log(`reject request ${request.command.name}`)
        socket.write(`${JSON.stringify({
          id: request.id,
          ok: false,
          error: { message: `Browser command not allowed by native host: ${request.command.name}` },
        })}\n`)
        continue
      }

      log(`forward request ${request.command.name}`)
      enqueueForward(request, socket)
    }
  })

  socket.on('close', () => {
    log('socket client closed')
  })
})

server.listen(SOCKET_PATH, () => {
  log('socket ready')
  process.stderr.write(`[native-host] socket ready at ${socketPermissionsHint()}\n`)
  if (DEBUG_STANDALONE) {
    process.stderr.write('[native-host] debug standalone mode enabled; stdin close will be ignored\n')
  }
})

process.stdin.on('data', parseNativeMessages)
process.stdin.on('data', () => {
  log('stdin data received')
})

process.stdin.on('end', () => {
  log('stdin end received')
  if (DEBUG_STANDALONE) return
  shutdown()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown()
  })
}
