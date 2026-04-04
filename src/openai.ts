// ============================================================
// openai.ts — AI 客户端，支持 OpenAI 兼容格式和 Anthropic 格式
// 包含基础 chat 和 Tool Calling 两种模式
// ============================================================
import type { ChatMessage, Settings } from './types'
import type { ToolDefinition, ToolCallRequest } from './tools'

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

// Tool calling 响应
export interface ToolCallingResponse {
  content: string
  toolCalls: ToolCallRequest[]
  stopReason: 'tool_use' | 'end_turn' | 'stop'
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

// ---- OpenAI Tool Calling ----
async function callOpenAIWithTools(
  messages: object[],
  tools: ToolDefinition[],
  model: string,
  baseUrl: string,
  apiKey: string,
  onChunk?: (delta: string) => void
): Promise<ToolCallingResponse> {
  const openaiTools = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: openaiTools,
      tool_choice: 'auto',
      max_tokens: 4096,
      stream: !!onChunk,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    const errMsg = (err as { error?: { message?: string } }).error?.message ?? resp.statusText
    // 流式请求失败（EOF / 连接断开），降级为非流式重试
    if (onChunk && (errMsg.includes('EOF') || errMsg.includes('stream') || errMsg.includes('connection'))) {
      return callOpenAIWithTools(messages, tools, model, baseUrl, apiKey, undefined)
    }
    throw new Error(`API 错误: ${errMsg}`)
  }

  if (onChunk) {
    // 流式处理：累积 tool_calls 和文本
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let textContent = ''
    // tool_calls 累积结构
    const toolCallAccum: Record<number, { id: string; name: string; argsStr: string }> = {}

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const chunk = JSON.parse(data) as {
            choices?: {
              delta?: {
                content?: string
                tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
              }
              finish_reason?: string
            }[]
          }
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue
          if (delta.content) { textContent += delta.content; onChunk(delta.content) }
          for (const tc of delta.tool_calls ?? []) {
            if (!toolCallAccum[tc.index]) toolCallAccum[tc.index] = { id: '', name: '', argsStr: '' }
            if (tc.id) toolCallAccum[tc.index].id = tc.id
            if (tc.function?.name) toolCallAccum[tc.index].name = tc.function.name
            if (tc.function?.arguments) toolCallAccum[tc.index].argsStr += tc.function.arguments
          }
        } catch { /* ignore */ }
      }
    }

    const toolCalls: ToolCallRequest[] = Object.values(toolCallAccum).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: safeParseArgs(tc.argsStr),
    }))

    return {
      content: textContent,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    }
  }

  // 非流式
  const json = await resp.json() as {
    choices?: {
      message?: {
        content?: string
        tool_calls?: { id: string; function: { name: string; arguments: string } }[]
      }
      finish_reason?: string
    }[]
  }
  const msg = json.choices?.[0]?.message
  const toolCalls: ToolCallRequest[] = (msg?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseArgs(tc.function.arguments),
  }))

  return {
    content: msg?.content ?? '',
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  }
}

// ---- Anthropic 格式 ----
async function callAnthropic(
  opts: CompletionOptions,
  baseUrl: string,
  apiKey: string,
  onChunk?: (delta: string) => void
): Promise<string> {
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

// ---- Anthropic Tool Calling ----
async function callAnthropicWithTools(
  messages: object[],
  tools: ToolDefinition[],
  model: string,
  systemPrompt: string,
  baseUrl: string,
  apiKey: string,
  onChunk?: (delta: string) => void
): Promise<ToolCallingResponse> {
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  // Anthropic messages: filter out system, convert tool messages
  const anthropicMessages = (messages as { role: string; content: unknown }[])
    .filter((m) => m.role !== 'system')
    .map((m) => {
      // tool result messages
      if (m.role === 'tool') {
        const tm = m as { role: string; tool_call_id: string; content: string }
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tm.tool_call_id, content: tm.content }],
        }
      }
      // assistant messages with tool_calls
      if (m.role === 'assistant') {
        const am = m as { role: string; content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
        if (am.tool_calls?.length) {
          const content: object[] = []
          if (am.content) content.push({ type: 'text', text: am.content })
          for (const tc of am.tool_calls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: safeParseArgs(tc.function.arguments),
            })
          }
          return { role: 'assistant', content }
        }
      }
      return m
    })

  const resp = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: anthropicTools,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(
      `API 错误: ${(err as { error?: { message?: string } }).error?.message ?? resp.statusText}`
    )
  }

  const json = await resp.json() as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
    stop_reason?: string
  }

  let textContent = ''
  const toolCalls: ToolCallRequest[] = []

  for (const block of json.content ?? []) {
    if (block.type === 'text') textContent += block.text ?? ''
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id!, name: block.name!, arguments: block.input ?? {} })
      if (onChunk && block.name) onChunk(`[调用工具: ${block.name}]`)
    }
  }

  return {
    content: textContent,
    toolCalls,
    stopReason: json.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
  }
}

// ---- 统一入口：基础 chat（流式，无 tool calling）----
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

// ---- 统一入口：Tool Calling chat（Agent Loop 使用）----
export async function chatWithTools(
  messages: object[],
  tools: ToolDefinition[],
  settings: Settings,
  onChunk?: (delta: string) => void
): Promise<ToolCallingResponse> {
  if (!settings.apiKey) throw new Error('请先在设置中填写 API Key')
  if (!settings.baseUrl) throw new Error('请先在设置中填写 API Base URL')

  if (settings.apiFormat === 'anthropic') {
    const systemPrompt = (messages.find((m) => (m as { role: string }).role === 'system') as { role: string; content: string } | undefined)?.content ?? ''
    return callAnthropicWithTools(messages, tools, settings.model, systemPrompt, settings.baseUrl, settings.apiKey, onChunk)
  }
  return callOpenAIWithTools(messages, tools, settings.model, settings.baseUrl, settings.apiKey, onChunk)
}

// ---- 工具函数 ----
function safeParseArgs(argsStr: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof argsStr === 'object') return argsStr
  try { return JSON.parse(argsStr) } catch { return {} }
}

// ---- 解析 AI 返回的动作指令（保留兼容）----
export function parseActions(text: string): import('./types').AgentAction[] {
  const match = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    if (Array.isArray(parsed)) return parsed as import('./types').AgentAction[]
  } catch { /* ignore */ }
  return []
}
