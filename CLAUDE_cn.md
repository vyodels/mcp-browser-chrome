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
| `src/sidepanel.ts` | 侧边栏 UI：Agent Loop 控制、工作流执行、四层记忆系统、子代理 |
| `src/settings.ts` | 设置页逻辑：API 配置、工作流/Skills/Prompts 完整 CRUD |
| `src/tools.ts` | 19 个工具定义（JSON Schema）+ 本地执行路由 |
| `src/workflow.ts` | 工作流数据结构、步骤提示词构建（注入 context + 记忆 + skills）、内置模板 |
| `src/tabManager.ts` | Chrome TabGroups API 封装 |
| `src/openai.ts` | AI 客户端：`chat()`（流式）+ `chatWithTools()`（Tool Calling） |
| `src/types.ts` | 全局类型：Settings、Workflow、MemoryEntry、LoopState 等 |
| `src/store.ts` | `chrome.storage.local` 封装，DEFAULT_SETTINGS 含内置工作流 |
| `src/rateLimit.ts` | 反检测：随机延迟、频率限制、鼠标模拟 |

---

## Agent Loop（核心运行模式）

```
用户发起任务 → runAgentLoop():
  while 运行中:
    chatWithTools(loopMessages, TOOL_DEFINITIONS, settings)
      → AI 返回 tool_calls（如 get_page_content、click_element）
    executeTool(name, args, ctx) 逐个执行
      → 如果是 ask_user：暂停 loop，显示介入 UI，等用户输入
    把工具结果压缩后 push 回 loopMessages
    超过 40 条时滑动窗口裁剪最旧的 tool 交换对
    重复，直到 AI 不再返回 tool_calls → 当前步骤完成
  工作流模式：进入下一步，重置 loopMessages，注入记忆
```

Loop 状态：`idle → running → (paused | waiting_user) → running → completed / error`

---

## 19 个工具（src/tools.ts）

### 基础浏览器操作（11 个）

| 工具 | 用途 |
|------|------|
| `get_page_content` | 页面快照：URL、标题、可读文本、可交互元素列表 |
| `click_element` | 点击 @eN 引用的元素（模拟真实鼠标） |
| `fill_input` | 逐字符填写输入框（反检测） |
| `navigate_to` | 在目标标签页打开 URL |
| `scroll_page` | 上/下滚动页面 |
| `press_key` | 键盘事件（Enter、Tab、Escape 等） |
| `wait_ms` | 等待指定毫秒（页面加载/动画） |
| `take_screenshot` | 截图当前可见区域 |
| `download_data` | 保存 JSON/CSV/TXT 到本地 |
| `open_new_tab` | 在 Agent 标签组内打开新标签页 |
| `ask_user` | **暂停 loop**，向用户提问或请求确认 |

### 数据记录（3 个）

| 工具 | 用途 |
|------|------|
| `log_candidate` | 写入/更新候选人记录（招聘工作流专用） |
| `log_record` | 按工作流自定义 schema 写入工作区记录 |
| `evolve_schema` | 提议向工作流 schema 添加新字段 |

### 记忆系统（3 个）

| 工具 | 用途 |
|------|------|
| `save_memory` | 写入会话记忆（session）或持久记忆（persistent） |
| `list_memory` | 查看当前所有记忆条目（两个层级） |
| `delete_memory` | 删除指定记忆条目 |

### AI 自进化 + 子代理（2 个）

| 工具 | 用途 |
|------|------|
| `save_skill` | 把发现的有效解法固化为 Skill（用户审批后激活） |
| `run_sub_agent` | 启动子代理处理独立子任务（如单个候选人完整沟通） |

---

## 四层上下文/记忆系统

参考 Claude Code 设计，防止长工作流中 token 爆炸。

```
Layer 0: 工作流定义层（静态，用户定义）
  来源：workflow.context + workspace schema + step instructions
  特点：AI 不可修改，每步必然注入
  编辑：侧边栏工作流卡片点「✏ 背景」内联编辑，或去设置页

Layer 1: 持久记忆层（跨会话，chrome.storage）
  来源：settings.memoryEntries[]，按 workflowId 隔离
  生命周期：关闭浏览器不丢失，用户手动删除
  典型内容：已知的 DOM 选择器、网站弹窗处理方式、反检测经验
  写入：save_memory(key, value, "persistent")
  步骤切换时自动重新加载（AI 写入当步即生效）

Layer 2: 会话记忆层（本次任务，内存）
  来源：sessionMemory{} 变量
  生命周期：工作流启动到停止，自动清空
  典型内容：候选人决策进度、当前执行状态
  写入：save_memory(key, value)（默认 session 层）

Layer 3: 步骤上下文层（当前步骤，最短命）
  来源：loopMessages[] 压缩历史
  管理：
    - get_page_content / take_screenshot 结果 > 2000 字符时压缩：
      保留头部 800 字符（URL + 正文开头）+ 尾部 600 字符（元素列表）
    - 超过 40 条消息时滑动窗口裁剪最旧 tool 交换对
  携带：上一步 AI 最终摘要（previousStepSummary）注入下一步
```

### 每步 system prompt 注入顺序

```
步骤指令 → workflow.context → workspace schema →
📚 持久记忆（Layer 1）→ 🧠 会话记忆（Layer 2）→
上一步完成摘要（Layer 3）→ 完成判定条件
```

---

## 子代理模式（Sub-Agent）

主要用途：一个工作流需处理多个独立对象时（如批量处理候选人）。

```
主编排 Agent（runAgentLoop）
  ↓ 调用 run_sub_agent("与张三完整沟通", context)
    子代理（runSubAgentLoop）
      - 独立 subMessages[]，不污染主循环上下文
      - 继承所有工具 + 会话记忆
      - 自己维护压缩窗口（> 40 条裁剪）
      - 完成后返回文字摘要
  ↓ 继续处理下一个候选人
```

