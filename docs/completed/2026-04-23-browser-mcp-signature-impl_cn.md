# browser-mcp 侧实施文档 · M1 · 元素稳定指纹 `signature` + M1.5 · 视口屏幕坐标字段

> **状态**：已完成（M1 + M1.5，2026-04-23）
> **归档位置**：`docs/completed/`（原 `docs/plan/active/`）
> **本文档角色**：本仓库该阶段实施说明（留档）
> **对应里程碑**：M1（含 M1.5 视口屏幕坐标字段）
> **作用范围**：仅本仓库。不依赖任何下游系统进展，独立可交付
> **预估工作量**：≤ 50 行代码 + 单元自测 + 验证 ≈ 0.5 人日

---

## 0. 背景一句话

本仓库 snapshot 已经返回每个 clickable 元素的 `role / text / 坐标`，缺一个跨快照稳定的元素指纹字段（`signature`）。补齐它之后，任何上游调用方都能拿它作为跨快照追踪、缓存键、聚合主键使用。

**本仓库不关心上游怎么用这个字段**，它只是一项中立的数据产出。

**非目标**（明确不做）：

- 不加任何新 MCP 工具（仅在 M1 范围内追加字段）
- 不触碰隐身红线（无 MAIN world、无合成事件、无 `web_accessible_resources`）
- 不改任何现有字段的语义，只**追加**一个新字段
- 不实现任何"跨快照元素追踪"、"机器学习指纹"之类的复杂逻辑——只是一个确定性哈希

---

## 1. 改动清单（M1 + M1.5，合计 4 个文件）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/types.ts` | M1：`ClickableElement` 新增必填字段 `signature: string` · M1.5：`SnapshotViewport` 新增 `screenX` / `screenY` / `visualViewport?: { scale, offsetLeft, offsetTop }` |
| 2 | `src/extension/shared/protocol.ts` | 无需改（两处都从 `types.ts` re-export） |
| 3 | `src/extension/content/snapshot.ts` | M1：新增 `computeCssPath()` + `computeElementSignature()` 两个辅助函数；`collectClickableCandidates` 里填充 signature · M1.5：`buildSnapshot()` 的 `viewport` 对象追加 `screenX/Y/visualViewport` 填充 |
| 4 | `CLAUDE.md` / `CLAUDE_cn.md` / `README.md` | Snapshot 说明里同时写入 signature + viewport 新字段 |

---

## 2. 代码实施

### 2.1 `src/types.ts` — 类型增补

在 `ClickableElement` 里加一个必填字段：

```ts
export interface ClickableElement {
  ref: string
  signature: string
  tag: string
  role?: string
  text: string
  ariaLabel?: string
  href?: string
  name?: string
  type?: string
  viewport: ElementRect
  document: ElementRect
  inViewport: boolean
  framePath?: string
  shadowDepth?: number
  detectedBy: 'selector' | 'cursor' | 'tabindex' | 'onclick'
}
```

**字段位置建议**：放在 `ref` 之后、`tag` 之前，语义分组清晰（`ref` 是本次快照内的临时 id，`signature` 是跨快照稳定的业务 id，两者并列）。

### 2.2 `src/extension/content/snapshot.ts` — 两个辅助函数 + 一处填充

在文件顶部（`import` 后）新增两个辅助函数：

```ts
function computeCssPath(el: Element): string {
  const segments: string[] = []
  let node: Element | null = el

  while (node && node.nodeType === Node.ELEMENT_NODE && segments.length < 8) {
    const tag = node.tagName.toLowerCase()
    const parent = node.parentElement
    if (!parent) {
      segments.unshift(tag)
      break
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node!.tagName)
    const index = siblings.indexOf(node)
    segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag)
    node = parent
  }

  return segments.join('>')
}

async function sha1Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 16)
}

function computeElementSignatureSync(el: Element, host: string): string {
  const role = deriveRole(el) ?? ''
  const text = getElementLabel(el).slice(0, 40)
  const cssPath = computeCssPath(el)
  return `${host}|${role}|${text}|${cssPath}`
}
```

**为什么 sha1 走 async 而 signature 填充看起来同步**：`crypto.subtle.digest` 是异步的，但 `collectClickableCandidates` 以及整个 snapshot pipeline 当前是同步的。两个方案选一个：

