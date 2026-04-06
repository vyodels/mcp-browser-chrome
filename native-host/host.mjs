#!/usr/bin/env node

import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SOCKET_PATH = process.env.MCP_BROWSER_CHROME_SOCKET || path.join(os.tmpdir(), 'browser-mcp.sock')
const DEBUG_STANDALONE = process.argv.includes('--debug-standalone')
const LOG_PATH = path.join(os.tmpdir(), 'browser-mcp-native-host.log')

const pending = new Map()
let nativeBuffer = Buffer.alloc(0)
let shuttingDown = false

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
    entry.socket.write(`${JSON.stringify(parsed)}\n`)
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

      log(`forward request ${request.command.name}`)
      pending.set(request.id, { socket })
      writeNativeMessage(request)
    }
  })

  socket.on('close', () => {
    log('socket client closed')
    for (const [id, entry] of pending.entries()) {
      if (entry.socket === socket) pending.delete(id)
    }
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
