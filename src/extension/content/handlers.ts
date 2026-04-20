import { dispatchContentMessage } from './dispatcher'

export function registerContentHandlers() {
  // Wake the MV3 background service worker whenever the content script loads on a normal page.
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }, () => {
    void chrome.runtime.lastError
  })

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    dispatchContentMessage(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return true
  })
}
