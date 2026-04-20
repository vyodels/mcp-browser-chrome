import type { AgentAction, Message } from '../../types'
import type {
  QueryElementsRequest,
  SnapshotRequest,
  WaitForDisappearRequest,
  WaitForElementRequest,
  WaitForTextRequest,
} from '../shared/protocol'
import { executeLegacyAction, configureRateLimit } from './actions'
import { queryElements } from './locators'
import { buildSnapshot, buildSnapshotSummary } from './snapshot'
import { waitForDisappear, waitForElement, waitForText } from './waits'

export async function dispatchContentMessage(message: Pick<Message, 'type' | 'payload'>) {
  switch (message.type) {
    case 'GET_PAGE_CONTENT':
      return { success: true, snapshot: buildSnapshot() }

    case 'DEBUG_DOM':
      return { success: true, snapshot: buildSnapshot({ includeHtml: true }) }

    case 'QUERY_ELEMENTS': {
      const req = (message.payload ?? {}) as QueryElementsRequest
      const snapshot = buildSnapshot()
      return {
        success: true,
        matches: queryElements(req),
        snapshotSummary: buildSnapshotSummary(snapshot),
      }
    }

    case 'WAIT_FOR_ELEMENT':
      return waitForElement((message.payload ?? {}) as WaitForElementRequest)

    case 'WAIT_FOR_TEXT':
      return waitForText((message.payload ?? {}) as WaitForTextRequest)

    case 'WAIT_FOR_DISAPPEAR':
      return waitForDisappear((message.payload ?? {}) as WaitForDisappearRequest)

    case 'EXECUTE_ACTION':
      return executeLegacyAction(message.payload as AgentAction)

    case 'CONFIGURE_RATE_LIMIT': {
      const payload = message.payload as { max: number; delay: [number, number] } | undefined
      if (!payload) {
        return { success: false, error: '缺少限流配置' }
      }
      configureRateLimit(payload.max, payload.delay)
      return { success: true }
    }

    case 'BROWSER_SNAPSHOT': {
      const req = (message.payload ?? {}) as SnapshotRequest
      return { success: true, snapshot: buildSnapshot(req) }
    }

    default:
      return { success: false, error: `不支持的消息类型: ${message.type}` }
  }
}
