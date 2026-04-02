# 项目交接文档 — GPT Browser Agent

> 最后更新：2026-04-02  
> 换电脑后用此文件恢复工作进度。

---

## 1. 项目是什么

一个 Chrome 扩展（Manifest V3），为 GPT 带来类似"Claude for Chrome"的 AI 侧边栏功能。核心使用场景：用户打开第三方网站（如招聘平台），侧边栏读取页面内容，应用预设 Skill，与候选人沟通，按标准筛选候选人，并将信息采集到本地导出。

核心设计原则：
- 运行在用户自己的浏览器中 → 共享真实登录 session，无需云端浏览器
- 所有数据仅本地存储（`chrome.storage.local`、IndexedDB）— 除 AI API 调用外不上传任何内容
- 反检测：随机延迟（800–2500ms）、逐字符输入、鼠标移动模拟
- 两种 AI 认证模式：OpenAI API Key（主要）或 ChatGPT session cookie（备用）

---

## 2. 环境配置

```bash
# Node 版本
nvm use v20.20.2   # 或：export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"

# npm 路径（根据实际情况调整）
# /Users/<你的用户名>/.nvm/versions/node/v20.20.2/bin/npm

cd gpt-browser-agent-ts
npm install
npm run build      # 输出到 dist/
npm run typecheck  # 仅做 TypeScript 类型检查
```

在 Chrome 中加载：`chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `dist/`

---

## 3. 当前 Git 状态

**主分支：** `main`  
**当前功能分支：** `feat/bug-fixes-auto-debug`  
**状态：** 功能分支已完成，构建通过，尚未合并到 main。

### 功能分支提交记录（从新到旧）
```
0a8f6b8  fix: remove dead else branch and guard runAutoDebug against exceptions
f69b07c  feat: one-click parse button per skill to read page and invoke skill
607ab66  feat: save-as-skill modal after successful auto-debug
91a24b6  fix: show correct message when auto-debug AI returns no fix
7f96426  feat: auto-debug loop — 3-round automatic retry with AI fix suggestions
17c34f4  fix: only reset lastError when all actions succeeded
9bbaa51  fix: escHtml covers >, reset lastError on success, require skill trigger
4f786d5  fix: propagate rate limit config from settings to content script
27cfb93  fix: implement screenshot action in content script via background
e12380d  fix: resolve ESM build errors and add SETTINGS_UPDATED listener in sidepanel
```

---

## 4. 本次会话完成的工作

### Bug 修复（全部完成）
| Bug | 修复方案 |
|-----|---------|
| 选项页保存后 sidepanel 不更新 | 在 `sidepanel.ts` 添加 `chrome.runtime.onMessage` 监听 `SETTINGS_UPDATED` |
| 速率限制设置（延迟/频率）从未应用到 content script | 新增 `CONFIGURE_RATE_LIMIT` 消息类型；sidepanel 初始化和设置变更时发送；background 转发到 content script |
| content.ts 的 `screenshot` 动作是空壳 | 现在向 background 发送 `TAKE_SCREENSHOT` 并返回 `screenshotDataUrl` |
| `escHtml()` 缺少 `>` 转义 | 在 `settings.ts` 中修复 |
| 动作失败时 `lastError` 仍被清除 | 用 `allSucceeded` 标志位保护 |
| Skill 可以用空触发词保存（永远不会被激活） | 在 `saveSkill()` 中添加校验和提示 |
| ESM 构建错误（`vite-plugin-static-copy` 是 ESM-only 包） | 在 `package.json` 中添加 `"type": "module"` |
| HTML script 标签引用的是编译产物 `.js` 而非源文件 `.ts` | 修复 `sidepanel.html` 和 `settings.html` |

### 新功能（全部完成）
| 功能 | 描述 |
|------|------|
| **自动调试循环** | 动作失败时，AI 自动获取 DOM 快照、生成修复方案、重试 — 最多 3 轮。3 轮后提示用户"是否继续？" |
| **保存为 Skill 弹窗** | 自动调试成功后（所有动作最终执行通过），弹出预填写好的 Skill 保存弹窗：名称（`hostname 操作修复 - 日期`）、触发词、成功的动作 JSON 作为指令。用户可修改后确认。 |
| **一键解析按钮** | 每个 Skill 卡片新增"解析当前页面"按钮，点击后自动读取页面、应用该 Skill 指令、流式输出 AI 响应，无需在对话框输入。 |

---

## 5. 架构参考

### 文件职责
| 文件 | 职责 |
|------|------|
| `src/background.ts` | Service Worker — 消息路由、ChatGPT session 代理、截图 |
| `src/content.ts` | 注入每个页面 — DOM 快照（`@e1`…`@eN`）、动作执行 |
| `src/sidepanel.ts` | 侧边栏 UI — 对话、Skills 管理、自动调试循环 |
| `src/sidepanel.html` | 侧边栏 HTML + 样式 |
| `src/settings.ts` | 选项页逻辑 |
| `src/settings.html` | 选项页 HTML |
| `src/openai.ts` | OpenAI API 客户端（API Key 模式 + ChatGPT session 模式）|
| `src/store.ts` | `chrome.storage.local` 封装 + 默认设置 |
| `src/rateLimit.ts` | 反检测：延迟、频率限制、鼠标模拟 |
| `src/types.ts` | 所有 TypeScript 接口和类型 |

### 消息流
```
侧边栏 ──→ background ──→ content script
           （路由）         （DOM / 动作）

