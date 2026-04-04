import type { QueryElementsRequest, WaitForConditionResponse, WaitForDisappearRequest, WaitForElementRequest, WaitForTextRequest } from '../shared/protocol'
import { buildSnapshot, buildSnapshotSummary } from './snapshot'
import { queryElements } from './locators'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 250

async function pollUntil(
  timeoutMs: number,
  pollIntervalMs: number,
  predicate: () => boolean
): Promise<{ matched: boolean; elapsedMs: number }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return { matched: true, elapsedMs: Date.now() - start }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  return { matched: false, elapsedMs: Date.now() - start }
}

function snapshotSummary() {
  return buildSnapshotSummary(buildSnapshot())
}

export async function waitForElement(req: WaitForElementRequest): Promise<WaitForConditionResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = req.pollIntervalMs ?? DEFAULT_POLL_MS

  const result = await pollUntil(timeoutMs, pollIntervalMs, () => queryElements(req).length > 0)
  return {
    success: result.matched,
    matched: result.matched,
    elapsedMs: result.elapsedMs,
    matches: result.matched ? queryElements(req).slice(0, req.limit ?? 20) : [],
    snapshotSummary: snapshotSummary(),
    error: result.matched ? undefined : '等待元素超时',
  }
}

export async function waitForText(req: WaitForTextRequest): Promise<WaitForConditionResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = req.pollIntervalMs ?? DEFAULT_POLL_MS
  const needle = req.text.trim().toLowerCase()

  const result = await pollUntil(timeoutMs, pollIntervalMs, () => {
    return document.body.innerText.toLowerCase().includes(needle)
  })

  return {
    success: result.matched,
    matched: result.matched,
    elapsedMs: result.elapsedMs,
    snapshotSummary: snapshotSummary(),
    error: result.matched ? undefined : `等待文本超时: ${req.text}`,
  }
}

export async function waitForDisappear(req: WaitForDisappearRequest): Promise<WaitForConditionResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = req.pollIntervalMs ?? DEFAULT_POLL_MS

  const result = await pollUntil(timeoutMs, pollIntervalMs, () => queryElements(req as QueryElementsRequest).length === 0)
  return {
    success: result.matched,
    matched: result.matched,
    elapsedMs: result.elapsedMs,
    snapshotSummary: snapshotSummary(),
    error: result.matched ? undefined : '等待元素消失超时',
  }
}

