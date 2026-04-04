# browser-mcp

隐蔽优先的 Chrome 浏览器执行底座。

项目不再以内置侧边栏 Agent 为主，而是拆成三层：

- Chrome Extension：真实浏览器执行能力
- Native Messaging Host：扩展与本地进程桥接
- Local MCP Server：向 Codex 暴露 `browser_*` tools

目标是让 Codex 在共享真实登录态的前提下，执行接近 Chrome MCP 的网页操作流程，同时避免 `localhost HTTP/WebSocket` 这类容易被页面侧探测的桥接方式。

---

## 当前能力

P0 已接入的能力：

- `browser_list_tabs`
- `browser_get_active_tab`
- `browser_select_tab`
- `browser_open_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_go_back`
- `browser_reload`
- `browser_snapshot`
- `browser_query_elements`
- `browser_get_element`
- `browser_debug_dom`
- `browser_click`
- `browser_hover`
- `browser_fill`
- `browser_clear`
- `browser_select_option`
- `browser_press_key`
- `browser_scroll`
- `browser_wait`
- `browser_wait_for_element`
- `browser_wait_for_text`
- `browser_wait_for_navigation`
- `browser_wait_for_disappear`
- `browser_screenshot`
- `browser_download_file`
- `browser_save_text`
- `browser_save_json`
- `browser_save_csv`

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

---

## 安装与构建

要求：

- Node.js 18+
- Chrome 114+

构建扩展：

```bash
npm install
npm run build
```

在 Chrome 中加载：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 加载已解压的扩展程序
4. 选择 `dist/`

---

## Native Host 安装

1. 先在 Chrome 中加载扩展，记下扩展 ID
2. 安装 native host manifest：

```bash
npm run native-host:install -- --extension-id=<your-extension-id>
```

这会在本机 Chrome Native Messaging Hosts 目录下生成：

- `com.vyodels.browser_mcp.json`

默认 host 名称：

- `com.vyodels.browser_mcp`

默认本地 socket：

- `/tmp/browser-mcp.sock`

可通过环境变量覆盖：

- `MCP_BROWSER_CHROME_SOCKET`

---

## 启动 MCP Server

```bash
npm run mcp:start
```

MCP server 通过 stdio 提供工具；内部通过 Unix socket 连接 native host。

如果需要单独调试 native host：

```bash
npm run native-host:start
```

---

## 隐蔽原则

当前架构默认遵守以下约束：

- 不使用 `localhost HTTP/WebSocket` 作为扩展桥接主通道
- 不在页面主 world 常驻注入桥接脚本
- 内容脚本优先在 isolated world 执行
- snapshot 默认精简，debug DOM 单独调用
- click/fill 使用更接近真人的事件链与输入方式

注意：

- 目标是降低暴露面，不是承诺“绝对不可发现”
- 更容易暴露的通常是页面执行行为异常，而不是 MCP 本身

---

## 开发命令

```bash
npm run typecheck
npm run build
npm run mcp:start
npm run native-host:start
npm run native-host:install -- --extension-id=<your-extension-id>
```
