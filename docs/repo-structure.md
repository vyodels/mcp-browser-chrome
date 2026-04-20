# browser-mcp 仓库结构说明

这份文档只描述当前仍然属于 `browser-mcp` 主路径的代码。

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
  host-launcher

scripts/
  setup-auto.mjs
  install-native-host.mjs
  install-codex-mcp.mjs

icons/
docs/
README.md
```

## 入口文件

### `src/background.ts`

Chrome 扩展 background 入口，仅负责注册后台 handlers。

### `src/content.ts`

Chrome content script 入口，仅负责注册页面侧 handlers。

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
- `contentBridge.ts`
  - background 与 content/mock 页面之间的桥接层
- `nativeHost.ts`
  - 与 Native Messaging host 的连接桥

### `src/extension/content/`

- `handlers.ts`
  - content script 注册入口
- `dispatcher.ts`
  - 页面侧消息分发
- `actions.ts`
  - 点击、输入、滚动、截图等页面动作实现
- `snapshot.ts`
  - 页面快照构建
- `locators.ts`
  - 元素定位
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

## 其他核心文件

### `src/rateLimit.ts`

执行节奏控制与随机延迟，供页面动作层使用。

### `src/types.ts`

仅保留当前 browser-mcp 主路径仍在使用的共享类型。

### `mcp/server.mjs`

本地 MCP server，负责把 `browser_*` 能力暴露给 Codex。

### `native-host/host.mjs`

Chrome Native Messaging host。

## 已移除的历史遗留

旧的 sidepanel / workflow / settings / 内置 agent 相关代码已从 `src/deprecated/` 移除，不再保留在仓库中。
