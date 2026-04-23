# browser-mcp 仓库结构说明

这份文档只回答两个问题：

1. 现在每个目录/文件是干什么的
2. 哪些是 **MCP 核心**，哪些是 **非核心遗留**，可以删

---

## 先看结论

### MCP 核心，必须保留

这些是现在真正属于 `browser-mcp` 主架构的部分：

```text
manifest.json
package.json
vite.config.ts
tsconfig.json

src/background.ts
src/content.ts
src/types.ts
src/extension/

mcp/server.mjs
native-host/host.mjs
scripts/install-codex-mcp.mjs
scripts/install-native-host.mjs
scripts/setup-auto.mjs
scripts/complex-layout-fixture.mjs
scripts/verify-complex-layout.mjs

icons/
README.md
docs/project-prompt.md
docs/repo-structure.md
docs/specs/2026-04-24-browser-mcp-complex-layout-acceptance_cn.md
```

### 非核心遗留，已归档到 `src/deprecated/`

这些是旧“扩展内置 Agent / Workflow 产品”留下来的代码，不属于 MCP 核心：

```text
src/deprecated/openai.ts
src/deprecated/settings.html
src/deprecated/settings.ts
src/deprecated/sidepanel.html
src/deprecated/sidepanel.ts
src/deprecated/store.ts
src/deprecated/tabManager.ts
src/deprecated/tools.ts
src/deprecated/workflow.ts
```

它们现在的问题不是“有 bug”，而是：

- 设计目标已经变了
- 不再参与主架构
- 容易让人误以为项目还依赖侧边栏 Agent
- 现在统一归档到 `src/deprecated/`，不再参与主路径

---

## 目录说明

## 根目录

### `manifest.json`

Chrome 扩展声明文件。

作用：

- 定义扩展名称、权限、background、content script
- 当前已经切到更接近 MCP runtime 的用途

分类：

- `MCP 核心`

### `package.json`

Node 项目入口配置。

作用：

- 定义构建命令
- 定义 `setup:auto`、`mcp:start`、`native-host:start`、`native-host:install`

分类：

- `MCP 核心`

### `vite.config.ts`

扩展构建配置。

作用：

- 构建 `background.ts` 和 `content.ts`
- 当前已经去掉 sidepanel/settings 的主构建入口

分类：

- `MCP 核心`

### `tsconfig.json`

TypeScript 编译配置。

分类：

- `MCP 核心`

### `icons/`

扩展图标资源。

分类：

- `MCP 核心`

### `docs/project-prompt.md`

产品和架构需求文档。

作用：

- 记录隐蔽优先、Native Messaging、MCP tool 边界等设计目标

分类：

- `MCP 核心`

### `docs/repo-structure.md`

当前这份仓库结构说明文档。

分类：

- `MCP 核心`

---

## `src/` 目录

### `src/background.ts`

扩展 background 入口薄壳。

作用：

- 只负责注册真正的 background handlers

分类：

- `MCP 核心`

### `src/content.ts`

扩展 content script 入口薄壳。

作用：

- 只负责注册真正的 content handlers

分类：

- `MCP 核心`

### `src/types.ts`

共享类型定义。

作用：

- 扩展消息类型
- 页面快照、只读定位、`signature` / `hitTestState` / `clickPoint` 等共享类型
- 顶层返回的目标页上下文（`tabId` / `windowId` / `url` / `title`）

分类：

- `MCP 核心`

---

## `src/extension/` 目录

这里是现在最重要的目录。  
可以把它理解为：**浏览器执行引擎本体**。

### `src/extension/background/`

扩展后台执行层。

#### `contentBridge.ts`

作用：

- background 和 content script 的通信桥
- 自动定位目标 tab
- 必要时补注入 content script

分类：

- `MCP 核心`

#### `handlers.ts`

作用：

- background 主路由
- 把 `browser_*` 命令映射到 Chrome API 或 content script
- 补充 `tabId` / `windowId` / `url` / `title` 等目标页上下文
- 支持 `browser_reload_extension`

分类：

- `MCP 核心`

#### `nativeHost.ts`

作用：

- 连接 Chrome Native Messaging host
- 接收 host 发来的浏览器命令
- 把命令转成扩展内部执行

分类：

- `MCP 核心`

### `src/extension/content/`

页面内执行层。

#### `handlers.ts`

作用：

- content script 消息路由
- 把 background 请求映射到 snapshot/query/action/wait

分类：

- `MCP 核心`

#### `locators.ts`

作用：

- 按 `ref / selector / text / role / index` 定位元素

分类：

- `MCP 核心`

#### `snapshot.ts`

作用：

- 生成页面快照
- 递归穿透同源 iframe 和 open shadow DOM
- 生成只读 `clickables` 列表
- 计算稳定 `signature`
- 计算 `hitTestState`
- 为当前真实可命中区域生成随机 `clickPoint`

分类：

- `MCP 核心`

#### `state.ts`

作用：

- 管理 `@e1 / @e2` 这类 ref 到 DOM 元素的映射

分类：

- `MCP 核心`

#### `waits.ts`

作用：

- `wait_for_element`
- `wait_for_text`
- `wait_for_disappear`

分类：

- `MCP 核心`

### `src/extension/shared/`

共享协议层。

#### `protocol.ts`

作用：

- 定义 browser 命令名
- 定义 Native Messaging bridge 请求/响应
- 定义 snapshot/query/wait 的结构

分类：

