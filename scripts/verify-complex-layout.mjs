import { spawn } from 'node:child_process'
import { createComplexLayoutServer, COMPLEX_LAYOUT, FIXTURE_SCROLL_Y } from './complex-layout-fixture.mjs'

const PROJECT_ROOT = '/Users/vyodels/AgentProjects/mcp-browser-chrome'
const MCP_TIMEOUT_MS = 20_000
const RECT_TOLERANCE = 2

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

function requireRect(actual, expected, label) {
  const failures = []
  for (const key of ['top', 'left', 'width', 'height']) {
    const delta = Math.abs(actual[key] - expected[key])
    if (delta > RECT_TOLERANCE) {
      failures.push(`${label}.${key}: expected ${expected[key]}, got ${actual[key]}, delta ${delta}`)
    }
  }
  return failures
}

function requireEqual(actual, expected, label) {
  return actual === expected ? [] : [`${label}: expected ${expected}, got ${actual}`]
}

function requireStartsWith(actual, prefix, label) {
  return typeof actual === 'string' && actual.startsWith(prefix)
    ? []
    : [`${label}: expected prefix ${prefix}, got ${actual}`]
}

function toDocumentRect(viewport) {
  return {
    top: viewport.top + FIXTURE_SCROLL_Y,
    left: viewport.left,
    width: viewport.width,
    height: viewport.height,
  }
}

function requireExpectedRects(actual, expectedViewport, label) {
  return [
    ...requireRect(actual.viewport, expectedViewport, `${label}.viewport`),
    ...requireRect(actual.document, toDocumentRect(expectedViewport), `${label}.document`),
  ]
}

function requireClickPointAbsent(actual, label) {
  return actual.clickPoint ? [`${label}.clickPoint: expected none`] : []
}

function requireClickPointPresent(actual, label) {
  return actual.clickPoint ? [] : [`${label}.clickPoint: missing`]
}

function requireClickPointInside(actual, label) {
  if (!actual.clickPoint) return [`${label}.clickPoint: missing`]
  const failures = []
  const { viewport, document } = actual.clickPoint
  if (viewport.x < actual.viewport.left || viewport.x > actual.viewport.left + actual.viewport.width) {
    failures.push(`${label}.clickPoint.viewport.x outside element viewport`)
  }
  if (viewport.y < actual.viewport.top || viewport.y > actual.viewport.top + actual.viewport.height) {
    failures.push(`${label}.clickPoint.viewport.y outside element viewport`)
  }
  if (document.x < actual.document.left || document.x > actual.document.left + actual.document.width) {
    failures.push(`${label}.clickPoint.document.x outside element document`)
  }
  if (document.y < actual.document.top || document.y > actual.document.top + actual.document.height) {
    failures.push(`${label}.clickPoint.document.y outside element document`)
  }
  return failures
}

async function openReusableTab(mcp, url, titleIncludes) {
  const focused = await mcp.call('browser_get_active_tab').catch(() => null)
  const listed = await mcp.call('browser_list_tabs', { currentWindowOnly: false }).catch(() => null)
  const reusable = listed?.tabs?.find((tab) => (
    (tab.title ?? '').includes(titleIncludes)
    && (!focused?.tab?.windowId || tab.windowId === focused.tab.windowId)
  ))
  return mcp.call('browser_open_tab', {
    tabId: reusable?.id,
    windowId: focused?.tab?.windowId,
    url,
    active: true,
  })
}

function requireTrianglePoint(actual, expectedViewport, label) {
  if (!actual.clickPoint) return [`${label}.clickPoint: missing`]
  const localX = actual.clickPoint.viewport.x - expectedViewport.left
  const localY = actual.clickPoint.viewport.y - expectedViewport.top
  const centerY = expectedViewport.height / 2
  const minX = expectedViewport.width * Math.abs(localY - centerY) / centerY
  const tolerance = Math.max(RECT_TOLERANCE * 2, expectedViewport.width * 0.2)
  return localX + tolerance >= minX ? [] : [`${label}.clickPoint.viewport not inside triangle`]
}

