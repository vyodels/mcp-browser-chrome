# browser-mcp

隐蔽优先的 Chrome 浏览器执行底座。

它不是“一个直接在终端里跑起来就能点网页的脚本”，而是一条三段式链路：

1. Chrome Extension 负责真实浏览器内执行
2. Native Messaging Host 负责把扩展和本地 socket 桥接起来
3. Local MCP Server 负责把 `browser_*` 能力以 MCP tools 形式暴露给 Codex

如果这三段里任何一段没有接上，表面现象通常都会像“browser-mcp 启动失败”。

---

## 目标体验

正常使用时，不应该手动启动任何东西：

- Chrome 打开且已加载 `dist/` 扩展
- background service worker 会通过 `connectNative()` 直接连到 native host
- Codex 会通过 `~/.codex/config.toml` 自动托管 `mcp/server.mjs`

也就是说，日常使用不需要手动执行 `npm run mcp:start` 或 `npm run native-host:start`。这两个命令都只保留给调试。

---

## 运行方式

这个项目里有两个 Node 进程，但它们的职责不同：

- `mcp/server.mjs`
  - 这是 MCP `stdio` server
  - 正常用法是被 MCP client 拉起
  - 直接在终端执行时，看起来会很快退出，这是预期行为，不代表报错

- `native-host/host.mjs`
  - 这是 Chrome Native Messaging host
  - 正常用法是被 Chrome 扩展拉起
  - `npm run native-host:start` 只用于本地调试

一句话：

- 正常使用时，不需要手动启动它们
- 调试 host/socket 时，再使用 `npm run native-host:start`

---

## 架构链路

```text
Codex / MCP Client
  -> mcp/server.mjs
  -> Unix socket
  -> native-host/host.mjs
  -> Chrome Native Messaging
  -> Chrome Extension background
  -> content script / Chrome APIs
```

`mcp/server.mjs`、`native-host/host.mjs` 和 extension background bridge 都必须按 FIFO 串行执行 browser 命令。即使 MCP client 同时发来多个 `tools/call`，也不能让多个浏览器观察/标签页/下载查询命令并发进入同一个 Chrome 目标环境；上游 `recruit-agent` 会把这些只读观察与 VirtualHID 写入组合成连续的 browser observe -> HID write -> browser observe 时序。

默认 host 名称：

- `com.vyodels.browser_mcp`

默认 socket 环境变量：

- `MCP_BROWSER_CHROME_SOCKET`

默认 socket 实际路径：

- `path.join(os.tmpdir(), 'browser-mcp.sock')`
- 在 macOS 上通常会展开成 `/var/folders/.../T/browser-mcp.sock`
- 不要把它想当然写死成 `/tmp/browser-mcp.sock`

---

## 当前能力

P0 已接入：

- `browser_list_tabs`
- `browser_get_active_tab`
- `browser_reload_extension`
- `browser_select_tab`
- `browser_open_tab`（默认在最后聚焦的 Chrome 窗口打开；传 `windowId` 可指定窗口；传 `tabId` 时复用并导航已有 tab；传 `newWindow: true` 时先复用 / 拆分已有同 URL 或同 origin tab，找不到才创建新的普通 Chrome 窗口；acceptance 默认优先复用测试 tab）
- `browser_snapshot`
- `browser_query_elements`
- `browser_get_element`
- `browser_debug_dom`
- `browser_screenshot`
- `browser_get_cookies`
- `browser_locate_download`
- `browser_wait_for_element`
- `browser_wait_for_text`
- `browser_wait_for_navigation`
- `browser_wait_for_disappear`
- `browser_wait_for_url`

---

## Snapshot Contract

`browser_snapshot` 当前面向上游输出的是“可复用的观察原子”，不是业务动作。

- `clickables[*].text` 只保留标签文案、可见文本、`aria-label`、`title` 等描述性文本
- 输入类状态从混合 `text` 中拆开，单独输出 `value` 和 `placeholder`
- 通用控件状态会显式输出 `disabled` / `readonly` / `checked` / `selected` / `expanded` / `focused`
- `inaccessibleFrames[*]` 会为 cross-origin iframe 提供只读占位，至少暴露 `framePath`、矩形和基础元数据，避免上游把不可深入区域误判成空白
- `ref` 只是单次快照内的临时句柄，不能当长期状态 key
- `signature` 是跨快照 soft key，不保证绝对稳定
- `clickPoint` 只是执行层提示，不是 scene state，不应进入长期业务记忆

---

## JS 可感知性验证

`scripts/detectable-surface-fixture.mjs` 提供本地检测页，页面主 world 会持续记录：

- `navigator.webdriver`
- `window.chrome.runtime.id`
- `mcp / vyodels / browser_mcp` 全局变量泄漏
- `chrome-extension://` 资源引用
- DOM mutation / `postMessage`
- `isTrusted === false` 的鼠标、键盘、输入事件
- tab 切换带来的 `visibilitychange` / focus / blur 生命周期事件

