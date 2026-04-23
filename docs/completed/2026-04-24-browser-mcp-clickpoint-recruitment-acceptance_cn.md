# browser-mcp 侧实施文档 · 随机 `clickPoint` + 招聘 IM 复杂布局验收

> **状态**：已完成（2026-04-24）
> **归档位置**：`docs/completed/`
> **作用范围**：仅本仓库

---

## 1. 本轮完成项

本轮在只读 runtime 的基础上，继续补了四件事：

1. `browser_snapshot.clickables[*]` 从“返回可落点区域数组”收口为“返回单个随机 `clickPoint`”
2. `clickPoint` 保证落在真实生效区域内，不再固定中心点
3. `browser_snapshot`、`browser_query_elements`、wait 类结果补充目标页上下文：`tabId / windowId / url / title`
4. 增加招聘 IM 语义的复杂布局 fixture 和自动验收脚本，覆盖：
   - fixed toolbar
   - 普通流式区域
   - 同源 iframe / nested iframe
   - open shadow DOM
   - 顶层 modal / backdrop
   - 聊天输入框
   - 上传附件简历
   - 查看在线简历
   - 查看离线简历
   - 下载离线简历
   - 下载候选人附件
   - 交换联系方式（局部遮挡）
   - 异形三角按钮

---

## 2. 代码改动

### 2.1 snapshot 结构

涉及文件：

- `src/types.ts`
- `src/extension/content/snapshot.ts`

关键变化：

- `ClickableElement` 新增 `clickPoint?: { viewport: {x,y}, document: {x,y} }`
- 保留 `signature` 和 `hitTestState`
- 上传 / 下载相关元素补充 `accept` / `multiple` / `download`

`clickPoint` 的生成逻辑：

1. 先对元素可见区域做命中采样
2. 只保留采样命中成功的安全小格
3. 在这些安全小格内随机取点
4. 最终再用一次 `elementFromPoint` 复核，确保随机点仍落在该元素本体

这使得异形控件和局部遮挡控件都不会退化成“矩形中心点”。

### 2.2 MCP 顶层上下文

涉及文件：

- `src/extension/background/handlers.ts`

关键变化：

- `browser_snapshot`
- `browser_query_elements`
- `browser_get_element`
- `browser_wait_for_element`
- `browser_wait_for_text`
- `browser_wait_for_disappear`
- `browser_screenshot`

这些返回值现在都会补充目标页上下文，至少包含：

- `tabId`
- `target.tabId`
- `target.windowId`
- `target.url`
- `target.title`

### 2.3 扩展自重载

涉及文件：

- `src/extension/shared/protocol.ts`
- `src/extension/background/handlers.ts`
- `mcp/server.mjs`

新增工具：

- `browser_reload_extension`

用途：

- 让新 `dist/` 生效时，可以由 MCP 直接触发扩展 reload，而不再依赖人工去 `chrome://extensions`

### 2.4 招聘 IM 验收夹具

涉及文件：

- `scripts/complex-layout-fixture.mjs`
- `scripts/verify-complex-layout.mjs`
- `docs/specs/2026-04-24-browser-mcp-complex-layout-acceptance_cn.md`

关键变化：

- fixture 改为招聘站工作台语义
- 验收从区域数组改成 `clickPoint` 校验
- 自动校验随机性、遮挡、异形命中、iframe/shadow 坐标和目标页上下文

---

## 3. 验证结果

本轮已通过：

```bash
npm run typecheck
npm run build
npm run acceptance:complex-layout
```

运行态验收覆盖结论：

- `clickPoint` 位于真实生效区域
- `covered` 元素不返回 `clickPoint`
- 局部遮挡按钮的点不会落入遮挡带
- 三角形按钮的点不会落入透明区域
- 同一页面两次快照中，代表性前景元素的 `clickPoint` 不完全相同
- 返回值带有正确的 `tabId / windowId / url / title`

---

## 4. 当前边界

本轮仍然是**只读 runtime**：

- 本仓库返回的是“应该点哪里”的随机 `clickPoint`
- 真实点击执行链路仍不在扩展 runtime 内
- 上传 / 下载目前提供的是识别和定位语义，不是文件系统桥接

后续如果要补端到端操作，需要在本仓库之外接入真实鼠标/键盘/文件执行层，并消费这里返回的 `clickPoint` 和目标页上下文。
