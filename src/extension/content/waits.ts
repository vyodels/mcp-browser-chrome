import type { QueryElementsRequest, WaitForConditionResponse, WaitForDisappearRequest, WaitForElementRequest, WaitForTextRequest } from '../shared/protocol'
import { MAX_QUERY_LIMIT, buildSnapshot, buildSnapshotSummary, clampPositiveInteger } from './snapshot'
import { queryElements } from './locators'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 250
const MAX_TIMEOUT_MS = 30_000
const MIN_POLL_MS = 100
const MAX_POLL_MS = 1000

function clampPollInterval(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POLL_MS
  return Math.max(MIN_POLL_MS, Math.min(Math.floor(parsed), MAX_POLL_MS))
}

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
  const timeoutMs = clampPositiveInteger(req.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const pollIntervalMs = clampPollInterval(req.pollIntervalMs)

  const result = await pollUntil(timeoutMs, pollIntervalMs, () => queryElements(req).length > 0)
  return {
    success: result.matched,
    matched: result.matched,
    elapsedMs: result.elapsedMs,
    matches: result.matched ? queryElements(req).slice(0, clampPositiveInteger(req.limit, 20, MAX_QUERY_LIMIT)) : [],
    snapshotSummary: snapshotSummary(),
    error: result.matched ? undefined : '等待元素超时',
  }
}

export async function waitForText(req: WaitForTextRequest): Promise<WaitForConditionResponse> {
  const timeoutMs = clampPositiveInteger(req.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const pollIntervalMs = clampPollInterval(req.pollIntervalMs)
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
  const timeoutMs = clampPositiveInteger(req.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const pollIntervalMs = clampPollInterval(req.pollIntervalMs)

  const result = await pollUntil(timeoutMs, pollIntervalMs, () => queryElements(req as QueryElementsRequest).length === 0)
  return {
    success: result.matched,
    matched: result.matched,
    elapsedMs: result.elapsedMs,
    snapshotSummary: snapshotSummary(),
    error: result.matched ? undefined : '等待元素消失超时',
  }
}
