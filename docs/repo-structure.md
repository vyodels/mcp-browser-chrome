# browser-mcp 仓库结构说明

这份文档只描述当前仍然属于 `browser-mcp` 主路径的代码。

仓库内所有实现默认服从 stealth / anti-bot / anti-crawler 约束；这类约束的优先级高于调试便利性和默认观测能力。
此外，真实站点默认禁止启用 Chrome debugger / CDP 调试通道；公开方法如果收紧高风险实现，必须保留安全降级路径。

## 核心目录

```text
manifest.json
package.json
tsconfig.json
vite.config.ts

src/
  background.ts
  content.ts
  popup.html
  popup.ts
  mock-boss.html
  mock-boss.ts
  rateLimit.ts
  types.ts
  extension/
  mock/

mcp/
  server.mjs

native-host/
  host.mjs
  host-launcher.template

scripts/
  setup-auto.mjs
  install-native-host.mjs
  install-codex-mcp.mjs

icons/
docs/
  field-notes/
README.md
```

## 入口文件

### `src/background.ts`

Chrome 扩展 background 入口，仅负责注册后台 handlers。

### `src/content.ts`

Chrome content script 入口，仅负责调用带一次性守卫的页面侧 handlers 注册逻辑。

### `src/popup.html` / `src/popup.ts`

扩展弹窗入口。当前用于切换 BOSS 页面级 mock 模式与场景阶段。

### `src/mock-boss.html` / `src/mock-boss.ts`

页面级 BOSS mock 入口。用于离线测试 `推荐牛人 / 打招呼 / 沟通 / 在线简历` 等页面链路。

## `src/extension/`

浏览器执行引擎主体。

### `src/extension/background/`

- `handlers.ts`
  - 后台命令分发与 Chrome API 调度
  - 当前已收紧页面操作策略：显式传 `tabId` 才执行页面操作
- `observability.ts`
  - 仅保留 download 观测与等待逻辑
- `contentBridge.ts`
  - background 与 content/mock 页面之间的桥接层
- `nativeHost.ts`
  - 与 Native Messaging host 的连接桥

### `src/extension/content/`

- `handlers.ts`
  - content script 注册入口
  - 内置一次性注册 guard，避免重复发送 ready 信号和重复挂载消息监听
- `dispatcher.ts`
  - 页面侧消息分发
- `actions.ts`
  - 点击、输入、滚动、截图等页面动作实现
- `snapshot.ts`
  - DOM / a11y / frame 快照构建
- `locators.ts`
  - 元素定位
- `dom.ts`
  - shadow DOM / 同源 iframe 遍历与 frame 列表
- `consoleMonitor.ts`
  - 页面 console 采集
  - 仅在显式诊断请求时按需开启被动错误监听，不 monkey-patch 页面 `console`
- `networkMonitor.ts`
  - 基于 `PerformanceResourceTiming` 的被动资源观测
  - 不依赖 debug 协议，不抓取 header/body/status
- `waits.ts`
  - 等待类逻辑
- `mockBridge.ts`
  - mock 页面桥接器

### `src/extension/shared/protocol.ts`

browser-mcp 内部共享协议定义。

## `src/mock/`

当前只包含 zhipin mock 数据与样式：

- `src/mock/zhipin/types.ts`
- `src/mock/zhipin/dataPack.ts`
- `src/mock/zhipin/mock-boss.css`

页面级 mock 数据模型整理见：

- [docs/boss-page-mock-data-model.md](/Users/didi/AgentProjects/mcp-browser-chrome/docs/boss-page-mock-data-model.md:1)

## 其他核心文件

### `src/rateLimit.ts`

执行节奏控制与随机延迟，供页面动作层使用。

### `src/types.ts`

仅保留当前 browser-mcp 主路径仍在使用的共享类型。

### `mcp/server.mjs`

本地 MCP server，负责把 `browser_*` 能力暴露给 Codex。

### `native-host/host.mjs`

Chrome Native Messaging host。

### `native-host/host-launcher.template`

Native Messaging launcher 模板。安装脚本会基于当前机器上的 Node 路径和仓库绝对路径生成本地 `native-host/host-launcher`，生成文件不纳入版本控制。

## 已移除的历史遗留

旧的 sidepanel / workflow / settings / 内置 agent 相关代码已从 `src/deprecated/` 移除，不再保留在仓库中。

## `docs/`

文档目录当前分为三类：

- 设计与约束
  - `docs/project-prompt.md`
  - `docs/repo-structure.md`
- mock 数据模型
  - `docs/boss-page-mock-data-model.md`
  - `docs/mock-data-structure-guide.md`
- 现场记录与经验沉淀
  - `docs/field-notes/README.md`
  - `docs/field-notes/2026-04-zhipin-validation-retrospective.md`
