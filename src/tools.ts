// ============================================================
// tools.ts — Tool Calling 工具定义 + 本地执行路由
// LLM 通过 function/tool calling API 调用这些工具
// 工具定义在本地，LLM 调用通过远程 OpenAI/Anthropic API
// ============================================================
import type { PageSnapshot, AgentAction, InterventionRequest, ActivityEntry } from './types'

// Re-export for use by openai.ts and sidepanel.ts
export type { ToolCallRequest } from './types'

// ---- 工具定义（JSON Schema，发送给 LLM）----

export interface ToolParameter {
  type: string
  description: string
  enum?: string[]
  items?: { type: string }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required?: string[]
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_page_content',
    description: '获取当前目标标签页的页面快照，包含 URL、标题、可读文本和所有可交互元素（带 @e1/@e2 等引用）。在执行任何页面操作前，应先调用此工具了解页面状态。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'click_element',
    description: '点击页面上的元素。使用 get_page_content 返回的 @eN 引用来指定目标元素，模拟真实用户鼠标点击。',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: '要点击的元素引用，如 @e1、@e3。从 get_page_content 结果中获取。',
        },
      },
      required: ['ref'],
    },
  },
  {
    name: 'fill_input',
    description: '向输入框或文本域填写内容，逐字符模拟真实键盘输入以规避反自动化检测。',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: '目标 input/textarea 元素的引用，如 @e2。',
        },
        value: {
          type: 'string',
          description: '要填写的文本内容。',
        },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'navigate_to',
    description: '在目标标签页中打开指定 URL，等待页面加载后返回新快照。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要导航到的完整 URL，包含协议（https://）。',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'scroll_page',
    description: '滚动当前页面，用于查看屏幕外的内容或触发懒加载。',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: '滚动方向：up（向上）或 down（向下）。',
          enum: ['up', 'down'],
        },
        pixels: {
          type: 'string',
          description: '滚动距离（像素），默认 400。',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'press_key',
    description: '在页面上触发键盘按键事件，适合提交表单（Enter）、切换焦点（Tab）或取消操作（Escape）等场景。',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: '键名，如 Enter、Tab、Escape、ArrowDown 等（KeyboardEvent.key 值）。',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'wait_ms',
    description: '等待指定毫秒数，用于等待页面加载、动画完成或异步请求响应。',
    parameters: {
      type: 'object',
      properties: {
        ms: {
          type: 'string',
          description: '等待时长（毫秒），建议范围 500-5000。',
        },
      },
      required: ['ms'],
    },
  },
  {
    name: 'take_screenshot',
    description: '截取当前标签页可见区域的截图，返回图像供视觉分析。当页面状态难以用文本描述清楚时使用。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'download_data',
    description: '将提取到的数据保存为本地文件，下载到 ~/Downloads/browser-agent-files/ 目录下。支持 JSON、CSV、TXT 格式。',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: '文件名（含扩展名），如 candidates.csv、posts.json。会自动归类到任务子目录中。',
        },
        content: {
          type: 'string',
          description: '文件内容字符串。JSON 请序列化为字符串，CSV 请包含表头行。',
        },
        format: {
          type: 'string',
          description: '文件格式：json、csv 或 txt。',
          enum: ['json', 'csv', 'txt'],
        },
      },
      required: ['filename', 'content', 'format'],
    },
  },
  {
    name: 'open_new_tab',
    description: '在 Agent 任务标签组中打开一个新标签页，不干扰用户其他标签页。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要在新标签页中打开的 URL。不传则打开空白页。',
        },
      },
    },
  },
  {
    name: 'ask_user',
    description: '暂停任务并向用户提问或请求确认。当需要用户提供信息（如面试时间）、选择方向或确认敏感操作时使用。用户回答后任务自动继续。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '向用户提出的问题，请清晰说明需要用户提供什么。',
        },
        options: {
          type: 'string',
          description: '可选的选项列表（逗号分隔），若提供则以按钮形式展示给用户选择；不提供则显示文本输入框。',
        },
        placeholder: {
          type: 'string',
          description: '文本输入框的占位提示（仅在无选项时生效）。',
        },
      },
      required: ['question'],
    },
  },
]

// ---- 工具执行上下文 ----