---

## 工作流系统

### 数据结构

```typescript
Workflow {
  id, name, description
  context?       // 全局背景要求（候选人标准等），注入每步
  startUrl?      // 工作流启动时自动打开的 URL
  workspace?     // WorkspaceSchema（自定义字段定义）
  steps[]        // WorkflowStep[]
}

WorkflowStep {
  id, name
  instructions   // 给 AI 的详细指令
  intervention   // none | optional | required
  completionHint // AI 判断此步完成的依据
  skillIds?      // 引用 Skill 的 ID，instructions 会注入本步
}
```

### 内置模板

- **BOSS直聘招聘**（6 步）：筛选候选人 → 发起沟通 → 索简历 → 下载 → 匹配分析 → 预约面试
- **小红书内容采集**（4 步）：打开首页 → 采集列表 → 查看详情 → 导出 CSV

### 工作流管理入口

- **设置页**（完整 CRUD）：侧边栏「⚡ 工作流」→ 右上角「⚙ 管理」→ 打开设置页
- **内联快速编辑**：工作流卡片「✏ 背景」按钮，展开 textarea 直接编辑 context 字段并保存

---

## Skill 系统

Skills 是可复用的指令块，存储在 `Settings.skills`。

| 来源 | 说明 |
|------|------|
| `builtin` | 扩展内置（DOM 调试器、表单助手） |
| `user` | 用户在设置页手动创建 |
| `ai_generated` | AI 执行中通过 `save_skill` 自动生成，状态 `pending_review` |

AI 生成的 Skill 触发侧边栏聊天区的审批横幅，用户点「✓ 批准」后状态改为 `active`。

---

## 工作区（Workspace）

每个工作流有独立的 workspace schema（字段定义），AI 通过 `log_record` 写入，数据存在 `settings.workspaceRecords[]`。

- 侧边栏「🗂 工作区」tab 展示当前工作流的所有记录
- 支持按 status 字段过滤
- 底部「🗃 记忆管理」展示持久记忆 + 会话记忆，支持删除

---

## Tool Calling API 格式

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

## 消息总线

所有 IPC：`侧边栏 → Background → Content Script`，通过 `chrome.runtime.sendMessage`。

| 消息 | 说明 |
|------|------|
| `GET_PAGE_CONTENT` | 获取页面快照 |
| `EXECUTE_ACTION_IN_TAB` | 执行单个动作（click/fill 等） |
| `TAKE_SCREENSHOT` | 截图 |
| `OPEN_TAB` | 在标签组内开新 tab |
| `OPEN_TAB_AND_WAIT` | 开新 tab 并等待加载完成 |
| `NAVIGATE_TAB` | 导航现有 tab |
| `CREATE_TAB_GROUP` | 创建命名标签组 |
| `CLOSE_TAB_GROUP` | 关闭整个标签组 |
| `DOWNLOAD_DATA` | 通过 chrome.downloads 保存文件 |
| `GET_ALL_TABS` | 获取当前窗口所有标签页 |
| `SETTINGS_UPDATED` | 设置页保存后通知侧边栏刷新 |
| `CONFIGURE_RATE_LIMIT` | 同步速率限制参数到 content script |

---

## 存储结构

```typescript
Settings {
  baseUrl, apiKey, apiFormat, model, systemPrompt
  actionDelay: [number, number]   // 随机延迟范围（ms）
  maxActionsPerMinute: number
  prompts: SavedPrompt[]
  skills: Skill[]
  workflows: Workflow[]           // 含每个工作流的 workspace schema
  activityLog: ActivityEntry[]    // 下载/导航记录（最多 200 条）
  candidates: CandidateEntry[]    // 招聘工作流候选人记录
  workspaceRecords: WorkspaceRecord[]  // log_record 写入的通用记录
  memoryEntries: MemoryEntry[]    // Layer 1 持久记忆
}
```

---

## 快照 + 引用系统

每次调用 `get_page_content` 时，`content.ts` 扫描页面所有可见可交互元素，分配临时引用 `@e1`、`@e2`...。**引用每次重新生成，不跨快照保留**。AI 在工具参数中用 `@eN` 指定目标元素。

---

## 关键设计约束

- Chrome 114+（Side Panel API 最低版本）
- **Apple 浅色主题**：`#f5f5f7` 背景、`#007aff` 蓝色、`rgba(255,255,255,0.85)` 卡片、`backdrop-filter: blur`
- 数据全本地：除配置的 AI API 外不发送任何网络请求
- `src/rateLimit.ts` 反检测逻辑不可删除或绕过
- HTML 中不允许内联事件处理器（CSP）：所有监听器通过 TS 文件 `addEventListener` 注册
- 不支持 ChatGPT session 模式：仅 OpenAI 兼容格式和 Anthropic API Key
- 必要权限：`activeTab, tabs, scripting, storage, sidePanel, desktopCapture, tabGroups, downloads`

---

## 开发参考

### 添加新工具

`src/tools.ts`：
1. 向 `TOOL_DEFINITIONS` 数组添加 JSON Schema 定义
2. 向 `ToolExecuteContext` 接口添加需要的回调（如 `someCallback?`）
3. 在 `executeTool()` switch 中增加 case
4. 实现具体执行函数
5. 在 `sidepanel.ts` 的 `ctx` 对象中注入回调实现

### 添加内置工作流

`src/workflow.ts` 的 `createDefaultWorkflows()` 中添加新的 `Workflow` 对象。

### 调试

- **Background**：`chrome://extensions` → Service Worker 链接
- **Sidepanel**：右键侧边栏 → 检查
- **Content Script**：目标页面 DevTools → Console
