# CLAUDE_cn.md

本文件为 CLAUDE.md 的中文版本，供开发者阅读参考。

## 常用命令

```bash
npm run dev                  # 监听模式构建（开发用）
npm run build                # 生产构建 → dist/
npm run typecheck            # TypeScript 类型检查（不输出文件）
npm run acceptance:smoke     # 本地 L1/L2 验收：静态检查 + 三组本地运行时 acceptance
npm run setup:auto           # 一键完成：构建 + 安装 native host + 注册 Codex MCP
npm run native-host:start    # 调试模式启动 native host（持久运行，本地排障用）
npm run native-host:stdio    # 模拟 Chrome 真实 stdio 方式拉起 native host
npm run mcp:start            # 直接启动 MCP server（stdio，正常应由 Codex 托管）
npm run native-host:install  # 仅安装 Chrome Native Messaging manifest
npm run codex:mcp:install    # 仅将 mcp/server.mjs 注册到 ~/.codex/config.toml
```

在 Chrome 中加载：`chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `dist/` 目录。

---

## 架构概述

**隐蔽优先的 Chrome 浏览器 MCP 执行底座。** 三段式链路：

```
Codex / MCP Client
  → mcp/server.mjs          （stdio MCP server，暴露 browser_* 工具）
  → Unix socket              （MCP_BROWSER_CHROME_SOCKET，默认路径：os.tmpdir()/browser-mcp.sock）
  → native-host/host.mjs    （Chrome Native Messaging host，名称：com.vyodels.browser_mcp）
  → Chrome Extension         （background service worker + content script）
  → 页面 DOM / Chrome API
```

**正常使用时无需手动启动任何进程。** Chrome 加载扩展后，扩展自动唤醒 background service worker，service worker 自动拉起 native host。Codex 通过 `~/.codex/config.toml` 自动托管 `mcp/server.mjs`。

`npm run mcp:start` 和 `npm run native-host:start` 仅用于调试。

---

## 源码结构

### 当前 MCP 主路径

| 路径 | 职责 |
|------|------|
| `src/background.ts` | 薄壳入口，注册 background handlers |
| `src/content.ts` | 薄壳入口，注册 content script handlers |
| `src/types.ts` | 共享类型，定义 tab、消息总线和只读快照载荷 |
| `src/extension/background/handlers.ts` | Background 主路由，将 `browser_*` 命令分发到 Chrome API 或 content script |
| `src/extension/background/nativeHost.ts` | Native Messaging 连接，接收 host 命令并驱动执行 |
| `src/extension/background/contentBridge.ts` | Background↔content 通信桥，定位目标标签页，必要时重新注入 content script，并固定向顶层 frame 发消息 |
| `src/extension/content/snapshot.ts` | 页面快照采集器，递归穿透同源 iframe 和 open shadow DOM，返回 viewport/document/clickables |
| `src/extension/content/locators.ts` | 只读元素查询：针对当前 snapshot 数据按 ref / selector / text / role / index 过滤 |
| `src/extension/content/state.ts` | 临时 `@e1`/`@e2` ref → DOM 元素映射，仅供只读查询使用 |
| `src/extension/content/waits.ts` | `wait_for_element`、`wait_for_text`、`wait_for_disappear` |
| `src/extension/content/handlers.ts` | Content script 消息路由 |
| `src/extension/shared/protocol.ts` | 命令名定义、Native Messaging bridge 类型，以及只读 snapshot/query 结构 |
| `mcp/server.mjs` | MCP stdio server，注册 `browser_*` 工具，转发调用到 native host |
| `native-host/host.mjs` | Native Messaging host，桥接 Chrome 扩展 ↔ Unix socket |
| `scripts/setup-auto.mjs` | 完整安装：构建 + native host + Codex 配置 |
| `scripts/install-native-host.mjs` | 安装 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vyodels.browser_mcp.json` |
| `scripts/install-codex-mcp.mjs` | 向 `~/.codex/config.toml` 写入 `browser-mcp` 条目 |

