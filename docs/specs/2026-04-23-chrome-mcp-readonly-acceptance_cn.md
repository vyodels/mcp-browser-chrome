# Chrome MCP 只读化重构 · 自动化验收标准

> **文档类型**：规格 / 验收标准（`docs/specs/`）
> 配套计划（已完成）：[`../completed/2026-04-23-chrome-mcp-readonly-refactor_cn.md`](../completed/2026-04-23-chrome-mcp-readonly-refactor_cn.md)
> **状态**：历史基线（2026-04-23）；当前复杂布局 / 随机 `clickPoint` / 目标页上下文验收请看 [`./2026-04-24-browser-mcp-complex-layout-acceptance_cn.md`](./2026-04-24-browser-mcp-complex-layout-acceptance_cn.md)
> 适用分支 / 提交：`main`（与备份 `feature/20260423-chrome-mcp` 对齐）
> 验收对象：`mcp-browser-chrome` 这个 Chrome 扩展 + MCP 运行时栈
> 验收目标：确认本轮只读化 + 隐身化重构的五项核心承诺成立
> 1. 工具面只剩 17 个只读 / 标签页管理工具，调用全部可达；`browser_locate_download` 只读定位 Chrome 下载记录中的本地 artifact 路径与状态，不恢复浏览器内下载动作
> 2. `browser_snapshot` 返回新协议（viewport / document / clickables / framePath / shadowDepth / detectedBy）
> 3. 扩展不向页面暴露任何可被 JS 探测的痕迹（`chrome.runtime.id` 不可见、无 MAIN world 注入、无合成事件、无 `web_accessible_resources`、无 DOM 污染）
> 4. 主流反自动化检测站点加载 `dist/` 之后的评分与 baseline 一致
> 5. 标签页切换 / 开启 / 聚焦的行为在页面侧与真实用户操作无法区分

---

## 0. 验收前置条件

| 项 | 要求 | 检查方式 |
|---|---|---|
| Node | ≥ 18 | `node -v` |
| Chrome | ≥ 114 | `chrome://version` |
| 工作目录 | `/Users/vyodels/AgentProjects/mcp-browser-chrome` | `pwd` |
| 分支 | `main`，工作区干净 | `git status --porcelain` 空 |
| 已执行一次 | `npm run setup:auto` | `dist/manifest.json` 存在 + `~/.codex/config.toml` 有 `browser-mcp` 条目 |
| Chrome 已加载 `dist/` | `chrome://extensions` 里启用 | 浏览器 action 图标显示 "browser-mcp" |
| Unix socket 已就绪 | 扩展成功唤起 native host | `ls $TMPDIR/browser-mcp.sock` 存在 |
| 当前至少有 1 个普通网页 tab | 非 `chrome://`、非 `about:blank` 空页 | `browser_list_tabs` 返回至少 1 条 `https://` tab |

> 以上任一条不满足 → 直接 **FAIL**，停止后续步骤。

---

## 1. 验收分级

本验收分三级，Agent 按顺序执行：

| 级别 | 描述 | 执行者 | 是否阻塞验收通过 |
|---|---|---|---|
| **L1 静态** | 源码 / 构建 / 产物审计，100% 脚本化 | Agent | 阻塞 |
| **L2 运行时** | 通过 MCP 调用自己，对真实页面跑 E2E | Agent | 阻塞 |
| **L3 人工辅助** | 需要在页面 Console 手动贴脚本 / 商用 SDK 评分肉眼判读 | 人 + Agent 准备 | 非阻塞，记录即可 |

最终判定：**L1 + L2 全部 PASS 即视为验收通过**。L3 作为加分 / 留痕项。

---

## 2. L1 静态验收（Agent 全自动）

### 2.1 类型检查

**执行：** `npm run typecheck`
**PASS 条件：** 退出码 `0`，无 `error TS` 输出
**FAIL 后果：** 阻塞

### 2.2 生产构建

**执行：** `npm run build`
**PASS 条件：**
- 退出码 `0`
- `dist/background.js` 存在且 < 15 KB（当前基线 7.21 KB）
- `dist/content.js` 存在且 < 15 KB（当前基线 7.05 KB）
- `dist/manifest.json` 存在
- `dist/icons/` 存在且包含 16/48/128 三个 PNG

**FAIL 后果：** 阻塞

### 2.3 `manifest.json` 字段审计（dist 为准）

