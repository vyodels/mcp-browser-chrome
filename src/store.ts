// ============================================================
// store.ts — chrome.storage 封装，统一读写设置
// ============================================================
import type { Settings } from './types'
import { createDefaultWorkflows } from './workflow'

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://127.0.0.1:8317/v1',
  apiKey: '',
  apiFormat: 'openai',
  model: 'gpt-5.4',
  systemPrompt: `你是一个浏览器自动化助手，通过工具调用来完成网页操作任务。

你拥有的工具能力：
- 读取页面内容（get_page_content）
- 点击元素、填写表单（click_element/fill_input）
- 页面导航、滚动（navigate_to/scroll_page）
- 截图分析（take_screenshot）
- 数据下载到本地（download_data）
- 向用户提问（ask_user）

操作原则：
1. 每次操作前先调用 get_page_content 了解页面状态
2. 遇到验证码、登录或付款页面，使用 ask_user 提示用户手动处理
3. 敏感操作（发消息、提交表单）前使用 ask_user 让用户确认
4. 数据提取完成后，使用 download_data 保存到本地
5. 完全模拟真实用户行为，操作间有合理延迟`,
  actionDelay: [800, 2500],
  maxActionsPerMinute: 12,
  prompts: [
    {
      id: 'p1',
      title: '总结页面',
      content: '请总结当前页面的主要内容',
      createdAt: Date.now(),
    },
    {
      id: 'p2',
      title: '提取数据',
      content: '请提取当前页面所有关键数据，以结构化方式保存到本地文件',
      createdAt: Date.now(),
    },
    {
      id: 'p3',
      title: '填写表单',
      content: '请帮我识别当前页面的表单字段，询问我需要填写的内容后自动填写',
      createdAt: Date.now(),
    },
  ],
  skills: [
    {
      id: 'skill-debug',
      name: 'DOM 调试器',
      description: '当页面操作失败时，分析 DOM 结构并给出修正方案',
      trigger: '操作失败|找不到元素|识别错误|调试',
      instructions: `你是一个专业的 DOM 调试专家。当页面操作失败时：
1. 分析提供的 DOM 结构
2. 找出目标元素的正确选择器
3. 说明为什么之前的操作失败
4. 提供修正后的操作指令
5. 如果页面结构特殊，提供备选方案`,
      status: 'active',
      createdAt: Date.now(),
    },
    {
      id: 'skill-form',
      name: '表单助手',
      description: '自动识别并填写各类表单',
      trigger: '填表|表单|注册|登录|提交',
      instructions: `你是表单填写专家。帮助用户：
1. 识别所有表单字段和类型
2. 按逻辑顺序填写
3. 处理下拉框、复选框、单选框
4. 提交前预览并确认`,
      status: 'active',
      createdAt: Date.now(),
    },
  ],
  workflows: createDefaultWorkflows(),
  activityLog: [],
  candidates: [],
  workspaceRecords: [],
  memoryEntries: [],
}

export async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      const saved = result.settings as Partial<Settings> | undefined
      const merged = { ...DEFAULT_SETTINGS, ...saved }
      // 确保 workflows 字段存在（升级兼容）
      if (!merged.workflows?.length) merged.workflows = createDefaultWorkflows()
      // 确保 activityLog 字段存在（升级兼容）
      if (!merged.activityLog) merged.activityLog = []
      if (!merged.candidates) merged.candidates = []
      if (!merged.workspaceRecords) merged.workspaceRecords = []
      if (!merged.memoryEntries) merged.memoryEntries = []
      resolve(merged)
    })
  })
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  const current = await loadSettings()
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings: { ...current, ...settings } }, resolve)
  })
}