---

## MCP 工具列表（`browser_*`）

默认 `tools/list` 只暴露以下 11 个只读工具：

`browser_list_tabs`、`browser_get_active_tab`、`browser_snapshot`、`browser_query_elements`、`browser_get_element`、`browser_debug_dom`、`browser_wait_for_element`、`browser_wait_for_text`、`browser_wait_for_disappear`、`browser_wait_for_navigation`、`browser_wait_for_url`

默认 runtime 不暴露 screenshot、cookie、下载记录、tab mutation 或 extension reload 工具。

仅本地 fixture acceptance 和单步调试可临时设置 `MCP_BROWSER_CHROME_DEBUG_TOOLS=1`，额外暴露：

`browser_reload_extension`、`browser_select_tab`、`browser_open_tab`

这些 tab 工具不属于生产 / 默认 MCP surface。它们会打开、切换或聚焦标签页，页面 JS 可以观察到生命周期事件，因此只用于本地 acceptance 和调试。

`browser_get_active_tab` 以 `chrome.windows.getLastFocused()` 为准，避免多窗口时误把隐藏窗口里的 active tab 当作当前目标。

---

## 快照与 Ref 系统

`browser_snapshot` 现在返回只读载荷，包含 `viewport`、`document`、`clickables` 三部分；顶层结果还会带 `tabId` 和 `target.{tabId,windowId,url,title}`。`viewport` 里除了 `innerWidth/Height`、`outerWidth/Height`、`scrollX/Y`，还提供 `devicePixelRatio`、`screenX/Y`（浏览器窗口观察指标）和可选的 `visualViewport`（pinch-zoom 的 scale + offset）。这些字段不是权威 HID 屏幕坐标映射合同；绝对坐标归一化属于外部 HID 层职责。每个 clickable 会附带 16 位稳定 `signature`、`hitTestState`，以及位于真实生效区域内的随机 `clickPoint`。文件相关元素还会附带 `type` / `accept` / `multiple` / `href` / `download` 等语义字段。`clickables` 仅用于只读查询和定位，不再用于浏览器交互；`browser_query_elements` 和 `browser_get_element` 仍可能返回 ref，但这些 ref 不再驱动任何动作工具。`browser_debug_dom` 可按需获取详细 DOM 信息。

---

## 关键设计约束

- Chrome 114+ 必须
- 无运行时 npm 依赖，纯 TypeScript，Vite 编译
- 所有数据本地存储，仅 MCP client 侧 AI 会产生网络请求
- 不保留页面交互辅助层；默认 runtime 只做只读查询
- HTML 不允许内联事件处理器（CSP），所有监听器通过 TS 文件 `addEventListener` 注册
- Unix socket 路径：`path.join(os.tmpdir(), 'browser-mcp.sock')`，不可硬编码为 `/tmp/browser-mcp.sock`
- 新构建通常从 `chrome://extensions` 手动 reload 当前 unpacked 扩展；`browser_reload_extension` 是 debug-only 工具，必须设置 `MCP_BROWSER_CHROME_DEBUG_TOOLS=1`

---

## 最小排障路径

如果 `browser_*` 工具无响应或超时，按以下顺序排查：

1. `npm run setup:auto` 是否执行成功
2. Chrome 是否真正加载了 `dist/` 目录下的扩展
3. 最近是否已通过 `chrome://extensions` reload 当前 unpacked 扩展（`browser_reload_extension` 仅限 debug-only）
4. 是否打开了至少一个普通网页（用于唤醒 background service worker）
5. MCP client 调用工具时，`mcp/server.mjs` 是否输出 `Native host unavailable`

常见误判：
- `npm run mcp:start` 一闪而过 → 正常现象，stdio server 设计如此
- 扩展已加载但 MCP 工具超时 → 大概率 background 未被唤醒，先打开一个普通网页
- 扩展无任何响应 → 大概率 Native Messaging manifest 未安装，或扩展 ID 漂移（重新执行 `setup:auto`）
