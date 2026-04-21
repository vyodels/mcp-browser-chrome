import type { AgentAction, Message } from '../../types'
import type {
  A11ySnapshotRequest,
  ConsoleMessagesRequest,
  DragRequest,
  EvaluateRequest,
  FillFormRequest,
  GetNetworkRequestRequest,
  NetworkRequestsRequest,
  QueryElementsRequest,
  RunCodeRequest,
  SnapshotRequest,
  WaitForDisappearRequest,
  WaitForElementRequest,
  WaitForNetworkEventRequest,
  WaitForTextRequest,
} from '../shared/protocol'
import { configureRateLimit, dragBetween, evaluateInPage, executeLegacyAction, fillForm, runCode } from './actions'
import { getConsoleMessages } from './consoleMonitor'
import { queryElements } from './locators'
import { getNetworkRequest, listNetworkRequests, waitForNetworkEvent } from './networkMonitor'
import { buildA11ySnapshot, buildFrameSnapshot, buildSnapshot, buildSnapshotSummary } from './snapshot'
import { waitForDisappear, waitForElement, waitForText } from './waits'

export async function dispatchContentMessage(message: Pick<Message, 'type' | 'payload'>) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_PING':
      return { success: true }

    case 'GET_PAGE_CONTENT':
      return { success: true, snapshot: buildSnapshot() }

    case 'DEBUG_DOM':
      return { success: true, snapshot: buildSnapshot({ includeHtml: true }) }

    case 'QUERY_ELEMENTS': {
      const req = (message.payload ?? {}) as QueryElementsRequest
      const snapshot = buildSnapshot(req.frameRef ? { frameRef: req.frameRef } : {})
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

    case 'BROWSER_A11Y_SNAPSHOT':
      return { success: true, snapshot: buildA11ySnapshot((message.payload ?? {}) as A11ySnapshotRequest) }

    case 'GET_FRAMES':
      return buildFrameSnapshot((message.payload as { includeMainFrame?: boolean } | undefined)?.includeMainFrame !== false)

    case 'GET_CONSOLE_MESSAGES':
      return getConsoleMessages((message.payload ?? {}) as ConsoleMessagesRequest)

    case 'GET_NETWORK_REQUESTS':
      return listNetworkRequests((message.payload ?? {}) as NetworkRequestsRequest)

    case 'GET_NETWORK_REQUEST':
      return getNetworkRequest((message.payload ?? {}) as GetNetworkRequestRequest)

    case 'WAIT_FOR_NETWORK_REQUEST':
    case 'WAIT_FOR_NETWORK_RESPONSE':
      return waitForNetworkEvent((message.payload ?? {}) as WaitForNetworkEventRequest)

    case 'FILL_FORM':
      return fillForm(
        (((message.payload ?? {}) as FillFormRequest).elements ?? []).map((element) => ({
          ...element,
          frameRef: element.frameRef ?? ((message.payload ?? {}) as FillFormRequest).frameRef,
        }))
      )

    case 'DRAG':
      return dragBetween((message.payload ?? {}) as DragRequest)

    case 'UPLOAD_FILE':
      return executeLegacyAction({
        ...((message.payload ?? {}) as AgentAction),
        action: 'upload_file',
      })

    case 'EVALUATE':
      return evaluateInPage((message.payload ?? {}) as EvaluateRequest)

    case 'RUN_CODE':
      return runCode((message.payload ?? {}) as RunCodeRequest)

    default:
      return { success: false, error: `不支持的消息类型: ${message.type}` }
  }
}
