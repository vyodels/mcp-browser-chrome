import { getFrameByRef, normalizeFrameRef, registerFrameRef, resetFrameState } from './state'

export interface SearchRoot {
  root: ParentNode
  framePath: string[]
  frameRef?: string
  frameUrl?: string
  isMainFrame?: boolean
}

function safeFrameDocument(frame: HTMLIFrameElement | HTMLFrameElement): Document | null {
  try {
    return frame.contentDocument
  } catch {
    return null
  }
}

function collectRootsFromNode(root: ParentNode, framePath: string[], out: SearchRoot[], seen: WeakSet<object>, frameRef?: string, frameUrl?: string) {
  if (seen.has(root as object)) return
  seen.add(root as object)
  out.push({ root, framePath, frameRef, frameUrl, isMainFrame: framePath.length === 0 })

  const elements = root instanceof Document || root instanceof ShadowRoot
    ? Array.from(root.querySelectorAll('*'))
    : []

  for (const element of elements) {
    if (element instanceof HTMLElement && element.shadowRoot) {
      collectRootsFromNode(element.shadowRoot, framePath, out, seen, frameRef, frameUrl)
    }

    if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
      const frameDocument = safeFrameDocument(element)
      if (frameDocument?.documentElement) {
        const nextFramePath = [...framePath, element.id || element.name || `frame:${out.length}`]
        const nextFrameRef = registerFrameRef(frameDocument)
        collectRootsFromNode(frameDocument, nextFramePath, out, seen, nextFrameRef, frameDocument.location?.href)
      }
    }
  }
}

export function getSearchRoots(): SearchRoot[] {
  const roots: SearchRoot[] = []
  resetFrameState()
  collectRootsFromNode(document, [], roots, new WeakSet<object>())
  return roots
}

export function getFrameRoots(options: { frameRef?: string; includeMainFrame?: boolean } = {}) {
  const requestedFrameRef = normalizeFrameRef(options.frameRef)
  return getSearchRoots().filter((item) => {
    if (requestedFrameRef) {
      if (requestedFrameRef === '@main') return item.isMainFrame === true
      return item.frameRef === requestedFrameRef
    }
    if (options.includeMainFrame === false) return !item.isMainFrame
    return true
  })
}

export function listFrames(includeMainFrame = true) {
  return getFrameRoots({ includeMainFrame })
    .filter((item) => item.root instanceof Document)
    .filter((item) => includeMainFrame || !item.isMainFrame)
    .filter((item) => item.isMainFrame || item.frameRef)
    .map((item) => ({
      ref: item.frameRef ?? '@main',
      path: item.framePath,
      url: item.isMainFrame ? location.href : (item.frameUrl ?? ''),
      title: item.root instanceof Document ? item.root.title : undefined,
      sameOrigin: true,
      isMainFrame: item.isMainFrame === true,
    }))
}

export function queryAllElements(selector = '*', options: { frameRef?: string } = {}): Array<{ element: Element; framePath: string[]; frameRef?: string }> {
  const results: Array<{ element: Element; framePath: string[]; frameRef?: string }> = []
  for (const { root, framePath, frameRef } of getFrameRoots({ frameRef: options.frameRef })) {
    if (!(root instanceof Document || root instanceof ShadowRoot)) continue
    for (const element of Array.from(root.querySelectorAll(selector))) {
      results.push({ element, framePath, frameRef })
    }
  }
  return results
}

export function resolveFrameDocument(frameRef?: string): Document | null {
  const normalizedFrameRef = normalizeFrameRef(frameRef)
  if (!normalizedFrameRef || normalizedFrameRef === '@main') return document
  return getFrameByRef(normalizedFrameRef)
}

export function findElementLocation(element: Element): { framePath: string[]; frameRef?: string } | null {
  const ownerDocument = element.ownerDocument

  for (const item of getSearchRoots()) {
    if (!(item.root instanceof Document)) continue
    if (item.root === ownerDocument) {
      return {
        framePath: item.framePath,
        frameRef: item.frameRef,
      }
    }
  }

  if (ownerDocument === document) {
    return { framePath: [], frameRef: undefined }
  }

  return null
}

export function absoluteClientRect(element: Element) {
  let rect = element.getBoundingClientRect()
  let win: Window | null = element.ownerDocument.defaultView

  while (win && win !== window) {
    const frame = win.frameElement
    if (!frame) break
    const frameRect = frame.getBoundingClientRect()
    rect = {
      top: rect.top + frameRect.top,
      left: rect.left + frameRect.left,
      width: rect.width,
      height: rect.height,
      right: rect.left + frameRect.left + rect.width,
      bottom: rect.top + frameRect.top + rect.height,
      x: rect.left + frameRect.left,
      y: rect.top + frameRect.top,
      toJSON: () => undefined,
    } as DOMRect
    win = frame.ownerDocument.defaultView
  }

  return rect
}
