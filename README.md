# GPT Browser Agent（TypeScript 源码版）

一个类似 Claude for Chrome 的 AI 浏览器助手插件，使用 TypeScript + Vite 构建。支持 OpenAI API Key 和 ChatGPT 账号两种模式，在浏览器侧边栏中帮你操作网页、发消息、填表、下载文件，完全使用你本机浏览器的登录状态。

---

## 环境要求

- Node.js 18+
- npm 9+
- Chrome 114+（Side Panel API 最低版本）

---

## 构建安装

### 第一步：安装依赖

```bash
cd gpt-browser-agent
npm install
```

### 第二步：构建

```bash
# 生产构建
npm run build

# 开发模式（修改代码自动重新编译）
npm run dev
```

构建产物输出到 `dist/` 目录。

### 第三步：类型检查（可选）

```bash
npm run typecheck
```

### 第四步：加载到 Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启**开发者模式**
3. 点击**「加载已解压的扩展程序」**
4. 选择项目中的 **`dist/`** 文件夹
5. 插件出现即安装成功

> ⚠️ 注意：加载的是 `dist/` 而不是源码根目录。每次修改代码后需要重新 `npm run build`，然后在 `chrome://extensions` 点击插件的刷新按钮。

### 第五步：固定到工具栏

1. 点击 Chrome 右上角拼图图标 🧩
2. 找到 **GPT Browser Agent**，点击 📌 固定

---

## 项目结构

```
gpt-browser-agent/
├── package.json          # 依赖配置
├── tsconfig.json         # TypeScript 配置
├── vite.config.ts        # Vite 多入口构建配置
├── manifest.json         # Chrome 扩展配置（MV3）
├── icons/                # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── src/                  # TypeScript 源码
│   ├── types.ts          # 全局类型定义
│   ├── store.ts          # chrome.storage 封装
│   ├── rateLimit.ts      # 风控保护：随机延迟 + 频率限制
│   ├── openai.ts         # OpenAI API 客户端（双模式）
│   ├── background.ts     # Service Worker
│   ├── content.ts        # 页面注入脚本
│   ├── sidepanel.html    # 侧边栏 HTML
│   ├── sidepanel.ts      # 侧边栏主逻辑
│   ├── settings.html     # 设置页 HTML
│   └── settings.ts       # 设置页逻辑
└── dist/                 # 构建产物（Chrome 加载此目录）
```

---

## 初始配置

安装后点击工具栏插件图标，侧边栏打开后点击右上角 **⚙️ 设置**。

---

### 认证方式一：OpenAI API Key（推荐）

1. 访问 [platform.openai.com/api-keys](https://platform.openai.com/api-keys) 创建 API Key
2. 设置页选择 **「🔑 API Key」** 标签
3. 粘贴 API Key（格式：`sk-...`）
4. 选择模型：
   - `gpt-4o` — 推荐，支持截图视觉分析
   - `gpt-4o-mini` — 更快更省钱
   - `gpt-4-turbo` — 长文本能力强
   - `o1-preview` — 强推理，较慢
5. 点击 **「💾 保存设置」**

> API Key 仅存储在本地 `chrome.storage.local`，不会上传任何服务器。

---

### 认证方式二：ChatGPT 账号登录

1. 先在浏览器访问 [chatgpt.com](https://chatgpt.com) 完成登录
2. 设置页选择 **「💬 ChatGPT 账号」** 标签
3. 选择模型后保存

> ⚠️ 注意：必须保持 chatgpt.com 已登录，不支持无痕模式，稳定性不如 API Key。

---

## 功能使用

### 侧边栏对话

- 直接输入需求，Enter 发送，Shift+Enter 换行
- 点击 **📄** 读取当前页面内容
- 点击 **📸** 截图发给 AI 分析
- 顶部快捷 Prompt 芯片可一键填入预设指令

### 页面操作

AI 会在回复中输出操作 JSON，插件自动识别并执行：

```json
[
  {"action": "click", "ref": "@e1"},
  {"action": "fill", "ref": "@e2", "value": "内容"},
  {"action": "press", "key": "Enter"},
  {"action": "scroll", "direction": "down", "pixels": 400},
  {"action": "wait", "ms": 1000},
  {"action": "navigate", "url": "https://example.com"}
]
```

支持的动作：`click`、`fill`、`select`、`press`、`scroll`、`wait`、`navigate`、`hover`、`clear`

### Skills 系统

切换到 **「⚡ Skills」** 标签，可创建自定义 AI 行为模块。输入内容包含触发关键词时自动激活。

内置 Skills：
- **DOM 调试器** — 操作失败时分析修复
- **智能回复** — 帮你起草消息回复
- **表单助手** — 自动识别填写表单

### DOM 调试器

切换到 **「🔧 调试」** 标签，操作失败时使用：

| 按钮 | 功能 |
|------|------|
| 📸 元素快照 | 列出页面所有交互元素 |
| 🌲 完整 DOM | 获取页面完整 HTML |
| 🤖 AI 分析 | AI 分析页面结构和难点 |
| 🔧 AI 修复 | AI 生成修正后的操作指令 |

---

## 风控保护

设置页 **「🛡️ 风控保护」** 部分可调整参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 最小延迟 | 800ms | 每次操作前最短等待 |
| 最大延迟 | 2500ms | 每次操作前最长等待（随机取值） |
| 每分钟操作上限 | 12次 | 超过后自动暂停等待 |

内置保护（不可关闭）：随机鼠标落点、逐字符输入（25~100ms/字）、随机抖动 ±100ms。

对于严格风控平台建议设置：延迟 1500~4000ms，频率 6~8次/分。

---

## 开发说明

### 添加新动作类型

在 `src/types.ts` 的 `ActionType` 中添加新类型，然后在 `src/content.ts` 的 `executeAction` 函数中实现对应逻辑。

### 添加内置 Skill

在 `src/store.ts` 的 `DEFAULT_SETTINGS.skills` 数组中添加新的 Skill 对象。

### 修改 AI 系统提示词

在 `src/store.ts` 的 `DEFAULT_SETTINGS.systemPrompt` 中修改默认系统提示词，用户也可在设置页覆盖。

### 调试插件

- **Background**：`chrome://extensions` → 点击「Service Worker」链接
- **Sidepanel**：右键侧边栏 → 检查
- **Content Script**：打开目标页面的 DevTools → Console

---

## 常见问题

**Q：`npm install` 报网络错误？**
检查网络，或配置 npm 镜像：
```bash
npm config set registry https://registry.npmmirror.com
npm install
```

**Q：构建后 Chrome 加载报错？**
确认加载的是 `dist/` 目录而不是项目根目录。检查 `dist/manifest.json` 是否存在。

**Q：修改代码后插件没有更新？**
运行 `npm run build` 重新构建，然后在 `chrome://extensions` 点击插件的刷新🔄按钮，再刷新目标页面。

**Q：开发时用 `npm run dev` 方便吗？**
是的，`dev` 模式会监听文件变化自动重新编译，你只需要在 Chrome 刷新插件即可，不需要每次手动 build。

---

## 后续计划

- [ ] Codex CLI 集成（本地 WebSocket bridge）
- [ ] Skill 导入/导出（JSON 格式）
- [ ] 多标签页并行操作
- [ ] 操作录制与回放
- [ ] 更多内置 Skill 模板