**方案 A（推荐）**：改用 **`FNV-1a 64-bit` 纯 JS 同步哈希**，避免把整个 pipeline 改成 async。元素指纹不是安全用途，不需要加密强度，FNV-1a 完全够用。

```ts
function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0xcbf29ce4 >>> 0
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x01000193) >>> 0
  }
  return ((h1.toString(16).padStart(8, '0')) + (h2.toString(16).padStart(8, '0'))).slice(0, 16)
}

function computeElementSignature(el: Element, host: string): string {
  const role = deriveRole(el) ?? ''
  const text = getElementLabel(el).slice(0, 40)
  const cssPath = computeCssPath(el)
  return fnv1a64(`${host}|${role}|${text}|${cssPath}`)
}
```

**方案 B**：把 `buildSnapshot` 改成 `async`。不推荐，改动面大、还要改消息 handler。

**决定**：走**方案 A**（FNV-1a），理由已在主文档 §4 隐含给出（指纹用途，不需要加密）。

---

在 `collectClickableCandidates` 里拿到 `host`（因为同一次快照里所有元素共享同一个 host，可以提前算好一次），然后在 push candidate 时填 `signature`：

```ts
function collectClickableCandidates(): ClickableCandidate[] {
  const candidates: ClickableCandidate[] = []
  const host = window.location.host

  walkDocument(window, { /* ... 省略 ... */ }, ({ element, view, framePath, shadowDepth, viewportOffsetTop, viewportOffsetLeft, documentOffsetTop, documentOffsetLeft }) => {
    if (!(element instanceof HTMLElement)) return
    if (!isVisibleInView(element, view)) return

    const detectedBy = detectClickableReason(element, view)
    if (!detectedBy) return

    // ... 现有 rect/viewport/document 计算逻辑不变 ...

    candidates.push({
      element,
      signature: computeElementSignature(element, host),
      tag: element.tagName.toLowerCase(),
      role: deriveRole(element),
      text: getElementLabel(element),
      ariaLabel: element.getAttribute('aria-label') ?? undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      name: element.getAttribute('name') ?? undefined,
      type: element instanceof HTMLInputElement ? element.type : undefined,
      viewport,
      document: documentRect,
      inViewport: inViewport(viewport),
      framePath,
      shadowDepth: shadowDepth > 0 ? shadowDepth : undefined,
      detectedBy,
    })
  })

  // 排序逻辑不变
  return candidates
}
```

**`ClickableCandidate` 类型也要同步加 `signature: string`**（在同一文件上方的 interface 定义里）。

### 2.3 iframe 的 host 处理

同源 iframe 内元素的 `signature` 是否用**父窗口 host** 还是**iframe 自身的 host**？

**决定**：用**父窗口 host**（即 `window.location.host`，不是 `view.location.host`）。

**理由**：`host` 字段的语义是"用户正在浏览的站点"（浏览器地址栏里那个）。如果 iframe 是同站但子域名不同（比如 `www.x.com` 嵌 `cdn.x.com` 的小组件），上游聚合时应该按"用户访问的是 www.x.com"这个维度处理，而不是给子域名组件单独一张表。这个语义选择对所有上游消费者（Agent / skill 缓存 / 后续可能的其他系统）都友好。

代码上已经在 `collectClickableCandidates` 顶层拿 `window.location.host`，对所有元素（包括 iframe 里的）都统一使用，不需要额外分支。

### 2.4 `resetRefState` 和指纹的关系

`resetRefState()` 每次快照重置 `@eN` 计数器；`signature` **不**受影响（每次独立计算，不需要状态）。两者职责正交。

---

## 3. 单元自测建议

在 `src/extension/content/snapshot.ts` 同目录下可选新增 `snapshot.spec.ts`（如果项目后续接入 vitest / jest；当前没有测试框架就先跳过，用手动验证代替）。

### 手动验证脚本（在任何网页的 DevTools Console 贴入，**不**需要装扩展）

```js
function fnv1a64(input) {
  let h1 = 0x811c9dc5 >>> 0, h2 = 0xcbf29ce4 >>> 0
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16)
}

function computeCssPath(el) {
  const segs = []
  let node = el
  while (node && node.nodeType === 1 && segs.length < 8) {
    const tag = node.tagName.toLowerCase()
    const parent = node.parentElement
    if (!parent) { segs.unshift(tag); break }
    const sibs = Array.from(parent.children).filter(c => c.tagName === node.tagName)
    const i = sibs.indexOf(node)
    segs.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${i + 1})` : tag)
    node = parent
  }
  return segs.join('>')
}