export interface ToolExecuteContext {
  targetTabId?: number
  taskName?: string
  tabGroupId?: number
  // 发送消息到 background/content 的函数
  sendMsg: (msg: object) => Promise<unknown>
  // ask_user 工具的 resolve（由 loop 外部注入）
  resolveIntervention?: (answer: string) => void
  // 活动记录写入（由 loop 外部注入）
  logActivity?: (entry: Omit<ActivityEntry, 'id' | 'timestamp'>) => void
}

// ---- 工具执行结果 ----

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  // ask_user 工具返回此字段，表示需要等待用户输入
  interventionRequest?: InterventionRequest
  // take_screenshot 返回的图像
  screenshotDataUrl?: string
}

// ---- 执行路由 ----

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecuteContext
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_page_content':
        return await toolGetPageContent(ctx)
      case 'click_element':
        return await toolClickElement(args as { ref: string }, ctx)
      case 'fill_input':
        return await toolFillInput(args as { ref: string; value: string }, ctx)
      case 'navigate_to':
        return await toolNavigateTo(args as { url: string }, ctx)
      case 'scroll_page':
        return await toolScrollPage(args as { direction: string; pixels?: string }, ctx)
      case 'press_key':
        return await toolPressKey(args as { key: string }, ctx)
      case 'wait_ms':
        return await toolWaitMs(args as { ms: string }, ctx)
      case 'take_screenshot':
        return await toolTakeScreenshot(ctx)
      case 'download_data':
        return await toolDownloadData(args as { filename: string; content: string; format: string }, ctx)
      case 'open_new_tab':
        return await toolOpenNewTab(args as { url?: string }, ctx)
      case 'ask_user':
        return toolAskUser(args as { question: string; options?: string; placeholder?: string })
      default:
        return { success: false, error: `未知工具: ${name}` }
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---- 各工具实现 ----

async function toolGetPageContent(ctx: ToolExecuteContext): Promise<ToolResult> {
  const resp = await ctx.sendMsg({ type: 'GET_PAGE_CONTENT', targetTabId: ctx.targetTabId }) as {
    success: boolean
    snapshot?: PageSnapshot
    error?: string
  }
  if (!resp.success) return { success: false, error: resp.error ?? '获取页面失败' }
  const snap = resp.snapshot!
  const elements = snap.interactiveElements.slice(0, 50).map((el) =>
    `${el.ref} [${el.tag}${el.type ? `(${el.type})` : ''}]${el.text ? ` "${el.text.slice(0, 60)}"` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}${el.href ? ` href="${el.href.slice(0, 80)}"` : ''}`
  ).join('\n')
  return {
    success: true,
    data: `URL: ${snap.url}\n标题: ${snap.title}\n\n页面文本:\n${snap.text.slice(0, 3000)}\n\n可交互元素:\n${elements}`,
  }
}