function requirePartialCoverAvoided(actual, expectedViewport, coveredWidth, label) {
  if (!actual.clickPoint) return [`${label}.clickPoint: missing`]
  return actual.clickPoint.viewport.x >= expectedViewport.left + coveredWidth
    ? []
    : [`${label}.clickPoint.viewport.x enters covered strip`]
}

function requireRandomizedPoint(left, right, label) {
  if (!left.clickPoint || !right.clickPoint) return [`${label}.clickPoint comparison missing`]
  const sameViewport = left.clickPoint.viewport.x === right.clickPoint.viewport.x &&
    left.clickPoint.viewport.y === right.clickPoint.viewport.y
  return sameViewport ? [`${label}.clickPoint stayed fixed across snapshots`] : []
}

function findClickable(clickables, text, tag) {
  return clickables.find((item) => item.text === text && item.tag === tag)
}

function findClickableIncludes(clickables, text, tag) {
  return clickables.find((item) => item.tag === tag && (item.text ?? '').includes(text))
}

function findClickableBy(clickables, predicate) {
  return clickables.find(predicate)
}

function findInaccessibleFrame(frames, predicate) {
  return frames.find(predicate)
}

function hasStateFieldSupport(snapshot) {
  return snapshot.clickables.some((item) => (
    item.value !== undefined ||
    item.placeholder !== undefined ||
    item.disabled !== undefined ||
    item.readonly !== undefined ||
    item.checked !== undefined ||
    item.selected !== undefined ||
    item.expanded !== undefined ||
    item.focused !== undefined
  ))
}

function hasInaccessibleFrameSupport(snapshot) {
  return Array.isArray(snapshot.inaccessibleFrames)
}

function frameViewportOrigin(frame) {
  return {
    top: frame.top - FIXTURE_SCROLL_Y + (frame.border ?? 0),
    left: frame.left + (frame.border ?? 0),
  }
}

