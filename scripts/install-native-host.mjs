#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const extensionId = process.argv.find((arg) => arg.startsWith('--extension-id='))?.split('=')[1]

if (!extensionId) {
  console.error('Usage: node scripts/install-native-host.mjs --extension-id=<chrome-extension-id>')
  process.exit(1)
}

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const hostScript = path.join(repoRoot, 'native-host', 'host.mjs')
const manifestDir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  : path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts')

mkdirSync(manifestDir, { recursive: true })
chmodSync(hostScript, 0o755)

const manifest = {
  name: 'com.vyodels.mcp_browser_chrome',
  description: 'Native messaging host for mcp-browser-chrome',
  path: hostScript,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}

const manifestPath = path.join(manifestDir, 'com.vyodels.mcp_browser_chrome.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Installed native host manifest at ${manifestPath}`)
