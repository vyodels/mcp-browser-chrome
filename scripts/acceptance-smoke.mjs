import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const l1Only = args.has('--l1-only') || args.has('--static-only') || process.env.BROWSER_MCP_ACCEPTANCE_L1_ONLY === '1'
const showHelp = args.has('--help') || args.has('-h')
const EXPECTED_TOOLS = [
  'browser_list_tabs',
  'browser_get_active_tab',
  'browser_snapshot',
  'browser_query_elements',
  'browser_get_element',
  'browser_wait_for_element',
  'browser_wait_for_text',
  'browser_wait_for_navigation',
  'browser_wait_for_disappear',
  'browser_wait_for_url',
]
const DEBUG_ONLY_TOOLS = [
  'browser_debug_dom',
  'browser_reload_extension',
  'browser_select_tab',
  'browser_open_tab',
]
const FORBIDDEN_DEFAULT_TOOLS = [
  'browser_screenshot',
  'browser_get_cookies',
  'browser_locate_download',
  ...DEBUG_ONLY_TOOLS,
]

const BLACKLIST = [
  { label: 'MAIN world injection', pattern: /world:\s*['"]MAIN['"]/ },
  { label: 'synthetic MouseEvent', pattern: /new MouseEvent\(|dispatchEvent\(.*MouseEvent/ },
  { label: 'synthetic KeyboardEvent', pattern: /new KeyboardEvent\(|dispatchEvent\(.*KeyboardEvent/ },
  { label: 'chrome cookies API', pattern: /\bchrome\.cookies\b/ },
  { label: 'chrome downloads API', pattern: /\bchrome\.downloads\b/ },
  { label: 'captureVisibleTab API', pattern: /\bcaptureVisibleTab\b/ },
  { label: 'DOM innerHTML write', pattern: /\binnerHTML\s*=/ },
  { label: 'DOM outerHTML write', pattern: /\bouterHTML\s*=/ },
  { label: 'DOM textContent write', pattern: /\btextContent\s*=/ },
  { label: 'DOM value write', pattern: /\.value\s*=/ },
  { label: 'DOM appendChild write', pattern: /\bappendChild\s*\(/ },
  { label: 'DOM insertAdjacent write', pattern: /\binsertAdjacent(?:HTML|Text|Element)\s*\(/ },
  { label: 'DOM dispatchEvent', pattern: /\bdispatchEvent\s*\(/ },
  { label: 'React fake input setter', pattern: /HTMLInputElement\.prototype.*set.*call\(/ },
  { label: 'chrome debugger', pattern: /chrome\.debugger\./ },
  { label: 'eval', pattern: /\beval\s*\(/ },
  { label: 'Function constructor', pattern: /new Function\(/ },
  { label: 'legacy action symbols', pattern: /AgentAction|ActionResult|BrowserActionRequest|Workflow|CandidateEntry|rateLimit|throttleAction|OPEN_SETTINGS|GET_PAGE_CONTENT|GET_ACTIVE_TAB|GET_ALL_TABS/ },
  { label: 'legacy interactiveLimit field', pattern: /interactiveLimit/ },
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, filePath), 'utf8'))
}

function collectFiles(dir) {
  const root = path.join(PROJECT_ROOT, dir)
  if (!existsSync(root)) return []
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      const entryPath = path.join(current, entry)
      const stat = statSync(entryPath)
      if (stat.isDirectory()) {
        visit(entryPath)
      } else {
        files.push(entryPath)
      }
    }
  }
  visit(root)
  return files
}

function assertEqualSet(actual, expected, label) {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} mismatch\nactual: ${left.join(', ')}\nexpected: ${right.join(', ')}`)
  }
}

function assertManifest() {
  const sourceManifest = readJson('manifest.json')
  const distManifest = readJson('dist/manifest.json')
  for (const [label, manifest] of [['manifest', sourceManifest], ['dist manifest', distManifest]]) {
    if (manifest.manifest_version !== 3) throw new Error(`${label} manifest_version must be 3`)
    assertEqualSet(manifest.permissions ?? [], ['activeTab', 'tabs', 'scripting', 'nativeMessaging'], `${label}.permissions`)
    for (const forbidden of ['cookies', 'downloads']) {
      if ((manifest.permissions ?? []).includes(forbidden)) throw new Error(`${label} must not include ${forbidden} permission`)
    }
    assertEqualSet(manifest.host_permissions ?? [], ['<all_urls>'], `${label}.host_permissions`)
    if ((manifest.content_scripts ?? []).length !== 0) throw new Error(`${label} must not include static content_scripts`)
  }
  for (const forbidden of ['web_accessible_resources', 'externally_connectable', 'key']) {
    if (forbidden in distManifest) throw new Error(`dist manifest must not include ${forbidden}`)
  }
  const csp = JSON.stringify(distManifest.content_security_policy ?? '')
  if (/unsafe-eval|unsafe-inline/.test(csp)) throw new Error('dist manifest CSP must not include unsafe-eval or unsafe-inline')
}

function extractToolNames() {
  const server = readFileSync(path.join(PROJECT_ROOT, 'mcp/server.mjs'), 'utf8')
  const start = server.indexOf('const DEFAULT_TOOL_DEFS')
  const end = server.indexOf('const DEBUG_TOOL_DEFS')
  if (start < 0 || end < 0 || end <= start) throw new Error('could not locate default tool definitions')
  return [...server.slice(start, end).matchAll(/\['(browser_[^']+)'/g)].map((match) => match[1])
}

function extractProtocolNames() {
  const protocol = readFileSync(path.join(PROJECT_ROOT, 'src/extension/shared/protocol.ts'), 'utf8')
  return [...protocol.matchAll(/\|\s*'(browser_[^']+)'/g)].map((match) => match[1])
}

function extractNativeHostCommandNames(arrayName) {
  const host = readFileSync(path.join(PROJECT_ROOT, 'native-host/host.mjs'), 'utf8')
  const marker = `const ${arrayName} = [`
  const start = host.indexOf(marker)
  if (start < 0) throw new Error(`could not locate native host ${arrayName}`)
  const end = host.indexOf(']', start)
  if (end < 0) throw new Error(`could not locate native host ${arrayName} closing bracket`)
  return [...host.slice(start, end).matchAll(/'([^']+)'/g)].map((item) => item[1])
}

function assertNoBlacklistedSource() {
  const files = [
    ...collectFiles('src'),
    ...collectFiles('mcp'),
    ...collectFiles('native-host'),
  ].filter((file) => /\.(mjs|js|ts|tsx)$/.test(file))

  const failures = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const item of BLACKLIST) {
      if (item.pattern.test(text)) failures.push(`${path.relative(PROJECT_ROOT, file)}: ${item.label}`)
    }
  }
  if (failures.length) throw new Error(`blacklist failures:\n${failures.join('\n')}`)
}

function assertStaticContracts() {
  assertManifest()
  const defaultToolNames = extractToolNames()
  assertEqualSet(defaultToolNames, EXPECTED_TOOLS, 'MCP TOOLS')
  assertEqualSet(extractProtocolNames(), [...EXPECTED_TOOLS, ...DEBUG_ONLY_TOOLS], 'BrowserCommandName')
  assertEqualSet(extractNativeHostCommandNames('DEFAULT_BROWSER_COMMANDS'), EXPECTED_TOOLS, 'native host default commands')
  assertEqualSet(extractNativeHostCommandNames('DEBUG_BROWSER_COMMANDS'), DEBUG_ONLY_TOOLS, 'native host debug commands')
  for (const name of FORBIDDEN_DEFAULT_TOOLS) {
    if (defaultToolNames.includes(name)) throw new Error(`default tools/list must not include ${name}`)
    if (extractNativeHostCommandNames('DEFAULT_BROWSER_COMMANDS').includes(name)) throw new Error(`native host default commands must not include ${name}`)
  }
  assertNoBlacklistedSource()
  if (existsSync(path.join(PROJECT_ROOT, 'src/deprecated'))) throw new Error('src/deprecated must not exist')
  if (existsSync(path.join(PROJECT_ROOT, 'src/extension/content/actions.ts'))) throw new Error('src/extension/content/actions.ts must not exist')
  if (existsSync(path.join(PROJECT_ROOT, 'src/rateLimit.ts'))) throw new Error('src/rateLimit.ts must not exist')

  const pkg = readJson('package.json')
  const dependencies = Object.keys(pkg.dependencies ?? {})
  if (dependencies.length) throw new Error(`runtime dependencies must stay empty: ${dependencies.join(', ')}`)
}

if (showHelp) {
  console.log(`Usage: node scripts/acceptance-smoke.mjs [--l1-only]

Default: run L1 static checks and L2 local runtime acceptance.
--l1-only: run typecheck, build, manifest/tool/protocol/blacklist checks only.`)
  process.exit(0)
}

run('npm', ['run', 'typecheck'])
run('npm', ['run', 'build'])
assertStaticContracts()
run('npm', ['run', 'acceptance:native-host-allowlist'])
run('npm', ['run', 'acceptance:mcp-serialization'])
if (!l1Only) {
  const debugToolEnv = { MCP_BROWSER_CHROME_DEBUG_TOOLS: '1' }
  run('npm', ['run', 'acceptance:complex-layout'], { env: debugToolEnv })
  run('npm', ['run', 'acceptance:boss-mock'], { env: debugToolEnv })
  run('npm', ['run', 'acceptance:detectable-surface'], { env: debugToolEnv })
}

console.log(JSON.stringify({
  success: true,
  checked: {
    static: true,
    typecheck: true,
    build: true,
    nativeHostAllowlist: true,
    mcpSerialization: true,
    tools: EXPECTED_TOOLS.length,
    complexLayout: !l1Only,
    bossMock: !l1Only,
    detectableSurface: !l1Only,
  },
}, null, 2))