运行：

```bash
npm run acceptance:detectable-surface
```

当前判定边界：

- `browser_snapshot` / `browser_query_elements` / `browser_get_element` / `browser_debug_dom` / wait 类 / `browser_get_cookies` / `browser_locate_download` / 活跃 tab 上的 `browser_screenshot` 不应留下页面 JS 可观察信号。
- `browser_locate_download` 只在 extension background 通过 `chrome.downloads.search` 读取 Chrome 下载记录、本地路径、下载状态和字节进度；可用 `sourceUrl` / `finalUrl` / `referrer` 加 `startedAfter` 把 HID 点击前的 snapshot 链接和下载记录强关联；可返回 `in_progress` / `interrupted` / `complete` 记录，不打开 `chrome://downloads`，不注入页面 JS，不依赖 mock DOM 标记。
- `browser_select_tab` 和 active tab 打开/切换天然会触发页面可见的生命周期事件，这属于 tab 管理能力，不是页面输入伪装能力。
- `browser_screenshot` 只允许截取目标窗口当前活跃 tab；传入 inactive `tabId` 会失败，避免 `captureVisibleTab` 静默截错页。

---

## Boss-like Mock Validation

`scripts/fixtures/boss-like/` 提供一组招聘站 mock 页面，用来验证通用 `browser_snapshot` contract 是否足够支撑 Autonomous Agent 在模拟环境执行自动化招聘任务：职位列表、候选人列表、候选人详情与附件简历入口。

这组页面只是 validation surface，不是 Boss/直聘专用 runtime 逻辑。验证脚本只检查只读快照中是否能观察到业务推理所需的通用页面状态，例如控件状态、下载入口、候选人详情入口和 artifact 定位提示。

```bash
npm run acceptance:boss-mock
```

完整本地 L1/L2 smoke：

```bash
npm run acceptance:smoke
```

该脚本会执行 typecheck、build、manifest/tool/protocol/黑名单静态检查，以及 complex-layout、Boss-like mock、detectable-surface 三组本地运行时验收。
运行时验收会优先复用已有测试标签页，避免每次回归都大量打开新 tab。

---

## 项目结构

```text
src/
  background.ts
  content.ts
  extension/
    background/
    content/
    shared/

mcp/
  server.mjs

native-host/
  host.mjs

scripts/
  install-native-host.mjs
```

更详细的目录职责见：

- [docs/repo-structure.md](/Users/vyodels/AgentProjects/mcp-browser-chrome/docs/repo-structure.md)

---

## 安装步骤

要求：

- Node.js 18+
- Chrome 114+

安装依赖：

```bash
npm install
```

在 Chrome 中加载扩展：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择仓库下的 `dist/`
然后在仓库根目录执行一次自动安装：

```bash
npm run setup:auto
```

这个命令会：

- 构建 `dist/`
- 安装 Chrome Native Messaging manifest
- 自动把 [mcp/server.mjs](/Users/vyodels/AgentProjects/mcp-browser-chrome/mcp/server.mjs) 注册到 `~/.codex/config.toml`
- 输出安装摘要和校验结果

执行成功后会生成：

- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vyodels.browser_mcp.json`

manifest 里最关键的是两项：

- `path` 必须指向当前仓库生成的 launcher，而不是依赖 shell 环境去解析 `node`
- `allowed_origins` 必须包含当前扩展 ID。安装脚本会从 Chrome 当前已加载的 `dist/` 记录里解析实际 ID。

安装脚本现在会额外生成：

- [native-host/host-launcher](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host-launcher)

这个 launcher 会把当前机器上的 Node 绝对路径写进去，再启动 [native-host/host.mjs](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host.mjs)。
这样 Chrome 启动 Native Messaging Host 时不依赖 `nvm`、shell profile 或 `PATH`，换电脑后只要重新执行 `npm run setup:auto` 即可。

如果你刚完成一次新的 `dist/` 构建，需要让 Chrome 载入最新扩展代码。`browser_reload_extension` 可用于手动调试，但 acceptance 脚本不会在运行中自动调用它，因为 extension reload 会短暂断开当前 native-host / MCP 通道，容易把验证变成 `snapshot` 缺失类竞态。稳定做法是先在 `chrome://extensions` 确认当前 unpacked extension 指向本仓库 `dist/`，手动点一次“重新加载”或重启 Chrome，再运行 acceptance。

---

## 正常启动

### 日常使用

- 不需要手动启动 `mcp/server.mjs`
- 不需要手动启动 `native-host/host.mjs`
- 只要 Chrome 打开、扩展已加载、Codex 读取了 `~/.codex/config.toml`，`browser_*` tools 就会自动可用

如果你刚执行完 `npm run setup:auto`，重新开一个 Codex 会话即可。

### 调试 MCP server