function signatureOf(el) {
  const host = location.host
  const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return fnv1a64(`${host}|${role}|${text}|${computeCssPath(el)}`)
}

// 对页面上所有 a / button 算一遍，看分布
const els = document.querySelectorAll('a[href], button')
const map = new Map()
els.forEach(el => {
  const sig = signatureOf(el)
  map.set(sig, (map.get(sig) ?? 0) + 1)
})
console.log('total:', els.length, 'unique sigs:', map.size, 'collisions:', els.length - map.size)
console.table([...map.entries()].filter(([_, n]) => n > 1))
```

**PASS 条件**：
- 在 3 个常见站点（github.com / bilibili.com / 任意电商首页）上跑，`collisions / total < 10%`
- 同一页面刷新后，同一元素的 sig 保持不变

---

## 4. 验证流程

### 4.1 本地 smoke

```bash
npm run typecheck && npm run build
```

**PASS 条件**：两条都退出码 0，`dist/content.js` 大小增幅 < 1 KB。

### 4.2 实际加载验证

1. Chrome 加载 `dist/`
2. 打开 Cursor / Codex Agent，运行：
   ```
   browser_snapshot({ clickableLimit: 20 })
   ```
3. 检查返回的 `snapshot.clickables[0].signature` 是 16 位十六进制字符串
4. 保持同一 tab 不动，再调一次 `browser_snapshot`
5. **PASS 条件**：同一元素（同 viewport 坐标）的 `signature` 两次调用**完全相等**

### 4.3 跨页面稳定性验证

1. 访问 `https://github.com/explore`
2. `browser_snapshot({})` 记下某个"Star" 按钮的 `signature = S1`
3. 切到 `https://github.com/trending`（同站不同页）
4. `browser_snapshot({})` 找到同样是"Star" 按钮的 `signature = S2`
5. **预期**：`S1 === S2`（因为 host / role / text / cssPath 相同）

**允许失败**：如果两页面里的"Star"按钮在 DOM 里层级深度不同导致 cssPath 不同，`S1 !== S2`——这是接受的，因为"不同页面"本来就应该区分开。此项仅作观察记录，不阻塞验收。

---

## 5. 验收 PASS/FAIL

| # | 检查项 | PASS 条件 |
|---|---|---|
| 1 | typecheck | 退出码 0 |
| 2 | build | 退出码 0 且 `dist/content.js` 增幅 < 1 KB |
| 3 | `browser_snapshot` 返回的 `clickables[*].signature` 存在 | 每项都是 `/^[0-9a-f]{16}$/` |
| 4 | 同一页面两次快照同元素 sig 一致 | 严格相等 |
| 5 | 跨同源 iframe 的元素 sig 用父窗口 host | 抓一个 iframe 里的元素 sig 的前 N 字符 hash 前缀能在父 host 下重现（手动计算对照） |
| 6 | 单页面 sig 碰撞率 | 在 3 个站点上 `collisions / total < 10%` |
| 7 | 隐身回归不破坏 | 回跑 [`docs/specs/2026-04-23-chrome-mcp-readonly-acceptance_cn.md`](../specs/2026-04-23-chrome-mcp-readonly-acceptance_cn.md) §3.5 ~ §3.7，Sannysoft / areyouheadless / CreepJS 全绿 |

**只要 1-5 + 7 全 PASS 即视为 M1 完成**。第 6 项为软指标，碰撞率 > 10% 时记 issue 但不阻塞合并（可通过给 `computeCssPath` 增加 `[class]` 维度迭代）。

---

## 6. 提交信息建议

```
feat(snapshot): add stable `signature` to ClickableElement

- FNV-1a 64-bit hash over (host, role, text, cssPath[:8])
- Stable across snapshots; intended as a neutral tracking/cache key
- No behavior change for existing fields; signature is additive
```

---

## 6bis. M1.5 · 视口屏幕坐标字段（已随 M1 同批次落地）

### 背景