对 `dist/manifest.json` 做字段级断言：

| 字段 | 期望值 | 判定 |
|---|---|---|
| `manifest_version` | `3` | 严格相等 |
| `permissions` | `["activeTab", "tabs", "scripting", "nativeMessaging", "cookies", "downloads"]`，**不允许更多**；`downloads` 仅用于 background 只读查询下载记录 | 集合相等 |
| `host_permissions` | `["<all_urls>"]` | 严格相等 |
| `content_scripts[0].all_frames` | `false` | 严格相等 |
| `content_scripts[0].matches` | `["<all_urls>"]` | 严格相等 |
| `web_accessible_resources` | 字段**不存在** | `'web_accessible_resources' in manifest === false` |
| `externally_connectable` | 字段**不存在** | `'externally_connectable' in manifest === false` |
| `content_security_policy` | 如果存在，不含 `unsafe-eval` / `unsafe-inline` | 正则 |
| `key` | 字段**不存在**（每次安装 ID 随机，降低指纹稳定性） | `'key' in manifest === false` |

**PASS 条件：** 全部命中
**FAIL 后果：** 阻塞

### 2.4 源码黑名单 grep（隐身红线）

在 `src/` + `mcp/` + `native-host/` 范围内执行以下 ripgrep，**任一命中即 FAIL**：

| 禁用项 | ripgrep 模式 | 原因 |
|---|---|---|
| 主 world 注入 | `world:\s*['"]MAIN['"]` | 会暴露 `window.chrome.runtime.id` / 打 hook |
| 合成鼠标事件 | `new MouseEvent\(` 或 `dispatchEvent\(.*MouseEvent` | 产出 `isTrusted: false`，一秒被抓 |
| 合成键盘事件 | `new KeyboardEvent\(` 或 `dispatchEvent\(.*KeyboardEvent` | 同上 |
| React fake input 模式 | `HTMLInputElement\.prototype.*set.*call\(` | 经典 RPA 指纹 |
| Chrome 远程调试 | `chrome\.debugger\.` | 会弹"DevTools 已附加"横幅 |
| `eval` | `\beval\s*\(` | 会留下 stack 特征 |
| `Function` 构造器 | `new Function\(` | 同上 |
| 旧产品遗留符号 | `AgentAction\|ActionResult\|BrowserActionRequest\|Workflow\|CandidateEntry\|rateLimit\|throttleAction\|OPEN_SETTINGS\|GET_PAGE_CONTENT\|GET_ACTIVE_TAB\|GET_ALL_TABS` | 死代码必须清零 |
| `interactiveLimit` 字段 | `interactiveLimit` | 旧协议字段，必须清零 |

**PASS 条件：** 全部 0 命中
**FAIL 后果：** 阻塞

### 2.5 `src/deprecated/` 目录不存在

**执行：** `test ! -d src/deprecated`
**PASS 条件：** 目录不存在
**FAIL 后果：** 阻塞

### 2.6 `src/extension/content/actions.ts` 与 `src/rateLimit.ts` 不存在

**PASS 条件：** 两个文件都 `!exists`
**FAIL 后果：** 阻塞

### 2.7 运行时 npm 依赖为零

**执行：** 读取 `package.json`
**PASS 条件：** `dependencies` 字段不存在或为空对象 `{}`
**FAIL 后果：** 阻塞

### 2.8 MCP 工具注册表基数

**执行：** 读取 `mcp/server.mjs`，数 `TOOLS` 数组长度
**PASS 条件：** 恰好 `17` 个工具，且集合等于：

```
browser_list_tabs, browser_get_active_tab, browser_reload_extension, browser_select_tab, browser_open_tab,
browser_snapshot, browser_query_elements, browser_get_element, browser_debug_dom,
browser_wait_for_element, browser_wait_for_text, browser_wait_for_navigation,
browser_wait_for_disappear, browser_screenshot, browser_get_cookies, browser_locate_download, browser_wait_for_url
```

**FAIL 后果：** 阻塞

### 2.9 `BrowserCommandName` union 与工具注册表一致

**执行：** 读取 `src/extension/shared/protocol.ts` 的 `BrowserCommandName`
**PASS 条件：** union 成员集合 === `TOOLS` 名称集合
**FAIL 后果：** 阻塞

---

## 3. L2 运行时验收（Agent 通过 MCP 自测）

