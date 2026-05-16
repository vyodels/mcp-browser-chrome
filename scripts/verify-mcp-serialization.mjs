import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const socketPath = path.join(os.tmpdir(), `browser-mcp-serialization-${process.pid}.sock`)
const FORBIDDEN_DEFAULT_TOOLS = new Set([
  'browser_get_cookies',
  'browser_locate_download',
  'browser_screenshot',
  'browser_debug_dom',
  'browser_open_tab',
  'browser_select_tab',
  'browser_reload_extension',
])

if (existsSync(socketPath)) rmSync(socketPath, { force: true })

let activeRequests = 0
let maxActiveRequests = 0
let observedOrder = 0
const observedCommands = []
const observedRequests = []

const fakeBridge = createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue

      const request = JSON.parse(line)
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      const order = ++observedOrder
      observedCommands.push(request.command?.name)
      observedRequests.push(request)

      setTimeout(() => {
        socket.write(`${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            success: true,
            observedOrder: order,
            command: request.command?.name,
            arguments: request.command?.arguments ?? {},
          },
        })}\n`)
        activeRequests -= 1
      }, 100)
    }
  })
})

function waitForBridge() {
  return new Promise((resolve, reject) => {
    fakeBridge.once('error', reject)
    fakeBridge.listen(socketPath, () => {
      fakeBridge.off('error', reject)
      resolve()
    })
  })
}

function waitForResponses(responses, count, child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${count} MCP responses; got ${responses.length}`))
    }, 5000)
    const maybeResolve = () => {
      if (responses.length < count) return
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      resolve()
    }
    let stdoutBuffer = ''
    const onData = (chunk) => {
      stdoutBuffer += chunk.toString('utf8')
      while (stdoutBuffer.includes('\n')) {
        const index = stdoutBuffer.indexOf('\n')
        const line = stdoutBuffer.slice(0, index).trim()
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (!line) continue
        responses.push(JSON.parse(line))
      }
      maybeResolve()
    }
    child.stdout.on('data', onData)
  })
}

await waitForBridge()

const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'mcp/server.mjs')], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    MCP_BROWSER_CHROME_SOCKET: socketPath,
    MCP_BROWSER_CHROME_BRIDGE_TIMEOUT_MS: '3000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stderr = []
child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

try {
  const responses = []
  const wait = waitForResponses(responses, 6, child)
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'tools/list',
    params: {},
  })}\n`)
  for (const id of [1, 2, 3]) {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'browser_get_active_tab',
        arguments: {},
      },
    })}\n`)
  }
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'browser_wait_for_element',
      arguments: {
        tabId: 123,
        selector: '#'.padEnd(900, 'x'),
        timeoutMs: 120000,
        pollIntervalMs: 5,
        limit: 1000,
      },
    },
  })}\n`)
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'browser_snapshot',
      arguments: {
        tabId: 123,
        maxTextLength: 999999,
        maxHtmlLength: 999999,
        clickableLimit: 999999,
      },
    },
  })}\n`)
  await wait

  const toolsList = responses.find((item) => item.id === 0)
  const defaultToolNames = toolsList?.result?.tools?.map((tool) => tool.name) ?? []
  const forbiddenTools = defaultToolNames.filter((name) => FORBIDDEN_DEFAULT_TOOLS.has(name))
  if (forbiddenTools.length) {
    throw new Error(`default tools/list exposed forbidden tools: ${forbiddenTools.join(', ')}`)
  }

  const callResponses = responses.filter((item) => item.id !== 0)
  const responseIds = callResponses.map((item) => item.id)
  const observedResponseOrders = callResponses.map((item) => item.result?.structuredContent?.observedOrder)
  if (JSON.stringify(responseIds) !== JSON.stringify([1, 2, 3, 4, 5])) {
    throw new Error(`MCP responses must preserve request order; got ${responseIds.join(', ')}`)
  }
  if (JSON.stringify(observedResponseOrders) !== JSON.stringify([1, 2, 3, 4, 5])) {
    throw new Error(`bridge call order mismatch; got ${observedResponseOrders.join(', ')}`)
  }
  if (maxActiveRequests !== 1) {
    throw new Error(`browser MCP bridge calls must be serialized; maxActiveRequests=${maxActiveRequests}`)
  }
  const waitArgs = observedRequests.find((item) => item.command?.name === 'browser_wait_for_element')?.command?.arguments ?? {}
  if (
    waitArgs.targetPolicy !== 'strict' ||
    waitArgs.selector?.length !== 512 ||
    waitArgs.timeoutMs !== 30000 ||
    waitArgs.pollIntervalMs !== 100 ||
    waitArgs.limit !== 100
  ) {
    throw new Error(`observe wait hardening args mismatch: ${JSON.stringify(waitArgs)}`)
  }
  const snapshotArgs = observedRequests.find((item) => item.command?.name === 'browser_snapshot')?.command?.arguments ?? {}
  if (
    snapshotArgs.targetPolicy !== 'strict' ||
    snapshotArgs.maxTextLength !== 60000 ||
    snapshotArgs.maxHtmlLength !== 120000 ||
    snapshotArgs.clickableLimit !== 500
  ) {
    throw new Error(`snapshot budget hardening args mismatch: ${JSON.stringify(snapshotArgs)}`)
  }

  console.log(JSON.stringify({
    success: true,
    maxActiveRequests,
    observedCommands,
    defaultTools: defaultToolNames,
  }, null, 2))
} finally {
  child.kill('SIGTERM')
  fakeBridge.close()
  if (existsSync(socketPath)) rmSync(socketPath, { force: true })
}
