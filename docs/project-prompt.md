# GPT Browser Agent — 完整产品需求提示词

## 20260404（v3 隐蔽优先架构，进行中）

### 新的核心定位

项目目标调整为：

- 不再把本项目继续做成“扩展内置 AI Agent + 工作流平台”
- 改为做一套 **隐蔽优先、MCP 优先、接近 Chrome MCP 的浏览器能力底座**
- 浏览器扩展只负责真实浏览器能力执行，不承载复杂业务编排
- 本地 **MCP Server** 负责把这些能力暴露给 Codex / LLM
- 具体业务流程（招聘、采集、表单处理、沟通流程）放在 Codex 侧完成

新的整体链路：

```text
Codex / LLM
    ↓ MCP
Local MCP Server
    ↓ Native Messaging
Chrome Extension
    ↓
Background / Content Script
    ↓
Real Web Page (shared login/session)
```

---

### 为什么选 Native Messaging

本项目的首要目标之一，是降低被网页侧反爬虫 / 反自动化机制感知到“外部自动化系统正在驱动浏览器”的概率。

因此，扩展与本地 MCP Server 的通信方式，优先选择：

- **Chrome Extension Native Messaging**

而不是：

- 本地 HTTP Server
- 本地 WebSocket Server
- 页面内桥接脚本 + `window.postMessage`

选择 Native Messaging 的原因：

1. 页面 JS 无法直接探测本地开放端口
2. 不暴露 `localhost` / `127.0.0.1` / `ws://` / `http://` 等典型辅助进程特征
3. 没有对页面可见的网络握手、长连接、轮询等痕迹
4. 通信链路完全位于浏览器扩展与本地宿主之间，更接近浏览器内部能力
5. 更适合后续长期产品化和稳定运行

注意：

- Native Messaging 能显著降低“桥接层被探测”的风险
- 但它 **不能保证绝对不可发现**
- 真正更容易暴露的，往往不是本地桥接，而是页面内的执行痕迹、事件链异常和环境污染

---

### 哪些实现方式绝不能用

以下实现方式与“隐蔽优先”目标冲突，默认禁止：

1. **不允许使用本地 HTTP / WebSocket 服务作为扩展桥接主通道**
   - 不允许扩展通过 `http://127.0.0.1:*` 与本地 MCP 服务通信
   - 不允许扩展通过 `ws://127.0.0.1:*` 与本地 MCP 服务通信

2. **不允许在页面主世界长期注入桥接脚本**
   - 不允许把 MCP 协议对象挂载到 `window`
   - 不允许暴露诸如 `window.__MCP__`、`window.__AGENT__` 等调试对象
   - 不允许通过 `CustomEvent` / `postMessage` 暴露控制协议

3. **不允许污染页面全局环境**
   - 不允许修改页面原生对象原型链
   - 不允许持久改写 `fetch` / `XMLHttpRequest` / `addEventListener` / `console`
   - 不允许为调试方便向页面插入可见 overlay / badge / helper DOM

4. **不允许默认高频全量扫描 DOM**
   - 不允许每个动作前都重新做一次大范围全文快照
   - 不允许默认抓取超长 HTML 或全量文本
   - 页面读取必须分层：snapshot → query → debug

5. **不允许把业务流程固化在扩展内**
   - 不继续在扩展内维护招聘工作流、采集工作流、子代理、技能自动沉淀等上层逻辑
   - 扩展只保留浏览器能力，不承载业务智能体

---

### 内容脚本如何做低痕执行

扩展执行原则：

1. **优先使用 content script isolated world**
   - 主要逻辑运行在扩展隔离环境中
   - 默认不向页面主 world 注入执行脚本

2. **仅在需要时做最小交互**
   - 先读页面，再局部定位，再执行操作
   - 失败时才进入 debug 模式
   - 不能一上来就做大规模 DOM 读取

