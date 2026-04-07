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

项目现在在 [manifest.json](/Users/vyodels/AgentProjects/mcp-browser-chrome/manifest.json) 中固定了扩展 `key`，后续 unpacked 扩展 ID 会稳定，不会因为重新加载而漂移。

执行成功后会生成：

- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.vyodels.browser_mcp.json`

manifest 里最关键的是两项：

- `path` 必须指向当前仓库生成的 launcher，而不是依赖 shell 环境去解析 `node`
- `allowed_origins` 必须包含当前扩展 ID。安装脚本会兼容当前已加载 ID 和稳定 ID。

安装脚本现在会额外生成：

- [native-host/host-launcher](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host-launcher)

这个 launcher 会把当前机器上的 Node 绝对路径写进去，再启动 [native-host/host.mjs](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host.mjs)。
这样 Chrome 启动 Native Messaging Host 时不依赖 `nvm`、shell profile 或 `PATH`，换电脑后只要重新执行 `npm run setup:auto` 即可。

如果你是从旧版本升级到这个版本：

1. 打开 `chrome://extensions`
2. 对当前 `browser-mcp` 扩展点一次“重新加载”

这一步只需要做一次，用来让 Chrome 接受新的稳定扩展 ID。完成后后续重载不应再需要重新绑定。

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
3. 如果是旧版本升级，是否在 `chrome://extensions` 里重载过一次扩展
4. Chrome 打开普通网页后，扩展是否已自动拉起 native host
5. MCP client 调用 tool 时，`mcp/server.mjs` 是否报 `Native host unavailable`

常见误判：

- `npm run mcp:start` 一闪而过
  - 不是崩溃，是因为它本来就是 `stdio` 服务

- 明明扩展加载了，但 MCP tool 还是超时
  - 常见原因是扩展仍处于旧实例，或 native host 启动路径配置错误
  - 先打开一个普通网页，再看一次
  - 如果是从旧版本升级，去 `chrome://extensions` 重载一次扩展

- 扩展明明加载了，但没有任何响应
  - 大概率是 Native Messaging manifest 没装，或者扩展 ID 变了

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
- snapshot 默认精简，debug DOM 单独调用
- click/fill 使用更接近真人的事件链与输入方式

注意：

- 目标是降低暴露面，不是承诺“绝对不可发现”
- 更容易暴露的通常是页面执行行为异常，而不是 MCP 本身
