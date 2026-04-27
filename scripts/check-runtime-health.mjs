#!/usr/bin/env node

import { createConnection } from 'node:net'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const socketPath = process.env.MCP_BROWSER_CHROME_SOCKET || path.join(os.tmpdir(), 'browser-mcp.sock')
const logPath = process.env.MCP_BROWSER_CHROME_NATIVE_HOST_LOG || path.join(os.tmpdir(), 'browser-mcp-native-host.log')
const timeoutMs = Number(process.env.MCP_BROWSER_CHROME_HEALTHCHECK_TIMEOUT_MS || 2500)
const json = process.argv.includes('--json')

function readRecentLog() {
  if (!existsSync(logPath)) return []
  try {
    return readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-20)
  } catch {
    return []
  }
}

function printHuman(report) {
  const lines = []
  lines.push(`[browser-mcp-health] status=${report.status}`)
  lines.push(`[browser-mcp-health] socket=${report.socketPath}`)
  lines.push(`[browser-mcp-health] nativeHostLog=${report.logPath}`)
  if (report.detail) lines.push(`[browser-mcp-health] detail=${report.detail}`)
  if (report.recentLog.length) {
    lines.push('[browser-mcp-health] recent native-host log:')
    for (const line of report.recentLog) lines.push(`  ${line}`)
  }
  if (report.recovery.length) {
    lines.push('[browser-mcp-health] recovery:')
    for (const step of report.recovery) lines.push(`  - ${step}`)
  }
  process.stderr.write(`${lines.join('\n')}\n`)
}

function finish(report, code) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    printHuman(report)
  }
  process.exit(code)
}

function recoverySteps() {
  return [
    'Do not close normal Chrome windows from reset scripts.',
    'Open or focus any ordinary webpage in the Chrome profile that has the unpacked browser-mcp dist/ extension enabled; tab/window activity should wake the extension bridge.',
    'If the socket is still missing, reload browser-mcp manually in chrome://extensions for the existing unpacked extension, then run this check again.',
    'If Chrome reports native messaging permission or extension-id problems, run `npm run setup:auto` in mcp-browser-chrome and then manually reload the existing extension.',
    '`browser_reload_extension` is maintenance-only and requires a live socket; it cannot recover an already-missing socket.',
  ]
}

async function callBrowserGetActiveTab() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const id = randomUUID()
    let buffer = ''
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const succeed = (payload) => {
      if (settled) return
      settled = true
      socket.end()
      resolve(payload)
    }

    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        id,
        type: 'browser_command',
        command: { name: 'browser_get_active_tab', arguments: {} },
      })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline).trim()
      if (!line) return
      try {
        succeed(JSON.parse(line))
      } catch (error) {
        fail(error)
      }
    })
    socket.on('error', fail)
    socket.on('timeout', () => fail(new Error(`timed out after ${timeoutMs}ms`)))
  })
}

async function main() {
  const baseReport = {
    socketPath,
    logPath,
    recentLog: readRecentLog(),
    recovery: recoverySteps(),
  }

  if (!existsSync(socketPath)) {
    finish({
      ...baseReport,
      status: 'missing_socket',
      detail: 'browser-mcp Unix socket does not exist; MCP tools/list can still work, but browser tool calls will fail before reaching Chrome.',
    }, 2)
  }

  let stat
  try {
    stat = lstatSync(socketPath)
  } catch (error) {
    finish({
      ...baseReport,
      status: 'socket_stat_failed',
      detail: error instanceof Error ? error.message : String(error),
    }, 2)
  }

  if (!stat.isSocket()) {
    finish({
      ...baseReport,
      status: 'not_socket',
      detail: 'path exists but is not a Unix socket',
    }, 2)
  }

  try {
    const response = await callBrowserGetActiveTab()
    if (response?.ok === false) {
      finish({
        ...baseReport,
        status: 'bridge_error',
        detail: response.error?.message ?? 'native host returned ok=false',
      }, 3)
    }
    finish({
      ...baseReport,
      status: 'ok',
      detail: 'socket, native host, and extension bridge answered browser_get_active_tab',
      recovery: [],
    }, 0)
  } catch (error) {
    finish({
      ...baseReport,
      status: 'socket_connect_failed',
      detail: error instanceof Error ? error.message : String(error),
    }, 3)
  }
}

main().catch((error) => {
  finish({
    socketPath,
    logPath,
    status: 'check_failed',
    detail: error instanceof Error ? error.message : String(error),
    recentLog: readRecentLog(),
    recovery: recoverySteps(),
  }, 4)
})