> Agent 以 MCP Client 身份调用本项目注册的 `browser_*` 工具完成验收。
> 所有断言以工具返回的 `structuredContent` / JSON payload 为准。

### 3.1 工具可达性 smoke（17/17）

对每个工具用最小合法参数调用一次。以下表格里"参数"一列是 Agent 要传的最小集合。

| 工具 | 参数 | PASS 条件 |
|---|---|---|
| `browser_list_tabs` | `{}` | `success === true` 且 `tabs.length ≥ 1` |
| `browser_get_active_tab` | `{}` | `success === true` 且 `tab.id` 为数字 |
| `browser_reload_extension` | `{}` | 仅单步调试时人工执行；自动 acceptance 不应在运行中调用，避免 reload 断开当前 MCP/native-host 通道 |
| `browser_open_tab` | 优先用 `{ tabId: <同一聚焦窗口内既有 scratch tab>, windowId: <focusedWindowId>, url: "about:blank", active: false }`；没有可复用 tab 时才用 `{ windowId: <focusedWindowId>, url: "about:blank", active: false }` | `success === true` 且 `tabId` 为数字；记录 `scratchTabId`，重复回归应复用该 tab 而不是持续新开 |
| `browser_select_tab` | `{ tabId: <3.1.2 拿到的 active.id> }` | `success === true` |
| `browser_snapshot` | `{}` | 详见 3.2 |
| `browser_query_elements` | `{ selector: "a" }` | `success === true`，`matches` 为数组 |
| `browser_get_element` | `{ selector: "a" }` | `success === true`，`matches.length ≤ 1` |
| `browser_debug_dom` | `{}` | `success === true` 且 `snapshot.html` 为字符串 |
| `browser_wait_for_element` | `{ selector: "body", timeoutMs: 2000 }` | `matched === true` |
| `browser_wait_for_text` | `{ text: "<从当前页面 title 里截一个子串>", timeoutMs: 2000 }` | `matched === true` |
| `browser_wait_for_disappear` | `{ selector: "#definitely-does-not-exist-xyz", timeoutMs: 500 }` | `matched === true` |
| `browser_wait_for_navigation` | `{ timeoutMs: 500 }` | 超时返回 `matched === false`，不抛异常（阴性用例） |
| `browser_wait_for_url` | `{ pattern: "http", timeoutMs: 500 }` | `matched === true` 或阴性但 `success ∈ {true,false}` 都接受 |
| `browser_screenshot` | `{}` | 目标 tab 已活跃时 `success === true` 且 `screenshotDataUrl` 以 `data:image/png;base64,` 起头；inactive `tabId` 必须 `success === false`，避免截错活跃页 |
| `browser_get_cookies` | `{}` | `success === true`，`cookies` 为数组 |
| `browser_locate_download` | `{ sourceUrl: "https://example.invalid/no-such.pdf", expectedExtensions: ["pdf"], waitMs: 0 }` | `success === true` 且 `found === false`、`located === false`；可用 `sourceUrl/finalUrl/referrer + startedAfter` 关联 HID 点击来源和下载记录；可返回 `in_progress` / `interrupted` / `complete` 记录；不可打开 `chrome://downloads`，不可留下页面 JS 可见信号 |

**PASS 条件：** 16 项自动调用全通过，`browser_reload_extension` 作为人工/单步调试工具单独记录。
**清理：** 对 `scratchTabId` 调用 `chrome.tabs.remove` 是删除操作——此版本**没有**暴露 `browser_close_tab`，清理留给人工关闭；Agent 只需在日志里标记即可。

### 3.2 `browser_snapshot` 协议字段完整性

在当前活跃 tab 上调用 `browser_snapshot({ includeText: true, clickableLimit: 50 })`，断言：

| 字段 | 类型 / 范围 | 必选 |
|---|---|---|
| `success` | `=== true` | ✅ |
| `tabId` | number | ✅ |
| `snapshot.url` | 非空字符串，以 `http` 起头 | ✅ |
| `snapshot.title` | 字符串（可空） | ✅ |
| `snapshot.viewport.innerWidth` | `> 0` | ✅ |
| `snapshot.viewport.innerHeight` | `> 0` | ✅ |
| `snapshot.viewport.scrollX` | number | ✅ |
| `snapshot.viewport.scrollY` | number | ✅ |
| `snapshot.viewport.devicePixelRatio` | `> 0` | ✅ |
| `snapshot.document.scrollWidth` | `> 0` | ✅ |
| `snapshot.document.scrollHeight` | `> 0` | ✅ |
| `snapshot.clickables` | 数组，`length ≤ 50` | ✅ |
| `snapshot.text` | 字符串，`length > 0` | ✅（开了 `includeText`） |
| `snapshot.html` | `=== undefined` | ✅（没开 `includeHtml`） |

