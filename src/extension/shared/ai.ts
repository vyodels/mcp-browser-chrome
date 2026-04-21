export interface PageInfo {
  cursor: number
  limit: number
  returned: number
  total: number
  hasMore: boolean
  nextCursor?: number
}

export interface TextSliceInfo {
  offset: number
  returnedLength: number
  totalLength: number
  truncated: boolean
  nextOffset?: number
}

export function clampLimit(limit: unknown, fallback: number, max: number): number {
  const parsed = Number(limit)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.floor(parsed)))
}

export function clampCursor(cursor: unknown): number {
  const parsed = Number(cursor)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

export function paginateItems<T>(items: T[], cursor: unknown, limit: unknown, fallback = 50, max = 200) {
  const normalizedCursor = clampCursor(cursor)
  const normalizedLimit = clampLimit(limit, fallback, max)
  const pageItems = items.slice(normalizedCursor, normalizedCursor + normalizedLimit)
  const nextCursor = normalizedCursor + pageItems.length

  return {
    items: pageItems,
    pageInfo: {
      cursor: normalizedCursor,
      limit: normalizedLimit,
      returned: pageItems.length,
      total: items.length,
      hasMore: nextCursor < items.length,
      nextCursor: nextCursor < items.length ? nextCursor : undefined,
    } satisfies PageInfo,
  }
}

export function sliceText(value: string, offset: unknown, maxLength: unknown, fallback = 4000, max = 12000) {
  const normalizedOffset = clampCursor(offset)
  const normalizedLength = clampLimit(maxLength, fallback, max)
  const content = value.slice(normalizedOffset, normalizedOffset + normalizedLength)
  const nextOffset = normalizedOffset + content.length

  return {
    content,
    info: {
      offset: normalizedOffset,
      returnedLength: content.length,
      totalLength: value.length,
      truncated: nextOffset < value.length,
      nextOffset: nextOffset < value.length ? nextOffset : undefined,
    } satisfies TextSliceInfo,
  }
}

export function previewText(value: string, maxLength = 280) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return {
      text: normalized,
      truncated: false,
      totalLength: normalized.length,
    }
  }

  return {
    text: `${normalized.slice(0, maxLength)}...`,
    truncated: true,
    totalLength: normalized.length,
  }
}

export function safeSerialize(value: unknown, options: { depth?: number; maxStringLength?: number; maxArrayLength?: number } = {}): unknown {
  const {
    depth = 4,
    maxStringLength = 2000,
    maxArrayLength = 20,
  } = options
  const seen = new WeakSet<object>()

  const walk = (input: unknown, currentDepth: number): unknown => {
    if (input == null) return input
    if (typeof input === 'string') {
      return input.length > maxStringLength ? `${input.slice(0, maxStringLength)}...` : input
    }
    if (typeof input === 'number' || typeof input === 'boolean') return input
    if (typeof input === 'bigint') return input.toString()
    if (typeof input === 'function') return `[Function ${input.name || 'anonymous'}]`
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        stack: input.stack ? walk(input.stack, currentDepth + 1) : undefined,
      }
    }
    if (typeof Element !== 'undefined' && input instanceof Element) {
      return {
        kind: 'element',
        tag: input.tagName.toLowerCase(),
        id: input.id || undefined,
        className: input.className || undefined,
        text: previewText(input.textContent ?? '', 160).text || undefined,
      }
    }
    if (currentDepth >= depth) {
      if (Array.isArray(input)) return `[Array(${input.length})]`
      return '[Object]'
    }
    if (typeof input === 'object') {
      if (seen.has(input as object)) return '[Circular]'
      seen.add(input as object)

      if (Array.isArray(input)) {
        return input.slice(0, maxArrayLength).map((item) => walk(item, currentDepth + 1))
      }

      const output: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(input as Record<string, unknown>).slice(0, 50)) {
        output[key] = walk(nested, currentDepth + 1)
      }
      return output
    }

    return String(input)
  }

  return walk(value, 0)
}
