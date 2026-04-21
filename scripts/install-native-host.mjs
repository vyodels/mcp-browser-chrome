#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const hostScript = path.join(repoRoot, 'native-host', 'host.mjs')
const hostLauncher = path.join(repoRoot, 'native-host', 'host-launcher')
const hostLauncherTemplate = path.join(repoRoot, 'native-host', 'host-launcher.template')
const distPath = path.join(repoRoot, 'dist')
const sourceManifestPath = path.join(repoRoot, 'manifest.json')
const manifestDir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  : path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts')
const securePreferencesPath = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Secure Preferences')
  : path.join(os.homedir(), '.config', 'google-chrome', 'Default', 'Secure Preferences')

function resolveExtensionIds() {
  const explicitId = process.argv.find((arg) => arg.startsWith('--extension-id='))?.split('=')[1]
  if (explicitId) return [explicitId]

  const ids = new Set()

  if (existsSync(sourceManifestPath)) {
    const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
    const manifestKey = sourceManifest?.key
    if (typeof manifestKey === 'string' && manifestKey.length > 0) {
      ids.add(deriveExtensionIdFromKey(manifestKey))
    }
  }

  if (!existsSync(securePreferencesPath)) {
    if (ids.size > 0) return [...ids]
    throw new Error(`Chrome Secure Preferences not found at ${securePreferencesPath}`)
  }

  const content = readFileSync(securePreferencesPath, 'utf8')
  const data = JSON.parse(content)
  const settings = data?.extensions?.settings

  if (!settings || typeof settings !== 'object') {
    throw new Error('Chrome extension settings are missing in Secure Preferences')
  }

  for (const [candidateId, extension] of Object.entries(settings)) {
    if (
      extension &&
      typeof extension === 'object' &&
      extension.path === distPath
    ) {
      ids.add(candidateId)
    }
  }

  if (ids.size > 0) return [...ids]

  throw new Error(
    `Could not find a loaded unpacked extension for ${distPath}. Load dist/ in chrome://extensions or pass --extension-id=<id>.`
  )
}

function deriveExtensionIdFromKey(base64Key) {
  const publicKey = Buffer.from(base64Key, 'base64')
  const digest = createHash('sha256').update(publicKey).digest()
  const alphabet = 'abcdefghijklmnop'
  let extensionId = ''

  for (const byte of digest.subarray(0, 16)) {
    extensionId += alphabet[(byte >> 4) & 0x0f]
    extensionId += alphabet[byte & 0x0f]
  }

  return extensionId
}

const extensionIds = resolveExtensionIds()

mkdirSync(manifestDir, { recursive: true })
chmodSync(hostScript, 0o755)

const launcherTemplate = readFileSync(hostLauncherTemplate, 'utf8')
const launcherScript = launcherTemplate
  .replaceAll('__NODE_PATH__', process.execPath)
  .replaceAll('__HOST_SCRIPT__', hostScript)
  .replace(/\s*$/, '\n')

writeFileSync(hostLauncher, launcherScript)
chmodSync(hostLauncher, 0o755)

const manifest = {
  name: 'com.vyodels.browser_mcp',
  description: 'Native messaging host for browser-mcp',
  path: hostLauncher,
  type: 'stdio',
  allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`),
}

const manifestPath = path.join(manifestDir, 'com.vyodels.browser_mcp.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Installed native host manifest at ${manifestPath}`)
console.log(`Allowed origins: ${manifest.allowed_origins.join(', ')}`)
