# CLAUDE_cn.md（仅供人工阅读，非 AI 上下文）

## 常用命令

```bash
npm run dev        # 监听模式构建（开发用）
npm run build      # 生产构建 → dist/
npm run typecheck  # TypeScript 类型检查（不输出文件）
```

加载到 Chrome：打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `dist/` 目录。

---

## 架构

Chrome 扩展（Manifest V3），AI 驱动的浏览器自动化助手。**无运行时 npm 依赖**，纯 TypeScript，Vite 编译。

### 源文件一览

| 文件 | 职责 |
|------|------|
| `src/background.ts` | Service Worker：消息路由、标签组管理、截图、文件下载 |
| `src/content.ts` | 注入每个页面：DOM 快照（@e1/@e2 引用）+ 执行动作 |
| `src/sidepanel.ts` | 侧边栏 UI：Agent Loop 控制、工作流执行、用户介入 UI |
| `src/settings.ts` | 设置页逻辑 |
| `src/tools.ts` | 11 个工具定义（JSON Schema）+ 本地执行路由 |
| `src/workflow.ts` | 工作流数据结构、步骤提示词构建、内置模板 |
| `src/tabManager.ts` | Chrome TabGroups API 封装 |
| `src/openai.ts` | AI 客户端：`chat()`（流式）+ `chatWithTools()`（Tool Calling） |
| `src/types.ts` | 全局类型：Settings、Workflow、LoopState、ToolCallRequest 等 |
| `src/store.ts` | `chrome.storage.local` 封装，DEFAULT_SETTINGS 含内置工作流 |
| `src/rateLimit.ts` | 反检测：随机延迟、频率限制、鼠标模拟 |

---

### Agent Loop（核心运行模式）

v2 起不再解析 AI 回复中的 JSON，改用标准 **Tool Calling Loop**：

```
用户发起任务 → runAgentLoop():
  while 运行中:
    chatWithTools(messages, TOOL_DEFINITIONS, settings)
      → AI 返回 tool_calls（如 get_page_content、click_element）
    executeTool(name, args, ctx) 逐个执行
      → 如果是 ask_user：暂停 loop，显示介入 UI，等用户输入
    把工具结果 push 回 messages
    重复，直到 AI 不再返回 tool_calls → 任务完成
```

Loop 状态：`idle → running → (paused | waiting_user) → running → completed / error`

---

### 11 个工具（src/tools.ts）

| 工具名 | 用途 |
|--------|------|
| `get_page_content` | 获取页面快照：URL、文本、可交互元素列表 |
| `click_element` | 点击 @eN 引用的元素（模拟鼠标） |
| `fill_input` | 逐字符填写输入框 |
| `navigate_to` | 在目标标签页打开 URL |
| `scroll_page` | 上/下滚动页面 |
| `press_key` | 键盘事件（Enter、Tab、Escape 等） |
| `wait_ms` | 等待指定毫秒（页面加载/动画） |
| `take_screenshot` | 截图当前可见区域 |
| `download_data` | 保存数据到 `~/Downloads/browser-agent-files/<任务名>/` |
| `open_new_tab` | 在 Agent 标签组内打开新标签页 |
| `ask_user` | **暂停 loop**，向用户提问或请求确认 |

---

### Tool Calling API 格式

**OpenAI 格式：**
- 请求：附带 `tools: [...]` 数组
- 响应：解析 `choices[0].message.tool_calls`
- 工具结果：`{ role: "tool", tool_call_id, content }`

**Anthropic 格式：**
- 请求：附带 `tools: [...]` 数组
- 响应：解析 `content[].type === "tool_use"`
- 工具结果：`{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }`

两种格式均在 `openai.ts` 的 `chatWithTools()` 中处理。

---

### 消息总线

所有 IPC 路径：`侧边栏 → Background → Content Script`，通过 `chrome.runtime.sendMessage`。

主要消息类型：

| 消息 | 说明 |
|------|------|
| `GET_PAGE_CONTENT` | 获取页面快照 |
| `EXECUTE_ACTION_IN_TAB` | 执行单个动作（click/fill 等） |
| `TAKE_SCREENSHOT` | 截图 |
| `OPEN_TAB` | 在标签组内开新 tab |
| `CREATE_TAB_GROUP` | 创建命名标签组 |
| `CLOSE_TAB_GROUP` | 关闭整个标签组 |
| `DOWNLOAD_DATA` | 通过 chrome.downloads 保存文件 |
| `GET_ALL_TABS` | 获取当前窗口所有标签页 |
| `SETTINGS_UPDATED` | 设置页保存后通知侧边栏刷新 |
| `CONFIGURE_RATE_LIMIT` | 同步速率限制参数到 content script |

---

### 工作流系统

工作流（`Workflow`）= 有序的步骤数组（`WorkflowStep[]`），存储在 `Settings.workflows`（chrome.storage.local）。

每个步骤包含：
- `instructions`：作为该步骤的 system message 注入给 AI
- `intervention`：`none | optional | required`，控制步骤完成后是否暂停等用户确认
- `completionHint`：AI 判断此步完成的依据

内置两个模板（`store.ts` 中初始化）：
- **BOSS直聘招聘**（6 步）：筛选候选人 → 发起沟通 → 索简历 → 下载 → 匹配分析 → 预约面试
- **小红书内容采集**（4 步）：打开首页 → 采集列表 → 查看详情 → 导出 CSV

---

### 数据存储

| 数据 | 存储方式 |
|------|----------|
| 所有设置（含工作流、Skills） | `chrome.storage.local` via `src/store.ts` |
| 下载文件 | `chrome.downloads` API → `~/Downloads/browser-agent-files/` |

---

### 快照 + 引用系统

每次调用 `get_page_content` 时，`content.ts` 扫描页面所有可见可交互元素，分配临时引用 `@e1`、`@e2`...。**引用每次重新生成，不跨快照保留**。AI 在工具参数中用 `@eN` 指定目标元素。

---

## 关键设计约束

- Chrome 114+ 必须（Side Panel API）
- **Apple 浅色主题**：`#f5f5f7` 背景，`#007aff` 蓝色，`rgba(255,255,255,0.85)` 卡片，`backdrop-filter: blur`
- 数据全本地：除配置的 AI API 外不发送任何网络请求
- `src/rateLimit.ts` 反检测逻辑不可删除或绕过
- 无 ChatGPT session 模式：仅支持 OpenAI 兼容格式和 Anthropic API Key
- 必要权限：`activeTab, tabs, scripting, storage, sidePanel, desktopCapture, tabGroups, downloads`
