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
| 模型 | `gpt-4o-mini`、`claude-3-5-sonnet-20241022` 等 |

---

## 项目结构

```
src/
├── types.ts         # 全局类型（Settings, Workflow, LoopState…）
├── store.ts         # chrome.storage 封装 + 默认设置
├── rateLimit.ts     # 反检测：随机延迟、频率限制、鼠标模拟
├── openai.ts        # AI 客户端：chat() + chatWithTools()
├── tools.ts         # 11 个工具定义（JSON Schema）+ 执行路由
├── workflow.ts      # 工作流数据结构 + 内置模板
├── tabManager.ts    # Chrome TabGroups 标签组管理
├── background.ts    # Service Worker：消息路由、截图、下载、标签组
├── content.ts       # 页面注入：DOM 快照 + 动作执行
├── sidepanel.html   # 侧边栏 UI（Apple 浅色风格）
├── sidepanel.ts     # 侧边栏主逻辑：Agent Loop 控制
├── settings.html    # 设置页
└── settings.ts      # 设置页逻辑
```

---

## 核心机制

### Tool Calling Loop

Agent 不解析 AI 回复中的 JSON，而是使用 OpenAI/Anthropic 原生 function calling API：

1. AI 收到页面上下文 + 11 个工具定义
2. AI 决策调用哪些工具（如 `get_page_content` → `click_element`）
3. 扩展本地执行工具，结果发回 AI
4. AI 继续推理 → 下一轮工具调用，直到任务完成

### 11 个工具

`get_page_content` / `click_element` / `fill_input` / `navigate_to` / `scroll_page` / `press_key` / `wait_ms` / `take_screenshot` / `download_data` / `open_new_tab` / `ask_user`

`ask_user` 是用户介入机制——AI 主动暂停任务，向用户提问或请求确认，用户回答后自动继续。

### Loop 控制

侧边栏底部控制栏：**▶ 开始 / ⏸ 暂停 / ▶ 继续 / ⏹ 停止**

Loop 状态：`idle → running → paused/waiting_user → completed/error`

### 工作流

「⚡ 工作流」标签预置两个模板，可直接执行：

- **BOSS直聘招聘**：打开直聘 → 筛选候选人 → 发起沟通 → 索简历 → 匹配分析 → 预约面试（6 步，关键步骤需用户确认）
- **小红书内容采集**：打开小红书 → 采集首页帖子 → 查看详情 → 导出 CSV（4 步，全自动）

### 数据下载

`download_data` 工具将数据保存到 `~/Downloads/browser-agent-files/<任务名>/文件名`，支持 JSON / CSV / TXT。

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

在 `src/tools.ts` 中：1) 向 `TOOL_DEFINITIONS` 添加 JSON Schema 定义；2) 在 `executeTool()` switch 中增加 case；3) 实现具体执行函数。

### 添加内置工作流

在 `src/workflow.ts` 的 `createDefaultWorkflows()` 中添加新的 `Workflow` 对象。

### 调试

- **Background**: `chrome://extensions` → Service Worker 链接
- **Sidepanel**: 右键侧边栏 → 检查
- **Content Script**: 目标页面 DevTools → Console

---

## 常见问题

**Q: 修改代码后没有生效？**  
运行 `npm run build` 重新构建，然后在 `chrome://extensions` 点击插件刷新按钮，再刷新目标页面。

**Q: 报错 "请先在设置中填写 API Key"？**  
打开设置页填写 API Base URL 和 API Key 后保存。

**Q: 操作被网站识别为机器人？**  
在设置中调高延迟范围（建议严格风控平台设 1500–4000ms）并降低每分钟操作次数。