`snapshot.clickables[0]`（若存在）字段断言：

| 字段 | 断言 |
|---|---|
| `ref` | 匹配 `^@e\d+$` |
| `tag` | 非空字符串且全小写 |
| `viewport.top/left/width/height` | 均为 number |
| `document.top/left/width/height` | 均为 number |
| `inViewport` | boolean |
| `detectedBy` | ∈ `{"selector","cursor","tabindex","onclick"}` |
| `framePath` | undefined 或形如 `"0"` / `"0.1"` |
| `shadowDepth` | undefined 或正整数 |

**PASS 条件：** 全部命中
**FAIL 后果：** 阻塞

### 3.3 `clickables` 有序性

`snapshot.clickables` 必须满足：

1. `inViewport === true` 的元素全部排在 `inViewport === false` 的之前
2. 视口内元素按 `viewport.top ASC`，同 `top` 按 `viewport.left ASC` 排序

Agent 遍历数组验证。**PASS 条件：** 无逆序

### 3.4 `ref` 对齐 `browser_query_elements`

从 3.2 拿到 `snapshot.clickables[0].ref`（假设为 `@e1`），调用：

```
browser_query_elements({ ref: "@e1" })
```

**PASS 条件：** `matches.length === 1`，且返回的元素 `tag` 与 `snapshot.clickables[0].tag` 相等

### 3.5 检测站点 1 — Sannysoft（基础反检测面板）

**步骤：**

1. 先 `browser_list_tabs` 查找既有 Sannysoft 检测 tab；再调用 `browser_open_tab({ tabId: <可选既有 tabId>, url: "https://bot.sannysoft.com/", active: true })` → 记录 `botTabId`
2. `browser_wait_for_text({ tabId: botTabId, text: "Intoli.com", timeoutMs: 15000 })`
3. `browser_wait_for_navigation({ tabId: botTabId, timeoutMs: 5000 })` （容忍超时）
4. `browser_debug_dom({ tabId: botTabId })` → 拿到 `snapshot.html` + `snapshot.text`
5. `browser_screenshot({ tabId: botTabId })` → 存档留证

**PASS 条件（全部满足）：**

- `snapshot.text` 中关键行全部为 passed 状态。对以下关键词做"正向命中 + 反向命中"检查：

| 关键行（text 里的关键词） | 正则期望值 |
|---|---|
| `WebDriver (New)` | 紧邻行匹配 `/WebDriver \(New\)[\s\S]{0,200}?(missing \(passed\))/i` |
| `WebDriver Advanced` | 匹配 `/WebDriver Advanced[\s\S]{0,200}?passed/i` |
| `Chrome (New)` | 匹配 `/Chrome \(New\)[\s\S]{0,200}?present \(passed\)/i` |
| `Permissions (New)` | 匹配 `/Permissions \(New\)[\s\S]{0,200}?(default|passed)/i` |
| `Plugins Length (Old)` | 匹配 `/Plugins Length \(Old\)[\s\S]{0,200}?passed/i` |
| `Languages (Old)` | 匹配 `/Languages \(Old\)[\s\S]{0,200}?passed/i` |
| `WebGL Vendor` | 匹配 `/WebGL Vendor[\s\S]{0,400}?(Google Inc|Intel|Apple|NVIDIA|AMD)/i`（**不能**是 "Not Supported"） |
| `WebGL Renderer` | 同上，不能是 "Not Supported" |
| `Broken Image Dimensions` | 匹配 `/Broken Image Dimensions[\s\S]{0,200}?passed/i` |

- `snapshot.html` 中所有 `<td class="result failed">` 出现次数 ≤ Chrome baseline（当前基线 = 0）

**FAIL 后果：** 阻塞。失败时附上 3.5.5 截图 + `snapshot.text` 前 5000 字。

### 3.6 检测站点 2 — Are You Headless

**步骤：**