```bash
npm run mcp:start
```

说明：

- 这是 `stdio` MCP server
- 设计上应该由 MCP client 托管
- 直接在终端执行时，看起来会很快结束，这是预期行为

### 单独调试 native host

```bash
npm run native-host:start
```

说明：

- 这个脚本会以调试常驻模式启动
- 适合排查“host 有没有起来”“socket 能不能连”

如果你要模拟 Chrome 真正使用的 `stdio` host 方式，可以运行：

```bash
npm run native-host:stdio
```

---

## 最小排障路径

如果你怀疑“browser-mcp 启动失败”，按这个顺序查：

1. `npm run setup:auto` 是否执行成功
2. Chrome 是否真的加载了 `dist/`
3. 最近是否把新 `dist/` 载入当前扩展实例（优先在 `chrome://extensions` 手动 reload；`browser_reload_extension` 只用于单步调试）
4. Chrome 打开普通网页后，扩展是否已自动拉起 native host
5. MCP client 调用 tool 时，`mcp/server.mjs` 是否报 `Native host unavailable`

可以先运行只读 socket/native-host 预检：

```bash
npm run health:runtime
```

这个检查不会关闭、打开或 reload Chrome 窗口。它只确认 `$MCP_BROWSER_CHROME_SOCKET`（默认 `os.tmpdir()/browser-mcp.sock`）是否存在，并通过 socket 发一个只读 `browser_get_active_tab` 探针。若 socket 已经消失，说明 `tools/list` 仍可能正常，但 browser tool call 会在进入 Chrome 前失败；恢复方式是复用现有普通 Chrome 窗口，打开或聚焦任意普通网页来唤醒扩展 bridge。若仍未恢复，再到 `chrome://extensions` 对当前已加载的 unpacked `dist/` 手动 reload。`browser_reload_extension` 只能在 socket 仍存活时作为维护动作使用，不能恢复已经缺失的 socket。

常见误判：

- `npm run mcp:start` 一闪而过
  - 不是崩溃，是因为它本来就是 `stdio` 服务

- 明明扩展加载了，但 MCP tool 还是超时
  - 常见原因是扩展仍处于旧实例，或 native host 启动路径配置错误
  - 先打开一个普通网页，再看一次
  - 去 `chrome://extensions` 确认 loaded path 是当前仓库 `dist/`，并手动 reload 一次

- 扩展明明加载了，但没有任何响应
  - 大概率是 Native Messaging manifest 没装，或者扩展 ID 变了

Acceptance verifier 会显式报告当前 Chrome 快照字段形态：

- `stateFieldMode: structured` 表示当前 Chrome 实例已运行包含 `value` / `placeholder` / `checked` 等结构化字段的 content snapshot。
- `stateFieldMode: legacy-text-fallback` 表示当前 Chrome 实例仍在返回旧字段形态；此时模拟招聘任务验证可以继续跑通，但不能证明当前浏览器实例已经加载最新 snapshot contract。
- `inaccessibleFrameMode: structured` 表示当前 Chrome 实例已返回 cross-origin iframe 占位；`legacy-no-inaccessible-frames` 表示当前实例仍是旧快照形态。

---

## 开发命令

```bash
npm run typecheck
npm run setup:auto
npm run mcp:start
npm run native-host:start
npm run native-host:stdio
npm run native-host:install
npm run codex:mcp:install
```

---

## 隐蔽原则

当前架构默认遵守：

- 不使用 `localhost HTTP/WebSocket` 作为扩展桥接主通道
- 不在页面主 world 常驻注入桥接脚本
- 内容脚本优先在 isolated world 执行
- snapshot 默认只返回只读结构化数据，`viewport` 提供 `innerWidth/Height`、`outerWidth/Height`、`devicePixelRatio`、`screenX/Y`、`visualViewport` 等浏览器可观察窗口/页面指标；这些指标不是权威 HID 屏幕坐标映射合同，绝对坐标归一化属于外部 HID 层职责；返回顶层还会带 `tabId / windowId / url / title`
- `clickables` 每项附带 16 位稳定 `signature`、`hitTestState`、随机 `clickPoint`，以及面向 scene reasoning 的只读状态字段：`value` / `placeholder` / `disabled` / `readonly` / `checked` / `selected` / `expanded` / `focused`
- cross-origin iframe 不做 DOM 深入，但会通过 `inaccessibleFrames` 返回最小占位元数据
- 上传 / 下载控件会额外带 `type` / `accept` / `multiple` / `href` / `download` 等语义字段，便于上游判断文件相关能力；HID 触发下载前，上游应保留 `href`、`download` 文件名和点击前时间戳，后续传给 `browser_locate_download` 做下载来源关联
- 不产生页面可观察的合成交互事件

注意：

- 目标是降低暴露面，不是承诺“绝对不可发现”
- 更容易暴露的通常是页面执行行为异常，而不是 MCP 本身
