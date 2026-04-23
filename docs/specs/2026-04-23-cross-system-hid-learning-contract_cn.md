# 键鼠控制层 + 学习能力 · 跨系统集成契约

> 状态：草案（跨仓库规格）
> 适用范围：**跨仓库**，不属于任何单一代码仓
> 对应仓库：
> - `~/AgentProjects/mcp-browser-chrome`（只读快照采集，已完成）
> - `~/AgentProjects/VirtualHID`（HID 注入，demo 阶段）
> - Agent 侧的 skill 层（主 Agent，粘合两者）
>
> 配套文档：
> - [`../completed/2026-04-23-chrome-mcp-readonly-refactor_cn.md`](../completed/2026-04-23-chrome-mcp-readonly-refactor_cn.md)（browser-mcp 只读化，**已完成**）
> - [`./2026-04-23-chrome-mcp-readonly-acceptance_cn.md`](./2026-04-23-chrome-mcp-readonly-acceptance_cn.md)（browser-mcp 验收标准）
>
> 本文档是**契约**而非实现清单；VirtualHID 侧的具体 PR 在它自己仓库提，但必须以本文为准。

---

## 0. 背景与三方职责再确认

本系统的三方解耦是硬约束，不因本轮扩展而破坏。

| 组件 | 职责 | 禁止做的事 |
|---|---|---|
| **browser-mcp**（只读） | 采集页面 DOM / 视口 / document 坐标 / clickables / 快照 | 任何键鼠注入、任何 MAIN world 脚本、任何 `isTrusted:false` 事件 |
| **VirtualHID**（HID 注入 + 本地学习） | 真实 HID 注入（`CGEvent.postToPid`）、拟人化策略、紧急停止、被动观察用户操作、离线学习 | 主动访问 DOM、主动去浏览器取上下文；**只接受 Agent 传入的 context** |
| **Agent** | 唯一的业务贯穿者：读 browser-mcp 拿到元素坐标/语义 → 封装成 `ActionContext` → 下发给 VirtualHID → 收集执行反馈 → 蒸馏 skill | 自己实现 HID / 自己实现 DOM 解析 |

**关键推论**：browser-mcp 和 VirtualHID **永远**不直接通信。它们之间唯一的"感知"是：Agent 在调度时把 browser-mcp 的快照字段（URL / element.ref / element.role / element.text / element 坐标）作为 `ActionContext` 的一部分塞给 VirtualHID。这份 `ActionContext` 是本方案引入的**唯一跨仓库契约**。

---

## 1. 本轮要解决的五个问题

| # | 问题 | 归属 |
|---|---|---|
| P1 | VirtualHID 现在键鼠节奏是固定 `sleep(ms)`，毫无拟人特征，面对带行为指纹检测的站（如 DataDome / PerimeterX）一测一个准 | VirtualHID |
| P2 | 没有紧急停止入口。一旦注入脚本跑飞，用户没法中断（目前只能 `kill -9`） | VirtualHID |
| P3 | Agent 没法读取 VirtualHID 的当前状态（鼠标在哪、是不是 busy、修饰键是否卡住、上次是否成功），只能盲发指令 | VirtualHID + Agent 契约 |
| P4 | 希望 VirtualHID 能学习用户在特定网页上的操作习惯，之后按用户自己的节奏执行——当前 demo 没有学习路径 | VirtualHID（被动观察 + 离线学习） |
| P5 | 学习要有业务意义需要"元素/任务"级别的标签；而 VirtualHID 感知不到页面业务。业务连贯今天完全靠 Agent 贯穿——需要给这个贯穿**一个稳定的形式化载体** | **Agent ↔ VirtualHID** 契约（`ActionContext`，browser-mcp 不参与） |
| P6 | `CGEvent.postToPid` 在目标窗口非聚焦时只能投递 `mouseMoved`，`leftMouseDown/Up` 等事件会被丢弃，实测失败率高 —— 必须让执行器能切换到 `CGEventPost`（全局事件流，命中前台窗口） | VirtualHID |

---

## 2. 架构决策

### 2.1 不改变三方互不直连的边界

不新增 VirtualHID ←→ browser-mcp 的直接通道。Agent 仍然是唯一的"业务桥"。

### 2.2 `ActionContext` 是 **Agent ↔ VirtualHID** 的契约（browser-mcp 不参与）

**语义归属**：`ActionContext` 是 Agent 为了驱动 VirtualHID 而构造的业务标签。它的字段来源可以是 browser-mcp snapshot、也可以是 Agent 自己的业务上下文（taskId / stage / urgency 等）。

**browser-mcp 视角**：不知道 `ActionContext` 的存在。它只返回**中立的原子数据字段**（host / ref / role / text / signature / 坐标），这些字段由 Agent 自主选择如何组装、或者直接不用。

**VirtualHID 视角**：把 `ActionContext` 当作一个**不透明标签**对待——唯一的用法是把其中几个字段作为 Profile Store 的聚合主键（`host + element.sig + taskId + action_type`），不做其他业务解读。

**后果**：

1. browser-mcp 仓库里**不需要**出现 `ActionContext` 这个词（实施文档 §4 只谈"稳定元素指纹字段"）
2. 契约版本升级只需要 Agent 侧 + VirtualHID 侧协同 bump，browser-mcp 不动
3. Agent 是唯一"知道业务是什么"的一方，这也是整套系统唯一合理的设计

契约 schema 详见 §6。

### 2.3 VirtualHID 内部演化为五层

```
┌─────────────────────────────────────────────────────────┐
│ MCP stdio server  (mcp/server.mjs, hid_* tools)         │  ← Agent 唯一入口
│   └─ dispatcher ──▶  Unix socket  ──▶  InjectorDaemon   │
├─────────────────────────────────────────────────────────┤
│ InjectorDaemon (Swift)                                  │
│ ┌─ Control Server (Unix socket backend, JSON lite)      │
│ ├─ Action Core   │ Humanization   │ State Reporter      │
│ │ (CGEvent)      │ (WindMouse /   │                     │
│ │                │  β-dwell /     │                     │
│ │                │  profile lookup│                     │
│ ├──────────────────────────────────────────────────────  │
│ │ Supervisor (CGEventTap)                               │
│ │  - Kill switch (5×ESC within 1.5s)                    │
│ │  - Passive observer (record real user events)         │
│ ├──────────────────────────────────────────────────────  │
│ └─ Profile Store (trace DB + aggregator + templates)    │
└─────────────────────────────────────────────────────────┘
```

