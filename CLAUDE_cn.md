# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 常用命令

```bash
npm run dev        # 监听模式构建（用于开发）
npm run build      # 生产环境构建 → dist/
npm run typecheck  # 仅进行 TypeScript 类型检查，不输出文件
```

在 Chrome 中加载：进入 `chrome://extensions`，开启开发者模式，点击"加载已解压的扩展程序"，选择 `dist/` 文件夹。

## 架构

这是一个 Chrome 扩展（Manifest V3），实现了 AI 驱动的浏览器代理。**没有运行时 npm 依赖** —— 纯 TypeScript，通过 Vite 编译。

### 四个入口（Vite 多入口构建）

| 入口 | 职责 |
|------|------|
| `src/background.ts` | Service Worker —— 路由侧边栏与 content script 之间的所有消息，处理 ChatGPT session 代理，管理标签页截图 |
| `src/content.ts` | 注入每个页面 —— 进行 DOM 快照（为可交互元素分配 `@e1`、`@e2`... 引用），执行 AI 动作 |
| `src/sidepanel.ts` | 侧边栏 UI —— 对话界面、Skills 管理、调试面板 |
| `src/settings.ts` | 选项页面 —— 认证配置、模型选择、速率限制滑块、已保存的快捷提示词 |

### 消息总线

所有 IPC 通过 `chrome.runtime.sendMessage` 进行。消息始终按以下方向传递：`侧边栏 → Background → Content Script`（content script 无法直接与侧边栏通信）。

关键消息类型：`GET_PAGE_CONTENT`、`EXECUTE_ACTION`、`DEBUG_DOM`、`TAKE_SCREENSHOT`、`SETTINGS_UPDATED`。

### 双认证模式

- **API Key 模式**：使用用户的 Key 直接调用 `api.openai.com`
- **ChatGPT session 模式**：Background 静默打开 `chatgpt.com` 标签页，通过 `chrome.scripting.executeScript` 提取 `accessToken`，再用该 token 调用同一 API

### 快照 + 引用系统（`content.ts`）

当侧边栏请求页面内容时，`content.ts` 扫描所有可见的可交互元素（`a[href]`、`button`、`input`、`textarea`、`select`、`[role="button"]`），分配顺序引用 `@e1`、`@e2`...，并返回结构化快照。AI 在其动作 JSON 中使用这些引用。引用是临时的 —— 每次调用快照时重新生成。

### 动作执行流程

1. 解析 AI 响应中的 JSON 动作数组
2. 每个动作（`click`、`fill`、`scroll`、`navigate` 等）通过 background 发送给 `content.ts`
3. Content script 在反检测延迟下执行（随机 800–2500ms、逐字符输入、鼠标模拟）
4. 每个动作执行后返回新快照；失败时捕获含完整 HTML 的调试快照

### 存储结构

所有设置通过 `src/store.ts` 持久化到 `chrome.storage.local`。`src/types.ts` 中的 `Settings` 接口是规范模式 —— 包含 `authMode`、`apiKey`、`model`、`systemPrompt`、`actionDelay`、`maxActionsPerMinute`、`prompts[]`、`skills[]`。

### Skills 系统

Skills 是存储在 `Settings.skills` 中的用户自定义指令集。当用户输入包含 skill 的 `trigger` 关键词（竖线分隔）时，对应的 `instructions` 会注入到 AI 系统提示中。扩展内置三个默认 Skill：DOM 调试器、智能回复、表单助手。

## 关键设计约束

- 扩展要求 Chrome 114+（Side Panel API 最低版本）
- 仅支持暗色主题；主强调色为 `#10a37f`
- 所有数据仅本地存储（`chrome.storage.local`）—— 除配置的 AI API 端点外，不向任何服务器发送数据
- `src/rateLimit.ts` 中的速率限制系统是有意为之的反检测行为 —— 请勿删除或绕过
