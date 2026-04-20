import type { Message } from '../../types'
import { dispatchContentMessage } from './dispatcher'

declare global {
  interface Window {
    __BROWSER_MCP_MOCK_BRIDGE__?: {
      handleMessage: (message: Pick<Message, 'type' | 'payload'>) => Promise<unknown>
    }
  }
}

export function installMockBridge() {
  window.__BROWSER_MCP_MOCK_BRIDGE__ = {
    handleMessage: (message) => dispatchContentMessage(message),
  }
}