1. 先 `browser_list_tabs` 查找既有 Are You Headless 检测 tab；再调用 `browser_open_tab({ tabId: <可选既有 tabId>, url: "https://arh.antoinevastel.com/bots/areyouheadless", active: true })`
2. `browser_wait_for_text({ text: "headless", timeoutMs: 10000 })`
3. `browser_debug_dom({})` → 拿 `snapshot.text`

**PASS 条件：**
- `snapshot.text` 包含子串 `"You are not Chrome headless"`（大小写不敏感）
- `snapshot.text` **不**包含子串 `"You are Chrome headless"`

### 3.7 检测站点 3 — CreepJS（高级指纹）

**步骤：**

1. 先 `browser_list_tabs` 查找既有 CreepJS 检测 tab；再调用 `browser_open_tab({ tabId: <可选既有 tabId>, url: "https://abrahamjuliot.github.io/creepjs/", active: true })`
2. `browser_wait_for_text({ text: "trust score", timeoutMs: 30000 })` （页面计算较慢，给足 30s）
3. 额外 `browser_wait_for_text({ text: "%", timeoutMs: 10000 })`
4. `browser_debug_dom({})` → 拿 `snapshot.text`
5. `browser_screenshot({})` → 存档

**PASS 条件：**
- `snapshot.text` 中能匹配 `/trust score[\s\S]{0,100}?(\d{1,3})\s*%/i`，提取到的分数 ≥ **60**（基线：不装扩展的 Chrome 约 70~90，装了扩展应该基本不变）
- `snapshot.text` 中**不**含 "lie" / "headless" / "automation" 被显式标红的字样（检查是否存在 `/lies: [1-9]/i` —— 有任何 Lie 条目 → FAIL）

> **注：** CreepJS 的 trust score 随 Chrome 小版本波动较大，所以判定用的是**绝对下限 60** 而不是"和 baseline 完全一致"。如果某一次跑出来 < 60，先用 L3 的方法人工对照裸 Chrome，排除是 Chrome 自身升级导致的漂移再判定 FAIL。

### 3.8 扩展 ID 不可从 dist 产物逆推

**执行：** 在 `dist/` 下 ripgrep 以下模式：

- `key` 字段（manifest）
- 形如 `[a-p]{32}` 的扩展 ID 字符串字面量

**PASS 条件：** 0 命中（扩展 ID 必须每次安装随机，不能固化到产物里）
**FAIL 后果：** 阻塞

### 3.9 多 tab / 切焦 / 开窗 无痕迹

**步骤：**

1. 在当前窗口开 tab A = Sannysoft、tab B = areyouheadless
2. `browser_list_tabs({})` → 断言两个 URL 都在
3. `browser_select_tab({ tabId: A })` → `browser_debug_dom({})` → 再次验 3.5 PASS 条件依然成立
4. `browser_select_tab({ tabId: B })` → `browser_debug_dom({})` → 再次验 3.6 PASS 条件依然成立
5. `browser_select_tab({ tabId: A })` → 再来一次 3.5 PASS

**PASS 条件：** 三次切换后同一页面的检测结果稳定 PASS，不因为 tab 切换导致某些指标翻转

### 3.10 跨源 iframe 安全边界

**步骤：**

找一个带跨源 iframe 的普通网页（建议：`https://www.w3schools.com/html/html_iframe.asp` 或手工构造的测试页），`browser_snapshot({})`。

**PASS 条件：**
- 不抛异常
- `snapshot.clickables` 里**不**包含跨源 iframe 内部的元素（隐身前提，不能尝试越过同源策略）
- `snapshot.clickables` 里同源 iframe 内部的元素带 `framePath`（若测试页恰好有同源 iframe）

---

## 4. L3 人工辅助验收（Agent 做准备，人工判读）

### 4.1 页面 Console 自检脚本（人工必做）

**目的：** 因为本次重构已删除 `browser_execute_script`，Agent 没有在目标页面直接执行 JS 的能力。以下自检必须由人打开 DevTools Console 手动贴入。

**操作：** 随便打开一个普通网页（如 Sannysoft），F12 → Console，贴入：