- **MCP stdio server**（新增）：Node.js 薄 shim，路径 `mcp/server.mjs`（与 browser-mcp 同构）。向 Agent 暴露 9 个 `hid_*` tool（详见 §3.5），把 MCP `tools/call` 请求下沉到 InjectorDaemon 的 Unix socket。100 行左右，**零业务逻辑**，仅做协议转换与错误码映射
- **InjectorDaemon**（Swift）：所有业务逻辑都在这里
- **Control Server**（Swift 侧）：Unix socket + newline-delimited JSON，作为 InjectorDaemon 的后端入口。既是 MCP shim 的下游，也保留 `nc -U` 直连能力用于调试 / 单测 / 其他客户端
- **Action Core**：接收"原语序列"（move / click / drag / type / key）+ context。**投递模式可切换**：默认 `CGEventPost`（全局事件流，命中前台窗口）；`CGEventPostToPid` 作为可选备选（详见 §3.7）
- **Humanization Layer**：拟人化策略外壳。按 `ActionContext` 查 Profile Store 是否有对应模板；命中就按模板生成节奏/轨迹，否则 fallback 到默认拟人策略
- **Supervisor**：`CGEventTap` 独立线程监听全局事件。两用：①紧急停止（5×ESC）②被动观察用户真实操作并写入 trace
- **State Reporter**：聚合当前鼠标位置、busy 状态、修饰键残留、最近错误、权限状态、kill-switch 状态、supervisor 是否在线
- **Profile Store**：SQLite 本地文件 + 定期聚合的参数化模板

**为什么选择 MCP 两层拓扑（而不是让 Swift 直接跑 MCP server）**：

1. Agent 侧**零文档依赖**：MCP 自带 `tools/list` + JSON Schema 自描述，Codex / Cursor / Claude Desktop 连上自动发现工具
2. 和 browser-mcp **结构对称**：两个下游都是 "stdio MCP shim → Unix socket → 原生进程"，Agent 侧注册方式统一（`~/.codex/config.toml` 里并排登记两个 stdio server）
3. Swift 侧**零 MCP 依赖**：不用手写 stdio MCP loop，也不用 vendor 任何 Swift MCP SDK；Swift 只维护 Unix socket JSON lite
4. Swift daemon **仍可单独使用**：`nc -U $TMPDIR/virtualhid.sock` 直接能连，调试 / 脚本 / 其他前端都不需要经过 MCP 层

### 2.4 browser-mcp 侧的最小增量

只加一件事：`ClickableElement` 里额外返回一个**稳定元素指纹** `signature`，作为一项中立的数据字段对外提供。

**browser-mcp 不关心 Agent 怎么用它** ——可以拿来做 skill 缓存键、跨快照元素追踪、传给下游任何系统做聚合键等。本文档建议的"Agent 把它填进 `ActionContext.element.sig` 供 VirtualHID 做学习主键"只是其中一种用法，browser-mcp 实施文档里不提这件事。

指纹生成规则（在 browser-mcp 里实现，**不**跨仓库执行）：

```
signature = sha1(host + "|" + role + "|" + normalizedText + "|" + cssPath)[:16]
```

- `host`：`new URL(location.href).host`
- `role`：`deriveRole(el)`（已有）
- `normalizedText`：`getElementLabel(el)` 取前 40 字（已有）
- `cssPath`：从根到元素，取每级 `tag[:nth-of-type(N)]`（新增辅助函数，≤ 30 行）

**为什么是这四个字段**：
- 不使用页面 DOM id（很多站是随机的，稳定性为 0）
- 不使用整段 CSS selector（太长、每个 a/b 测试就变）
- `host + role + text` 在绝大部分站点足够唯一到"同一业务按钮"
- `cssPath` 作为 tie-breaker，防止一个页面里多个 "提交" 按钮撞 sig

Agent 在下发 VirtualHID 指令时**可选**地把这个 sig 写进 `ActionContext.element.sig`，VirtualHID 会把它当作 Profile Store 的聚合主键之一。Agent 如果不填，VirtualHID 会 fallback 到"仅站点级"聚合（见 §3.6 执行命中）。

### 2.5 不引入网络调用

- 控制面：Unix socket（本机）
- Profile Store：SQLite 本地文件（`~/Library/Application Support/VirtualHID/profiles.db`）
- Trace 日志：同目录 JSONL
- 不上传、不同步。学习完全在用户本机完成。

---

## 3. VirtualHID 模块拆解与任务

### 3.1 Action Core（重构现有）

**动作原语**（取代现有硬编码 scenario）：

| 原语 | 参数 |
|---|---|
| `move` | `{ to: {x, y}, via?: "wind"|"bezier"|"linear", durationMs?: number }` |
| `click` | `{ at: {x, y}, button: "left"|"right"|"middle", holdMs?: number, count?: 1|2|3 }` |
| `drag` | `{ from: {x, y}, to: {x, y}, button, via? }` |
| `scroll` | `{ at: {x, y}, dy: number, dx?: number, via?: "wheel"|"trackpad" }` |
| `type` | `{ text: string, layout?: "us"|"mac-abc" }` |
| `key` | `{ code: "return"|"tab"|"escape"|"cmd+a"|…, holdMs? }` |

**高层动作**（由多个原语组成，仍由 Agent 调度）：

| 高层动作 | 展开为 |
|---|---|
| `click_element` | `move(to=el.center) → click(at=el.center)` |
| `fill_input` | `click_element → key(cmd+a) → type(text)` |
| `submit_form` | `fill_input → key(return)` |

