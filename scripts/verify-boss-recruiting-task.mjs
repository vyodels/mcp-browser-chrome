import { spawn } from 'node:child_process'
import { createBossRecruitingTaskServer } from './boss-recruiting-task-fixture.mjs'

const PROJECT_ROOT = '/Users/vyodels/AgentProjects/mcp-browser-chrome'
const MCP_TIMEOUT_MS = 20_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createMcpClient() {
  const child = spawn('node', ['mcp/server.mjs'], {
    cwd: PROJECT_ROOT,
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

function hasText(snapshot, value) {
  return (snapshot.text ?? '').includes(value) || snapshot.clickables.some((item) => (item.text ?? '').includes(value))
}

function findClickable(snapshot, predicate) {
  return snapshot.clickables.find(predicate)
}

function hasStateFieldSupport(snapshot) {
  return snapshot.clickables.some((item) => (
    item.value !== undefined ||
    item.placeholder !== undefined ||
    item.checked !== undefined ||
    item.disabled !== undefined ||
    item.focused !== undefined
  ))
}

function requireCondition(condition, message) {
  return condition ? [] : [message]
}

async function findReusableTab(mcp, titleIncludes) {
  const focused = await mcp.call('browser_get_active_tab').catch(() => null)
  const listed = await mcp.call('browser_list_tabs', { currentWindowOnly: false }).catch(() => null)
  return listed?.tabs?.find((tab) => (
    (tab.title ?? '').includes(titleIncludes)
    && (!focused?.tab?.windowId || tab.windowId === focused.tab.windowId)
  ))
}

function verifyJobList(snapshot) {
  const detailEntry = findClickable(snapshot, (item) => (item.text ?? '').includes('查看职位详情'))
  const candidateEntry = findClickable(snapshot, (item) => (item.text ?? '').includes('查看候选人'))
  return [
    ...requireCondition(snapshot.title.includes('职位列表'), 'job_list.title missing'),
    ...requireCondition(hasText(snapshot, '国际销售工程师'), 'job_list missing job title'),
    ...requireCondition(hasText(snapshot, '招聘中'), 'job_list missing active status'),
    ...requireCondition(!!detailEntry, 'job_list missing detail entry'),
    ...requireCondition(!!candidateEntry, 'job_list missing candidate entry'),
  ]
}

function verifyCandidateList(snapshot) {
  const supportsStateFields = hasStateFieldSupport(snapshot)
  const searchInput = findClickable(snapshot, (item) => (
    item.name === 'candidateSearch' &&
    (item.placeholder === '搜索候选人' || (!supportsStateFields && (item.text ?? '').includes('搜索候选人')))
  ))
  const attachmentFilter = findClickable(snapshot, (item) => (
    item.name === 'withAttachmentOnly' &&
    (item.checked === true || (!supportsStateFields && item.type === 'checkbox'))
  ))
  const detailEntry = findClickable(snapshot, (item) => (item.text ?? '').includes('查看候选人详情'))
  return [
    ...requireCondition(snapshot.title.includes('候选人推荐'), 'candidate_list.title missing'),
    ...requireCondition(hasText(snapshot, '李青'), 'candidate_list missing candidate name'),
    ...requireCondition(hasText(snapshot, '附件简历 PDF'), 'candidate_list missing resume clue'),
    ...requireCondition(!!searchInput, 'candidate_list missing search placeholder state'),
    ...requireCondition(!!attachmentFilter, 'candidate_list missing checked filter state'),
    ...requireCondition(!!detailEntry, 'candidate_list missing detail entry'),
  ]
}

function verifyCandidateDetail(snapshot) {
  const supportsStateFields = hasStateFieldSupport(snapshot)
  const downloadEntry = findClickable(snapshot, (item) => item.download === 'li-qing-resume.pdf')
  const uploadInput = findClickable(snapshot, (item) => item.type === 'file' && (item.accept ?? '').includes('pdf'))
  const composer = findClickable(snapshot, (item) => (
    item.name === 'chatComposer' &&
    (item.placeholder === '输入消息，和候选人打个招呼' || (!supportsStateFields && (item.text ?? '').includes('输入消息')))
  ))
  const disabledSend = findClickable(snapshot, (item) => (
    (item.text ?? '').includes('发送并开始沟通') &&
    (item.disabled === true || !supportsStateFields)
  ))
  return [
    ...requireCondition(snapshot.title.includes('候选人详情'), 'candidate_detail.title missing'),
    ...requireCondition(hasText(snapshot, '在线简历摘要'), 'candidate_detail missing online resume summary'),
    ...requireCondition(hasText(snapshot, '待本地 artifact 定位'), 'candidate_detail missing artifact location cue'),
    ...requireCondition(!!downloadEntry, 'candidate_detail missing resume download entry'),
    ...requireCondition(!!downloadEntry?.href && downloadEntry.href.startsWith('http://'), 'candidate_detail resume download entry missing absolute href'),
    ...requireCondition(!!uploadInput, 'candidate_detail missing upload accept state'),
    ...requireCondition(!!composer, 'candidate_detail missing composer placeholder state'),
    ...requireCondition(!!disabledSend, 'candidate_detail missing disabled send state'),
  ]
}

async function snapshotPage(mcp, url, reusableTabId) {
  const focused = await mcp.call('browser_get_active_tab').catch(() => null)
  const opened = await mcp.call('browser_open_tab', { tabId: reusableTabId, windowId: focused?.tab?.windowId, url, active: true })
  await mcp.call('browser_wait_for_navigation', { tabId: opened.tabId, timeoutMs: 8000 }).catch(() => null)
  await sleep(500)
  const result = await mcp.call('browser_snapshot', {
    tabId: opened.tabId,
    includeText: true,
    clickableLimit: 120,
  })
  return { ...result, tabId: opened.tabId }
}

async function main() {
  const fixture = await createBossRecruitingTaskServer()
  const mcp = createMcpClient()
  const failures = []

  try {
    const reusable = await findReusableTab(mcp, 'Recruiting Workspace')
    const jobs = await snapshotPage(mcp, fixture.routes.jobs, reusable?.id)
    failures.push(...verifyJobList(jobs.snapshot))

    const candidates = await snapshotPage(mcp, fixture.routes.candidates, jobs.tabId)
    failures.push(...verifyCandidateList(candidates.snapshot))

    const detail = await snapshotPage(mcp, fixture.routes.candidateDetail, jobs.tabId)
    failures.push(...verifyCandidateDetail(detail.snapshot))

    const report = {
      success: failures.length === 0,
      origin: fixture.origin,
      stateFieldMode: {
        jobList: hasStateFieldSupport(jobs.snapshot) ? 'structured' : 'legacy-text-fallback',
        candidateList: hasStateFieldSupport(candidates.snapshot) ? 'structured' : 'legacy-text-fallback',
        candidateDetail: hasStateFieldSupport(detail.snapshot) ? 'structured' : 'legacy-text-fallback',
      },
      pages: {
        jobList: jobs.snapshot.url,
        candidateList: candidates.snapshot.url,
        candidateDetail: detail.snapshot.url,
      },
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
