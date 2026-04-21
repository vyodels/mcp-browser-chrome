// ============================================================
// rateLimit.ts — 风控保护：随机延迟 + 频率限制
// ============================================================

interface RateLimitState {
  actionTimestamps: number[]
  maxActionsPerMinute: number
  delayRange: [number, number]
}

const state: RateLimitState = {
  actionTimestamps: [],
  maxActionsPerMinute: 12,
  delayRange: [800, 2500],
}

export function configureRateLimit(max: number, delay: [number, number]) {
  state.maxActionsPerMinute = max
  state.delayRange = delay
}

/** 随机延迟（模拟人类操作节奏） */
export function randomDelay(min?: number, max?: number): Promise<void> {
  const lo = min ?? state.delayRange[0]
  const hi = max ?? state.delayRange[1]
  // 加入少量抖动，避免规律性
  const jitter = Math.random() * 200 - 100
  const ms = Math.max(200, lo + Math.random() * (hi - lo) + jitter)
  return new Promise((r) => setTimeout(r, ms))
}

/** 检查是否超过频率限制 */
export function checkRateLimit(): { allowed: boolean; waitMs: number } {
  const now = Date.now()
  const windowMs = 60_000
  // 清理 1 分钟前的记录
  state.actionTimestamps = state.actionTimestamps.filter(
    (t) => now - t < windowMs
  )

  if (state.actionTimestamps.length >= state.maxActionsPerMinute) {
    const oldest = state.actionTimestamps[0]
    const waitMs = windowMs - (now - oldest) + 500
    return { allowed: false, waitMs }
  }
  return { allowed: true, waitMs: 0 }
}

/** 记录一次动作并等待随机延迟 */
export async function throttleAction(): Promise<void> {
  const { allowed, waitMs } = checkRateLimit()
  if (!allowed) {
    await new Promise((r) => setTimeout(r, waitMs))
  }
  state.actionTimestamps.push(Date.now())
  await randomDelay()
}

/** 鼠标移动模拟（content script 中使用） */
export function simulateMouseMove(
  el: Element,
  doc: Document = document
): void {
  const rect = el.getBoundingClientRect()
  // 随机落点在元素内部
  const x = rect.left + rect.width * (0.2 + Math.random() * 0.6)
  const y = rect.top + rect.height * (0.2 + Math.random() * 0.6)
  const events: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }
  el.dispatchEvent(new MouseEvent('mouseover', events))
  el.dispatchEvent(new MouseEvent('mousemove', events))

  // 模拟 focus
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    el.focus()
  }
  void doc // suppress unused warning
}