**为什么不让 VirtualHID 自动做"click_element"这种高层动作**：因为它需要 DOM 上下文（比如自动避开 overlay），这是 Agent 的活。VirtualHID 只认坐标 + context 标签。

**KeyMap 扩展**：当前只有 a-z / 0-9 / space。扩展到完整 ANSI 键 + 常用修饰键组合 + 常用快捷键（`cmd+a/c/v/x/z`、`cmd+shift+z`、`return/tab/esc/backspace/arrow*`）。中文等多字节字符走**剪贴板 + cmd+v** 路径（直接 type 不现实）。

### 3.2 Humanization Layer

默认策略（无 profile 命中时）：

**鼠标轨迹**：采用 **WindMouse** 变体（Benjamin J. Land 原始算法）。参数：

```
G_0 = 9    // gravity toward target
W_0 = 3    // wind noise magnitude
M_0 = 15   // max step length
D_0 = 12   // distance threshold where wind decays
```

关键特征：路径非单调、末端会有 overshoot + correction、距离越近速度越慢（Fitts' law 一致）。

**参考开源**：
- WindMouse 原始 pseudo-code（公开算法，C# / Python / JS 都有移植）
- `ghost-cursor` (Node.js MIT) 的贝塞尔路径生成——对 WindMouse 是补充方案
- `pyclick` 的贝塞尔曲线生成器

实现放在 `Sources/HumanizationKit/`（新增 target）。纯算法，单元测试覆盖。

**键盘节奏**：
- dwell time（按下到释放）：Beta(2, 5) 映射到 [40ms, 180ms]
- inter-key interval：按 char 类别分布
  - 同一单词内相邻字母：Log-Normal(μ=log(110), σ=0.35)
  - 单词边界（空格前后）：Log-Normal(μ=log(180), σ=0.4)
  - 大小写切换 / 特殊符号：+30% bias
- shift 按下/释放与字符重叠 10-40ms（真实用户特征）
- 偶发 typo + 立即退格修正（可关闭开关，默认**关**；学习后可按用户 profile 打开）

**参考文献**：Keystroke Dynamics 相关论文，Monrose & Rubin 是经典起点；现代可看 DSN-KeyStroke 数据集的统计分布。

**滚轮**：模拟 trackpad 滚动的惯性衰减（指数衰减 + 初始速度 from Log-Normal）。

### 3.3 Supervisor（新增）

**独立线程 / 独立 Mach port**，跑 `CGEventTap`，监听 `kCGSessionEventTap` 层的键鼠事件。

**两个职责**：

**A. Kill Switch — 连按 5 次 ESC**
- 维护一个 ring buffer，记录最近 5 次 ESC 的 `kCGEventSourceUserData`
- 只计数**真实用户**发的 ESC（source data **不**等于 VHID 的 `0x56484944`）
- 5 次 ESC 时间戳的跨度 ≤ 1500ms 时触发
- 触发后：
  1. 立即中断当前所有 injector 任务（抢占锁 + 取消 token）
  2. 释放所有仍按住的修饰键（Shift/Cmd/Opt/Ctrl/Caps）—— 否则用户键盘会卡
  3. 鼠标按键全部 release
  4. 写入 `killSwitchTriggered: true` 到 state，Agent 下次查 state 会看到
  5. 后续所有 `command` 请求都返回 `error: "kill switch active"`，直到 Agent 显式调用 `unlock`（或用户手动切换）
- 触发时蜂鸣一次 + log 记录（方便事后复盘）

**B. Passive Observer — 被动记录用户真实操作**
- 默认**关闭**，Agent 显式调用 `observe: {enable: true, host: "..."}` 才启动（避免无意中长期录屏级收集）
- 启用后：记录所有 `source data ≠ 0x56484944` 的事件（即"非自己发的"），带时间戳 + 坐标 + 键码
- 和 browser-mcp 的 snapshot 对齐：Agent 在用户每次 click / input 前后各取一次 snapshot，Supervisor 把落在这个窗口里的真实事件关联到对应元素 sig
- 落到 trace JSONL + SQLite

**权限**：`CGEventTap` 要求 Accessibility 授权。启动时自检 + 暴露 `state.accessibilityGranted`。

### 3.4 State Reporter（新增）

`GET state` 返回：

```json
{
  "version": "0.2.0",
  "busy": false,
  "lastAction": {
    "id": "act-1234",
    "finishedAt": "2026-04-23T10:15:30.123Z",
    "ok": true,
    "error": null,
    "elapsedMs": 847
  },
  "cursor": {
    "x": 1240, "y": 680,
    "screenIndex": 0
  },
  "modifiers": {
    "shift": false, "cmd": false, "opt": false, "ctrl": false, "fn": false,
    "stuck": []
  },
  "killSwitch": {
    "active": false,
    "triggeredAt": null,
    "unlockable": true
  },
  "supervisor": {
    "online": true,
    "observing": false,
    "observingHost": null
  },
  "permissions": {
    "accessibility": true,
    "inputMonitoring": true
  },
  "targetApp": {
    "bundleId": "com.google.Chrome",
    "pid": 52341,
    "frontmost": true,
    "windowTitle": "..."
  },
  "post": {
    "default": "global",
    "lastUsed": "global",
    "available": ["global", "pid", "auto"]
  },
  "profiles": {
    "totalTemplates": 37,
    "lastLearnedAt": "2026-04-22T22:10:00Z"
  }
}
```

**关键字段说明**：

- `modifiers.stuck`：如果检测到修饰键按下时长超过 10s 且无配对 release，记为"可能卡住"—— Agent 看到就应该 warn
- `targetApp.frontmost`：**在 `CGEventPost` 投递模式下是硬要求**（非前台时 click/keyDown 等事件会落到其他窗口或被丢弃）。Agent 必须在执行前置检查里断言此字段为 `true`
- `post.default` / `post.lastUsed`：当前投递模式与上次使用的投递模式（详见 §3.7）
- `profiles.totalTemplates`：让 Agent 知道"学过多少"，用于 telemetry

