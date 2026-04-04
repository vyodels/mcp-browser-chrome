const refMap = new Map<string, Element>()
let refCounter = 0

export function resetRefState() {
  refMap.clear()
  refCounter = 0
}

export function registerElementRef(el: Element): string {
  const ref = `@e${++refCounter}`
  refMap.set(ref, el)
  return ref
}

export function getElementByRef(ref: string): Element | null {
  return refMap.get(ref) ?? null
}