```js
({
  webdriver: navigator.webdriver,
  globalLeak: Object.keys(window).filter(k => /mcp|vyodels|browser_mcp/i.test(k)),
  domLeak: document.querySelectorAll('[data-mcp],[data-browser-mcp],[data-vyodels]').length,
  attrLeak: Array.from(document.documentElement.attributes).filter(a => /mcp|vyodels/i.test(a.name)).map(a => a.name),
  injectedScripts: Array.from(document.scripts).filter(s => /mcp|vyodels/.test((s.src || '') + s.textContent.slice(0,200))).length,
  chromeRuntimeId: typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : null,
  chromeRuntimeSendMessage: typeof chrome !== 'undefined' && chrome.runtime ? typeof chrome.runtime.sendMessage : null,
})
```

**期望输出（逐字段）：**

| 字段 | 期望值 |
|---|---|
| `webdriver` | `false` 或 `undefined` |
| `globalLeak` | `[]` |
| `domLeak` | `0` |
| `attrLeak` | `[]` |
| `injectedScripts` | `0` |
| `chromeRuntimeId` | `undefined`（关键！网站不能拿到扩展 ID） |
| `chromeRuntimeSendMessage` | `"undefined"` 或 `"function"` 都可（MV3 无 `externally_connectable` 时，页面侧的 `chrome.runtime.sendMessage` 有但调不通） |

> `chromeRuntimeId === undefined` 是这次重构最核心的隐身指标。如果它返回了一个 32 位字符串，意味着你在 `manifest.json` 里意外暴露了 `web_accessible_resources` 或 `externally_connectable`，必须回头排查。

### 4.2 `chrome-extension://` 资源不可达（人工）

**操作：** 在 Sannysoft 页面的 DevTools Console 执行（替换 `<EXT_ID>` 为实际扩展 ID，从 `chrome://extensions` 抄）：

```js
fetch(`chrome-extension://<EXT_ID>/manifest.json`).then(r => r.status).catch(e => e.message)
```

**期望：** 抛错或返回非 200（因为没有 `web_accessible_resources`）。若返回 200 → FAIL。

### 4.3 商用反爬 SDK demo（人工观察）

Agent 打开下列页面并截图，由人目视判断结果（不做正则判定，因为这些厂家页面布局变动太频繁）：

| URL | 期望 |
|---|---|
| `https://fingerprint.com/demo/` | Bot likelihood 判定为 "Not a bot" 或 "Low" |
| `https://pixelscan.net/` | Overall consistency 绿灯，没有红色 "Inconsistent" |
| `https://iphey.com/` | 结果显示 "Trusted"（不能是 "Fake" / "Suspicious"） |

**Agent 步骤：** 依次 `browser_open_tab` + `browser_wait_for_text`（关键词 "bot"、"consistency"、"trust"）+ `browser_screenshot`，把 dataURL 存档。
**判定：** 人工对三张截图各打一个 PASS / FAIL。

### 4.4 真实用户操作无法区分（人工）

**操作：**
1. Agent 调用 `browser_select_tab` 切换到某个带 `visibilitychange` 监听器的页面（可以用 `https://visibilitystatechange.glitch.me/` 这类 demo，或任意装了 Google Analytics 的站点）
2. 在页面 Console 观察：`document.hidden` / `document.visibilityState` / `document.hasFocus()` 的值
3. 随后用鼠标手动切到同一个 tab，再看同样三个值

**期望：** 两次切换在页面侧触发的事件序列 / 属性值完全一致，无法从页面 JS 侧区分是"用户切的"还是"MCP 切的"。

---

## 5. 验收报告格式

Agent 跑完后产出一份 markdown 报告，结构如下：

