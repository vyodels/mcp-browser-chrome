// ============================================================
// openai.ts — AI 客户端，支持 OpenAI 兼容格式和 Anthropic 格式
// ============================================================
import type { ChatMessage, Settings } from './types'

export interface CompletionOptions {
  messages: { role: string; content: string | ContentPart[] }[]
  model: string
  onChunk?: (delta: string) => void
}

interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

// ---- OpenAI / 兼容格式 ----
async function callOpenAI(
  opts: CompletionOptions,
  baseUrl: string,
  apiKey: string,
  onChunk?: (delta: string) => void
): Promise<string> {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: 2048,
      stream: !!onChunk,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(
      `API 错误: ${(err as { error?: { message?: string } }).error?.message ?? resp.statusText}`
    )
  }

  if (onChunk) {
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const delta: string = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] })
            .choices?.[0]?.delta?.content ?? ''
          if (delta) { full += delta; onChunk(delta) }
        } catch { /* ignore parse errors */ }
      }
    }
    return full
  }

  const json = await resp.json()
  return (json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''
}

// ---- Anthropic 格式 ----
async function callAnthropic(
  opts: CompletionOptions,
  baseUrl: string,
  apiKey: string,
  onChunk?: (delta: string) => void
): Promise<string> {
  // Anthropic messages API 不支持 system 角色混入 messages 数组
  const systemMsg = (opts.messages.find((m) => m.role === 'system')?.content as string) ?? ''
  const messages = opts.messages.filter((m) => m.role !== 'system')

  const resp = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 2048,
      system: systemMsg || undefined,
      messages,
      stream: !!onChunk,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(
      `API 错误: ${(err as { error?: { message?: string } }).error?.message ?? resp.statusText}`
    )
  }

  if (onChunk) {
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6)) as {
            type?: string
            delta?: { type?: string; text?: string }
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text ?? ''
            if (text) { full += text; onChunk(text) }
          }
        } catch { /* ignore */ }
      }
    }
    return full
  }

  const json = await resp.json() as { content?: { type: string; text: string }[] }
  return json.content?.find((b) => b.type === 'text')?.text ?? ''
}

// ---- 统一入口 ----
export async function chat(
  history: ChatMessage[],
  userInput: string,
  settings: Settings,
  imageDataUrl?: string,
  onChunk?: (delta: string) => void
): Promise<string> {
  if (!settings.apiKey) throw new Error('请先在设置中填写 API Key')
  if (!settings.baseUrl) throw new Error('请先在设置中填写 API Base URL')

  const messages: { role: string; content: string | ContentPart[] }[] = [
    { role: 'system', content: settings.systemPrompt },
    ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
  ]

  if (imageDataUrl) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userInput },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] as ContentPart[],
    })
  } else {
    messages.push({ role: 'user', content: userInput })
  }

  const opts: CompletionOptions = { messages, model: settings.model, onChunk }

  if (settings.apiFormat === 'anthropic') {
    return callAnthropic(opts, settings.baseUrl, settings.apiKey, onChunk)
  }
  return callOpenAI(opts, settings.baseUrl, settings.apiKey, onChunk)
}

// ---- 解析 AI 返回的动作指令 ----
export function parseActions(text: string): import('./types').AgentAction[] {
  const match = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    if (Array.isArray(parsed)) return parsed as import('./types').AgentAction[]
  } catch { /* ignore */ }
  return []
}
