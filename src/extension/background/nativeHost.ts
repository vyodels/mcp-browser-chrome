import type { BrowserCommand, NativeBridgeRequest, NativeBridgeResponse } from '../shared/protocol'
import { NATIVE_HOST_NAME } from '../shared/protocol'

export interface NativeHostBridge {
  start: () => void
}

export function createNativeHostBridge(
  executeCommand: (command: BrowserCommand) => Promise<unknown>
): NativeHostBridge {
  let port: chrome.runtime.Port | null = null
  let reconnectTimer: number | null = null
  let connecting = false

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  const connect = () => {
    if (port || connecting) return

    clearReconnectTimer()
    connecting = true

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch (error) {
      connecting = false
      scheduleReconnect()
      console.error('[native-host] connect failed', error)
      return
    }

    connecting = false

    port.onMessage.addListener(handleMessage)
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message
      if (err) console.warn('[native-host] disconnected:', err)
      port = null
      scheduleReconnect()
    })
  }

  const scheduleReconnect = () => {
    if (reconnectTimer !== null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, 1500) as unknown as number
  }

  const postResponse = (message: NativeBridgeResponse) => {
    try {
      port?.postMessage(message)
    } catch (error) {
      console.error('[native-host] post response failed', error)
    }
  }

  const handleMessage = async (message: NativeBridgeRequest) => {
    if (!message || message.type !== 'browser_command' || !message.id || !message.command) return

    try {
      const result = await executeCommand(message.command)
      postResponse({
        id: message.id,
        ok: true,
        result,
      })
    } catch (error) {
      postResponse({
        id: message.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  return {
    start: connect,
  }
}