function buildExpectedRects() {
  return {
    publishJob: {
      top: COMPLEX_LAYOUT.toolbar.top,
      left: COMPLEX_LAYOUT.toolbar.left,
      width: COMPLEX_LAYOUT.toolbar.width,
      height: COMPLEX_LAYOUT.toolbar.height,
    },
    openChat: {
      top: COMPLEX_LAYOUT.articleButton.top - FIXTURE_SCROLL_Y,
      left: COMPLEX_LAYOUT.articleButton.left,
      width: COMPLEX_LAYOUT.articleButton.width,
      height: COMPLEX_LAYOUT.articleButton.height,
    },
    resumeFrameButton: {
      top: frameViewportOrigin(COMPLEX_LAYOUT.libraryFrame).top + COMPLEX_LAYOUT.libraryFrameButton.top,
      left: frameViewportOrigin(COMPLEX_LAYOUT.libraryFrame).left + COMPLEX_LAYOUT.libraryFrameButton.left,
      width: COMPLEX_LAYOUT.libraryFrameButton.width,
      height: COMPLEX_LAYOUT.libraryFrameButton.height,
    },
    nestedDownload: {
      top: frameViewportOrigin(COMPLEX_LAYOUT.libraryFrame).top + COMPLEX_LAYOUT.nestedFrame.top + COMPLEX_LAYOUT.nestedFrameLink.top,
      left: frameViewportOrigin(COMPLEX_LAYOUT.libraryFrame).left + COMPLEX_LAYOUT.nestedFrame.left + COMPLEX_LAYOUT.nestedFrameLink.left,
      width: COMPLEX_LAYOUT.nestedFrameLink.width,
      height: COMPLEX_LAYOUT.nestedFrameLink.height,
    },
    favoriteCandidate: {
      top: COMPLEX_LAYOUT.shadowHost.top + COMPLEX_LAYOUT.shadowCard.border + COMPLEX_LAYOUT.shadowCard.paddingTop - FIXTURE_SCROLL_Y,
      left: COMPLEX_LAYOUT.shadowHost.left + COMPLEX_LAYOUT.shadowCard.border + COMPLEX_LAYOUT.shadowCard.paddingLeft,
      width: COMPLEX_LAYOUT.shadowButton.width,
      height: COMPLEX_LAYOUT.shadowButton.height,
    },
    closeDialog: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalClose.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalClose.left,
      width: COMPLEX_LAYOUT.modalClose.width,
      height: COMPLEX_LAYOUT.modalClose.height,
    },
    composer: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalComposer.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalComposer.left,
      width: COMPLEX_LAYOUT.modalComposer.width,
      height: COMPLEX_LAYOUT.modalComposer.height,
    },
    uploadResume: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalUploadInput.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalUploadInput.left,
      width: COMPLEX_LAYOUT.modalUploadInput.width,
      height: COMPLEX_LAYOUT.modalUploadInput.height,
    },
    viewOfflineResume: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalViewOfflineLink.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalViewOfflineLink.left,
      width: COMPLEX_LAYOUT.modalViewOfflineLink.width,
      height: COMPLEX_LAYOUT.modalViewOfflineLink.height,
    },
    downloadOfflineResume: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalDownloadLink.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalDownloadLink.left,
      width: COMPLEX_LAYOUT.modalDownloadLink.width,
      height: COMPLEX_LAYOUT.modalDownloadLink.height,
    },
    moreActions: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalTriangle.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalTriangle.left,
      width: COMPLEX_LAYOUT.modalTriangle.width,
      height: COMPLEX_LAYOUT.modalTriangle.height,
    },
    exchangeContacts: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalPartialAction.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalPartialAction.left,
      width: COMPLEX_LAYOUT.modalPartialAction.width,
      height: COMPLEX_LAYOUT.modalPartialAction.height,
    },
    sendMessage: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalAction.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalAction.left,
      width: COMPLEX_LAYOUT.modalAction.width,
      height: COMPLEX_LAYOUT.modalAction.height,
    },
    externalFrame: {
      top: COMPLEX_LAYOUT.externalFrame.top - FIXTURE_SCROLL_Y,
      left: COMPLEX_LAYOUT.externalFrame.left,
      width: COMPLEX_LAYOUT.externalFrame.width,
      height: COMPLEX_LAYOUT.externalFrame.height,
    },
    viewOnlineResume: {
      top: COMPLEX_LAYOUT.modal.top + COMPLEX_LAYOUT.modalFrame.top + COMPLEX_LAYOUT.modalFrameButton.top,
      left: COMPLEX_LAYOUT.modal.left + COMPLEX_LAYOUT.modalFrame.left + COMPLEX_LAYOUT.modalFrameButton.left,
      width: COMPLEX_LAYOUT.modalFrameButton.width,
      height: COMPLEX_LAYOUT.modalFrameButton.height,
    },
  }
}

function collectTargets(clickables) {
  return {
    publishJob: findClickable(clickables, '发布职位', 'button'),
    openChat: findClickable(clickables, '立即沟通', 'button'),
    jobDetailLink: findClickable(clickables, '查看职位详情', 'a'),
    searchInput: findClickableBy(clickables, (item) => item.tag === 'input' && item.name === 'jobQuery'),
    backgroundMessage: findClickableBy(clickables, (item) => item.tag === 'textarea' && item.name === 'candidateNote'),
    stageSelect: findClickableBy(clickables, (item) => item.tag === 'select'),
    moreFilters: findClickable(clickables, '更多筛选', 'div'),
    candidateTag: findClickable(clickables, '候选人标签', 'div'),
    scheduleInterview: findClickable(clickables, '安排面试', 'div'),
    resumeFrameButton: findClickable(clickables, '打开候选人档案', 'button'),
    nestedDownload: findClickable(clickables, '下载候选人附件', 'a'),
    favoriteCandidate: findClickable(clickables, '收藏候选人', 'button'),
    closeDialog: findClickable(clickables, '关闭沟通窗', 'button'),
    composer: findClickableBy(clickables, (item) => item.tag === 'textarea' && item.name === 'chatComposer'),
    uploadResume: findClickable(clickables, '上传附件简历', 'input'),
    viewOfflineResume: findClickable(clickables, '查看离线简历', 'a'),
    downloadOfflineResume: findClickable(clickables, '下载离线简历', 'a'),
    moreActions: findClickable(clickables, '更多沟通操作', 'div'),
    exchangeContacts: findClickable(clickables, '交换联系方式', 'button'),
    sendMessage: findClickable(clickables, '发送消息', 'button'),
    viewOnlineResume: findClickable(clickables, '查看在线简历', 'button'),
  }
}

