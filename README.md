# browser-mcp

隐蔽优先的 Chrome 浏览器执行底座。

隐蔽 / 反自动化 / 反爬约束是这个项目的最高优先级，优先级高于调试便利性、默认观测能力和新功能接入速度。

它不是“一个直接在终端里跑起来就能点网页的脚本”，而是一条三段式链路：

1. Chrome Extension 负责真实浏览器内执行
2. Native Messaging Host 负责把扩展和本地 socket 桥接起来
3. Local MCP Server 负责把 `browser_*` 能力以 MCP tools 形式暴露给 Codex

如果这三段里任何一段没有接上，表面现象通常都会像“browser-mcp 启动失败”。

---

## 最高优先级规则

- stealth / anti-bot / anti-crawler 约束高于调试便利性、观测完整性和功能扩展速度。
- 默认禁止启用 Chrome `debugger` / CDP 调试通道；凡是依赖浏览器 debug 模式的能力，都必须提供非 debug 的安全降级路径。
- 默认路径不得在页面主 world 注入长期桥接或 monkey-patch；任何必须触达页面主 world 的诊断能力都只能显式触发、按需启用。
- 不允许简单移除公开方法导致拟人化操作链路中断；如果某条高风险路径被禁用，必须同时提供结构化的替代方案或安全降级行为。
- 只要某项实现会明显增加网页可探测面，它就不能成为默认行为。

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

- `browser_tabs`
- `browser_navigate`
- `browser_navigate_back`
- `browser_navigate_forward`
- `browser_reload`
- `browser_snapshot`
- `browser_frames`
- `browser_query_elements`
- `browser_get_element`
- `browser_debug_dom`
- `browser_click`
- `browser_hover`
- `browser_type`
- `browser_select_option`
- `browser_press_key`
- `browser_scroll`
- `browser_wait_for`
- `browser_take_screenshot`
- `browser_evaluate`
- `browser_run_code`
- `browser_console_messages`
- `browser_network_requests`
- `browser_get_network_request`
- `browser_file_upload`
- `browser_drag`
- `browser_fill_form`
- `browser_cookie_list`
- `browser_cookie_set`
- `browser_cookie_delete`
- `browser_cookie_clear`
- `browser_wait_for_url`
- `browser_wait_for_request`
- `browser_wait_for_response`
- `browser_wait_for_download`
- `browser_handle_dialog`
- `browser_resize`
- `browser_emulate`

注意：

- 旧的 `browser_list_tabs` / `browser_open_tab` / `browser_fill` / `browser_screenshot` 等名字已经移除，不再保留兼容别名。
- `browser_tabs` 的 `action` 支持 `list` / `current` / `new` / `close` / `select`。
- `browser_tabs` 在 `action=list` 时默认只返回当前 Chrome 窗口；显式传入 `{ "scope": "all_windows" }` 时，会返回所有普通 Chrome 窗口中的标签页。

页面操作还有一个额外约束：

- 除标签管理类工具外，调用方应显式传入目标 `tabId`
- 不再默认回退到“当前活动标签页”
- 这样可以避免误操作用户正在使用的前台标签页

截图也按同样原则收紧：

- `browser_take_screenshot` 只会在目标 `tabId` 本身就是当前可见标签页时执行
- 不会为了截图而偷偷切换标签页或抓取用户当前正在看的页面
- 元素截图会在当前可见画面上裁剪
- 真实站点默认禁用 `fullPage`，因为它需要滚动页面并可能触发曝光埋点或风控；如需整页截图，优先在离线 mock 页面验证

AI 适配补充：

- 大文本和长列表默认会带 `pageInfo` / `textInfo` / `htmlInfo` / `summary` 等结构化元数据。
- `browser_console_messages` 和 `browser_network_requests` 默认分页返回，避免把大批日志一次性塞进上下文。
- `browser_snapshot` 现在默认走 a11y-tree 风格输出，更接近 Playwright MCP；完整 DOM 仍通过 `browser_debug_dom` 单独读取。
- `browser_console_messages` 改为显式调用后才启用被动错误采集；默认只返回 `error` / `unhandledrejection`，不再 monkey-patch 页面 `console`。
- `browser_frames` 会显式返回同源 frame 列表，后续 `snapshot / query / click / type / evaluate / run_code / file_upload / drag / fill_form / take_screenshot` 都可以带 `frameRef`。
- `browser_network_requests` / `browser_get_network_request` 走 `PerformanceResourceTiming` 被动资源时序，不启用 debug 协议；默认只返回资源级元数据，不返回 header/body/status。
- `browser_evaluate` / `browser_run_code` 在 stealth 模式下只支持有限的只读安全表达式，用于取标题、URL、文本、属性等轻量信息。
- `browser_emulate` 不再进入浏览器 debug 模式；默认只保留窗口尺寸调整这条安全降级路径。
- `browser_click` 在真实站点默认只走保守点击，不再自动升级到 root / ancestor 补点；`打招呼 / 继续沟通 / 发送 / 求简历 / 换电话 / 换微信 / 索要联系方式` 这类一键副作用动作默认拒绝，必须显式传入 `allowDangerousAction=true`。