### 3.5 对 Agent 的接口 —— MCP stdio server

**Agent 视角**：VirtualHID 是一个 MCP stdio server，Agent 通过 MCP 协议连接并调用 `hid_*` 工具。**不需要关心底层 Unix socket**。

**MCP server 注册**（Agent 侧 `~/.codex/config.toml` 增加一条，和 `browser-mcp` 并列）：

```toml
[mcp_servers.virtualhid]
command = "node"
args = ["/Users/USER/AgentProjects/VirtualHID/mcp/server.mjs"]
```

**工具清单**（MCP `tools/list` 自动可发现）：

| tool | 参数 | 说明 |
|---|---|---|
| `hid_action` | `{ id, primitives: [...], context: ActionContext, options?: { postMode?: "global"\|"pid"\|"auto", timeoutMs?, dryRun?, contextVersion?: 1 } }` | 执行一组动作原语；`postMode` 见 §3.7，缺省使用 `state.post.default` |
| `hid_state` | `{}` | 返回 §3.4 的 state snapshot |
| `hid_stop` | `{}` | 主动停止当前动作（轻量版，不触发 kill switch） |
| `hid_unlock` | `{}` | 解除 kill switch |
| `hid_observe` | `{ enable: bool, host?: string, taskId?: string }` | 开关被动观察 |
| `hid_profiles_list` | `{ host?: string }` | 列出已学模板 |
| `hid_profiles_get` | `{ host, sig }` | 取具体模板参数 |
| `hid_profiles_forget` | `{ host?: string, sig?: string }` | 清除学习数据 |
| `hid_trace_tail` | `{ n?: 50, onlyUnresolved?: boolean }` | 最近 N 条 trace（`hid_observe` 开启后有数据；`onlyUnresolved=true` 时只返回尚未打上 element_sig 的真实事件，供 Agent 关联） |
| `hid_trace_commit` | `{ eventId, elementSig, role, text, host, taskId?, stage? }` | Agent 把 element 关联结果回写给 VirtualHID，补齐某条 trace 的业务标签（见 §8.2） |

**错误语义**：MCP tool 失败时返回 `isError: true` + 文本内容，文本开头是错误码前缀：

```
E_BUSY: injector is running action act-0042
E_KILL_SWITCH: user triggered kill switch at 2026-04-23T10:15:30Z
E_NOT_FRONTMOST: target app is not frontmost, global post mode requires it
E_POST_MODE_UNSUPPORTED: postMode=pid cannot deliver leftMouseDown
E_CONTEXT_REQUIRED: missing required field context.host
E_PROFILE_MISS: no template for host=example.com sig=a8f1...
E_PERMISSION: accessibility permission missing
E_NO_TARGET: cannot resolve frontmost Chrome window
E_UNKNOWN: <message>
```

**两层内部传输**（MCP shim ↔ InjectorDaemon）：Unix socket `$TMPDIR/virtualhid.sock`，newline-delimited JSON，每条 request 一行。shim 层做 MCP `tools/call` → Unix socket method 的 1:1 映射（`hid_action` → `action`、`hid_profiles_list` → `profiles.list` 等）。这一层是**实现细节**，Agent 不感知、不应编程依赖。

**Swift daemon 仍可 `nc -U` 直连**：用于 CI / 单测 / 本地手工验证；不会随 MCP shim 消失。

### 3.6 Profile Store（新增）

**Schema**（SQLite）：

```sql
-- 原始 trace（保留 N 天，默认 30 天，可配置）
CREATE TABLE traces (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,      -- epoch ms
  source      TEXT NOT NULL,         -- "user" | "agent"
  host        TEXT NOT NULL,
  element_sig TEXT,
  task_id     TEXT,
  stage       TEXT,
  action_type TEXT NOT NULL,         -- "click" | "type" | "drag" | "scroll"
  payload     TEXT NOT NULL          -- JSON: 轨迹点序列 / 按键时序
);

-- 聚合后的参数化模板
CREATE TABLE templates (
  host          TEXT NOT NULL,
  element_sig   TEXT NOT NULL,
  task_id       TEXT,
  action_type   TEXT NOT NULL,
  sample_size   INTEGER NOT NULL,    -- 基于多少条 trace 聚合
  confidence    REAL NOT NULL,       -- 0..1
  params        TEXT NOT NULL,       -- JSON: 拟合后的分布参数
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (host, element_sig, task_id, action_type)
);

CREATE INDEX idx_traces_host_sig ON traces(host, element_sig);
```

**聚合器**：
- 触发：a) 每 N 条 trace 一次；b) 每天定时一次；c) Agent 调 `profiles.rebuild`
- 最小样本：每组 `(host, sig, task_id, action_type)` 样本数 ≥ **5** 才生成模板，否则不做
- 拟合方法：
  - 鼠标轨迹 → 用 Douglas-Peucker 简化成 8~16 个控制点 → 平均 + 协方差（供执行时按多元高斯抖动采样）
  - 键盘 dwell / inter-key → Beta / Log-Normal 极大似然拟合
  - 每组模板计算 confidence = f(样本数, 样本方差)

**执行时命中逻辑**：

```
ctx = request.context
candidates = [
  (ctx.host, ctx.element.sig, ctx.taskId, action),     // 最精确
  (ctx.host, ctx.element.sig, null,       action),     // 跨任务
  (ctx.host, null,            null,       action),     // 仅站点级
]
pick first template with confidence >= 0.5, else default策略
```

**为什么引入 `task_id`**：同一个"搜索按钮"在"随便浏览"和"赶时间"两种任务下用户节奏完全不同。Agent 在下发时可以打 taskId（比如 "casual-browse" / "quick-task"），学到更细粒度的 profile。不打就 fallback。

### 3.7 投递模式（Post Mode）

