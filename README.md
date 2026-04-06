# browser-mcp

隐蔽优先的 Chrome 浏览器执行底座。

它不是“一个直接在终端里跑起来就能点网页的脚本”，而是一条三段式链路：

1. Chrome Extension 负责真实浏览器内执行
2. Native Messaging Host 负责把扩展和本地 socket 桥接起来
3. Local MCP Server 负责把 `browser_*` 能力以 MCP tools 形式暴露给 Codex

如果这三段里任何一段没有接上，表面现象通常都会像“browser-mcp 启动失败”。

---

## 先看运行方式

这个项目里有两个 Node 进程，但它们的职责不同：

- `mcp/server.mjs`
  - 这是 MCP `stdio` server
  - 正常用法是被 MCP client 拉起
  - 直接在终端执行时，看起来会很快退出，这是预期行为，不代表报错

- `native-host/host.mjs`
  - 这是 Chrome Native Messaging host
  - 正常用法是被 Chrome 扩展拉起
  - 直接以标准 host 模式执行时，也可能因为 `stdio` 断开而退出
  - 仓库里的 `npm run native-host:start` 已切到本地调试模式，会保持 socket 常驻，方便排障

一句话：

- 想给 Codex 接 MCP，用 `npm run mcp:start`
- 想单独确认 host/socket 是否正常，用 `npm run native-host:start`

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

更详细的目录职责见：

- [docs/repo-structure.md](/Users/vyodels/AgentProjects/mcp-browser-chrome/docs/repo-structure.md)

---

## 安装步骤

要求：

- Node.js 18+
- Chrome 114+

安装依赖并构建扩展：

```bash
npm install
npm run build
```

在 Chrome 中加载扩展：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择仓库下的 `dist/`
5. 记下扩展 ID

安装 Native Messaging manifest：

```bash
npm run native-host:install -- --extension-id=<your-extension-id>
```

这个命令会生成：

- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vyodels.browser_mcp.json`

manifest 里最关键的是两项：

- `path` 必须指向当前仓库的 [native-host/host.mjs](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host.mjs)
- `allowed_origins` 必须包含当前已加载扩展的 `chrome-extension://<extension-id>/`

如果你重新加载扩展后 ID 变了，需要重新执行安装命令。

---

## 正常启动

### 启动给 Codex 使用的 MCP server

```bash
npm run mcp:start
```

说明：

- 这是 `stdio` MCP server
- 设计上应该由 MCP client 托管
- 如果你只是手动在终端跑一遍，看到它很快结束，不代表代码坏了

### 单独调试 native host

```bash
npm run native-host:start
```

说明：

- 这个脚本现在会以调试常驻模式启动
- 它会监听本地 socket，并在 `stdin` 结束后继续存活
- 适合排查“host 有没有起来”“socket 能不能连”

如果你要模拟 Chrome 真正使用的 `stdio` host 方式，可以运行：

```bash
npm run native-host:stdio
```

---

## 最小排障路径

如果你怀疑“browser-mcp 启动失败”，按这个顺序查：

1. `npm run build` 是否通过
2. Chrome 是否真的加载了 `dist/`
3. 扩展 ID 是否和 Native Messaging manifest 里的 `allowed_origins` 一致
4. `npm run native-host:start` 是否能打印 `socket ready`
5. MCP client 调用 tool 时，`mcp/server.mjs` 是否报 `Native host unavailable`

常见误判：

- `npm run mcp:start` 一闪而过
  - 不是崩溃，是因为它本来就是 `stdio` 服务

- `npm run native-host:start` 以前一闪而过
  - 那是 host 模式依赖 `stdio`
  - 现在脚本已改成调试常驻模式

- 扩展明明加载了，但没有任何响应
  - 大概率是 Native Messaging manifest 没装，或者扩展 ID 变了

---

## 开发命令

```bash
npm run typecheck
npm run build
npm run mcp:start
npm run native-host:start
npm run native-host:stdio
npm run native-host:install -- --extension-id=<your-extension-id>
```

---

## 隐蔽原则

当前架构默认遵守：

- 不使用 `localhost HTTP/WebSocket` 作为扩展桥接主通道
- 不在页面主 world 常驻注入桥接脚本
- 内容脚本优先在 isolated world 执行
- snapshot 默认精简，debug DOM 单独调用
- click/fill 使用更接近真人的事件链与输入方式

注意：

- 目标是降低暴露面，不是承诺“绝对不可发现”
- 更容易暴露的通常是页面执行行为异常，而不是 MCP 本身
