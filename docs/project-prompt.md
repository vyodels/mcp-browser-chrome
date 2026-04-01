# GPT Browser Agent — 完整产品需求提示词

## 项目背景

开发一个类似 Anthropic「Claude for Chrome」的 Chrome 浏览器插件，核心思路是：
- AI 运行在用户本机浏览器的侧边栏中
- 共享用户浏览器的真实登录状态（cookies/session）
- 不依赖云端浏览器，避免无法访问需要登录的网站
- 主要使用场景：帮用户在网站上和人沟通、下载文件、操作页面，同时规避平台风控

---

## 技术要求

### 语言与构建
- 使用 **TypeScript** 开发（不是纯 JS）
- 构建工具：**Vite**（轻量，编译速度快）
- 目标产物：解压即可在 Chrome 开发者模式加载，无需用户执行构建命令

### 扩展规范
- Chrome Extension **Manifest V3**
- 使用 Chrome **Side Panel API**（侧边栏，不是 popup）
- Content Script 注入所有页面

---

## AI 后端支持

必须同时支持两种认证模式，用户可在设置中切换：

### 模式一：OpenAI API Key（主要模式）
- 用户填入自己的 OpenAI API Key
- 直接调用 `https://api.openai.com/v1/chat/completions`
- 支持流式输出（Server-Sent Events）
- 支持多模态（截图 + 文字一起发送）
- 支持模型选择：gpt-4o / gpt-4o-mini / gpt-4-turbo / o1-preview

### 模式二：ChatGPT 账号登录（备用模式）
- 借用用户在 chatgpt.com 已登录的 session token
- Background Service Worker 后台静默打开 chatgpt.com tab
- 通过 `chrome.scripting.executeScript` 注入脚本获取 `accessToken`
- 用该 token 调用 OpenAI API
- 注意：此模式不保证稳定，受账号速率限制

---

## 核心功能模块

### 1. 侧边栏对话界面
- 暗色主题 UI，专业简洁
- 支持 Markdown 渲染（加粗、代码块）
- 流式输出（打字机效果）
- 消息带时间戳
- 截图附件预览（可删除）
- 快捷 Prompt 芯片按钮（横向滚动）
- Enter 发送，Shift+Enter 换行
- 输入框高度自动扩展

### 2. 页面内容读取（快照系统）
参考 agent-browser 的 snapshot + refs 模式：
- 扫描页面所有可交互元素：`a[href]`、`button`、`input`、`textarea`、`select`、`[role="button"]` 等
- 过滤不可见元素
- 为每个元素分配 ref 编号：`@e1`、`@e2`...
- 返回结构化快照：URL、标题、页面文字（前5000字）、交互元素列表
- 调试模式下附带精简 HTML

### 3. 页面动作执行器
AI 回复中包含 JSON 动作列表时自动执行：

```json
[
  {"action": "click", "ref": "@e1"},
  {"action": "fill", "ref": "@e2", "value": "内容"},
  {"action": "select", "ref": "@e3", "value": "选项"},
  {"action": "press", "key": "Enter"},
  {"action": "scroll", "direction": "down", "pixels": 400},
  {"action": "wait", "ms": 1000},
  {"action": "navigate", "url": "https://example.com"},
  {"action": "hover", "ref": "@e4"},
  {"action": "clear", "ref": "@e5"}
]
```

执行每个动作后返回新的页面快照，失败时返回含 HTML 的调试快照。

### 4. 截图功能
- 使用 `chrome.tabs.captureVisibleTab` 截取当前页面
- 截图以 base64 dataURL 格式附加到下一条消息
- 底部显示截图预览，支持移除

### 5. Skills 系统
用户可创建、编辑、启用/停用、删除 Skill：

```typescript
interface Skill {
  id: string
  name: string
  description: string
  trigger: string        // 关键词，用 | 分隔
  instructions: string  // 注入给 AI 的专属指令
  status: 'active' | 'disabled' | 'error'
  createdAt: number
  lastUsed?: number
}
```

当用户输入包含触发词时自动激活对应 Skill，将 Skill 的 instructions 注入到 AI 上下文中。

内置 3 个默认 Skill：
- **DOM 调试器**：操作失败时分析 DOM 结构给出修复方案
- **智能回复**：帮用户起草消息回复（提供多种风格版本）
- **表单助手**：自动识别并协助填写表单

### 6. DOM 调试器（独立标签）
专门用于页面操作失败时的诊断：
- **元素快照**：列出所有交互元素 + rect 坐标
- **完整 DOM**：获取页面完整 HTML（前25000字）
- **AI 分析**：让 AI 分析页面结构特点和操作难点
- **AI 修复**：结合失败错误信息，AI 生成修正后的动作 JSON

操作失败时自动记录 `lastError`，供调试器使用。

### 7. 设置页面
使用 Chrome Options Page，包含：
- 认证模式切换（Tab 形式）
- API Key 输入（password 类型）
- 模型选择下拉框
- 系统提示词自定义（textarea）
- 风控参数配置（滑块）
- 快捷 Prompt 管理（增删改）
- 保存后通知侧边栏更新配置