**背景**：现有 demo 使用 `CGEvent.postToPid(pid)` 投递事件。实测发现这条路径只对 `kCGEventMouseMoved` 有效——目标窗口非前台时，`leftMouseDown` / `leftMouseUp` / `keyDown` / `keyUp` 会被 WindowServer 丢弃或落到前台窗口的事件管线上。点击失败率接近 100%。

**决策**：执行器必须支持两种投递模式，Agent 按需切换。

| 模式 | 底层 API | 特性 | 适用场景 |
|---|---|---|---|
| `global` **（默认，主力）** | `CGEvent.post(tap: .cgSessionEventTap)` | 进入系统事件流，命中前台窗口；所有事件类型都能投递 | 常规用例：Agent 先把目标窗口激活到前台，再投递动作 |
| `pid` | `CGEvent.postToPid(pid)` | 绕过前台，直达目标进程；但只有 `mouseMoved` / 部分滚轮有效 | **仅用于探测与诊断**：比如检测目标窗口的 frame、在不打扰用户的情况下做可见性探针 |
| `auto` | 先尝试 `pid`，检测到事件类型不支持时自动升级为 `global` | 给 Agent 一个懒惰档 | 初期少用；等 telemetry 足够再考虑启用 |

**前置约束**：

- 使用 `global` 模式**必须**先保证 `state.targetApp.frontmost === true`。ControlServer 在 `action` 请求进来时自检：若 `postMode == global` 且 `targetApp.frontmost == false`，**直接拒绝**并返回 `E_NOT_FRONTMOST`，不尝试发事件（避免事件落到错误窗口造成严重副作用）
- 使用 `pid` 模式时，若 `primitives` 里存在 `click` / `drag` / `type` / `key`（即非 `move`/`scroll`）原语，**直接拒绝**并返回 `E_POST_MODE_UNSUPPORTED`（或 downgrade 到 `auto` 的逻辑里）
- `global` 模式下执行前，执行器应自动把目标 App 激活到前台（通过 `FocusController.activate`）并等待 180-260ms；如果 180ms 后仍未 frontmost，返回 `E_NOT_FRONTMOST` 并让 Agent 决定是否重试

**Event Source User Data 自标记保持不变**：两种模式下生成的 `CGEvent` 都要 `setIntegerValueField(.eventSourceUserData, value: 0x56484944)`，Supervisor 的 kill switch 仍然靠这个字段区分真实用户 vs 自注入事件。

**修饰键释放（kill switch 触发时）必须用 `global`**：因为用户感知里的"按住 Cmd 不放"是系统级状态，必须发给 session event tap 才能清掉。这个是硬编码行为，不走 postMode 选项。

**接口落点**：

```swift
// Sources/InjectorCore/EventPoster.swift
public enum PostMode: String, Codable { case global, pid, auto }

public struct EventPoster {
    public let mode: PostMode
    public let targetPid: pid_t?      // pid / auto 模式必需

    public func post(_ event: CGEvent, kind: CGEventType) {
        // 仅非 mouseMoved/scrollWheel 且 mode==.pid → 抛 E_POST_MODE_UNSUPPORTED
        // mode==.auto → 先 pid，若检测到事件未送达则 fallback 为 global（需要 M8 前加探测）
        // mode==.global → event.post(tap: .cgSessionEventTap)
        // mode==.pid    → event.postToPid(targetPid!)
    }
}
```

**历史决策回溯**：demo 阶段埋了 `postToPid` 做"不聚焦也能投"的理想方案，实测后发现是 macOS WindowServer 的安全限制，和 Chrome 的实现无关。接受这个现实，把 `global` 定为主力。

---

## 4. browser-mcp 侧的最小增量

**只加一个字段**，不改任何现有行为，也**不引入任何 ActionContext / VirtualHID 相关概念**。

`src/extension/content/snapshot.ts` 的 `ClickableElement` 新增 `signature` 字段，按 §2.4 的规则生成。

对应：
- `src/types.ts` 的 `ClickableElement` 新增 `signature: string`
- `src/extension/shared/protocol.ts` 同步
- `buildSnapshot` 里调用新辅助函数 `computeElementSignature(el)`

预估改动：**≤ 50 行**。不破坏只读 / 隐身任何承诺（cssPath 全部通过 `Element.parentElement` + `indexOf` 计算，在 isolated world 里做，不碰页面脚本）。

**浇一遍冷水**：browser-mcp 仓库的代码里、注释里、测试里、文档里，都**不应该**出现 `ActionContext` / `VirtualHID` / `profileStore` / `HID` 等下游系统的名字。`signature` 的存在理由只需要说"提供一个跨快照稳定的元素标识，便于上游系统做缓存键/追踪/聚合"。

加完后 browser-mcp 侧**不**需要再改任何东西。它是**中立数据源**，不是任何下游系统的特供组件。

---

## 5. Agent 侧的改动（粘合层）

Agent 新增三件事（§5.1 / §5.2 / §5.3），另加一项坐标换算职责（§5.0）。

### 5.0 坐标换算：页面 → 屏幕（CGPoint）

`browser-mcp` 提供的 `ClickableElement.viewport` / `.document` 是**页面坐标系**的 CSS 像素，`VirtualHID` 收到的是 **macOS 屏幕坐标系**（CGEvent / CGPoint，pt 单位）。这层转换 **只能由 Agent 做**（browser-mcp 拿不到 OS 窗口/标题栏信息，VirtualHID 不解析 DOM）。

输入（全部已由 browser-mcp 提供，M1 + M1.5 已落地）：

- `snapshot.viewport.screenX` / `screenY` — 浏览器内容视口左上角在屏幕上的位置
- `snapshot.viewport.devicePixelRatio` — 缩放比（CSS px ↔ physical px；注意 macOS CGEvent 本身使用 pt，一般与 CSS px 同尺度）
- `snapshot.viewport.visualViewport.scale / offsetLeft / offsetTop` — pinch-zoom 状态（有才带）
- `clickable.viewport.{top,left,width,height}` — 元素在视口里的位置

核心换算（忽略 pinch-zoom 时）：