- `MCP 核心`

---

## 本地进程目录

### `mcp/server.mjs`

本地 MCP server。

作用：

- 通过 stdio 提供 MCP 协议
- 注册 `browser_*` tools
- 把 tool 调用发到 native host

分类：

- `MCP 核心`

### `native-host/host.mjs`

Native Messaging host。

作用：

- 作为 Chrome 扩展和本地 MCP server 的桥
- 读取 Chrome 发来的 Native Messaging 请求
- 转发到本地 Unix socket

分类：

- `MCP 核心`

### `scripts/install-native-host.mjs`

安装脚本。

作用：

- 为 Chrome 生成 Native Messaging host manifest
- 注册 `com.vyodels.browser_mcp`

分类：

- `MCP 核心`

---

## 遗留文件说明

下面这些文件来自旧产品方向，不应该继续扩展。

### `src/deprecated/openai.ts`

旧 LLM 客户端。  
过去用于扩展内部直接调用 OpenAI / Anthropic。

现在为什么非核心：

- MCP 架构里，扩展不应该内置模型调用
- 模型编排应该在 Codex / MCP client 侧

结论：

- `建议删除`

### `src/deprecated/sidepanel.html` / `src/deprecated/sidepanel.ts`

旧侧边栏 UI 和 Agent loop 主流程。

现在为什么非核心：

- MCP runtime 不再依赖 side panel
- 这里是旧产品形态的中心，不是新架构的中心

结论：

- `建议删除`

### `src/deprecated/settings.html` / `src/deprecated/settings.ts`

旧设置页。

现在为什么非核心：

- 主要围绕 API Key、workflow、skills、prompts
- 这些都不属于 MCP runtime 主路径

结论：

- `建议删除`

### `src/deprecated/store.ts`

旧 chrome.storage 持久层。

现在为什么非核心：

- 服务的是旧 settings / workflow / memory / skills
- 不属于浏览器执行底座本身

结论：

- `建议删除`

### `src/deprecated/tools.ts`

旧扩展内 tool-calling 路由。

现在为什么非核心：

- 那是“扩展自己当 Agent”的工具层
- 现在工具层应该放在 `mcp/server.mjs` + `src/extension/*`

结论：

- `建议删除`

### `src/deprecated/workflow.ts`

旧工作流模板和步骤提示词。

结论：

- `建议删除`

### `src/deprecated/tabManager.ts`

旧 tab group 管理辅助。

现在为什么非核心：

- 相关能力已经应该并入 background `browser_*` 命令层
- 不需要再保留旧 sidepanel 导向接口

结论：

- `建议删除`

---

## 建议的最终精简结构

当前推荐结构是保留归档目录，主路径和遗留目录分离：

```text
docs/
  project-prompt.md
  repo-structure.md

icons/

mcp/
  server.mjs

native-host/
  host.mjs

scripts/
  install-native-host.mjs

src/
  background.ts
  content.ts
  deprecated/
  types.ts
  extension/
    background/
    content/
    shared/

manifest.json
package.json
package-lock.json
README.md
tsconfig.json
vite.config.ts
```

---

## 下一步清理建议

如果你后面确定这些归档代码永远不会再看，可以按这个顺序彻底删除：

1. 先删旧 UI
   - `src/deprecated/sidepanel.html`
   - `src/deprecated/sidepanel.ts`
   - `src/deprecated/settings.html`
   - `src/deprecated/settings.ts`

2. 再删旧 Agent 能力
   - `src/deprecated/openai.ts`
   - `src/deprecated/tools.ts`
   - `src/deprecated/workflow.ts`
   - `src/deprecated/store.ts`
   - `src/deprecated/tabManager.ts`

3. 最后再清 `src/types.ts`
   - 删掉只服务于 workflow / skill / memory / candidate 的类型
   - 保留浏览器协议与快照类型

这样删最稳，因为：

- 构建入口已经不依赖旧 UI
- 新的扩展执行层已经独立
- 最后再清类型，冲击最小
### `scripts/install-codex-mcp.mjs`

作用：

- 把 `browser-mcp` 注册进 `~/.codex/config.toml`
- 让 Codex 自动托管 `mcp/server.mjs`

分类：

- `MCP 核心`

### `scripts/install-native-host.mjs`

作用：

- 安装 Chrome Native Messaging manifest
- 从 Chrome 当前已加载的 `dist/` 记录里解析实际扩展 ID

分类：

- `MCP 核心`

### `scripts/setup-auto.mjs`

作用：

- 一次执行构建、Native Messaging 安装、Codex MCP 注册
- 输出安装摘要和校验结果

分类：

- `MCP 核心`

### `scripts/complex-layout-fixture.mjs`

作用：

- 启动招聘 IM 语义的复杂布局本地夹具
- 覆盖 iframe、nested iframe、shadow DOM、modal、上传/下载、局部遮挡、异形控件等场景

分类：

- `MCP 核心`

### `scripts/verify-complex-layout.mjs`

作用：

- 自动拉起复杂布局夹具并调用 MCP 验证
- 校验目标页上下文、坐标还原、`hitTestState` 和随机 `clickPoint`

分类：

- `MCP 核心`

### `docs/specs/2026-04-24-browser-mcp-complex-layout-acceptance_cn.md`

作用：

- 记录招聘 IM 复杂布局验收规范
- 定义 iframe / shadow / modal / 上传下载 / 随机点位的验收口径

分类：

- `MCP 核心`
