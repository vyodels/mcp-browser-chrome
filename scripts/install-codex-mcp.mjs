#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const configDir = path.join(os.homedir(), '.codex')
const configPath = path.join(configDir, 'config.toml')
const projectKey = `[projects."${repoRoot}"]`
const projectBlock = `${projectKey}\ntrust_level = "trusted"`
const serverKey = '[mcp_servers.browser-mcp]'
const serverBlock = [
  serverKey,
  `command = "${process.execPath}"`,
  `args = ["${path.join(repoRoot, 'mcp', 'server.mjs')}"]`,
  '',
  'startup_timeout_sec = 60',
].join('\n')

function upsertBlock(source, key, block) {
  const normalizedBlock = block.trim()
  const lines = source ? source.split('\n') : []
  const startIndex = lines.findIndex((line) => line === key)

  if (startIndex >= 0) {
    let endIndex = startIndex + 1
    while (endIndex < lines.length && !lines[endIndex].startsWith('[')) {
      endIndex += 1
    }

    const before = lines.slice(0, startIndex).join('\n').trimEnd()
    const after = lines.slice(endIndex).join('\n').trimStart()
    if (before && after) return `${before}\n\n${normalizedBlock}\n\n${after}\n`
    if (before) return `${before}\n\n${normalizedBlock}\n`
    if (after) return `${normalizedBlock}\n\n${after}\n`
    return `${normalizedBlock}\n`
  }

  const trimmed = source.trimEnd()
  return trimmed ? `${trimmed}\n\n${normalizedBlock}\n` : `${normalizedBlock}\n`
}

mkdirSync(configDir, { recursive: true })

const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
let next = upsertBlock(current, projectKey, projectBlock)
next = upsertBlock(next, serverKey, serverBlock)

writeFileSync(configPath, next)

console.log(`Updated Codex config at ${configPath}`)
console.log(`Registered MCP server browser-mcp -> ${path.join(repoRoot, 'mcp', 'server.mjs')}`)