页面层级处理约束：

- AI 在进行任何业务点击、输入、拖拽前，应先检查当前页面是否存在弹窗、下载引导、遮罩层、全屏蒙层、浮层提示或其它遮挡主内容的顶层元素。
- 如果存在遮挡，应优先关闭、取消或收起这些顶层元素，再继续操作底层业务区域；不要无视覆盖关系直接点击底层目标。
- 推荐顺序是：`browser_snapshot / browser_debug_dom / browser_query_elements` 识别层级问题，必要时先执行关闭动作，然后再进行业务交互。
- 这个约束属于“拟人化操作链路”的一部分，不是可选优化项。

AI 默认操作顺序：

- 先通过 `browser_tabs` 明确目标标签页，再显式传入 `tabId`；不要假设“当前活动标签页”就是目标页面。
- 除标签管理类工具外，默认所有真实站点页面操作都应携带 `tabId`；如果拿不到 `tabId`，应先补齐标签页识别，而不是直接操作当前前台页面。
- 进入业务交互前，先做一次轻量读取：优先 `browser_snapshot`，必要时再 `browser_query_elements`，只有在确实需要 DOM 细节时才升级到 `browser_debug_dom`。
- 读取完页面后，先判断是否存在 modal / overlay / toast / 顶部横幅 / 下载提示 / 浮层引导；如存在，先清障，再点击、输入、拖拽或截图。
- 点击或输入之后，优先用显式 wait、状态字段、结构化结果或再次快照确认页面状态变化，不要连续盲点。
- 如果目标交互属于高风险动作，先寻找低风险替代路径；只有在替代路径不存在时，才升级到更强的交互方式。
- 对 `打招呼 / 发送 / 求简历 / 换电话 / 换微信 / 索要联系方式` 这类可能直接改变业务状态的动作，不要直接调用默认点击；应先做风险判断，必要时让上层 AI 明确 opt-in。

定位与抓取建议：

- locator 选择优先级建议为：稳定 `ref` > 明确 `selector` > 语义 `role` + `text` > 纯 `text` 模糊匹配。
- 使用文本定位时，优先找更小、更具体、更可见、更语义化的节点；不要把 `html`、`body`、大容器或整页根节点当作业务目标。
- 在列表、卡片、聊天记录等重复结构中，应先缩小作用域，再选目标项；不要直接拿全页同名文本的第一个命中结果。
- 读取大文本和长列表时，优先消费 `pageInfo` / `textInfo` / `htmlInfo` / `summary` 这些结构化元数据；需要更多内容时分段继续读，不要一次性抓完整 HTML。
- 常规读取优先 `browser_snapshot`；只在需要定位交互元素时调用 `browser_query_elements`；只在调试结构、排查遮挡或分析复杂层级时调用 `browser_debug_dom`。

高风险交互处理原则：

- 默认不要通过 Chrome `debugger`、CDP attach、remote debugging、DevTools 驱动或其它 debug 模式能力来完成真实站点默认流程。
- 如果某项高风险能力被限制，AI 应选择备选方案，而不是把链路直接判死。
- 原生 JS dialog 不走覆写方案时，备选是优先处理页面内自定义弹层，或改为人工接管。
- `fullPage` 截图被限制时，备选是元素截图、当前可见区域截图，或在离线 mock 页面验证整页流程。
- 复杂读取被限制时，备选是 `snapshot -> query -> debug_dom` 逐级升级，而不是一开始就抓整页 HTML。
- 难以稳定点击的目标，备选是先定位其所在卡片/区域、先清除遮挡、先滚动到可见，再执行点击；不要简单把点击能力判定为不可用。
- 真实站点点击失败时，默认不要自动升级为 root / ancestor 二次补点；备选是重新取快照、收缩作用域、显式等待业务信号，必要时人工接管。
- 高风险路径若仍不可安全执行，响应中应明确说明替代方案或人工接管点，让上层 AI 能继续编排，而不是只返回“禁用”。

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
  host-launcher.template

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
- 模板来自 [native-host/host-launcher.template](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host-launcher.template)

`host-launcher` 是安装脚本基于模板生成的本地文件，会把当前机器上的 Node 绝对路径写进去，再启动 [native-host/host.mjs](/Users/vyodels/AgentProjects/mcp-browser-chrome/native-host/host.mjs)。
这样 Chrome 启动 Native Messaging Host 时不依赖 `nvm`、shell profile 或 `PATH`，换电脑后只要重新执行 `npm run setup:auto` 即可。
这个生成文件不应该提交到仓库；仓库中只保留模板和生成逻辑。

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
