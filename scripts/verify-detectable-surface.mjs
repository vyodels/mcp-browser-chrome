import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDetectableSurfaceServer } from './detectable-surface-fixture.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MCP_TIMEOUT_MS = 20_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createMcpClient() {
  const child = spawn('node', ['mcp/server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MCP_BROWSER_CHROME_DEBUG_TOOLS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let buffer = ''
  let nextId = 0
  const pending = new Map()

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk)
  })

  return {
    async call(name, args = {}) {
      const id = ++nextId
      const payload = {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }

      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP timeout: ${name}`))
        }, MCP_TIMEOUT_MS)

        pending.set(id, {
          resolve: (message) => {
            clearTimeout(timer)
            resolve(message)
          },
        })
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      })

      const result = response.result?.structuredContent
      if (!result) {
        throw new Error(response.result?.content?.[0]?.text ?? `tool failed: ${name}`)
      }
      return result
    },
    close() {
      child.kill('SIGTERM')
    },
  }
}

function parseReport(snapshotResult, label) {
  const text = snapshotResult.snapshot?.text ?? ''
  const match = text.match(/REPORT_START(\{.*\})REPORT_END/s)
  if (!match) {
    throw new Error(`${label}: detectable report not found in snapshot text`)
  }
  return JSON.parse(match[1])
}

async function readReport(mcp, tabId, label) {
  const result = await mcp.call('browser_snapshot', {
    tabId,
    includeText: true,
    maxTextLength: 60_000,
    clickableLimit: 20,
  })
  return parseReport(result, label)
}

async function readStableReport(mcp, tabId, label, timeoutMs = 5000) {
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < timeoutMs) {
    last = await readReport(mcp, tabId, label)
    if (last.readyState === 'complete' && last.visibilityState === 'visible' && last.elapsedMs >= 300) return last
    await sleep(150)
  }
  return last ?? readReport(mcp, tabId, label)
}

function delta(after, before, key) {
  return (after[key] ?? 0) - (before[key] ?? 0)
}

function mutationDelta(after, before = {}) {
  return {
    addedNodes: delta(after, before, 'addedNodes'),
    removedNodes: delta(after, before, 'removedNodes'),
    attributes: delta(after, before, 'attributes'),
    characterData: delta(after, before, 'characterData'),
  }
}

function total(values) {
  return Object.values(values ?? {}).reduce((sum, value) => sum + value, 0)
}

function countSignals(report, baseline) {
  const mutationSummary = baseline
    ? mutationDelta(report.mutationSummary ?? {}, baseline.mutationSummary ?? {})
    : (report.mutationSummary ?? {})
  const failureSignals = (report.failureSignals ?? [])
    .filter((signal) => signal !== 'unexpected DOM mutation observed')
  if (total(mutationSummary) > 0) {
    failureSignals.push('unexpected DOM mutation observed')
  }

  return {
    failureSignals,
    untrustedTotal: baseline
      ? total(report.untrustedEventCounters) - total(baseline.untrustedEventCounters)
      : total(report.untrustedEventCounters),
    lifecycle: report.lifecycle ?? {},
    mutationSummary,
  }
}

async function waitForActiveTab(mcp, tabId, timeoutMs = 4000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const listed = await mcp.call('browser_list_tabs', { currentWindowOnly: false })
    const target = listed.tabs?.find((tab) => tab.id === tabId)
    if (target?.active === true) return target
    await sleep(100)
  }
  throw new Error(`tab ${tabId} did not become active`)
}

async function openReusableTab(mcp, url, titleIncludes, active = true, preferredWindowId = undefined) {
  const focused = await mcp.call('browser_get_active_tab').catch(() => null)
  const windowId = preferredWindowId ?? focused?.tab?.windowId
  const listed = await mcp.call('browser_list_tabs', { currentWindowOnly: false }).catch(() => null)
  const reusable = listed?.tabs?.find((tab) => (
    (tab.title ?? '').includes(titleIncludes)
    && (!windowId || tab.windowId === windowId)
  ))
  return mcp.call('browser_open_tab', {
    tabId: reusable?.id,
    windowId,
    url,
    active,
  })
}

async function main() {
  const fixture = await createDetectableSurfaceServer()
  const mcp = createMcpClient()
  const failures = []

  try {
    const focused = await mcp.call('browser_get_active_tab').catch(() => null)
    const preferredWindowId = focused?.tab?.windowId
    const opened = await openReusableTab(mcp, fixture.routes.probe, 'browser MCP 可感知性检测页', true, preferredWindowId)
    await mcp.call('browser_wait_for_navigation', { tabId: opened.tabId, timeoutMs: 8000 }).catch(() => null)
    await mcp.call('browser_wait_for_text', { tabId: opened.tabId, text: 'detectable-surface-ready', timeoutMs: 12_000, pollIntervalMs: 200 })
    await mcp.call('browser_select_tab', { tabId: opened.tabId })
    await waitForActiveTab(mcp, opened.tabId)

    const before = await readStableReport(mcp, opened.tabId, 'before observe tools')

    const observeResults = {
      snapshot: await mcp.call('browser_snapshot', { tabId: opened.tabId, includeText: true, clickableLimit: 40 }),
      queryElements: await mcp.call('browser_query_elements', { tabId: opened.tabId, selector: 'button', limit: 5 }),
      getElement: await mcp.call('browser_get_element', { tabId: opened.tabId, selector: '#surface-button' }),
      waitForElement: await mcp.call('browser_wait_for_element', { tabId: opened.tabId, selector: '#surface-button', timeoutMs: 2000, pollIntervalMs: 100 }),
      waitForText: await mcp.call('browser_wait_for_text', { tabId: opened.tabId, text: 'detectable-surface-ready', timeoutMs: 2000, pollIntervalMs: 100 }),
      waitForDisappear: await mcp.call('browser_wait_for_disappear', { tabId: opened.tabId, selector: '#surface-never-exists', timeoutMs: 500, pollIntervalMs: 100 }),
      debugDom: await mcp.call('browser_debug_dom', { tabId: opened.tabId }),
    }

    await sleep(600)
    const afterObserve = await readReport(mcp, opened.tabId, 'after observe tools')
    const observeSignals = countSignals(afterObserve, before)
    if (observeSignals.failureSignals.length) {
      failures.push(`observe tools left JS-visible signals: ${observeSignals.failureSignals.join(', ')}`)
    }

    const secondary = await openReusableTab(mcp, fixture.routes.secondary, 'browser MCP 次级标签页', true, opened.tab?.windowId ?? preferredWindowId)
    await mcp.call('browser_wait_for_text', { tabId: secondary.tabId, text: 'detectable-surface-ready', timeoutMs: 4000, pollIntervalMs: 100 })
    await mcp.call('browser_select_tab', { tabId: opened.tabId })
    await waitForActiveTab(mcp, opened.tabId)
    await mcp.call('browser_wait_for_text', { tabId: opened.tabId, text: 'detectable-surface-ready', timeoutMs: 4000, pollIntervalMs: 100 })
    const beforeSwitch = await readReport(mcp, opened.tabId, 'before tab switch')
    await mcp.call('browser_select_tab', { tabId: secondary.tabId })
    await sleep(300)
    await mcp.call('browser_select_tab', { tabId: opened.tabId })
    await mcp.call('browser_wait_for_text', { tabId: opened.tabId, text: 'detectable-surface-ready', timeoutMs: 4000, pollIntervalMs: 100 })
    await sleep(600)
    const afterSwitch = await readReport(mcp, opened.tabId, 'after tab switch')

    const lifecycleDelta = {
      visibilitychange: delta(afterSwitch.lifecycle, beforeSwitch.lifecycle, 'visibilitychange'),
      focus: delta(afterSwitch.lifecycle, beforeSwitch.lifecycle, 'focus'),
      blur: delta(afterSwitch.lifecycle, beforeSwitch.lifecycle, 'blur'),
    }

    const report = {
      success: failures.length === 0,
      origin: fixture.origin,
      probeTabId: opened.tabId,
      secondaryTabId: secondary.tabId,
      observeTools: {
        tested: Object.keys(observeResults),
        jsVisibleSignals: observeSignals.failureSignals,
        untrustedEventTotal: observeSignals.untrustedTotal,
        mutationSummary: observeSignals.mutationSummary,
      },
      tabManagement: {
        jsVisibleByDesign: lifecycleDelta.visibilitychange > 0 || lifecycleDelta.focus > 0 || lifecycleDelta.blur > 0,
        lifecycleDelta,
      },
      conclusion: {
        readOnlyObservationTools: failures.length === 0 ? 'not_detected_by_fixture_js' : 'detected_by_fixture_js',
        browserSelectTab: 'page_js_can_observe_visibility_focus_lifecycle',
        removedDefaultTools: 'cookie_download_screenshot_not_part_of_default_surface',
      },
      before,
      afterObserve,
      afterSwitch,
      failures,
    }

    console.log(JSON.stringify(report, null, 2))
    if (failures.length) process.exitCode = 1
  } finally {
    mcp.close()
    await fixture.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
