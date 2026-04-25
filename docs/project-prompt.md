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
2. **默认只读优先**：先读页面，再做定位与分层；运行时本身不在页面内合成点击、输入、滚动等事件
3. **默认只暴露必要快照**：页面文本限制长度，clickables 限制数量，HTML 仅在 debug 模式下返回
4. **快照需要足够几何信息**：
   - 页面级：`innerWidth/Height`、`outerWidth/Height`、`scrollX/Y`、`devicePixelRatio`、`screenX/Y`、`visualViewport` 等浏览器可观察窗口/页面指标；它们不是权威 HID 屏幕坐标映射合同
   - 元素级：`viewport` / `document` / `framePath` / `shadowDepth`
   - 命中级：`hitTestState` + 位于真实生效区域内的随机 `clickPoint`
5. **显式等待优于盲等**：优先 `wait_for_element` / `wait_for_text` / `wait_for_navigation`

---

### MCP 工具设计原则

1. **工具分层，不走"大一统万能工具"**：tabs、snapshot/query、wait、capture、extension lifecycle
2. **默认最小读取**：`browser_snapshot` 返回精简信息，`browser_debug_dom` 仅按需调用
3. **只读定位支持多种方式**：`ref`、`selector`、`text`、`role`、`index`，优先级从高到低
4. **工具返回结构化结果**：至少包含 `success`、`tabId`、`target`、`snapshotSummary`、`error`
5. **默认不截图**：`browser_screenshot` 为显式工具，不作为常规读取手段
6. **默认不抓完整 HTML**：全量 DOM 视为调试级工具，与正常 snapshot 分离

---

### 能力边界

#### 扩展内保留的能力

- 标签页识别与切换
- 扩展自身 reload
- 页面打开
- 页面快照与元素查询
- 显式等待（元素出现 / 文本出现 / 导航完成 / 元素消失）
- 截图
- Cookies 读取
- 只读文件相关语义识别（上传控件 / 下载链接）
- 只读下载记录 / artifact 路径定位（`browser_locate_download`，background `chrome.downloads.search`，可用 `sourceUrl/finalUrl/referrer + startedAfter` 关联 HID 点击来源与下载记录，可返回下载中 / 中断 / 已完成状态，不走页面 JS）

#### 已从扩展中移出的能力（放到 Codex / MCP client 侧）

- 扩展内置 LLM 对话主循环
- 工作流引擎
- 页面交互执行链路（真实鼠标/键盘/文件操作）
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
3. 能通过 `ref` / `selector` / `text` 三种方式稳定定位元素
4. `browser_snapshot` 返回的 `clickPoint` 落在真实可命中区域内，且不是固定中心点
5. 能通过显式 wait 工具稳定等待页面变化
6. 整个链路不依赖 localhost HTTP / WebSocket

---

### 最小验证流程

先用小场景验收，不要从完整业务流程切入：

1. 打开指定页面
2. 抓取 snapshot
3. 校验目标页上下文、坐标和 `clickPoint`
4. 等待指定文本或元素出现
5. 提取目标元素和页面结构化数据

此流程稳定通过后，再进入招聘、沟通、简历处理等更复杂场景。