async function main() {
  const fixture = await createComplexLayoutServer()
  const mcp = createMcpClient()

  try {
    const opened = await openReusableTab(mcp, fixture.url, '招聘中台坐标验收夹具')
    await mcp.call('browser_wait_for_navigation', { tabId: opened.tabId, timeoutMs: 8000 }).catch(() => null)
    await mcp.call('browser_wait_for_text', { tabId: opened.tabId, text: 'fixture-ready', timeoutMs: 12000, pollIntervalMs: 200 })
    await sleep(300)

    const first = await mcp.call('browser_snapshot', {
      tabId: opened.tabId,
      includeText: true,
      clickableLimit: 260,
    })
    await sleep(120)
    const second = await mcp.call('browser_snapshot', {
      tabId: opened.tabId,
      includeText: true,
      clickableLimit: 260,
    })

    const snapshot = first.snapshot
    if (!snapshot || !second.snapshot) {
      throw new Error(`browser_snapshot missing snapshot payload: first keys=${Object.keys(first).join(',')}, second keys=${Object.keys(second).join(',')}`)
    }

    const clickables = snapshot.clickables
    const stateFieldsSupported = hasStateFieldSupport(snapshot)
    const inaccessibleFrameSupported = hasInaccessibleFrameSupport(snapshot)
    const inaccessibleFrames = inaccessibleFrameSupported ? snapshot.inaccessibleFrames : []
    const target = first.target
    const expected = buildExpectedRects()
    const actual = collectTargets(clickables)
    const randomized = collectTargets(second.snapshot.clickables)
    const externalFrame = findInaccessibleFrame(inaccessibleFrames, (item) => item.title === '外部人才库')

    const failures = []
    for (const [key, value] of Object.entries(actual)) {
      if (!value) failures.push(`missing clickable: ${key}`)
    }

    if (failures.length === 0) {
      failures.push(
        ...requireEqual(first.tabId, opened.tabId, 'snapshotResult.tabId'),
        ...requireEqual(target?.tabId, opened.tabId, 'target.tabId'),
        ...requireEqual(typeof target?.windowId, 'number', 'target.windowId.type'),
        ...requireEqual(target?.url, snapshot.url, 'target.url'),
        ...requireEqual(target?.title, snapshot.title, 'target.title'),
        ...requireEqual(snapshot.viewport.scrollY, FIXTURE_SCROLL_Y, 'viewport.scrollY'),
        ...requireEqual(snapshot.viewport.scrollX, 0, 'viewport.scrollX'),
        ...requireExpectedRects(actual.publishJob, expected.publishJob, 'publishJob'),
        ...requireEqual(actual.publishJob.hitTestState, 'covered', 'publishJob.hitTestState'),
        ...requireClickPointAbsent(actual.publishJob, 'publishJob'),
        ...requireExpectedRects(actual.openChat, expected.openChat, 'openChat'),
        ...requireEqual(actual.openChat.hitTestState, 'covered', 'openChat.hitTestState'),
        ...requireClickPointAbsent(actual.openChat, 'openChat'),
        ...requireEqual(actual.jobDetailLink.hitTestState, 'covered', 'jobDetailLink.hitTestState'),
        ...requireClickPointAbsent(actual.jobDetailLink, 'jobDetailLink'),
        ...requireEqual(actual.searchInput.hitTestState, 'covered', 'searchInput.hitTestState'),
        ...requireEqual(actual.searchInput.type, 'text', 'searchInput.type'),
        ...(stateFieldsSupported ? requireEqual(actual.searchInput.text, '', 'searchInput.text') : []),
        ...(stateFieldsSupported ? requireEqual(actual.searchInput.value, '前端工程师', 'searchInput.value') : []),
        ...(stateFieldsSupported ? requireEqual(actual.searchInput.readonly, true, 'searchInput.readonly') : []),
        ...requireClickPointAbsent(actual.searchInput, 'searchInput'),
        ...requireEqual(actual.backgroundMessage.hitTestState, 'covered', 'backgroundMessage.hitTestState'),
        ...(stateFieldsSupported ? requireEqual(actual.backgroundMessage.text, '', 'backgroundMessage.text') : []),
        ...(stateFieldsSupported ? requireEqual(actual.backgroundMessage.placeholder, '给候选人留言', 'backgroundMessage.placeholder') : []),
        ...requireClickPointAbsent(actual.backgroundMessage, 'backgroundMessage'),
        ...requireEqual(actual.stageSelect.hitTestState, 'covered', 'stageSelect.hitTestState'),
        ...(stateFieldsSupported ? requireEqual(actual.stageSelect.value, '初筛中', 'stageSelect.value') : []),
        ...requireClickPointAbsent(actual.stageSelect, 'stageSelect'),
        ...requireEqual(actual.moreFilters.hitTestState, 'covered', 'moreFilters.hitTestState'),
        ...(stateFieldsSupported ? requireEqual(actual.moreFilters.expanded, true, 'moreFilters.expanded') : []),
        ...requireClickPointAbsent(actual.moreFilters, 'moreFilters'),
        ...requireEqual(actual.candidateTag.hitTestState, 'covered', 'candidateTag.hitTestState'),
        ...requireEqual(actual.candidateTag.role, 'option', 'candidateTag.role'),
        ...(stateFieldsSupported ? requireEqual(actual.candidateTag.selected, true, 'candidateTag.selected') : []),
        ...requireClickPointAbsent(actual.candidateTag, 'candidateTag'),
        ...requireEqual(actual.scheduleInterview.hitTestState, 'covered', 'scheduleInterview.hitTestState'),
        ...requireEqual(actual.scheduleInterview.role, 'checkbox', 'scheduleInterview.role'),
        ...(stateFieldsSupported ? requireEqual(actual.scheduleInterview.checked, true, 'scheduleInterview.checked') : []),
        ...requireClickPointAbsent(actual.scheduleInterview, 'scheduleInterview'),
        ...requireExpectedRects(actual.resumeFrameButton, expected.resumeFrameButton, 'resumeFrameButton'),
        ...requireEqual(actual.resumeFrameButton.framePath, '0', 'resumeFrameButton.framePath'),
        ...requireEqual(actual.resumeFrameButton.hitTestState, 'covered', 'resumeFrameButton.hitTestState'),
        ...requireClickPointAbsent(actual.resumeFrameButton, 'resumeFrameButton'),
        ...requireExpectedRects(actual.nestedDownload, expected.nestedDownload, 'nestedDownload'),
        ...requireEqual(actual.nestedDownload.framePath, '0.0', 'nestedDownload.framePath'),
        ...requireEqual(actual.nestedDownload.hitTestState, 'covered', 'nestedDownload.hitTestState'),
        ...requireEqual(actual.nestedDownload.download, 'candidate-portfolio.pdf', 'nestedDownload.download'),
        ...requireClickPointAbsent(actual.nestedDownload, 'nestedDownload'),
        ...requireExpectedRects(actual.favoriteCandidate, expected.favoriteCandidate, 'favoriteCandidate'),
        ...requireEqual(actual.favoriteCandidate.shadowDepth, 1, 'favoriteCandidate.shadowDepth'),
        ...requireEqual(actual.favoriteCandidate.hitTestState, 'covered', 'favoriteCandidate.hitTestState'),
        ...requireClickPointAbsent(actual.favoriteCandidate, 'favoriteCandidate'),
        ...requireExpectedRects(actual.closeDialog, expected.closeDialog, 'closeDialog'),
        ...requireEqual(actual.closeDialog.hitTestState, 'top', 'closeDialog.hitTestState'),
        ...requireClickPointPresent(actual.closeDialog, 'closeDialog'),
        ...requireClickPointInside(actual.closeDialog, 'closeDialog'),
        ...requireExpectedRects(actual.composer, expected.composer, 'composer'),
        ...requireEqual(actual.composer.hitTestState, 'top', 'composer.hitTestState'),
        ...(stateFieldsSupported ? requireEqual(actual.composer.text, '', 'composer.text') : []),
        ...(stateFieldsSupported ? requireEqual(actual.composer.placeholder, '输入消息，和候选人打个招呼', 'composer.placeholder') : []),
        ...(stateFieldsSupported && typeof actual.composer.focused !== 'boolean' ? ['composer.focused missing boolean state'] : []),
        ...requireClickPointPresent(actual.composer, 'composer'),
        ...requireClickPointInside(actual.composer, 'composer'),
        ...requireExpectedRects(actual.uploadResume, expected.uploadResume, 'uploadResume'),
        ...requireEqual(actual.uploadResume.hitTestState, 'top', 'uploadResume.hitTestState'),
        ...requireEqual(actual.uploadResume.type, 'file', 'uploadResume.type'),
        ...requireEqual(actual.uploadResume.accept, 'application/pdf,.pdf', 'uploadResume.accept'),
        ...requireEqual(actual.uploadResume.multiple, false, 'uploadResume.multiple'),
        ...requireClickPointPresent(actual.uploadResume, 'uploadResume'),
        ...requireClickPointInside(actual.uploadResume, 'uploadResume'),
        ...requireExpectedRects(actual.viewOfflineResume, expected.viewOfflineResume, 'viewOfflineResume'),
        ...requireEqual(actual.viewOfflineResume.hitTestState, 'top', 'viewOfflineResume.hitTestState'),
        ...requireClickPointPresent(actual.viewOfflineResume, 'viewOfflineResume'),
        ...requireClickPointInside(actual.viewOfflineResume, 'viewOfflineResume'),
        ...requireExpectedRects(actual.downloadOfflineResume, expected.downloadOfflineResume, 'downloadOfflineResume'),
        ...requireEqual(actual.downloadOfflineResume.hitTestState, 'top', 'downloadOfflineResume.hitTestState'),
        ...requireEqual(actual.downloadOfflineResume.download, 'candidate-resume.pdf', 'downloadOfflineResume.download'),
        ...requireClickPointPresent(actual.downloadOfflineResume, 'downloadOfflineResume'),
        ...requireClickPointInside(actual.downloadOfflineResume, 'downloadOfflineResume'),
        ...requireExpectedRects(actual.moreActions, expected.moreActions, 'moreActions'),
        ...requireEqual(actual.moreActions.hitTestState, 'top', 'moreActions.hitTestState'),
        ...requireClickPointPresent(actual.moreActions, 'moreActions'),
        ...requireClickPointInside(actual.moreActions, 'moreActions'),
        ...requireTrianglePoint(actual.moreActions, expected.moreActions, 'moreActions'),
        ...requireExpectedRects(actual.exchangeContacts, expected.exchangeContacts, 'exchangeContacts'),
        ...requireEqual(actual.exchangeContacts.hitTestState, 'partial', 'exchangeContacts.hitTestState'),
        ...requireClickPointPresent(actual.exchangeContacts, 'exchangeContacts'),
        ...requireClickPointInside(actual.exchangeContacts, 'exchangeContacts'),
        ...requirePartialCoverAvoided(actual.exchangeContacts, expected.exchangeContacts, COMPLEX_LAYOUT.modalPartialCover.width, 'exchangeContacts'),
        ...requireExpectedRects(actual.sendMessage, expected.sendMessage, 'sendMessage'),
        ...requireEqual(actual.sendMessage.hitTestState, 'top', 'sendMessage.hitTestState'),
        ...(stateFieldsSupported ? requireEqual(actual.sendMessage.disabled, true, 'sendMessage.disabled') : []),
        ...requireClickPointPresent(actual.sendMessage, 'sendMessage'),
        ...requireClickPointInside(actual.sendMessage, 'sendMessage'),
        ...(inaccessibleFrameSupported && !externalFrame ? ['missing inaccessible frame: externalFrame'] : []),
        ...(externalFrame ? requireExpectedRects(externalFrame, expected.externalFrame, 'externalFrame') : []),
        ...(externalFrame ? requireEqual(externalFrame.reason, 'cross_origin', 'externalFrame.reason') : []),
        ...(externalFrame ? requireEqual(externalFrame.name, 'external-talent', 'externalFrame.name') : []),
        ...(externalFrame ? requireEqual(externalFrame.title, '外部人才库', 'externalFrame.title') : []),
        ...(externalFrame ? requireStartsWith(externalFrame.host, '127.0.0.1:', 'externalFrame.host') : []),
        ...requireExpectedRects(actual.viewOnlineResume, expected.viewOnlineResume, 'viewOnlineResume'),
        ...requireEqual(actual.viewOnlineResume.framePath, inaccessibleFrameSupported ? '2' : '1', 'viewOnlineResume.framePath'),
        ...requireEqual(actual.viewOnlineResume.hitTestState, 'top', 'viewOnlineResume.hitTestState'),
        ...requireClickPointPresent(actual.viewOnlineResume, 'viewOnlineResume'),
        ...requireClickPointInside(actual.viewOnlineResume, 'viewOnlineResume'),
        ...requireRandomizedPoint(actual.closeDialog, randomized.closeDialog, 'closeDialog'),
        ...requireRandomizedPoint(actual.uploadResume, randomized.uploadResume, 'uploadResume'),
        ...requireRandomizedPoint(actual.viewOfflineResume, randomized.viewOfflineResume, 'viewOfflineResume'),
        ...requireRandomizedPoint(actual.exchangeContacts, randomized.exchangeContacts, 'exchangeContacts'),
      )

      const firstCoveredIndex = clickables.findIndex((item) => item.hitTestState === 'covered')
      if (firstCoveredIndex !== -1) {
        clickables.forEach((item, index) => {
          if (item.hitTestState === 'top' && index > firstCoveredIndex) {
            failures.push(`top clickables must stay ahead of covered clickables: ${item.text || item.tag} at index ${index}, first covered index ${firstCoveredIndex}`)
          }
        })
      }
    }

    const report = {
      success: failures.length === 0,
      tabId: first.tabId,
      target,
      stateFieldMode: stateFieldsSupported ? 'structured' : 'legacy-text-fallback',
      inaccessibleFrameMode: inaccessibleFrameSupported ? 'structured' : 'legacy-no-inaccessible-frames',
      url: snapshot.url,
      viewport: snapshot.viewport,
      document: snapshot.document,
      sample: clickables.map((item) => ({
        text: item.text,
        value: item.value,
        placeholder: item.placeholder,
        tag: item.tag,
        type: item.type,
        accept: item.accept,
        download: item.download,
        disabled: item.disabled,
        readonly: item.readonly,
        checked: item.checked,
        selected: item.selected,
        expanded: item.expanded,
        focused: item.focused,
        framePath: item.framePath,
        shadowDepth: item.shadowDepth,
        hitTestState: item.hitTestState,
        clickPoint: item.clickPoint,
        viewport: item.viewport,
        document: item.document,
      })),
      inaccessibleFrames,
      failures,
    }

    if (!report.success) {
      console.error(JSON.stringify(report, null, 2))
      process.exitCode = 1
      return
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    mcp.close()
    await fixture.close()
  }
}

await main()
