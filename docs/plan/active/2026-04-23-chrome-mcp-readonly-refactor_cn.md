# mcp-browser-chrome 只读化重构计划

**状态**: 待执行
**日期**: 2026-04-23
**范围**: 只保留"对页面只读" + "tab 查询/切换/打开/聚焦"能力；删除所有会被页面 JS 检测到的交互代码；把 `browser_snapshot` 升级为含**视口坐标 + 文档绝对坐标**的完整可点击元素清单，供外部 `CGEventPostToPid` 消费。
**依据参考**: [`/Users/vyodels/AgentProjects/recruit-agent/docs/analysis/2026-04-22-anti-automation-detection-surface_cn.md`](../../../../recruit-agent/docs/analysis/2026-04-22-anti-automation-detection-surface_cn.md)

**遵守原则**: 查询类保留；"可被检测的通通删除"；用户声明的 tab 切换/打开/聚焦保留。

---

## 1. 分支策略

```bash
git checkout main
git pull --ff-only
git branch feature/20260423-chrome-mcp   # 仅创建备份分支（指向当前 main），不切过去
# 继续留在 main 上修改
```

备份分支**只作快照**，不会自动跟进后续改动；如需要回滚直接 `git reset --hard feature/20260423-chrome-mcp`。

---

## 2. MCP 工具清单变更

### 保留（15 个）

| 工具 | 状态 |
|---|---|
| `browser_list_tabs` | 不变 |
| `browser_get_active_tab` | 不变 |
| `browser_select_tab` | 不变（`chrome.tabs.update` + `chrome.windows.update({focused:true})`）|
| `browser_open_tab` | 不变 |
| `browser_snapshot` | **重写增强**（见 §5）|
| `browser_query_elements` | 小改（配合新 snapshot 数据）|
| `browser_get_element` | 同上 |
| `browser_debug_dom` | 不变 |
| `browser_screenshot` | 不变（`chrome.tabs.captureVisibleTab`，不注入 JS）|
| `browser_get_cookies` | 不变（`chrome.cookies` API）|
| `browser_wait_for_element` | 不变 |
| `browser_wait_for_text` | 不变 |
| `browser_wait_for_disappear` | 不变 |
| `browser_wait_for_navigation` | 不变 |
| `browser_wait_for_url` | 不变 |

### 删除（21 个）

- 交互类（合成事件 `isTrusted:false`，§8.1）：`browser_click` / `browser_double_click` / `browser_hover` / `browser_fill` / `browser_clear` / `browser_select_option` / `browser_press_key` / `browser_scroll` / `browser_scroll_element`
- `world:'MAIN'` 注入类（§3.6 主 world 污染）：`browser_execute_script` / `browser_handle_dialog`
- 非查询且用户未声明保留：`browser_navigate` / `browser_go_back` / `browser_go_forward` / `browser_reload` / `browser_close_tab`
- 无意义或非查询：`browser_wait`（纯 sleep）/ `browser_download_file` / `browser_save_text` / `browser_save_json` / `browser_save_csv`

---

## 3. 文件变更清单

### 删除

- 整个 [`src/deprecated/`](../../../src/deprecated)（9 文件，~200KB）
- [`src/extension/content/actions.ts`](../../../src/extension/content/actions.ts)（所有 `dispatchEvent` 合成事件源头）
- [`src/rateLimit.ts`](../../../src/rateLimit.ts)（仅被 `actions.ts` 使用）

### 重写

- [`src/extension/content/snapshot.ts`](../../../src/extension/content/snapshot.ts) —— 新增视口/文档坐标、宽定义可点击、shadow DOM 穿透、同源 iframe 穿透（见 §5）

### 精简

- [`src/extension/content/handlers.ts`](../../../src/extension/content/handlers.ts) —— 去掉 `EXECUTE_ACTION` / `CONFIGURE_RATE_LIMIT` 分支
- [`src/extension/background/handlers.ts`](../../../src/extension/background/handlers.ts) —— 删除上表中所有被删工具对应的 `case`；保留工具的逻辑基本不变
- [`src/extension/shared/protocol.ts`](../../../src/extension/shared/protocol.ts) —— 删除 `BrowserActionName` / `BrowserActionRequest` / `BrowserActionResponse`；从 `BrowserCommandName` 中删除被删工具；`SnapshotRequest` / `PageSnapshot` 扩展新字段
- [`src/types.ts`](../../../src/types.ts) —— 删除 `AgentAction` 等仅交互类型使用的类型；`PageSnapshot` / `InteractiveElement` 调整
- [`mcp/server.mjs`](../../../mcp/server.mjs) —— `TOOLS` 数组删除被删工具

### 保留但微调