```
centerScreenX = viewport.screenX + clickable.viewport.left + clickable.viewport.width  / 2
centerScreenY = viewport.screenY + clickable.viewport.top  + clickable.viewport.height / 2
```

pinch-zoom 场景（`visualViewport.scale !== 1`）要先把元素坐标乘以 scale 再加 offsetLeft/offsetTop，再加 `screenX/Y`。具体实现放在 Agent 的 macOS 粘合层。

**browser-mcp 不越界**的边界：Chrome 窗口标题栏/菜单栏/Dock 的高度不在 snapshot 里——那是 OS 层知识，Agent 自己通过 `NSScreen` / VirtualHID 的 `BrowserResolver` 拿。snapshot 只负责把"页面本身可见"的部分说清楚。

### 5.1 `ActionContext` 组装器

```ts
function buildActionContext(snapshot, clickable, taskId?, stage?): ActionContext {
  const url = new URL(snapshot.url)
  return {
    host: url.host,
    url: snapshot.url,
    element: {
      ref: clickable.ref,
      sig: clickable.signature,   // 来自 browser-mcp §4
      role: clickable.role,
      text: clickable.text.slice(0, 40),
      viewport: clickable.viewport,
      document: clickable.document,
    },
    taskId, stage,
    snapshotAt: Date.now(),
  }
}
```

### 5.2 执行前置检查（硬约束）

在调 `hid_action` 前，Agent 必须：

1. `browser_select_tab({ tabId })`（激活目标 tab + 聚焦 Chrome 窗口）
2. （如有导航）`browser_wait_for_navigation`
3. 调用 macOS 侧的 Chrome 激活（可通过 AppleScript / `osascript -e 'tell application "Google Chrome" to activate'`）—— 仅 `browser_select_tab` 不保证 Chrome 是**系统前台 App**
4. 调 `hid_state` → 断言：
   - `busy === false` —— 否则等 / `hid_stop`
   - `killSwitch.active === false` —— 否则 `hid_unlock` 或报警
   - `permissions.accessibility === true` —— 否则请用户授权
   - `targetApp.frontmost === true` —— **硬要求**，`global` 投递模式依赖此
   - `modifiers.stuck` 为空 —— 否则先 `hid_unlock`（unlock 会 release 修饰键）
5. 任一不满足 → 按上面的修复动作处理；仍不行就放弃这次指令并报错给上层

**投递模式选择**：

- 默认省略 `options.postMode`，让 daemon 用 `state.post.default`（也是 `global`）
- 只有"探测类"动作（比如先 move 看看 hover 状态）才考虑显式 `postMode: "pid"`
- 碰到 `E_NOT_FRONTMOST` 错误 → 说明第 3 步没生效，Agent 重新激活 Chrome 并重试 1 次；2 次仍失败报错

### 5.3 Skill 蒸馏

Agent 蒸馏的 skill 以 `(host, element.sig, taskId)` 为缓存键。命中时直接：

```
1. 取 snapshot（validate sig 是否仍在 clickables 里）
2. 调 hid_profiles_get({ host, sig }) 拉 template → 直接生成 primitives
3. 不再做坐标计算 / 元素查询
```

这是用户需求里的 "避免每次重新计算、提高速度、降低 token" 的落地方式。skill 存储本身属于 Agent 侧，不进 VirtualHID / browser-mcp。

---

## 6. `ActionContext` 契约 —— Agent ↔ VirtualHID

### 6.1 契约归属

| 角色 | 职责 |
|---|---|
| **Agent**（调用方） | 契约的**生产者**。负责组装 `ActionContext`，字段可来自 browser-mcp snapshot、Agent 自身业务上下文、或任何第三方数据源 |
| **VirtualHID**（服务方） | 契约的**消费者**。把 context 当作**不透明标签**用于 Profile Store 聚合主键；不做任何业务解读、不做字段校验之外的 URL/业务推断 |
| **browser-mcp** | **契约外**。它的 `ClickableElement.signature` / `viewport` / `document` / `role` / `text` 只是 Agent 组装 context 时可选的数据来源之一，browser-mcp 不知道 context 是什么 |

### 6.2 JSON Schema

```jsonc
{
  "host": "example.com",                       // string, required
  "url": "https://example.com/...",            // string, required
  "element": {                                 // optional（仅在动作绑定到具体元素时带）
    "ref": "@e12",                             // browser-mcp 返回的临时 ref（可选，仅用于日志追溯）
    "sig": "a8f1c0b3d4e5f607",                 // 稳定指纹，强烈建议填（VirtualHID 聚合主键）
    "role": "button",
    "text": "提交",                            // ≤40 char
    "viewport": { "top": 320, "left": 450, "width": 120, "height": 40 },
    "document": { "top": 1820, "left": 450, "width": 120, "height": 40 }
  },
  "taskId": "checkout-flow",                   // 可选；Profile 二级键
  "stage": "step-2-payment",                   // 可选；Profile 三级键
  "snapshotAt": 1745409334000,
  "hints": {
    "urgency": "normal",                       // "normal" | "quick" | "deliberate"
    "risk": "low"                              // "low" | "medium" | "high"
  }
}
```

### 6.3 契约不变点

- **必填**：`host`、`url`
- **强烈建议填**：`element.sig`（不填则 VirtualHID 只能按站点级聚合，学习粒度变粗）
- **字段只增不改**；删字段 = 破坏性变更，需要 Agent + VirtualHID 两方协同 bump
- **版本字段** `contextVersion` 放在外层 `hid_action` 参数的 `options` 里（`hid_action({ id, primitives, context, options: { contextVersion: 1, ... } })`），不污染 context 本身

### 6.4 VirtualHID 对 context 的可用字段白名单

VirtualHID 的代码只允许读取以下字段，其他字段**透传到日志但不参与逻辑**：

- `host` → Profile key L1、trace 的 `host` 列
- `element.sig` → Profile key L2、trace 的 `element_sig` 列
- `element.role` → 敏感过滤（`textbox` + `password` 组合丢弃 trace）
- `taskId` → Profile key L3、trace 的 `task_id` 列
- `stage` → trace 的 `stage` 列（不参与 Profile key）
- `hints.urgency` → Humanization 参数缩放（如果 §11 开放问题 3 最终启用）

