import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = '/Users/vyodels/AgentProjects/mcp-browser-chrome'
const socketPath = path.join(os.tmpdir(), `browser-mcp-serialization-${process.pid}.sock`)

if (existsSync(socketPath)) rmSync(socketPath, { force: true })

let activeRequests = 0
let maxActiveRequests = 0
let observedOrder = 0
const observedCommands = []

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

      setTimeout(() => {
        socket.write(`${JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            success: true,
            observedOrder: order,
            command: request.command?.name,
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
  const wait = waitForResponses(responses, 3, child)
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
  await wait

  const responseIds = responses.map((item) => item.id)
  const observedResponseOrders = responses.map((item) => item.result?.structuredContent?.observedOrder)
  if (JSON.stringify(responseIds) !== JSON.stringify([1, 2, 3])) {
    throw new Error(`MCP responses must preserve request order; got ${responseIds.join(', ')}`)
  }
  if (JSON.stringify(observedResponseOrders) !== JSON.stringify([1, 2, 3])) {
    throw new Error(`bridge call order mismatch; got ${observedResponseOrders.join(', ')}`)
  }
  if (maxActiveRequests !== 1) {
    throw new Error(`browser MCP bridge calls must be serialized; maxActiveRequests=${maxActiveRequests}`)
  }

  console.log(JSON.stringify({
    success: true,
    maxActiveRequests,
    observedCommands,
  }, null, 2))
} finally {
  child.kill('SIGTERM')
  fakeBridge.close()
  if (existsSync(socketPath)) rmSync(socketPath, { force: true })
}
