const refMap = new Map<string, Element>()
const elementRefMap = new WeakMap<Element, string>()
const frameMap = new Map<string, Document>()
const frameDocMap = new WeakMap<Document, string>()
const MAIN_FRAME_REFS = new Set(['main', '@main'])
let refCounter = 0
let frameCounter = 0

export function resetRefState() {
  refMap.clear()
}

export function normalizeFrameRef(frameRef?: string): string | undefined {
  if (!frameRef) return undefined
  return MAIN_FRAME_REFS.has(frameRef) ? '@main' : frameRef
}

export function registerElementRef(el: Element): string {
  const existing = elementRefMap.get(el)
  if (existing) {
    refMap.set(existing, el)
    return existing
  }
  const ref = `@e${++refCounter}`
  refMap.set(ref, el)
  elementRefMap.set(el, ref)
  return ref
}

export function getElementByRef(ref: string): Element | null {
  const element = refMap.get(ref) ?? null
  if (!element?.isConnected) {
    refMap.delete(ref)
    return null
  }
  return element
}

export function registerFrameRef(documentNode: Document): string {
  const existing = frameDocMap.get(documentNode)
  if (existing) {
    frameMap.set(existing, documentNode)
    return existing
  }
  const ref = `@local-frame:${++frameCounter}`
  frameMap.set(ref, documentNode)
  frameDocMap.set(documentNode, ref)
  return ref
}

export function getFrameByRef(ref: string): Document | null {
  if (MAIN_FRAME_REFS.has(ref)) return document
  const documentNode = frameMap.get(ref) ?? null
  if (!documentNode) return null

  const ownerFrame = documentNode.defaultView?.frameElement
  if (ownerFrame && !ownerFrame.isConnected) {
    frameMap.delete(ref)
    return null
  }

  return documentNode
}

export function resetFrameState() {
  frameMap.clear()
}
