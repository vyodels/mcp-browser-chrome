// ============================================================
// tools.ts — Tool Calling 工具定义 + 本地执行路由
// LLM 通过 function/tool calling API 调用这些工具
// 工具定义在本地，LLM 调用通过远程 OpenAI/Anthropic API
// ============================================================
import type { PageSnapshot, AgentAction, InterventionRequest, ActivityEntry, CandidateEntry, CandidateStatus, SchemaProposal, Skill, Workflow, WorkspaceField, InterventionType, WorkspaceRecord } from './types'

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
  {
    name: 'log_candidate',
    description: '记录或更新候选人信息到候选人追踪系统。招聘工作流中每处理一个候选人都应调用此工具，无论结果如何。支持创建新记录和更新已有记录（传入相同 id 即更新）。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '候选人唯一标识。更新已有记录时传入之前返回的 id；新候选人留空，系统自动生成。',
        },
        name: {
          type: 'string',
          description: '候选人真实姓名',
        },
        status: {
          type: 'string',
          description: '当前状态：screening=筛选中, contacted=已沟通, resume_received=已收简历, interview_scheduled=已预约面试, passed=通过, rejected=淘汰',
          enum: ['screening', 'contacted', 'resume_received', 'interview_scheduled', 'passed', 'rejected'],
        },
        position: { type: 'string', description: '当前职位或应聘职位' },
        company: { type: 'string', description: '当前所在公司' },
        experience: { type: 'string', description: '工作年限，如"5年"' },
        education: { type: 'string', description: '最高学历，如"本科/985"' },
        salary: { type: 'string', description: '期望薪资，如"25-30k"' },
        notes: { type: 'string', description: '备注：沟通情况、匹配评分、特殊说明等。追加写入时请包含前次内容。' },
        resumeFile: { type: 'string', description: '简历文件名（已下载到本地的文件名）' },
        interviewTime: { type: 'string', description: '已确认的面试时间，如"2024-04-10 周三 14:00"' },
        tags: { type: 'string', description: '标签，逗号分隔，如"强推,React专家,需背调"' },
      },
      required: ['name', 'status'],
    },
  },
  {
    name: 'log_record',
    description: '向当前工作流的工作区写入或更新一条数据记录。使用工作流定义的字段名（field id）作为 data 的 key。每处理完一个关键数据项（候选人/帖子/文章等）都应调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        record_id: {
          type: 'string',
          description: '记录唯一 ID。更新已有记录时传入之前返回的 id；新记录留空自动生成。',
        },
        data: {
          type: 'string',
          description: '记录数据，JSON 字符串，key 为工作流 schema 中的字段 id，value 为字符串值。例：{"name":"张三","status":"已沟通","score":"8"}',
        },
      },
      required: ['data'],
    },
  },
  {
    name: 'save_skill',
    description: '将当前执行中发现的有效解法固化为可复用的 Skill，供未来相同场景直接调用。当你找到了一个通用的解决方案（如处理某类弹窗、解析特定网站结构、处理验证码绕过等）时，应主动调用此工具保存。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill 名称，简洁描述能力，如"BOSS直聘弹窗关闭"',
        },
        description: {
          type: 'string',
          description: '一句话描述该 Skill 的用途和适用场景',
        },
        trigger: {
          type: 'string',
          description: '触发关键词（竖线分隔），如"弹窗|Dialog|浮层关闭"',
        },
        instructions: {
          type: 'string',
          description: '可复用的操作指令，要足够通用，未来同类场景可直接参考执行',
        },
        context: {
          type: 'string',
          description: '说明为什么生成这个 Skill，以及在什么情况下触发的（帮助用户审批决策）',
        },
      },
      required: ['name', 'description', 'instructions', 'context'],
    },
  },
  {
    name: 'save_memory',
    description: `保存关键信息到分层记忆系统。支持两个层级：
- session（默认）：会话记忆，本次任务运行期间有效，适合保存候选人决策进度、本次状态等
- persistent：持久记忆，跨会话长期保存（即使关闭浏览器），适合保存网站操作技巧、已知 DOM 选择器、反检测经验等
记忆会自动注入到后续每个步骤的 system prompt 中。`,
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: '记忆键名，简洁英文，如 candidate_decisions、boss_popup_fix、screening_progress',
        },
        value: {
          type: 'string',
          description: '要记忆的内容，建议简洁（<300字）',
        },
        layer: {
          type: 'string',
          description: 'session（默认，本次任务有效）或 persistent（持久化跨会话）',
          enum: ['session', 'persistent'],
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'list_memory',
    description: '查看当前所有记忆内容（持久记忆 + 会话记忆）。当需要了解已保存了哪些信息，或判断是否需要更新/删除某条记忆时调用。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delete_memory',
    description: '删除一条记忆条目。当某条记忆已过时、不再准确或需要更新时，先删除再重新 save_memory。',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: '要删除的记忆键名',
        },
        layer: {
          type: 'string',
          description: 'session 或 persistent',
          enum: ['session', 'persistent'],
        },
      },
      required: ['key', 'layer'],
    },
  },
  {
    name: 'run_sub_agent',
    description: '启动子代理执行一个独立的子任务。子代理拥有独立上下文，可使用所有工具，完成后返回结果摘要。主要用于：处理单个候选人的完整沟通流程、执行独立的数据采集任务等。子代理完成后，主代理继续工作。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '子代理的具体任务，越详细越好。如"与候选人张三进行完整的初步沟通：查看其聊天页、发送个性化消息、记录沟通结果到 log_record"',
        },
        context: {
          type: 'string',
          description: '子代理需要的背景信息，如候选人数据、工作流要求、当前状态等。这是子代理的初始上下文，它不能访问主代理的历史对话。',
        },
      },
      required: ['task', 'context'],
    },
  },
  {
    name: 'list_records',
    description: '查看当前工作流工作区中已有的所有数据记录。批量处理候选人/数据前先调用此工具，可知道哪些已处理过，避免重复。',
    parameters: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          description: '可选：按状态字段值过滤记录，如"已沟通"、"筛选中"',
        },
      },
    },
  },
  {
    name: 'create_workflow',
    description: '创建并保存一个新的自动化工作流。收集完用户需求后调用此工具。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工作流名称，简洁明了' },
        description: { type: 'string', description: '一句话描述工作流用途' },
        context: { type: 'string', description: '全局背景信息，如岗位要求、采集目标等，每步都会注入' },
        start_url: { type: 'string', description: '起始URL（可选）' },
        steps: {
          type: 'string',
          description: 'JSON数组，格式：[{"name":"步骤名","instructions":"详细指令","intervention":"none|optional|required","completionHint":"完成判定"}]',
        },
        workspace_fields: {
          type: 'string',
          description: '工作区字段定义JSON数组（可选）：[{"id":"field_id","name":"显示名","type":"text|status|number|date|tags|url","options":["选项1","选项2"],"required":true}]',
        },
      },
      required: ['name', 'description', 'steps'],
    },
  },
  {
    name: 'evolve_schema',
    description: '当当前工作流的数据字段不足以记录关键信息时，提议添加新字段到工作区 schema。字段会立即生效，用户可在设置页审核。每次最多提议一个字段。',
    parameters: {
      type: 'object',
      properties: {
        field_name: {
          type: 'string',
          description: '新字段的显示名称，如"简历评分"',
        },
        field_id: {
          type: 'string',
          description: '字段唯一标识（英文/拼音，如 resume_score），用于 log_record 的 data key',
        },
        field_type: {
          type: 'string',
          description: '字段类型',
          enum: ['text', 'number', 'status', 'date', 'tags', 'url'],
        },
        options: {
          type: 'string',
          description: 'status 类型的枚举值，逗号分隔，如"优秀,良好,一般,差"',
        },
        reason: {
          type: 'string',
          description: '说明为什么当前 schema 不满足需求，以及这个字段会记录什么信息',
        },
      },
      required: ['field_name', 'field_id', 'field_type', 'reason'],
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
  // 候选人记录写入/更新（由 loop 外部注入）
  logCandidate?: (entry: Partial<CandidateEntry> & { name: string; status: CandidateStatus }) => Promise<string>
  // 工作区通用记录写入（由 loop 外部注入）
  logRecord?: (recordId: string | undefined, data: Record<string, string>) => Promise<string>
  // AI 生成 Skill（待审批）
  saveSkill?: (skill: Skill) => Promise<void>
  // Schema 演进提议
  evolveSchema?: (proposal: SchemaProposal) => Promise<void>
  // 当前工作流 ID（用于 log_record 和 evolve_schema）
  workflowId?: string
  // 分层记忆系统
  saveMemory?: (key: string, value: string, layer?: 'session' | 'persistent') => Promise<void> | void
  listMemory?: () => { persistent: import('./types').MemoryEntry[]; session: Record<string, string> }
  deleteMemory?: (key: string, layer: 'session' | 'persistent') => Promise<void> | void
  // 启动子代理执行独立子任务
  runSubAgent?: (task: string, context: string) => Promise<string>
  // 创建新工作流
  createWorkflow?: (workflow: Workflow) => Promise<void>
  // 读取工作区记录
  listRecords?: (statusFilter?: string) => Promise<WorkspaceRecord[]>
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
  // AI 提议新 Skill（待审批）
  skillProposal?: { skill: Skill; context: string }
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
      case 'log_candidate':
        return await toolLogCandidate(args as unknown as CandidateArgs, ctx)
      case 'log_record':
        return await toolLogRecord(args as { record_id?: string; data: string }, ctx)
      case 'save_skill':
        return await toolSaveSkill(args as { name: string; description: string; trigger?: string; instructions: string; context: string }, ctx)
      case 'evolve_schema':
        return await toolEvolveSchema(args as { field_name: string; field_id: string; field_type: string; options?: string; reason: string }, ctx)
      case 'save_memory':
        return await toolSaveMemory(args as { key: string; value: string; layer?: string }, ctx)
      case 'list_memory':
        return toolListMemory(ctx)
      case 'delete_memory':
        return await toolDeleteMemory(args as { key: string; layer: string }, ctx)
      case 'run_sub_agent':
        return await toolRunSubAgent(args as { task: string; context: string }, ctx)
      case 'list_records':
        return await toolListRecords(args as { status_filter?: string }, ctx)
      case 'create_workflow':
        return await toolCreateWorkflow(args as { name: string; description: string; context?: string; start_url?: string; steps: string; workspace_fields?: string }, ctx)
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

interface CandidateArgs {
  id?: string
  name: string
  status: CandidateStatus
  position?: string
  company?: string
  experience?: string
  education?: string
  salary?: string
  notes?: string
  resumeFile?: string
  interviewTime?: string
  tags?: string
  workflowId?: string
}

async function toolLogCandidate(args: CandidateArgs, ctx: ToolExecuteContext): Promise<ToolResult> {
  if (!ctx.logCandidate) {
    return { success: false, error: '候选人记录功能未初始化' }
  }
  const tagList = args.tags ? args.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined
  const newId = await ctx.logCandidate({
    ...(args.id ? { id: args.id } : {}),
    name: args.name,
    status: args.status,
    position: args.position,
    company: args.company,
    experience: args.experience,
    education: args.education,
    salary: args.salary,
    notes: args.notes,
    resumeFile: args.resumeFile,
    interviewTime: args.interviewTime,
    tags: tagList,
    workflowId: args.workflowId,
    taskName: ctx.taskName,
  })
  return {
    success: true,
    data: `候选人记录已${args.id ? '更新' : '创建'}：${args.name} [${args.status}]，id=${newId}`,
  }
}

async function toolLogRecord(
  args: { record_id?: string; data: string },
  ctx: ToolExecuteContext
): Promise<ToolResult> {
  if (!ctx.logRecord) return { success: false, error: '工作区记录功能未初始化' }
  let data: Record<string, string>
  try {
    data = JSON.parse(args.data)
  } catch {
    return { success: false, error: `data 参数必须是合法 JSON 字符串，收到：${args.data.slice(0, 100)}` }
  }
  const id = await ctx.logRecord(args.record_id, data)
  return { success: true, data: `记录已${args.record_id ? '更新' : '创建'}，id=${id}` }
}

async function toolSaveSkill(
  args: { name: string; description: string; trigger?: string; instructions: string; context: string },
  ctx: ToolExecuteContext
): Promise<ToolResult> {
  if (!ctx.saveSkill) return { success: false, error: 'Skill 保存功能未初始化' }
  const skill: Skill = {
    id: `skill-ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: args.name,
    description: args.description,
    trigger: args.trigger ?? '',
    instructions: args.instructions,
    status: 'pending_review',
    source: 'ai_generated',
    aiContext: args.context,
    createdAt: Date.now(),
  }
  await ctx.saveSkill(skill)
  return {
    success: true,
    data: `Skill「${args.name}」已保存为待审批状态，用户在侧边栏确认后生效。`,
    skillProposal: { skill, context: args.context },
  }
}

async function toolEvolveSchema(
  args: { field_name: string; field_id: string; field_type: string; options?: string; reason: string },
  ctx: ToolExecuteContext
): Promise<ToolResult> {
  if (!ctx.evolveSchema || !ctx.workflowId) return { success: false, error: 'Schema 演进功能未初始化' }
  const field = {
    id: args.field_id,
    name: args.field_name,
    type: args.field_type as import('./types').WorkspaceFieldType,
    options: args.options ? args.options.split(',').map((s) => s.trim()) : undefined,
    aiProposed: true,
  }
  await ctx.evolveSchema({
    workflowId: ctx.workflowId,
    workflowName: ctx.taskName ?? '当前工作流',
    field,
    reason: args.reason,
  })
  return {
    success: true,
    data: `已向工作流「${ctx.taskName}」添加新字段：${args.field_name}（${args.field_type}）。原因：${args.reason}`,
  }
}

async function toolSaveMemory(args: { key: string; value: string; layer?: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  if (!ctx.saveMemory) return { success: false, error: '记忆功能未初始化' }
  const layer = (args.layer === 'persistent' ? 'persistent' : 'session') as 'session' | 'persistent'
  await ctx.saveMemory(args.key, args.value, layer)
  return {
    success: true,
    data: `已保存到 ${layer === 'persistent' ? '📚 持久记忆' : '🧠 会话记忆'} [${args.key}]: ${args.value.slice(0, 60)}${args.value.length > 60 ? '...' : ''}`,
  }
}

function toolListMemory(ctx: ToolExecuteContext): ToolResult {
  if (!ctx.listMemory) return { success: false, error: '记忆查询功能未初始化' }
  const { persistent, session } = ctx.listMemory()
  const persLines = persistent.map((e) => `  [${e.key}]: ${e.value}`).join('\n') || '  (空)'
  const sessLines = Object.entries(session).map(([k, v]) => `  [${k}]: ${v}`).join('\n') || '  (空)'
  return {
    success: true,
    data: `📚 持久记忆（跨会话）:\n${persLines}\n\n🧠 会话记忆（本次任务）:\n${sessLines}`,
  }
}

async function toolDeleteMemory(args: { key: string; layer: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  if (!ctx.deleteMemory) return { success: false, error: '记忆删除功能未初始化' }
  const layer = (args.layer === 'persistent' ? 'persistent' : 'session') as 'session' | 'persistent'
  await ctx.deleteMemory(args.key, layer)
  return { success: true, data: `已从 ${layer === 'persistent' ? '持久记忆' : '会话记忆'} 删除 [${args.key}]` }
}

async function toolRunSubAgent(args: { task: string; context: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  if (!ctx.runSubAgent) return { success: false, error: '子代理功能未初始化' }
  const result = await ctx.runSubAgent(args.task, args.context)
  return { success: true, data: result }
}

async function toolListRecords(args: { status_filter?: string }, ctx: ToolExecuteContext): Promise<ToolResult> {
  if (!ctx.listRecords) return { success: false, error: '记录查询功能未初始化' }
  const records = await ctx.listRecords(args.status_filter)
  if (records.length === 0) {
    return { success: true, data: args.status_filter ? `没有状态为「${args.status_filter}」的记录。` : '当前工作流暂无记录，这是第一批处理。' }
  }
  const lines = records.slice(0, 100).map((r) => {
    const fields = Object.entries(r.data).map(([k, v]) => `${k}:${v}`).join(', ')
    return `  [id:${r.id}] ${fields}`
  })
  const suffix = records.length > 100 ? `\n  ...（共 ${records.length} 条，仅显示前 100 条）` : ''
  return { success: true, data: `工作区已有 ${records.length} 条记录：\n${lines.join('\n')}${suffix}` }
}

async function toolCreateWorkflow(
  args: { name: string; description: string; context?: string; start_url?: string; steps: string; workspace_fields?: string },
  ctx: ToolExecuteContext
): Promise<ToolResult> {
  if (!ctx.createWorkflow) return { success: false, error: '创建工作流功能未初始化' }
  let rawSteps: Array<{ name: string; instructions: string; intervention?: string; completionHint?: string }>
  try {
    rawSteps = JSON.parse(args.steps)
  } catch {
    return { success: false, error: `steps 参数必须是合法 JSON 数组，解析失败：${args.steps.slice(0, 100)}` }
  }
  const workspaceFields: WorkspaceField[] = args.workspace_fields
    ? (() => { try { return JSON.parse(args.workspace_fields!) } catch { return [] } })()
    : []

  const workflow: Workflow = {
    id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: args.name,
    description: args.description,
    context: args.context,
    startUrl: args.start_url,
    workspace: workspaceFields.length > 0 ? { fields: workspaceFields } : undefined,
    steps: rawSteps.map((s) => ({
      id: Math.random().toString(36).slice(2, 10),
      name: s.name,
      instructions: s.instructions,
      intervention: (['none', 'optional', 'required'].includes(s.intervention ?? '') ? s.intervention : 'optional') as InterventionType,
      completionHint: s.completionHint ?? '步骤任务已完成',
    })),
    createdAt: Date.now(),
  }
  await ctx.createWorkflow(workflow)
  return { success: true, data: `工作流「${args.name}」已创建成功，共 ${workflow.steps.length} 个步骤。可在工作流列表中查看并运行。` }
}

// ---- 格式化 tool result 为 LLM 可读字符串 ----
export function formatToolResult(result: ToolResult): string {
  if (!result.success) return `错误: ${result.error}`
  if (typeof result.data === 'string') return result.data
  return JSON.stringify(result.data)
}