3. **事件链必须尽量接近真人**
   - click 不能只调用 `.click()`
   - 应尽量补齐 `pointerover` / `mouseover` / `mousemove` / `pointerdown` / `mousedown` / `focus` / `pointerup` / `mouseup` / `click`
   - fill 不能只做 `el.value = x`
   - 应使用原生 setter，并触发 `input` / `change` / `blur`

4. **操作节奏必须反规律化**
   - 随机延迟必须存在，但不能机械化
   - 滚动距离、输入间隔、点击前停顿需要可配置随机化
   - 不能固定“每步 400px 滚动”或“每次间隔 1000ms”

5. **默认只暴露必要快照**
   - 页面文本限制长度
   - 交互元素限制数量
   - HTML 仅在 debug 模式或失败上下文中返回

6. **显式等待优于盲等**
   - 优先 `wait_for_element` / `wait_for_text` / `wait_for_navigation`
   - 减少简单 `sleep` 风格等待

7. **不要依赖页面可见的控制通道**
   - 不通过 DOM 属性或隐藏节点传输内部状态
   - 不通过页面 console 输出调试日志

---

### MCP 工具如何设计成默认低暴露模式

MCP 工具设计原则：

1. **工具分层，不走“大一统万能工具”**
   - `tabs/navigation`
   - `snapshot/query`
   - `interaction`
   - `wait`
   - `capture/files`

2. **默认模式是最小读取**
   - `browser_snapshot` 返回精简信息
   - `browser_query_elements` 返回局部元素结果
   - `browser_debug_dom` 只在必要时调用

3. **交互工具支持多种定位方式**
   - `ref`
   - `selector`
   - `text`
   - `role`
   - `index`

4. **工具返回结构化结果，不只返回字符串**
   - 结果需包含执行目标、是否成功、是否触发导航、简化后的页面状态
   - 便于 Codex 基于结果继续推理，而不是重复抓整页

5. **默认不截图**
   - `browser_screenshot` 应为显式工具
   - 不作为常规读取手段
   - 截图仅用于视觉确认、复杂页面排障、记录结果

6. **默认不抓完整 HTML**
   - 全量 DOM / HTML 视为调试级工具
   - 必须与正常 snapshot 工具分离

---

### 新的能力边界

#### 扩展内保留的能力

- 标签页识别与切换
- 页面导航
- 页面快照
- 元素查询
- 点击 / 悬停 / 输入 / 清空 / 选择 / 滚动 / 按键
- 显式等待
- 截图
- 文件下载
- 基础风控节奏控制

#### 从扩展中移出的能力

- 扩展内置 LLM 对话主循环
- 工作流引擎
- 招聘 / 小红书等业务模板
- 子代理系统
- 持久记忆和会话记忆系统
- Skill 自动沉淀与审批流
- 候选人 CRM / 工作区 schema 系统

这些能力后续统一放在 Codex / 外部调用侧，由 MCP 工具组合实现。

---

### 目标架构

#### 1. Chrome Extension

职责：

- 提供真实浏览器执行能力
- 共享用户本地浏览器登录态
- 通过 Background + Content Script 执行页面操作
- 通过 Native Messaging 与本地宿主通信

内部拆分建议：

```text
src/extension/
  background/
    router.ts
    tabs.ts
    capture.ts
    downloads.ts
    nativeHost.ts
  content/
    snapshot.ts
    query.ts
    actions.ts
    waits.ts
    locators.ts
  shared/
    protocol.ts
    types.ts
```

#### 2. Local MCP Server

职责：

- 暴露标准 MCP tools 给 Codex
- 转发工具调用到 Chrome Native Host
- 管理调用上下文和返回结构
- 不承担业务编排和页面策略判断

目录建议：

```text
mcp/
  server.ts
  bridge/
    nativeMessagingClient.ts
  tools/
    tabs.ts
    navigation.ts
    snapshot.ts
    query.ts
    actions.ts
    waits.ts
    capture.ts
    files.ts
```

---

### P0 工具集合（第一阶段必须完成）

#### Tabs / Navigation

