// ============================================================
// store.ts — chrome.storage 封装，统一读写设置
// ============================================================
import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  authMode: 'apikey',
  apiKey: '',
  model: 'gpt-4o',
  systemPrompt: `你是一个浏览器操作助手。你可以帮助用户：
1. 理解当前网页内容
2. 执行页面操作（点击、填表、导航）
3. 分析截图
4. 完成复杂的多步骤任务

操作时注意：
- 每次操作前先确认当前页面状态
- 不确定时先询问用户
- 遇到验证码或登录页时暂停并提示用户手动处理
- 敏感操作（支付、删除等）前必须获得用户确认`,
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
      content: '请提取当前页面所有关键数据，以结构化的方式展示',
      createdAt: Date.now(),
    },
    {
      id: 'p3',
      title: '填写表单',
      content: '请帮我识别当前页面的表单字段，并告诉我需要填写哪些内容',
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
}

export async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      const saved = result.settings as Partial<Settings> | undefined
      resolve({ ...DEFAULT_SETTINGS, ...saved })
    })
  })
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  const current = await loadSettings()
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings: { ...current, ...settings } }, resolve)
  })
}
