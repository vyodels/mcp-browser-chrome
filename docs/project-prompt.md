# browser-mcp — 产品架构设计文档

## v3 隐蔽优先架构（当前版本，2026-04-04）

### 核心定位

项目目标：

- 不再做"扩展内置 AI Agent + 工作流平台"
- 做一套**隐蔽优先、MCP 优先、接近 Chrome MCP 的浏览器能力底座**
- 浏览器扩展只负责真实浏览器能力执行，不承载复杂业务编排
- 本地 MCP Server 负责把这些能力暴露给 Codex / LLM
- 具体业务流程（招聘、采集、表单处理）放在 Codex 侧完成

整体链路：

```
Codex / LLM
    ↓ MCP stdio
Local MCP Server（mcp/server.mjs）
    ↓ Unix socket
Native Messaging Host（native-host/host.mjs）
    ↓ Chrome Native Messaging
Chrome Extension Background（src/extension/background/）
    ↓
Content Script（src/extension/content/）
    ↓
真实网页（共享用户登录态）
```

---

### 为什么选 Native Messaging

本项目首要目标之一是降低被网页侧反爬虫 / 反自动化机制探测到的概率。扩展与本地 MCP Server 的通信优先选择 Chrome Extension Native Messaging，而不是：

- 本地 HTTP Server（暴露 `localhost` 端口）
- 本地 WebSocket Server（暴露 `ws://` 连接）
- 页面内桥接脚本 + `window.postMessage`

Native Messaging 的优势：

1. 页面 JS 无法探测本地开放端口
2. 不暴露 `localhost` / `127.0.0.1` / `ws://` 等典型辅助进程特征
3. 通信链路完全在浏览器扩展与本地宿主之间，无页面可见的网络痕迹
4. 更适合长期产品化与稳定运行

注意：Native Messaging 能显著降低"桥接层被探测"的风险，但不能保证绝对不可发现。更容易暴露的往往是页面内的事件链异常和环境污染，而不是本地桥接。

---

### 禁止的实现方式

以下实现方式与"隐蔽优先"目标冲突，默认禁止：

1. **不允许使用本地 HTTP / WebSocket 服务作为扩展桥接主通道**
2. **不允许在页面主世界长期注入桥接脚本**（不允许挂载 `window.__MCP__` 等对象，不允许通过 `CustomEvent` / `postMessage` 暴露控制协议）
3. **不允许污染页面全局环境**（不修改原型链，不持久改写 `fetch` / `XHR` / `console`，不插入可见 overlay）
4. **不允许默认高频全量扫描 DOM**（页面读取分层：snapshot → query → debug）
5. **不允许把业务流程固化在扩展内**（扩展只保留浏览器能力，不承载业务逻辑）

---

### 内容脚本低痕执行原则

1. **优先使用 content script isolated world**，主要逻辑不向页面主 world 注入
2. **仅在需要时做最小交互**：先读页面，再局部定位，再执行操作，失败时才进入 debug 模式
3. **事件链尽量接近真人**：
   - click 补齐 `pointerover → mouseover → mousemove → pointerdown → mousedown → focus → pointerup → mouseup → click`
   - fill 使用原生 setter，触发 `input` / `change` / `blur`
4. **操作节奏反规律化**：随机延迟存在但不机械，滚动距离、输入间隔、点击前停顿均需随机化
5. **默认只暴露必要快照**：页面文本限制长度，交互元素限制数量，HTML 仅在 debug 模式下返回
6. **显式等待优于盲等**：优先 `wait_for_element` / `wait_for_text` / `wait_for_navigation`

---

### MCP 工具设计原则

1. **工具分层，不走"大一统万能工具"**：tabs/navigation、snapshot/query、interaction、wait、capture/files
2. **默认最小读取**：`browser_snapshot` 返回精简信息，`browser_debug_dom` 仅按需调用
3. **交互工具支持多种定位方式**：`ref`、`selector`、`text`、`role`、`index`，优先级从高到低
4. **工具返回结构化结果**：至少包含 `success`、`tabId`、`target`、`navigationDetected`、`snapshotSummary`、`error`
5. **默认不截图**：`browser_screenshot` 为显式工具，不作为常规读取手段
6. **默认不抓完整 HTML**：全量 DOM 视为调试级工具，与正常 snapshot 分离

---

### 能力边界

#### 扩展内保留的能力

- 标签页识别与切换
- 页面导航（打开、后退、刷新）
- 页面快照与元素查询
- 点击 / 悬停 / 输入 / 清空 / 选择 / 滚动 / 按键
- 显式等待（元素出现 / 文本出现 / 导航完成 / 元素消失）
- 截图
- 文件下载与保存
- 基础风控节奏控制（`src/rateLimit.ts`）

#### 已从扩展中移出的能力（放到 Codex / MCP client 侧）

- 扩展内置 LLM 对话主循环
- 工作流引擎
- 业务场景模板（招聘、小红书等）
- 子代理系统
- 持久记忆与会话记忆系统
- Skill 自动沉淀与审批流
- 候选人 CRM / 工作区 schema 系统

---

### 验收标准

以下能力稳定跑通，才算进入可用状态：

1. Codex 能枚举并选择浏览器标签页
2. 能读取页面快照而不依赖截图
3. 能通过 `ref` / `selector` / `text` 三种方式定位并操作元素
4. 能通过显式 wait 工具稳定等待页面变化
5. 能在真实登录态页面上执行多步骤流程
6. 能把结果保存到本地文件
7. 整个链路不依赖 localhost HTTP / WebSocket

---

### 最小验证流程

先用小场景验收，不要从完整业务流程切入：

1. 打开指定页面
2. 定位搜索框
3. 输入关键词
4. 等待结果列表出现
5. 提取前 10 条标题和链接
6. 保存为 JSON 文件

此流程稳定通过后，再进入招聘、沟通、简历处理等更复杂场景。