- `browser_list_tabs`
- `browser_get_active_tab`
- `browser_select_tab`
- `browser_open_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_go_back`
- `browser_reload`

#### Snapshot / Query

- `browser_snapshot`
- `browser_query_elements`
- `browser_get_element`
- `browser_debug_dom`

#### Interaction

- `browser_click`
- `browser_hover`
- `browser_fill`
- `browser_clear`
- `browser_select_option`
- `browser_press_key`
- `browser_scroll`

#### Wait

- `browser_wait`
- `browser_wait_for_element`
- `browser_wait_for_text`
- `browser_wait_for_navigation`
- `browser_wait_for_disappear`

#### Capture / Files

- `browser_screenshot`
- `browser_download_file`
- `browser_save_text`
- `browser_save_json`
- `browser_save_csv`

---

### Tool 设计约束

所有交互类工具建议统一支持以下定位参数：

- `tabId`
- `ref`
- `selector`
- `text`
- `role`
- `index`
- `timeoutMs`

定位优先级建议：

1. `ref`
2. `selector`
3. `text + role`
4. `text`

返回值必须尽量结构化，至少包含：

- `success`
- `tabId`
- `target`
- `navigationDetected`
- `snapshotSummary`
- `error`（失败时）

---

### 第一阶段验收标准

以下能力跑通，才算进入可用状态：

1. Codex 能稳定枚举并选择浏览器标签页
2. 能读取页面快照而不依赖截图
3. 能通过 `ref / selector / text` 三种方式定位并操作元素
4. 能通过显式 wait 工具稳定等待页面变化
5. 能在真实登录态页面上执行多步骤流程
6. 能把结果保存到本地文件
7. 整个链路不依赖 localhost HTTP / WebSocket

---

### 第一条真实验证流程（建议）

先不要从招聘全流程切入，先用更小的验收闭环：

1. 打开指定页面
2. 定位搜索框
3. 输入关键词
4. 等待结果列表出现
5. 提取前 10 条标题和链接
6. 保存为 JSON 文件

如果这条流程稳定通过，再进入招聘、沟通、简历处理等更复杂场景。

---

## 项目背景

开发一个类似 Anthropic「Claude for Chrome」的 Chrome 浏览器插件，核心思路是：
- AI 运行在用户本机浏览器的侧边栏中
- 共享用户浏览器的真实登录状态（cookies/session）
- 不依赖云端浏览器，避免无法访问需要登录的网站
- 主要使用场景：帮用户在网站上和人沟通、下载文件、操作页面，同时规避平台风控

---
### 确认的问题
1. 数据采集的字段：你面试场景要采集哪些字段？（姓名、平台账号、联系方式、简历链接、评估结果，还是用 AI 自由提取？）
2. 自动调试的边界：自主重试失败动作，最多几轮合适？超过后是静默停止还是提示用户介入？
3. Skill 自动保存：调试成功后，是直接自动保存，还是弹窗让用户确认并命名？
4. 工作流优先级：多步骤工作流是近期必须要的，还是可以先做数据采集和自学习调试？
5. Bug 修复：上面列的 4 个高/中级 Bug，是否先全部修完再加新功能？

1、如果我没有自定义，则AI 匹配，如果我定义了，按照我定义的来，我的定义形式一般是 skill
2、一般 3 轮就行，超过之后提示用，是否要继续尝试自动调试
3、可以弹窗，预先生成一个命名，让用户修改/直接确认
4、可以先做数据采集和自学习调试，但这个需要用户来控制，选择哪个页面需要你调试
5、先修 bug
6、代码风格有问题的也可以进行修复
7、不需要每个浏览器页面都解析，由用户控制是否解析，并且可以由用户点击按钮（比如招聘流程-匹配对应的skill） or 直接和 GPT 沟通，来控制具体怎么解析，是否要获取候选人信息？或者只是进行网页摘要