async function toolClickElement(args: { ref: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  const action: AgentAction = { action: 'click', ref: args.ref }
  const resp = await ctx.sendMsg({
    type: 'EXECUTE_ACTION_IN_TAB',
    targetTabId: ctx.targetTabId,
    payload: { type: 'EXECUTE_ACTION', payload: action },
  }) as { success?: boolean; message?: string; error?: string }
  if (resp.success === false) return { success: false, error: resp.error ?? resp.message ?? '点击失败' }
  return { success: true, data: `已点击 ${args.ref}` }
}

async function toolFillInput(args: { ref: string; value: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  const action: AgentAction = { action: 'fill', ref: args.ref, value: args.value }
  const resp = await ctx.sendMsg({
    type: 'EXECUTE_ACTION_IN_TAB',
    targetTabId: ctx.targetTabId,
    payload: { type: 'EXECUTE_ACTION', payload: action },
  }) as { success?: boolean; message?: string; error?: string }
  if (resp.success === false) return { success: false, error: resp.error ?? resp.message ?? '填写失败' }
  return { success: true, data: `已填写 ${args.ref}: "${args.value}"` }
}

async function toolNavigateTo(args: { url: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  // 通过 background 直接调用 chrome.tabs.update，不依赖 content script
  const resp = await ctx.sendMsg({
    type: 'NAVIGATE_TAB',
    payload: { url: args.url, targetTabId: ctx.targetTabId },
  }) as { success: boolean; tabId?: number; error?: string }

  if (!resp.success) return { success: false, error: resp.error ?? '导航失败' }

  // 导航完成后更新 targetTabId（tabId 可能因 background 重新解析而变化）
  if (resp.tabId && !ctx.targetTabId) {
    ctx.targetTabId = resp.tabId
  }

  // 再等一小会确保 content script 注入完成
  await new Promise((r) => setTimeout(r, 800))
  const result = await toolGetPageContent(ctx)
  ctx.logActivity?.({ type: 'navigate', title: args.url, taskName: ctx.taskName })
  return result
}

async function toolScrollPage(args: { direction: string; pixels?: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  const action: AgentAction = {
    action: 'scroll',
    direction: args.direction as 'up' | 'down',
    pixels: args.pixels ? parseInt(args.pixels) : 400,
  }
  await ctx.sendMsg({
    type: 'EXECUTE_ACTION_IN_TAB',
    targetTabId: ctx.targetTabId,
    payload: { type: 'EXECUTE_ACTION', payload: action },
  })
  return { success: true, data: `已向${args.direction === 'down' ? '下' : '上'}滚动 ${args.pixels ?? 400}px` }
}

async function toolPressKey(args: { key: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  const action: AgentAction = { action: 'press', key: args.key }
  await ctx.sendMsg({
    type: 'EXECUTE_ACTION_IN_TAB',
    targetTabId: ctx.targetTabId,
    payload: { type: 'EXECUTE_ACTION', payload: action },
  })
  return { success: true, data: `已按键 ${args.key}` }
}

async function toolWaitMs(args: { ms: string }, _ctx: ToolExecuteContext): Promise<ToolResult> {
  const ms = Math.min(parseInt(args.ms) || 1000, 10000)
  await new Promise((r) => setTimeout(r, ms))
  return { success: true, data: `已等待 ${ms}ms` }
}

async function toolTakeScreenshot(ctx: ToolExecuteContext): Promise<ToolResult> {
  const resp = await ctx.sendMsg({ type: 'TAKE_SCREENSHOT', targetTabId: ctx.targetTabId }) as {
    success: boolean
    dataUrl?: string
    error?: string
  }
  if (!resp.success) return { success: false, error: resp.error ?? '截图失败' }
  return { success: true, data: '截图已获取', screenshotDataUrl: resp.dataUrl }
}

async function toolDownloadData(
  args: { filename: string; content: string; format: string },
  ctx: ToolExecuteContext
): Promise<ToolResult> {
  const taskDir = (ctx.taskName ?? 'agent-task').replace(/[^a-z0-9\u4e00-\u9fa5-]/gi, '-').toLowerCase()
  const resp = await ctx.sendMsg({
    type: 'DOWNLOAD_DATA',
    payload: {
      filename: `browser-agent-files/${taskDir}/${args.filename}`,
      content: args.content,
      format: args.format,
    },
  }) as { success: boolean; error?: string }
  if (!resp.success) return { success: false, error: resp.error ?? '下载失败' }
  ctx.logActivity?.({
    type: 'download',
    title: args.filename,
    detail: `~/Downloads/browser-agent-files/${taskDir}/`,
    taskName: ctx.taskName,
  })
  return { success: true, data: `文件已保存: ~/Downloads/browser-agent-files/${taskDir}/${args.filename}` }
}

async function toolOpenNewTab(args: { url?: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  const resp = await ctx.sendMsg({
    type: 'OPEN_TAB',
    payload: { url: args.url, groupId: ctx.tabGroupId },
  }) as { success: boolean; tabId?: number; error?: string }
  if (!resp.success) return { success: false, error: resp.error ?? '打开标签页失败' }
  return { success: true, data: `新标签页已打开 (id=${resp.tabId})` }
}

function toolAskUser(args: { question: string; options?: string; placeholder?: string }): ToolResult {
  const options = args.options
    ? args.options.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined
  return {
    success: true,
    interventionRequest: {
      question: args.question,
      options,
      placeholder: args.placeholder,
    },
  }
}

// ---- 格式化 tool result 为 LLM 可读字符串 ----
export function formatToolResult(result: ToolResult): string {
  if (!result.success) return `错误: ${result.error}`
  if (typeof result.data === 'string') return result.data
  return JSON.stringify(result.data)
}
