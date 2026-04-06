#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const nativeManifestPath = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.vyodels.browser_mcp.json')
  : path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', 'com.vyodels.browser_mcp.json')
const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml')
const distManifestPath = path.join(repoRoot, 'dist', 'manifest.json')
const distBackgroundPath = path.join(repoRoot, 'dist', 'background.js')
const distContentPath = path.join(repoRoot, 'dist', 'content.js')

function runStep(title, file, args) {
  process.stdout.write(`\n[setup:auto] ${title}\n`)
  execFileSync(file, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  })
}

function assertFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} missing: ${filePath}`)
  }
}

function verifyNativeManifest() {
  assertFileExists(nativeManifestPath, 'Native messaging manifest')
  const manifest = JSON.parse(readFileSync(nativeManifestPath, 'utf8'))
  const origins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : []
  if (!origins.length) {
    throw new Error(`Native messaging manifest has no allowed_origins: ${nativeManifestPath}`)
  }
  return origins
}

function verifyCodexConfig() {
  assertFileExists(codexConfigPath, 'Codex config')
  const content = readFileSync(codexConfigPath, 'utf8')
  if (!content.includes('[mcp_servers.browser-mcp]')) {
    throw new Error(`browser-mcp MCP server missing from ${codexConfigPath}`)
  }
}

function verifyDist() {
  assertFileExists(distManifestPath, 'Built manifest')
  assertFileExists(distBackgroundPath, 'Built background script')
  assertFileExists(distContentPath, 'Built content script')
}

try {
  runStep('Building extension', 'npm', ['run', 'build'])
  runStep('Installing Chrome Native Messaging manifest', process.execPath, ['scripts/install-native-host.mjs'])
  runStep('Installing Codex MCP server config', process.execPath, ['scripts/install-codex-mcp.mjs'])

  verifyDist()
  const allowedOrigins = verifyNativeManifest()
  verifyCodexConfig()

  process.stdout.write('\n[setup:auto] Summary\n')
  process.stdout.write(`[ok] dist built at ${path.join(repoRoot, 'dist')}\n`)
  process.stdout.write(`[ok] native host manifest installed at ${nativeManifestPath}\n`)
  process.stdout.write(`[ok] allowed origins: ${allowedOrigins.join(', ')}\n`)
  process.stdout.write(`[ok] Codex MCP server registered in ${codexConfigPath}\n`)
  process.stdout.write('[next] If you are upgrading from an older unpacked extension load, reload browser-mcp once in chrome://extensions\n')
} catch (error) {
  process.stderr.write(`\n[setup:auto] Failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