## prompt change log
### 20260402
帮我分析下这个项目，我的本意是设计一款类似于 Claude For Chrome的插件，给 GPT 来使用（GPT 目前没有类似的功能）
- 可以辅助用户读取网页信息，执行一些自定义操作，例如面试场景：
  - 可以根据预先设定的 提示词、skill等，
  - GPT 帮我和候选人沟通，通过我的自定义 skill 候选人标准，，让GPT 来帮我筛选符合要求的候选人
  - 筛选通过的可以拿到简历，交换联系方式等
  - 最后把这些信息下载到本地文件。
- 我需要的是浏览器插件的形式，这样可以共享我在第三方网站的session，并且不会出现疯狂等异常的情况
- 我需要的能力是 可以根据页面内容，让大模型自学习，自适配，如果适配失败
  - 可以自己进行多轮调试，最终把这些调试成功的页面可以落地成 skill，以便下次复用。
  - 这个自检功能本身也是一个skill。

大致上是这样。帮我分析下现在是否还有功能欠缺，是否还存在 bug，如果存在，和我确认过后，完善好 docs/prject-prompt.md，再进入 coding/bugfix 等环节

### 20260403（v2 升级，已完成）
#### 现在更新下对项目的要求，项目是为了做一个网页助手，助手可以做以下几个功能：
- Chrome标签页的识别定位能力，知道用户当前在哪个页面或者要打开哪个页面，开始任务时，则让用户选择从哪个页面开始，并创建 标签页分组
- LLM：支持 anthropic 和 openai 两种的 APIKEY 登录的形式。
- 解析并读取网页数据，类似于 Chrome MCP 的功能，但是要防止被反爬虫 js 等检测到，完全模拟用户行为，（当前标签页所在的网页/打开指定的网页，由助手操作的网页需要创建一个独立的标签页分组），
- 可以按照自定义的要求（例如分析下页面的标题/内容/哪些内容项）分析 并下载网页数据到本地～/Downloads/browser-agent-files/目录下
- 关于页面UI 风格设计，要 苹果的 设计风格
- 设置设置自定义工作流，按照我预先设置的工作流，推进整个工作流的完成。例如打开 xx 网页，找到页面上的候选人，查看候选人简介，初步分析，分析完成符合预期，和候选人沟通，等等
  - 示例 1：打开 zhipin.com 网页，作为招聘者身份，按照履历筛选候选人（筛选标准通过读取 skills 来完成），
    - 和候选人沟通（由skills 来完成，预置沟通要求，引导等），符合初步要求的索要简历，并下载到本地，
    - 进行简历匹配度分析，简历匹配完成的，则和候选人预约面试时间，
    - 这时候可以让我来接管提供一个具体的时间，并和候选人确认时间，不满足要求的时间，需要我再次介入俺怕
  - 示例 2：打开 xiaohongshu.com，作为用户身份，帮我筛选出来首页推荐的帖子标题和内容，并存储为文件形式下载到本地

#### 技术实现细节：本 Agent 的核心能力，是一个 loop，可以持续性的处理工作，在需要用户介入的时候，会提供类似于 codex/Claude Code 等的选择项/自定义项
- 工具链能力。对网页数据的识别，操作等能力（例如点击、鼠标移动、返回上一个页面，输入文本）。优先走类似于 Chrome MCP 的思路，看Chrome是否有现成的方法可以使用，需要把用到的网友操作分析能力封装成 MCP，可以给 LLM 来调用
- 项目中需要预先集成好需要用到的skill，并放到项目的文件夹中。并在 Chrome 中使用时，可以有用户自定义修改和扩展 skills。
- 基础交互能力-工具链的使用：工作流中的每一步，都需要 LL 先访问本项目可用 skills/MCP 等。如果有可用的能力，LLM 则调用本地工具链执行，并把执行结果返回给LLM，LLM 根据执行结果对数据进行分析提取，包装成符合任务要求的模板
- 基础交互能力-无工具链的情况：当无可用工具链时，则需要执行对应的 DOM 解析/网页快照等能力，完成页面的数据分析，并将本次页面解析能力落地成 skills，以便后面给 LLM 继续复用


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