**不允许**的逻辑：VirtualHID **禁止**根据 `host` 做"特殊站点白名单/黑名单"、**禁止**根据 `url` 做正则匹配、**禁止**根据 `text` 做"识别这是不是登录按钮"。所有业务判断都是 Agent 的职责。

---

## 7. 紧急停止详细设计

| 子项 | 决策 |
|---|---|
| 触发条件 | 真实用户发出的 ESC 键 `kCGEventKeyDown`，5 次，跨度 ≤ 1500ms |
| 真实 vs 注入区分 | `kCGEventSourceUserData != 0x56484944`（VHID 自标记）= 真实用户 |
| 触发后行为 | ① 中断所有 injector 子任务 ② 释放修饰键 ③ 释放鼠标按键 ④ 置 killSwitch ⑤ 蜂鸣 ⑥ log |
| 解除方式 | Agent 调 `unlock`，或进程重启。**不**对用户自动解除（防止自动化脚本自己解自己） |
| 兜底 | 一旦 supervisor 线程自身崩了，injector 主进程 1s 无心跳也自爆 |
| 用户教学 | VirtualHID 首次启动 / 首次 supervisor 上线时，在 notification center 弹一次：「紧急停止：连按 5 次 ESC」 |

**其他候选方案对比**（供参考）：

| 候选 | 优点 | 否决理由 |
|---|---|---|
| 物理快捷键（如 F19） | 唯一性强 | 许多键盘没 F19，移植性差 |
| cmd+opt+ctrl+shift+esc | 组合稀有 | 手一只按不过来，紧急时反而用不了 |
| 鼠标晃动超阈值（panic wiggle） | 直觉 | 易误触，用户正常操作也可能触发 |
| **5×ESC** ✅ | 简单、任何键盘都有、紧急时本能就会按 ESC、连按 5 次不会误触 | —— |

---

## 8. 学习能力详细设计

### 8.1 学习数据来源

| 来源 | 记录时机 | 标签完整度 |
|---|---|---|
| **A. 被动观察**（Supervisor 录制用户真实操作） | Agent 显式打开 observing 时 | 需要 Agent 配合在每个事件前后取 snapshot 做元素关联 |
| **B. 执行回放**（VirtualHID 自己每次注入后回写 trace） | 每次 action 完成 | 完整（因为 Agent 已传 context） |

B 是"自举"数据，一开始就有；A 需要用户在一段时间内真实操作。

### 8.2 元素关联算法（来源 A 的关键环节）

Supervisor 只能拿到"真实事件的坐标和时间"，它不认识"页面元素"。元素关联由 Agent 侧的 recorder 完成：

```
1. Agent 在 observe 开启前，启动一个后台循环：每 300-500ms 调一次 browser_snapshot（轻量模式，includeText=false）
2. 快照带时间戳存入 Agent 内存（滚动窗口 30s）
3. Agent 周期性调用 `hid_trace_tail({ n: 50 })` 轮询未关联的真实事件（VirtualHID 侧由 Supervisor 写入）
4. Agent 收到事件后，在窗口里找到时间戳 ≤ event_ts 的最近一个 snapshot → 在 clickables 里找 viewport 内距离事件坐标最近的元素（容忍 ±8px）→ 生成 (sig, role, text)
5. 关联结果通过 `hid_trace_commit({ eventId, elementSig, role, text, host, taskId?, stage? })` 补齐 trace 的业务标签
```

**为什么这套设计算合理**：
- browser-mcp 保持只读 / 无事件 hook（不破坏隐身）
- VirtualHID 不访问 DOM（保持职责单一）
- 所有业务关联都在 Agent 完成 —— 符合"Agent 贯穿业务"的原则

**代价**：observe 模式下 browser-mcp 会以 300-500ms 频率跑 snapshot，有一定 CPU 成本。作为观察期功能可以接受（不是常态）。

### 8.3 学习的粒度与冷启动

- 学习**不**按鼠标原始轨迹回放（那样一换分辨率就废）
- 学习**参数**：速度分布、dwell 分布、典型曲率半径、典型 overshoot 量、点击后等待时长等
- 冷启动：没学习前全部走 §3.2 的默认拟人策略
- 学习 ≥ 5 样本后模板生效；任意时刻 Agent 可 `profiles.forget` 清除

### 8.4 隐私与边界

- Profile Store 仅存**参数化分布**，**不**存任何文本内容（`payload` 里只存坐标时序 + 键码时序，不存打过的字）
- trace 明确排除：
  - 任何 `input[type=password]` 附近的键盘事件（按 element sig 里的 role 过滤）
  - 任何敏感站点（预置黑名单 + 用户可扩展：银行、邮箱、支付类）
- trace JSONL 默认 30 天滚动清理
- `profiles.forget({ host })` 一键清站点级数据，供用户撤销同意

---

## 9. 里程碑

| 里程碑 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| M0 | 本文档定稿 + 三方共识 | —— | 0.5 day |
| M1 | browser-mcp `signature` 字段 + snapshot 协议 bump | —— | 0.5 day |
| M2 | VirtualHID 拆出 Action Core + Humanization（默认策略，无学习） | M0 | 3 day |
| M3 | Supervisor（kill switch only，不含 observer） | M2 | 2 day |
| M4a | InjectorDaemon Unix socket backend + State Reporter | M2 | 2 day |
| M4b | MCP stdio shim (`mcp/server.mjs`, `hid_*` 工具) + Codex/Cursor 注册 | M4a | 1 day |
| M5 | Supervisor passive observer + Agent observe loop + trace 落库 | M3, M1 | 3 day |
| M6 | Profile Store 聚合器 + 执行时命中 | M5 | 3 day |
| M7 | Agent skill 蒸馏器（缓存 `(host, sig, taskId) → primitives`） | M4b | 2 day |
| M8 | 端到端集成测试 + 3 个目标站点（建议：知乎发帖、小红书评论、B 站三连）的观察→学习→执行全链路 | All | 3 day |

