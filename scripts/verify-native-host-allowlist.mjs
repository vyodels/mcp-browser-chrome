import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOCKET_TIMEOUT_MS = 5000

function socketPathFor(label) {
  return path.join(os.tmpdir(), `browser-mcp-native-host-${label}-${process.pid}.sock`)
}

function writeNativeMessage(stream, message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  stream.write(Buffer.concat([header, json]))
}

function observeNativeFrames(child) {
  const frames = []
  let buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) break
      const payload = buffer.subarray(4, 4 + length).toString('utf8')
      buffer = buffer.subarray(4 + length)
      frames.push(JSON.parse(payload))
    }
  })
  return frames
}

function waitForSocketReady(child) {
  return new Promise((resolve, reject) => {
    const stderr = []
    const timer = setTimeout(() => reject(new Error('native host did not report socket readiness')), SOCKET_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
    }
    const onStderr = (chunk) => {
      const text = chunk.toString('utf8')
      stderr.push(text)
      if (!text.includes('socket ready')) return
      cleanup()
      resolve()
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`native host exited before socket readiness: code=${code} signal=${signal} stderr=${stderr.join('').trim()}`))
    }
    child.stderr.on('data', onStderr)
    child.on('exit', onExit)
  })
}

function startHost(socketPath, env = {}) {
  if (existsSync(socketPath)) rmSync(socketPath, { force: true })
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'native-host/host.mjs'), '--debug-standalone'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
      MCP_BROWSER_CHROME_SOCKET: socketPath,
      MCP_BROWSER_CHROME_NATIVE_RESPONSE_TIMEOUT_MS: '3000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return child
}

function callSocket(socketPath, commandName) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`socket call timed out for ${commandName}`))
    }, SOCKET_TIMEOUT_MS)

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        id: `${commandName}-request`,
        type: 'browser_command',
        command: { name: commandName, arguments: {} },
      })}\n`)
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      socket.end()
      resolve(JSON.parse(buffer.slice(0, newline).trim()))
    })

    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function withHost(label, env, fn) {
  const socketPath = socketPathFor(label)
  const child = startHost(socketPath, env)
  const frames = observeNativeFrames(child)

  try {
    await waitForSocketReady(child)
    return await fn({ child, frames, socketPath })
  } finally {
    child.kill('SIGTERM')
    if (existsSync(socketPath)) rmSync(socketPath, { force: true })
  }
}

await withHost('default', {}, async ({ frames, socketPath }) => {
  const response = await callSocket(socketPath, 'browser_open_tab')
  if (response.ok !== false) {
    throw new Error(`default native host should reject browser_open_tab, got ${JSON.stringify(response)}`)
  }
  if (frames.length !== 0) {
    throw new Error(`default native host forwarded a rejected debug command: ${frames.map((item) => item.command?.name).join(', ')}`)
  }
})

await withHost('debug', { MCP_BROWSER_CHROME_DEBUG_TOOLS: '1' }, async ({ child, frames, socketPath }) => {
  const responsePromise = callSocket(socketPath, 'browser_open_tab')
  const startedAt = Date.now()
  while (frames.length === 0 && Date.now() - startedAt < SOCKET_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const forwarded = frames[0]
  if (forwarded?.command?.name !== 'browser_open_tab') {
    throw new Error(`debug native host did not forward browser_open_tab, got ${JSON.stringify(forwarded)}`)
  }
  writeNativeMessage(child.stdin, {
    id: forwarded.id,
    ok: true,
    result: { success: true, allowedByDebugEnv: true },
  })
  const response = await responsePromise
  if (response.ok !== true || response.result?.allowedByDebugEnv !== true) {
    throw new Error(`debug native host response mismatch: ${JSON.stringify(response)}`)
  }
})

console.log(JSON.stringify({
  success: true,
  checked: {
    defaultRejectsDebugCommands: true,
    debugEnvAllowsDebugCommands: true,
  },
}, null, 2))