- [`src/extension/content/locators.ts`](../../../src/extension/content/locators.ts) —— 去掉对 `actions.ts` 的依赖（如有）
- [`src/extension/content/state.ts`](../../../src/extension/content/state.ts) —— 无改动
- [`src/extension/content/waits.ts`](../../../src/extension/content/waits.ts) —— 无改动
- [`native-host/host.mjs`](../../../native-host/host.mjs) —— 无改动
- [`src/background.ts`](../../../src/background.ts) / [`src/content.ts`](../../../src/content.ts) —— 无改动

---

## 4. `manifest.json` 清理

```json
{
  "manifest_version": 3,
  "name": "browser-mcp",
  "version": "1.0.0",
  "description": "Read-only Chrome browser MCP runtime",
  "permissions": [
    "activeTab",
    "tabs",
    "scripting",
    "nativeMessaging",
    "cookies"
  ],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "browser-mcp", "default_icon": { ... } },
  "icons": { ... },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ]
}
```

**删除项**:

- `web_accessible_resources`（§11 唯一的 manifest 层探测面，且 `dist/assets/` 实际不存在）
- `desktopCapture` / `tabGroups` / `downloads` / `storage` 权限（随对应工具删除而移除）

**变更项**:

- `content_scripts[0].all_frames` 保持 `false`（只在顶层 frame 注入；同源 iframe 通过顶层 DOM 递归抓坐标）
- `description` 改为 "Read-only Chrome browser MCP runtime"

---

## 5. `browser_snapshot` 新协议

### 5.1 输出结构

```ts
interface PageSnapshot {
  url: string
  title: string
  viewport: {
    innerWidth: number
    innerHeight: number
    scrollX: number
    scrollY: number
    devicePixelRatio: number
  }
  document: {
    scrollWidth: number
    scrollHeight: number
  }
  clickables: ClickableElement[]    // 替代原 interactiveElements
  text?: string                      // 可选保留，默认关闭
  html?: string                      // debug_dom 才启用
}

interface ClickableElement {
  ref: string                        // "@e1", "@e2"... 供 query_elements 复用
  tag: string                        // "button", "a", "div"...
  role?: string                      // aria role 或推断 role
  text: string                       // 截断 120 字
  ariaLabel?: string
  href?: string
  name?: string                      // form 元素的 name
  type?: string                      // input type

  viewport: { top: number; left: number; width: number; height: number }
  document: { top: number; left: number; width: number; height: number }
  inViewport: boolean                // 是否至少部分在视口内

  framePath?: string                 // 若在 iframe 内，格式 "0.2.1"（frame 索引路径）
  shadowDepth?: number               // 若在 shadow DOM 内的嵌套深度
  detectedBy: 'selector' | 'cursor' | 'tabindex' | 'onclick'
}
```

### 5.2 判定"可点击"的宽定义

```ts
const CLICKABLE_SELECTORS = [
  'a[href]', 'button', 'input', 'textarea', 'select',
  '[role="button"]', '[role="link"]', '[role="checkbox"]',
  '[role="menuitem"]', '[role="tab"]', '[role="option"]',
  '[contenteditable="true"]', '[tabindex]', '[onclick]'
]

function isClickable(el: HTMLElement): DetectReason | null {
  // 1. 白名单命中 → 'selector'
  // 2. getComputedStyle(el).cursor === 'pointer' 且非继承自父 → 'cursor'
  // 3. el.onclick !== null / onmousedown !== null → 'onclick'
  // 4. tabindex 已在白名单
}
```

### 5.3 Shadow DOM 穿透

```ts
function* walkDeep(root: Document | ShadowRoot): Generator<Element> {
  const stack: (Element | Document | ShadowRoot)[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node instanceof Element) yield node
    const children = (node as Element).children ?? (node as Document).children
    for (const c of children) {
      stack.push(c)
      if (c.shadowRoot) stack.push(c.shadowRoot)   // open shadow root
    }
  }
}
```

closed shadow root 无法访问，这是浏览器硬限制，不处理。

### 5.4 同源 iframe 处理

- 当前实现统一由顶层 frame 的 content script 采集快照；同源 iframe 通过 `iframe.contentDocument` / `contentWindow` 递归遍历并叠加偏移
- background 发消息固定走顶层 frame（`frameId: 0`），注入时也只向顶层 frame 注入；避免消息路由与注入范围不一致
- 跨源 iframe 的坐标叠加比较复杂，本次 MVP 不实现，后续按需扩展

### 5.5 视口/文档坐标换算

```ts
const vp = el.getBoundingClientRect()
const viewport = { top: vp.top, left: vp.left, width: vp.width, height: vp.height }
const document = {
  top: vp.top + window.scrollY,
  left: vp.left + window.scrollX,
  width: vp.width,
  height: vp.height,
}
const inViewport = vp.bottom > 0 && vp.right > 0 && vp.top < innerHeight && vp.left < innerWidth
```

### 5.6 可见性过滤

保留现有 `isVisible`（`display/visibility/opacity`），**并**增加：

