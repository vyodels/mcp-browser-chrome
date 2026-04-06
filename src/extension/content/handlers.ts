import type { AgentAction } from '../../types'
import type { QueryElementsRequest, SnapshotRequest, WaitForDisappearRequest, WaitForElementRequest, WaitForTextRequest } from '../shared/protocol'
import { executeLegacyAction, configureRateLimit } from './actions'
import { queryElements } from './locators'
import { buildSnapshot, buildSnapshotSummary } from './snapshot'
import { waitForDisappear, waitForElement, waitForText } from './waits'

export function registerContentHandlers() {
  // Wake the MV3 background service worker whenever the content script loads on a normal page.
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }, () => {
    void chrome.runtime.lastError
  })

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'GET_PAGE_CONTENT':
        sendResponse({ success: true, snapshot: buildSnapshot() })
        break

      case 'DEBUG_DOM':
        sendResponse({ success: true, snapshot: buildSnapshot({ includeHtml: true }) })
        break

      case 'QUERY_ELEMENTS': {
        const req = (message.payload ?? {}) as QueryElementsRequest
        const snapshot = buildSnapshot()
        sendResponse({
          success: true,
          matches: queryElements(req),
          snapshotSummary: buildSnapshotSummary(snapshot),
        })
        break
      }

      case 'WAIT_FOR_ELEMENT':
        waitForElement((message.payload ?? {}) as WaitForElementRequest).then(sendResponse)
        return true

      case 'WAIT_FOR_TEXT':
        waitForText((message.payload ?? {}) as WaitForTextRequest).then(sendResponse)
        return true

      case 'WAIT_FOR_DISAPPEAR':
        waitForDisappear((message.payload ?? {}) as WaitForDisappearRequest).then(sendResponse)
        return true

      case 'EXECUTE_ACTION':
        executeLegacyAction(message.payload as AgentAction).then(sendResponse)
        return true

      case 'CONFIGURE_RATE_LIMIT': {
        const payload = message.payload as { max: number; delay: [number, number] } | undefined
        if (!payload) {
          sendResponse({ success: false, error: '缺少限流配置' })
          break
        }
        configureRateLimit(payload.max, payload.delay)
        sendResponse({ success: true })
        break
      }

      case 'BROWSER_SNAPSHOT': {
        const req = (message.payload ?? {}) as SnapshotRequest
        sendResponse({ success: true, snapshot: buildSnapshot(req) })
        break
      }
    }
    return false
  })
}
