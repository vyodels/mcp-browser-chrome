// ============================================================
// openai.ts — OpenAI 客户端，支持 API Key 和 chatgpt.com 两种模式
// ============================================================
import type { ChatMessage, Settings } from './types'

export interface CompletionOptions {
  messages: { role: string; content: string | ContentPart[] }[]
  model: string
  maxTokens?: number
  onChunk?: (delta: string) => void  // 流式回调
}

interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

// ---- API Key 模式 ----
async function callWithApiKey(
  opts: CompletionOptions,
  apiKey: string,
  onChunk?: (delta: string) => void
): Promise<string> {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 2048,
      stream: !!onChunk,
    }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(
      `OpenAI API 错误 ${resp.status}: ${(err as { error?: { message?: string } }).error?.message ?? resp.statusText}`
    )
  }

  if (onChunk) {
    // 流式处理
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const json = JSON.parse(data)
          const delta: string = json.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            full += delta
            onChunk(delta)
          }
        } catch {
          // ignore parse errors in stream
        }
      }
    }
    return full
  }

  const json = await resp.json()
  return json.choices?.[0]?.message?.content ?? ''
}

// ---- chatgpt.com 会话模式 ----
// 借用浏览器中已登录的 ChatGPT session，通过 background 中转请求
async function callWithSession(
  opts: CompletionOptions,
  onChunk?: (delta: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'CHATGPT_SESSION_REQUEST', payload: opts },
      (response: { success: boolean; content?: string; error?: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (!response.success) {
          reject(new Error(response.error ?? '会话请求失败'))
          return
        }
        if (onChunk && response.content) {
          // session 模式暂不支持真正流式，模拟逐字输出
          const words = response.content.split('')
          let i = 0
          const timer = setInterval(() => {
            if (i >= words.length) {
              clearInterval(timer)
              resolve(response.content!)
              return
            }
            onChunk(words[i++])
          }, 10)
        } else {
          resolve(response.content ?? '')
        }
      }
    )
  })
}

// ---- 统一入口 ----
export async function chat(
  history: ChatMessage[],
  userInput: string,
  settings: Settings,
  imageDataUrl?: string,
  onChunk?: (delta: string) => void
): Promise<string> {
  const systemMsg = {
    role: 'system' as const,
    content: settings.systemPrompt,
  }

  // 构建消息列表
  const messages: { role: string; content: string | ContentPart[] }[] = [
    systemMsg,
    ...history.slice(-20).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ]

  // 最后一条用户消息（可带图片）
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

  const opts: CompletionOptions = {
    messages,
    model: settings.model,
    onChunk,
  }

  if (settings.authMode === 'apikey') {
    if (!settings.apiKey) throw new Error('请先在设置中填写 OpenAI API Key')
    return callWithApiKey(opts, settings.apiKey, onChunk)
  } else {
    return callWithSession(opts, onChunk)
  }
}

// ---- 解析 AI 返回的动作指令 ----
export function parseActions(text: string): import('./types').AgentAction[] {
  const actions: import('./types').AgentAction[] = []
  // 匹配代码块中的 JSON 动作列表
  const match = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/)
  if (!match) return actions
  try {
    const parsed = JSON.parse(match[1])
    if (Array.isArray(parsed)) {
      return parsed as import('./types').AgentAction[]
    }
  } catch {
    // ignore
  }
  return actions
}