每个里程碑必须**可独立验收**，即使后续里程碑不做，前面的也能单独工作。

---

## 10. 验收骨架

本轮先不出完整 acceptance 文档，等 M4b 落地后单独写一份 `2026-xx-xx-virtualhid-acceptance_cn.md`。核心要点预告：

- **Kill switch**：在 injector 跑一个长 scenario 时，5×ESC 必须在 200ms 内停下，修饰键 release
- **State 一致性**：`state.busy` 必须严格反映当前是否有 in-flight action
- **投递模式**：
  - `postMode: "global"` + 非 frontmost → 必须返回 `E_NOT_FRONTMOST`，**不**投递任何事件
  - `postMode: "pid"` + `click` 原语 → 必须返回 `E_POST_MODE_UNSUPPORTED`
  - `postMode: "pid"` + `move` 原语 → 即使 Chrome 非前台也能成功投递（回归现状能力）
- **隐身回归**：加了 humanization 后，回到 `bot.sannysoft.com` + `creepjs` 依然全绿（仅验证执行 click / type 后无新检测指纹）
- **学习收敛性**：同一元素（host+sig）在 20 次真实操作后，生成的模板参数 1-sigma 区间应稳定（std 不再下降 > 5% per 10 samples）
- **业务隔离**：`profiles.forget({ host })` 后该站所有模板清空，不影响其他站
- **契约边界**：`rg -n "ActionContext\|VirtualHID\|profileStore" src/ mcp/` 在 browser-mcp 仓库必须 0 命中（Agent 和下游系统的概念不得泄漏到 browser-mcp）
- **MCP 工具自描述**：`tools/list` 返回 10 个 `hid_*` 工具，每个都有 JSON Schema input；Codex / Cursor 连上后在 UI 里能直接看到工具名和参数说明
- **MCP 错误语义**：触发 kill switch 后调 `hid_action`，响应必须是 `isError: true` + 文本以 `E_KILL_SWITCH:` 开头

---

## 11. 开放问题（需讨论后再实现）

1. **多显示器坐标系**：现有 VirtualHID 用 `target.frame.minX/Y + factor * width/height`。多显示器 + 不同 DPI 下需要特别处理。建议 M2 里一起做掉，但如果复杂先标 TODO。

2. **中文 / IME 输入**：`type(text)` 对多字节字符走剪贴板 + cmd+v，但剪贴板会污染用户当前内容。方案：①备份恢复剪贴板 ②提示 Agent"本次不保留剪贴板"。倾向 ①。

3. **Humanization strength 档位**：是否暴露 `hints.urgency` 到拟人化参数（quick 档减少 overshoot、normal 默认、deliberate 多做犹豫）。初版建议先实现 normal，其他档 M8 后再补。

4. **Profile 的迁移/导出**：用户换机器时想不想带走 profile？如果要，就得设计 export/import。初版不做。

5. **多 Agent 并发**：同时有两个 Agent 想下命令怎么办？初版 InjectorDaemon 单并发，后来者返回 `E_BUSY`。MCP shim 也做连接级互斥（单 stdio 连接内串行）。

6. **Observer 录到用户打私信/密码框周边数据**：`element.sig` 的 role 过滤足够吗？是否还需要全屏 OCR 级别的内容避让？初版只做 sig role 过滤，若后续用户反馈要加 OCR 黑名单再加。

---

## 12. 与 browser-mcp 现有成果的兼容性

本方案对 browser-mcp 的唯一硬需求是 §4 的 `signature` 字段。在字段落地前，Agent 可以 fallback：用 `sha1(host + role + text + clickable.document.top/left)` 作为伪 sig，功能等价但跨页面布局变更时稳定性差一点。因此 M1 可以与 M2 并行启动，不阻塞 VirtualHID 侧主干开发。

其他方面：
- browser-mcp 的 15 个只读工具**不**增不删
- browser-mcp 的 `all_frames: false` / 隐身红线**不**放宽
- VirtualHID 不会要求 browser-mcp 提供任何新工具

---

## 13. 修订记录

| 日期 | 修改人 | 内容 |
|---|---|---|
| 2026-04-23 | Cursor Agent | 初稿 |
| 2026-04-23 | Cursor Agent | rev-1：①明确 `ActionContext` 是 **Agent ↔ VirtualHID** 契约，browser-mcp 不参与、不感知；②新增 §3.7 投递模式，以 `CGEventPost`（global）为主力、`CGEventPostToPid` 为备选；③State / ControlServer 增加 `post` 字段与 `postMode` 参数；④Agent 前置检查里 `targetApp.frontmost === true` 升级为硬要求 |
| 2026-04-23 | Cursor Agent | rev-2：新增 §5.0 坐标换算职责声明 —— Agent 负责把页面坐标转屏幕坐标（CGPoint）；browser-mcp M1.5 已同步落地 `viewport.screenX/screenY/visualViewport` 作为该换算的输入；VirtualHID 仍然只收 `CGPoint`，不关心换算细节 |
| 2026-04-23 | Cursor Agent | rev-3：VirtualHID 对外协议统一为 **MCP stdio server**（两层拓扑：Node MCP shim + Swift Unix socket daemon），工具命名 `hid_*`（10 个）。§2.3 架构图重画；§3.5 重写为 MCP 工具表；§5.2/§5.3/§8.2 调用方式切换；§6.3 `contextVersion` 挪到 options；§9 M4 拆成 M4a（Swift daemon）+ M4b（Node MCP shim）；§10 新增 MCP 自描述 + 错误语义验收项 |
| 2026-04-23 | Cursor Agent | rev-4：配套文档路径调整 —— browser-mcp 只读化计划与 signature 实施文档归入 [`docs/completed/`](../completed/)；自动化验收标准归入 [`docs/specs/`](../specs/)；§ 开头「配套文档」两链已更新 |