上游消费者在把"元素视口坐标"转换为"屏幕坐标"时需要几项输入：浏览器内容视口左上角在屏幕上的位置、`devicePixelRatio`、`visualViewport` 缩放状态。这些都是页面本身可见的数据，content script 直接就能拿到，放在 snapshot 里完全符合中立数据源原则。

### 落地范围

`SnapshotViewport` 追加 3 个字段：

| 字段 | 必填 | 取值 |
|---|---|---|
| `screenX: number` | 是 | `window.screenX` — 内容视口左上角到屏幕左边缘的像素距离 |
| `screenY: number` | 是 | `window.screenY` — 内容视口左上角到屏幕上边缘的像素距离 |
| `visualViewport?: { scale, offsetLeft, offsetTop }` | 否 | `window.visualViewport.*`，处理 pinch-zoom 与键盘弹出场景；不支持时 `undefined` |

（`devicePixelRatio` 已随 M1 首批提交存在，继续保留。）

### 改动位置

- `src/types.ts` — `SnapshotViewport` 接口新增上述字段
- `src/extension/content/snapshot.ts` — `buildSnapshot()` 里的 `viewport: { ... }` 对象同步填充

改动面 ≤ 15 行。

### PASS 条件

1. `npm run typecheck` && `npm run build` 通过
2. 调 `browser_snapshot` 返回的 `viewport` 里：
   - `screenX`、`screenY` 是**非负整数**（单显示器情况下；多显示器时可能为负，合法）
   - `devicePixelRatio` 与 Chrome 当前缩放一致（在 Chrome 地址栏 `chrome://settings/` 里调缩放 125% 后，应读到 `1.25` 或 `2.5`，取决于 Retina）
   - `visualViewport.scale` 在未 pinch-zoom 时 = 1
3. 手动用 "Cmd+加号" 缩放几次，`devicePixelRatio` 跟随变化
4. **语义自证**：`screenX + clickables[i].viewport.left` 在 Chrome 全屏且无多屏时应落在 `[0, screenWidth]` 范围内

### 为什么 browser-mcp 做到这里就停

再往下一层的窗口系统坐标换算，需要知道标题栏/工具栏高度、菜单栏、Dock 等 OS / 窗口管理器信息，content script 拿不到。这一步不属于本仓库职责。

---

## 7. 绝对不要做的事（红线）

1. **不要**把 signature 计算放到 background / native host 侧 —— 只能在 isolated world content script 里做
2. **不要**为了稳定性引入 `querySelectorAll`（超大页面性能炸）
3. **不要**使用 `el.outerHTML.length` 之类会触发 serialize 的属性做指纹来源 —— 开销大且不稳定
4. **不要**偷偷加依赖（比如 `crypto-js`）—— 本项目 0 runtime dep 是硬约束，FNV-1a 手写 6 行搞定
5. **不要**擅自改签名算法为 SHA-256 之类 —— 这会把 `buildSnapshot` 污染成 async，改动面爆炸
6. **不要**在 signature 里加入任何时间戳、随机数 —— 指纹必须确定性，否则"稳定"二字失去意义
7. **不要**在本仓库代码/注释/测试/文档里引入任何具体下游系统名词 —— 本仓库是中立数据源，`signature` 的 rationale 只描述到"跨快照稳定的元素标识"为止

---

## 8. 修订记录

| 日期 | 修改人 | 内容 |
|---|---|---|
| 2026-04-23 | Cursor Agent | 初稿 |
| 2026-04-23 | Cursor Agent | rev-1：去掉下游耦合措辞；明确本仓库是中立数据源；新增红线 §7.7 禁止下游概念泄漏 |
| 2026-04-23 | Cursor Agent | rev-2：追加 §6bis M1.5（已落地）—— `SnapshotViewport` 补 `screenX` / `screenY` / `visualViewport` 三个字段；用途是让上游把元素视口坐标转成屏幕坐标，同时不越界去做标题栏/菜单栏/Dock 相关推断 |
| 2026-04-23 | Cursor Agent | rev-3：归档至 `docs/completed/`；验收标准引用改为 [`docs/specs/2026-04-23-chrome-mcp-readonly-acceptance_cn.md`](../specs/2026-04-23-chrome-mcp-readonly-acceptance_cn.md)；主文档 Cross-ref 路径更新 |