```
# 验收报告 · <YYYY-MM-DD HH:mm>

## 环境
- node: <版本>
- chrome: <版本>
- commit: <git rev-parse HEAD>
- 扩展 ID: <从 chrome://extensions 抄>

## L1 结果
| 步骤 | 结果 | 备注 |
| 2.1 typecheck | PASS / FAIL | <exit code> |
| 2.2 build | PASS / FAIL | bg=<KB> content=<KB> |
| 2.3 manifest 审计 | PASS / FAIL | <失配字段列表> |
| 2.4 源码黑名单 | PASS / FAIL | <命中列表> |
| 2.5 deprecated 目录 | PASS / FAIL | |
| 2.6 actions/rateLimit 清理 | PASS / FAIL | |
| 2.7 运行时依赖为空 | PASS / FAIL | |
| 2.8 MCP 工具数=16 | PASS / FAIL | <实际数量> |
| 2.9 union ↔ 注册表一致 | PASS / FAIL | <差异> |

## L2 结果
| 步骤 | 结果 | 备注 |
| 3.1 工具 smoke 16/16 | PASS / FAIL | <失败工具列表> |
| 3.2 snapshot 协议 | PASS / FAIL | |
| 3.3 clickables 有序 | PASS / FAIL | |
| 3.4 ref ↔ query 对齐 | PASS / FAIL | |
| 3.5 Sannysoft | PASS / FAIL | failed 行数=<N> |
| 3.6 Are You Headless | PASS / FAIL | |
| 3.7 CreepJS | PASS / FAIL | score=<X>% lies=<Y> |
| 3.8 dist 不含扩展 ID | PASS / FAIL | |
| 3.9 多 tab 稳定 | PASS / FAIL | |
| 3.10 跨源 iframe 边界 | PASS / FAIL | |

## L3 结果（人工）
| 步骤 | 结果 | 备注 |
| 4.1 Console 自检 | PASS / FAIL / 未执行 | chromeRuntimeId=<value> |
| 4.2 chrome-extension:// fetch | PASS / FAIL / 未执行 | |
| 4.3 商用 SDK 三站 | PASS / FAIL / 未执行 | <逐站结果> |
| 4.4 用户操作不可区分 | PASS / FAIL / 未执行 | |

## 结论
- **L1**: <全通过 / 有阻塞>
- **L2**: <全通过 / 有阻塞>
- **L3**: <全通过 / 部分未执行 / 有阻塞>
- **总结论**: **PASS / FAIL**

## 附件
- sannysoft-screenshot.png
- creepjs-screenshot.png
- fingerprint-screenshot.png
- pixelscan-screenshot.png
- iphey-screenshot.png
```

---

## 6. 失败时的标准排查路径

| 失败项 | 最可能的根因 | 排查第一步 |
|---|---|---|
| 2.3 `permissions` 超集 | 有人偷偷加回 `storage`/`tabGroups` 或把 `downloads` 用成下载动作 | `git log manifest.json` |
| 2.4 命中 `world: 'MAIN'` | 新功能绕过隐身规则 | 看 PR diff |
| 2.4 命中 `dispatchEvent(new MouseEvent` | 有人加回交互工具 | 检查 `src/extension/content/` 新文件 |
| 3.1 某工具 smoke 失败 | native host / socket 未起来 | `ls $TMPDIR/browser-mcp.sock` + `chrome://extensions` 重新加载 |
| 3.5 Sannysoft 出现 failed | Chrome 自身指纹变化 / navigator.webdriver 被意外设为 true | 先在裸 Chrome（新建 profile）跑一遍对照 |
| 3.7 CreepJS trust < 60 | 装了其他 stealth 插件 / 同一 profile 被污染 | 换全新 profile 只装 `dist/` |
| 4.1 `chromeRuntimeId` 非 undefined | `manifest.json` 误加了 `web_accessible_resources` | 2.3 必然也会挂，回去看 2.3 |

---

## 7. 可选 · 回归烟雾脚本

当前已提供 `scripts/acceptance-smoke.mjs`：

```bash
npm run acceptance:smoke
npm run acceptance:smoke -- --l1-only
```

默认执行 L1 静态检查 + 本地 L2 fixture（complex-layout / Boss-like mock / detectable-surface）。L2 fixture 优先复用已有测试标签页；需要导航时传 `browser_open_tab({ tabId, url })`，不要每次回归都大量打开新 tab。在外层沙箱无法监听 `127.0.0.1` 时，可用 `--l1-only` 只跑 typecheck、build、manifest、工具清单、协议一致性和黑名单检查。

---

## 8. 修订记录

| 日期 | 修改人 | 内容 |
|---|---|---|
| 2026-04-23 | Cursor Agent | 初稿，对齐 `2026-04-23-chrome-mcp-readonly-refactor_cn.md` 第 7 节验证清单 |
| 2026-04-23 | Cursor Agent | 归入 `docs/specs/`；配套计划链接改为 [`../completed/2026-04-23-chrome-mcp-readonly-refactor_cn.md`](../completed/2026-04-23-chrome-mcp-readonly-refactor_cn.md)（已完成） |
| 2026-04-25 | Codex | 工具数修正为 16；补充 `acceptance:smoke`、JS 可感知性检测与 screenshot inactive-tab 安全边界 |