- `rect.width > 0 && rect.height > 0`
- `!el.closest('[aria-hidden="true"]')`（排除无障碍隐藏的装饰）
- `getComputedStyle(el).pointerEvents !== 'none'`（排除纯装饰层）

---

## 6. 隐身性自检清单（改完后对着过）

| 检测面（对照反自动化检测面清单） | 是否规避 |
|---|---|
| §3.1 `Runtime.enable` Error.stack | 不用 CDP |
| §3.6 主 world 污染 | 全部走 isolated world / `content_scripts` |
| §4 `chrome.debugger` 黄条 | 不用 |
| §8.1 `isTrusted:false` | **交互代码已全部删除**，本扩展不产生合成事件 |
| §8.3 React fake input | `applyInputValue` 已删 |
| §11 `web_accessible_resources` 探测 | **已删除** |
| §11 content script DOM 残留 | 无：只读 DOM，不注入 script / style / attr |
| §11 `window` / `document` 标记 | 无 |
| §11 `postMessage` 桥 | 无 |
| §11 iframe `chrome.runtime.id` | isolated world 不泄漏 |
| §12 rAF 伪装时序不一致 | `chrome.tabs.update` 是真切换，`visibilityState` 与 rAF 频率自动自洽 |

---

## 7. 验证步骤

1. `npm run typecheck` —— 确保类型无错
2. `npm run build` —— 输出 `dist/`
3. `ls dist/` —— 确认不再有 `assets/` 目录（也不需要有）
4. `cat dist/manifest.json` —— 核对 permissions 精简、`all_frames:false`、无 `web_accessible_resources`
5. Chrome 手动载入 `dist/`，访问几个目标站点：
   - 普通页面 → `browser_snapshot` 返回 `clickables` 含视口/文档坐标
   - 含 Web Components 的页面（如 YouTube）→ shadow DOM 内按钮应出现
   - 含同源 iframe 的页面 → iframe 内按钮带正确 `framePath` 和叠加后的坐标
   - 任意页面粘贴 JS 自检：`document.querySelectorAll('*').length`、`document.__*`、`window.__*` 应无扩展相关残留
6. 在 `https://bot.sannysoft.com/` 跑一次，确认没有新的红项（应该和改之前一样或更好，因为少了所有 `isTrusted` 问题）

---

## 8. 风险与取舍

| 风险 | 缓解 |
|---|---|
| 跨源 iframe 暂不穿透 | 目标招聘类站点少见；后续按需加，不影响主流程 |
| closed shadow root 不可访问 | 浏览器硬限制，无解；现实中 closed 极少 |
| `getComputedStyle` 对大量元素有性能开销（§5.2 cursor 判定）| 限制 `clickables` 上限（默认 500），按 viewport 优先排序 |
| 仅顶层 frame 注入意味着跨源 iframe 仍不可穿透 | 与当前 routing 一致，减少注入面；同源 iframe 坐标采集不受影响 |
| 删 `browser_navigate` 后外部打开指定 URL 只能靠 `browser_open_tab({url})` 开新 tab | 符合用户"非查询类都删"原则；旧 tab 内跳转需要走 `CGEventPostToPid` 操作地址栏或点击链接 |

---

## 9. 执行顺序

1. git 备份分支
2. 清理 `src/deprecated/` + `src/extension/content/actions.ts` + `src/rateLimit.ts`
3. 重写 `src/extension/content/snapshot.ts`
4. 精简 `src/extension/shared/protocol.ts` + `src/types.ts`
5. 精简 `src/extension/content/handlers.ts`
6. 精简 `src/extension/background/handlers.ts`
7. 精简 `mcp/server.mjs`（`TOOLS` 数组）
8. 清理 `manifest.json`
9. `npm run typecheck` → `npm run build` → 修错
10. 更新 [`CLAUDE.md`](../../../CLAUDE.md) 和 [`CLAUDE_cn.md`](../../../CLAUDE_cn.md) 反映新工具清单
11. 自测（§7）

---

## 10. 决策记录

本计划在启动前与用户的确认点：

- **快照粒度**: 只要 human 可见的、最直接可见的所有可操作元素坐标（主要是可点击类），不需要所有文本节点 rect。
- **失焦下聚焦目标 tab 的语义**: 选 A，切换必须直接切到目标 tab（Chrome 窗口抢前台 + `tabs.update({active:true})`）。
- **删除范围**: 非查询类功能除用户声明保留外，全部删除；"可被检测的通通删除"为最高优先级。
- **shadow DOM / iframe 穿透**: 采用 open shadow DOM 递归穿透 + 顶层 frame 递归读取同源 iframe DOM；跨源 iframe 暂不处理。
- **可点击元素判定范围**: 宽定义（现有白名单 + `cursor:pointer` + `tabindex` + `onclick` attribute）。
- **wait_for_\* 辅助工具**: 5 个全部保留（`element` / `text` / `disappear` / `navigation` / `url`）。
