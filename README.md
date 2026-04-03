# Browser Agent

Chrome 浏览器 AI 助手插件。在侧边栏中通过自然语言驱动浏览器完成多步骤任务：读取页面、点击操作、填写表单、采集数据并下载到本地。

支持 OpenAI / Anthropic 及所有兼容 API，数据全部本地存储。

---

## 环境要求

- Node.js 18+
- Chrome 114+（Side Panel API 最低版本）

---

## 安装

```bash
npm install
npm run build
```

在 Chrome 中加载：`chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `dist/` 目录。

开发模式（自动重编译）：

```bash
npm run dev
```

---

## 初始配置

打开侧边栏 → 右上角 ⚙️ → 设置页：

| 字段 | 说明 |
|------|------|
| API Base URL | `https://api.openai.com/v1` / `https://api.anthropic.com/v1` / 任意兼容端点 |
| API Key | `sk-...` 或 `sk-ant-...`，仅本地存储 |
| API 格式 | OpenAI（大多数三方 API）或 Anthropic |
| 模型 | `gpt-4o-mini`、`claude-sonnet-4-6` 等 |

---

## 项目结构

```
src/
├── types.ts         # 全局类型（Settings, Workflow, MemoryEntry, LoopState…）
├── store.ts         # chrome.storage 封装 + 默认设置
├── rateLimit.ts     # 反检测：随机延迟、频率限制、鼠标模拟
├── openai.ts        # AI 客户端：chat() + chatWithTools()
├── tools.ts         # 19 个工具定义（JSON Schema）+ 执行路由
├── workflow.ts      # 工作流数据结构 + 步骤提示词构建 + 内置模板
├── tabManager.ts    # Chrome TabGroups 标签组管理
├── background.ts    # Service Worker：消息路由、截图、下载、标签组
├── content.ts       # 页面注入：DOM 快照 + 动作执行
├── sidepanel.html   # 侧边栏 UI（Apple 浅色风格）
├── sidepanel.ts     # 侧边栏主逻辑：Agent Loop、四层记忆、子代理
├── settings.html    # 设置页
└── settings.ts      # 设置页逻辑（工作流/Skills/Prompts 完整 CRUD）
```

---

## 核心机制

### Tool Calling Loop

Agent 使用 OpenAI/Anthropic 原生 function calling API，不解析 AI 回复中的 JSON：

1. AI 收到页面上下文 + 19 个工具定义
2. AI 决策调用哪些工具（如 `get_page_content` → `click_element`）
3. 扩展本地执行工具，结果压缩后发回 AI
4. AI 继续推理 → 下一轮工具调用，直到任务完成

### 19 个工具

**基础操作（11 个）**

`get_page_content` / `click_element` / `fill_input` / `navigate_to` / `scroll_page` / `press_key` / `wait_ms` / `take_screenshot` / `download_data` / `open_new_tab` / `ask_user`

`ask_user` 是用户介入机制——AI 主动暂停任务，向用户提问或确认，用户回答后自动继续。

**数据记录（3 个）**

`log_candidate` / `log_record` / `evolve_schema`

**分层记忆（3 个）**

`save_memory` / `list_memory` / `delete_memory`

**AI 自进化 + 子代理（2 个）**

`save_skill` / `run_sub_agent`

### 四层上下文/记忆系统

参考 Claude Code 设计，解决长工作流的 token 爆炸问题：

| 层级 | 存储位置 | 生命周期 | 典型内容 |
|------|----------|----------|----------|
| **Layer 0** 工作流定义 | workflow 对象 | 永久，用户编辑 | context、步骤指令、workspace schema |
| **Layer 1** 持久记忆 | chrome.storage | 跨会话，手动删除 | DOM 技巧、网站操作经验 |
| **Layer 2** 会话记忆 | 内存变量 | 本次任务期间 | 候选人决策进度、当前状态 |
| **Layer 3** 步骤上下文 | loopMessages[] | 当前步骤 | 压缩的工具调用历史 |

**上下文压缩策略**

- `get_page_content` 结果超过 2000 字符时：保留头部 800 字符（URL + 正文）+ 尾部 600 字符（元素列表），压缩中间正文
- 消息超过 40 条时滑动窗口裁剪最旧的 tool 交换对
- 步骤切换时携带上一步 AI 摘要注入下一步

### 子代理模式

`run_sub_agent` 工具可让主 Agent 为每个独立子任务（如每位候选人）启动一个隔离的子代理循环，子代理有独立的消息队列，完成后返回摘要，不污染主循环上下文。

### 工作流

「⚡ 工作流」标签预置两个模板：

- **BOSS直聘招聘**（6 步）：筛选候选人 → 发起沟通 → 索简历 → 匹配分析 → 预约面试
- **小红书内容采集**（4 步）：打开首页 → 采集列表 → 查看详情 → 导出 CSV

工作流管理：
- 完整 CRUD → 侧边栏「⚡ 工作流」→「⚙ 管理」→ 设置页
- 快速编辑全局背景 → 工作流卡片「✏ 背景」按钮，内联展开编辑

### Skill 系统

可复用的指令块，可手动创建或由 AI 执行中自动发现并提交审批（`save_skill` 工具）。批准后可按步骤引用，instructions 会注入对应步骤的 system prompt。

### 工作区

每个工作流有独立的数据 schema，AI 通过 `log_record` 写入，侧边栏「🗂 工作区」tab 展示记录并支持按状态过滤。底部「🗃 记忆管理」可查看和删除持久/会话记忆。

### 数据下载

`download_data` 将数据保存到 `~/Downloads/browser-agent-files/<任务名>/文件名`，支持 JSON / CSV / TXT。

### 标签组隔离

Agent 操作的标签页会被归入独立的 Chrome 标签组（蓝色），与用户其他标签页隔离。

---

## 反检测保护

| 参数 | 默认值 |
|------|--------|
| 操作延迟 | 800–2500ms 随机 |
| 每分钟操作上限 | 12 次 |
| 逐字符输入间隔 | 25–100ms |

鼠标点击前随机移动到元素内部随机位置，触发 `mouseover`/`mousemove` 事件。

---

## 开发参考

### 添加新工具

`src/tools.ts`：①向 `TOOL_DEFINITIONS` 添加 JSON Schema；②向 `ToolExecuteContext` 添加回调字段；③在 `executeTool()` switch 中增加 case；④实现执行函数；⑤在 `sidepanel.ts` 的 `ctx` 对象中注入回调。

### 添加内置工作流

`src/workflow.ts` 的 `createDefaultWorkflows()` 中添加新的 `Workflow` 对象。

### 调试

- **Background**：`chrome://extensions` → Service Worker 链接
- **Sidepanel**：右键侧边栏 → 检查
- **Content Script**：目标页面 DevTools → Console

---

## 常见问题

**Q: 修改代码后没有生效？**
运行 `npm run build` 重新构建，然后在 `chrome://extensions` 点击插件刷新按钮，再刷新目标页面。

**Q: 报错「请先在设置中填写 API Key」？**
打开设置页填写 API Base URL 和 API Key 后保存。

**Q: 操作被网站识别为机器人？**
在设置中调高延迟范围（建议严格风控平台设 1500–4000ms）并降低每分钟操作次数。

**Q: 工作流执行中 token 消耗过快？**
正常现象，四层记忆系统会自动压缩历史。如果单步骤工具调用很多，考虑把大步骤拆分为多个小步骤。
