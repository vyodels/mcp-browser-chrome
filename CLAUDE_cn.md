# CLAUDE_cn.md

本文件为 CLAUDE.md 的中文版本，供开发者阅读参考。

## 常用命令

```bash
npm run dev                  # 监听模式构建（开发用）
npm run build                # 生产构建 → dist/
npm run typecheck            # TypeScript 类型检查（不输出文件）
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
| `src/rateLimit.ts` | 反检测：随机延迟、鼠标模拟 |
| `src/types.ts` | 共享类型（含部分待清理的旧类型） |
| `src/extension/background/handlers.ts` | Background 主路由，将 `browser_*` 命令分发到 Chrome API 或 content script |
| `src/extension/background/nativeHost.ts` | Native Messaging 连接，接收 host 命令并驱动执行 |
| `src/extension/background/contentBridge.ts` | Background↔content 通信桥，定位目标标签页，必要时重新注入 content script |
| `src/extension/content/actions.ts` | 点击、悬停、填写、按键、滚动、截图，模拟真实事件链 |
| `src/extension/content/snapshot.ts` | 页面快照 + 交互元素列表（默认精简模式） |
| `src/extension/content/locators.ts` | 按 ref / selector / text / role / index 定位元素 |
| `src/extension/content/state.ts` | `@e1`/`@e2` ref → DOM 元素映射管理 |
| `src/extension/content/waits.ts` | `wait_for_element`、`wait_for_text`、`wait_for_disappear` |
| `src/extension/content/handlers.ts` | Content script 消息路由 |
| `src/extension/shared/protocol.ts` | 命令名定义、Native Messaging bridge 类型、snapshot/action 结构 |
| `mcp/server.mjs` | MCP stdio server，注册 `browser_*` 工具，转发调用到 native host |
| `native-host/host.mjs` | Native Messaging host，桥接 Chrome 扩展 ↔ Unix socket |
| `scripts/setup-auto.mjs` | 完整安装：构建 + native host + Codex 配置 |
| `scripts/install-native-host.mjs` | 安装 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vyodels.browser_mcp.json` |
| `scripts/install-codex-mcp.mjs` | 向 `~/.codex/config.toml` 写入 `browser-mcp` 条目 |

### 已归档（`src/deprecated/`）

旧产品方向遗留代码（扩展内置 AI Agent），不参与 MCP 主路径，不参与构建：

`openai.ts`、`sidepanel.ts/html`、`settings.ts/html`、`store.ts`、`tools.ts`、`workflow.ts`、`tabManager.ts`

---

## MCP 工具列表（`browser_*`）

**标签页控制：** `browser_list_tabs`、`browser_get_active_tab`、`browser_select_tab`、`browser_open_tab`、`browser_close_tab`

**页面导航：** `browser_navigate`、`browser_go_back`、`browser_reload`

**页面读取：** `browser_snapshot`、`browser_query_elements`、`browser_get_element`、`browser_debug_dom`、`browser_screenshot`

**页面交互：** `browser_click`、`browser_hover`、`browser_fill`、`browser_clear`、`browser_select_option`、`browser_press_key`、`browser_scroll`

**等待：** `browser_wait`、`browser_wait_for_element`、`browser_wait_for_text`、`browser_wait_for_navigation`、`browser_wait_for_disappear`

**文件输出：** `browser_download_file`、`browser_save_text`、`browser_save_json`、`browser_save_csv`

---

## 快照与 Ref 系统

每次调用 `browser_snapshot` 时，`snapshot.ts` 扫描页面所有可见可交互元素，分配临时引用 `@e1`、`@e2`...，供 `browser_click`、`browser_fill` 等工具使用。**引用在每次快照时重新生成，不跨调用保留。** `browser_debug_dom` 可按需获取详细 DOM 信息。

---

## 关键设计约束

- Chrome 114+ 必须
- 无运行时 npm 依赖，纯 TypeScript，Vite 编译
- 所有数据本地存储，仅 MCP client 侧 AI 会产生网络请求
- `src/rateLimit.ts` 反检测逻辑不可删除或绕过
- HTML 不允许内联事件处理器（CSP），所有监听器通过 TS 文件 `addEventListener` 注册
- Unix socket 路径：`path.join(os.tmpdir(), 'browser-mcp.sock')`，不可硬编码为 `/tmp/browser-mcp.sock`
- `manifest.json` 中扩展 `key` 已固定，unpacked 扩展 ID 不会因重新加载漂移

---

## 最小排障路径

如果 `browser_*` 工具无响应或超时，按以下顺序排查：

1. `npm run setup:auto` 是否执行成功
2. Chrome 是否真正加载了 `dist/` 目录下的扩展
3. 如果是从旧版本升级，是否在 `chrome://extensions` 里手动重载过一次扩展（只需一次）
4. 是否打开了至少一个普通网页（用于唤醒 background service worker）
5. MCP client 调用工具时，`mcp/server.mjs` 是否输出 `Native host unavailable`

常见误判：
- `npm run mcp:start` 一闪而过 → 正常现象，stdio server 设计如此
- 扩展已加载但 MCP 工具超时 → 大概率 background 未被唤醒，先打开一个普通网页
- 扩展无任何响应 → 大概率 Native Messaging manifest 未安装，或扩展 ID 漂移（重新执行 `setup:auto`）