---

## 风控保护系统

**目标：模拟真人操作节奏，降低被平台风控识别的风险**

### 随机延迟
- 每次动作执行前等待随机时间（默认范围：800ms ~ 2500ms）
- 加入 ±100ms 随机抖动，避免规律性
- 用户可在设置中调整延迟范围（200ms ~ 10000ms）

### 频率限制
- 默认每分钟最多执行 12 次操作
- 超过限制时自动暂停，等待到时间窗口重置
- 用户可调整（3 ~ 30 次/分钟）

### 行为模拟
- 点击前随机移动鼠标到元素内部随机位置（非正中心）
- 触发 `mouseover`、`mousemove` 事件
- `fill` 操作逐字符输入（每字符间隔 25~100ms）
- 使用 React/Vue 兼容的原生 input setter 触发框架事件
- 输入后触发 `blur` 事件

---

## 数据存储

使用 `chrome.storage.local` 存储所有设置：

```typescript
interface Settings {
  authMode: 'apikey' | 'chatgpt'
  apiKey: string
  model: string
  systemPrompt: string
  actionDelay: [number, number]
  maxActionsPerMinute: number
  prompts: SavedPrompt[]
  skills: Skill[]
}
```

- API Key 仅本地存储，不上传任何服务器
- 设置变更后广播 `SETTINGS_UPDATED` 消息给侧边栏

---

## 消息总线设计

Background ↔ Sidepanel ↔ Content Script 之间的消息类型：

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `GET_PAGE_CONTENT` | Sidepanel → Background → Content | 获取页面快照 |
| `DEBUG_DOM` | Sidepanel → Background → Content | 获取含 HTML 的完整快照 |
| `EXECUTE_ACTION` | Sidepanel → Background → Content | 执行单个动作 |
| `TAKE_SCREENSHOT` | Sidepanel → Background | 截取当前页面 |
| `OPEN_SETTINGS` | Sidepanel → Background | 打开设置页 |
| `CHATGPT_SESSION_REQUEST` | Background internal | ChatGPT session 代理 |
| `SETTINGS_UPDATED` | Background → Sidepanel | 设置已更新 |

---

## UI 设计规范

- **主题**：暗色（Dark mode only）
- **主色**：`#10a37f`（OpenAI 绿）
- **背景层级**：`#0f0f0f` / `#1a1a1a` / `#242424`
- **边框**：`#2e2e2e` ~ `#303030`
- **危险色**：`#e54b4b`
- **警告色**：`#f59e0b`
- **字体**：`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **圆角**：8px
- **侧边栏宽度**：Chrome 默认（约 320~400px）

### 布局结构
```
[Header: Logo + 模型标识 + 清空/设置按钮]
[Tabs: 💬对话 | ⚡Skills | 🔧调试]
[Panel Content（flex:1，可滚动）]
[Status Bar: 状态指示点 + 文字]
```

---

## Codex 集成（待实现）

目前暂未实现，后续规划：
- 本机运行一个轻量 WebSocket bridge 服务（Python 或 Node.js）
- 插件连接 `ws://localhost:PORT`
- Codex CLI 也连接同一服务
- 实现双向通信：Codex 指令 → 插件执行 → 结果返回 Codex
- 以 Codex Skill 的形式封装调用接口

---

## 交付要求

1. **解压即用**：不需要用户执行 `npm install` 或任何构建命令
2. **纯原生 JS**（如无构建环境）或 **TypeScript + Vite 构建产物**
3. 打包为 `.zip`，解压后直接在 `chrome://extensions` 加载
4. 提供完整 README，包含安装步骤、配置方法、使用说明、风控参数说明

---

## 不需要的功能

- 不需要爬虫/数据抓取（主要是替代人工操作）
- 不需要多浏览器支持（仅 Chrome）
- 不需要服务端组件
- 不需要账号注册系统

帮我分析下这个项目，我的本意是设计一款类似于 Claude For Chrome的插件，给 GPT 来使用（GPT 目前没有类似的功能），可以辅助用户读取网页信息，执行一些自定义操作，例如面试场景，可以根据预先设定的 提示词、skill
等，和候选人沟通，通过我的自定义 skill 候选人标准，让GPT 来帮我筛选符合要求的候选人，筛选通过的可以拿到简历，交换联系方式等，最后把这些信息下载到本地文件。我需要的是浏览器插件的形式，这样可以共享我在第三方网站的
session，并且不会出现疯狂等异常的情况， 我需要的能力是 可以根据页面内容，让大模型自学习，自适配，如果适配失败，可以自己进行多轮调试，最终把这些调试成功的页面可以落地成 skill，以便下次复用。这个自检功能本身也是一个
skill。大致上是这样。帮我分析下现在是否还有功能欠缺，是否还存在 bug，如果存在，和我确认过后，完善好 docs/prject-prompt.md，再进入 coding/bugfix 等环节