关键消息类型：
  GET_PAGE_CONTENT       → 获取 DOM 快照
  EXECUTE_ACTION_IN_TAB  → 执行 click/fill/scroll 等动作
  DEBUG_DOM              → 获取含完整 HTML 的快照
  TAKE_SCREENSHOT        → 截取可见标签页
  CONFIGURE_RATE_LIMIT   → 同步延迟/频率设置到 content script
  SETTINGS_UPDATED       → 选项页通知侧边栏
```

### 快照 + 引用系统
`content.ts` 扫描所有可见交互元素，每次页面加载时分配 `@e1`、`@e2`... 引用。AI 在动作 JSON 中使用这些引用。引用是临时的 — 每次快照调用重新生成。

### Skills 系统
存储在 `chrome.storage.local` 的 `Settings.skills` 中。每个 Skill 包含：
- `trigger`：竖线分隔的关键词（`"面试|候选人"`）
- `instructions`：触发时注入到 AI 系统上下文
- 现在也可通过"解析当前页面"按钮直接激活

---

## 6. 下一个任务：数据采集系统

**这是下一个计划功能 — 尚未开始。**

### 需要构建的内容
为面试/招聘场景设计结构化数据采集和导出系统。

**已确认的用户决策：**
1. **字段定义**：默认由 AI 自动提取；如果 Skill 中定义了字段，则按 Skill 定义来
2. **存储方式**：IndexedDB（持久化，关闭侧边栏后数据不丢失）
3. **导出格式**：本地文件下载 — JSON 和 CSV 两种
4. **触发方式**：用户主动触发（不自动采集），可通过对话或 Skill 按钮触发

### 建议的计划结构
- `src/collector.ts` — 新模块：`CollectedRecord` 类型、IndexedDB 读写、JSON/CSV 导出
- `src/types.ts` — 添加 `CollectedRecord` 接口
- `src/sidepanel.html` — 新增"📊 数据"标签面板
- `src/sidepanel.ts` — 接入 collector，添加数据面板渲染 + 导出按钮

### CollectedRecord 数据结构（提案）
```typescript
interface CollectedRecord {
  id: string
  timestamp: number
  pageUrl: string
  pageTitle: string
  fields: Record<string, string>   // AI 提取或 Skill 定义的键值对
  rawText?: string                 // 采集时的完整页面文本
  skillUsed?: string               // 触发采集的 Skill 名称
}
```

**计划文件位置：** `docs/superpowers/plans/`（为数据采集创建新的计划文件）

---

## 7. 关键产品决策（上下文备忘）

| 决策 | 选择 |
|------|------|
| 页面解析触发方式 | **始终用户主动触发** — 不在标签页加载时自动解析 |
| 解析方式 | 通过 Skill 的"解析当前页面"按钮 或 在对话框直接输入 |
| 自动调试轮数 | **最多 3 轮**，超过后提示用户"是否继续自动调试？" |
| 调试成功后保存 | **弹窗预填名称**，用户可修改后确认 |
| 数据字段提取 | 默认 AI 推断；Skill 定义的字段优先 |
| 导出格式 | JSON + CSV 本地文件下载 |
| 认证方式 | 双模式：OpenAI API Key（推荐）/ ChatGPT session cookie |
| 数据存储 | 设置/Skills 用 `chrome.storage.local`；采集记录用 IndexedDB |

---

## 8. 如何在新电脑上恢复

```bash
# 1. 克隆 / 拉取代码库
git clone <repo-url>
cd gpt-browser-agent-ts

# 2. 配置 Node
nvm install v20.20.2
nvm use v20.20.2

# 3. 安装依赖
npm install

# 4. 切换到功能分支
git checkout feat/bug-fixes-auto-debug

# 5. 构建
npm run build

# 6. 加载到 Chrome
# chrome://extensions → 开启开发者模式 → 加载已解压的扩展程序 → 选择 dist/

# 7. 下一步
# 开始数据采集计划：
# 创建：docs/superpowers/plans/2026-04-02-data-collection.md
# 然后用 superpowers:subagent-driven-development skill 执行
```

---

## 9. 使用的工具和工作流

- **构建**：Vite 5.2 + TypeScript 5.4，多入口（background/content/sidepanel/settings）
- **使用的 Skills**：`superpowers:writing-plans` → `superpowers:subagent-driven-development` → 每个 Task 做规格合规审查 + 代码质量审查
- **审查流程**：每个 Task 先做规格合规审查（通过才进入质量审查），再做代码质量审查。有问题退回实现者修复后再标记完成。
- **提交规范**：每个 Task 一个提交，祈使句格式（`fix:` / `feat:` 前缀）
