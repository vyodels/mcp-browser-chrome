# browser-mcp 招聘 IM 场景复杂布局验收规范

> **文档类型**：规格 / 验收标准（`docs/specs/`）
> **目标**：验证 `browser_snapshot` 在招聘网站工作台场景下，能够稳定返回 clickable 元素的坐标、目标页上下文、遮挡层级，以及位于真实生效区域内的随机 `clickPoint`。
> **配套脚本**：`npm run acceptance:complex-layout`

---

## 1. 验收目的

本轮验收补的是招聘流程里最容易踩坑的 UI 场景，重点验证：

1. 同一快照中，`viewport` / `document` 坐标能还原 fixed toolbar、普通流式布局、iframe、nested iframe、shadow DOM、modal 前景层
2. 返回值会带目标页上下文：`tabId / windowId / url / title`
3. `browser_snapshot.clickables[*]` 能通过 `hitTestState` 区分：
   - `top`：当前真实顶层可命中
   - `partial`：仅局部区域暴露
   - `covered`：当前被遮挡
4. 每个可操作元素都返回单个 `clickPoint`
   - `top` / `partial`：必须给出
   - `covered`：不得给出
5. `clickPoint` 不允许固定在中心点语义，而是要落在真实可命中区域内，并在连续两次快照之间具备随机性
6. 招聘 IM 工作台里的上传、下载、在线简历、离线简历、交换联系方式、输入消息等控件，都能被正确识别

---

## 2. 测试页面组成

`scripts/complex-layout-fixture.mjs` 会起一个同源本地页面，模拟招聘站工作台：

- 顶层 fixed toolbar：`发布职位`
- 长文档职位卡按钮：`立即沟通`
- 背景筛选区：职位详情链接 / 搜索输入框 / 留言 textarea / 阶段 select / 更多筛选 / 候选人标签 / 安排面试
- 背景同源 iframe：`打开候选人档案`
- 背景 nested iframe：`下载候选人附件`
- open shadow DOM：`收藏候选人`
- 顶层 IM modal：
  - `关闭沟通窗`
  - `查看在线简历`（modal 内 iframe）
  - `输入消息，和候选人打个招呼`（textarea）
  - `上传附件简历`（`input[type=file]`）
  - `查看离线简历`（普通链接）
  - `下载离线简历`（`a[download]`）
  - `更多沟通操作`（异形三角按钮）
  - `交换联系方式`（局部遮挡）
  - `发送消息`

页面在所有 iframe 加载完成后自动滚动到固定 `scrollY=640`，并输出 `fixture-ready` 作为验收开始信号。

---

## 3. PASS 条件

`npm run acceptance:complex-layout` 通过时，至少满足：

1. 所有目标元素都能在 `browser_snapshot` 中找到
2. 以下锚点元素的 `viewport` / `document` 坐标与 fixture 设计值误差 ≤ 2px
   - `发布职位`
   - `立即沟通`
   - `打开候选人档案`
   - `下载候选人附件`
   - `收藏候选人`
   - `关闭沟通窗`
   - `输入消息，和候选人打个招呼`
   - `上传附件简历`
   - `查看离线简历`
   - `下载离线简历`
   - `更多沟通操作`
   - `交换联系方式`
   - `发送消息`
   - `查看在线简历`
3. `framePath` 命中预期：
   - `打开候选人档案` → `0`
   - `下载候选人附件` → `0.0`
   - `查看在线简历` → `1`
4. `shadowDepth` 命中预期：
   - `收藏候选人` → `1`
5. `hitTestState` 命中预期：
   - modal 前景控件 → `top`
   - `交换联系方式` → `partial`
   - `更多沟通操作` → `partial`
   - 被 modal/backdrop 覆盖的背景控件 → `covered`
6. 上传 / 下载语义字段命中预期：
   - `上传附件简历` → `type === "file"`，`accept === "application/pdf,.pdf"`
   - `下载离线简历` → `download === "candidate-resume.pdf"`
   - `下载候选人附件` → `download === "candidate-portfolio.pdf"`
7. `clickPoint` 命中预期：
   - `top` / `partial` 元素必须有 `clickPoint`
   - `covered` 元素必须没有 `clickPoint`
   - `clickPoint` 必须落在对应元素的真实 `viewport` / `document` 范围内
   - `交换联系方式` 的 `clickPoint` 不能落进遮挡带
   - `更多沟通操作` 的 `clickPoint` 必须落在三角形实际可见区域内
8. 连续两次快照中，代表性前景元素的 `clickPoint` 不能保持完全相同，用于证明其不是固定中心点
9. 排序只要求层级分层有效，不要求具体 tie-break 顺序：
   - 所有 `top` 元素必须出现在首个 `covered` 元素之前

---

## 4. 运行方式

前置条件：

- `npm run build` 已完成
- Chrome 已 reload 当前 `dist/`
- native host / socket 正常可用

执行：

```bash
npm run acceptance:complex-layout
```

输出：

- 成功时打印完整 JSON 报告，`success: true`
- 失败时打印 `failures[]`

---

## 5. 解释口径

本规范不要求 snapshot 只返回前景层元素。相反，它要求：

- 背景层元素仍然可见于返回结果，便于上游做完整页面建模
- 但必须能用 `hitTestState` 区分“当前真正在前景可操作的元素”和“当前被遮挡的元素”
- 对前景元素，不再输出区域数组，而是返回一个已经位于真实生效区域内的随机 `clickPoint`

---

## 6. 几何真值约束

为避免“被测快照自己给自己当 ground truth”，本规范额外要求：

- verifier 的期望坐标只能由 fixture 常量和显式布局参数推导，不能从 `snapshot.viewport.*` 或 clickable 自身矩形反推
- modal 使用固定 `left` 常量，不依赖实时 viewport 宽度
- iframe 内元素坐标要显式计入 iframe border 语义
- shadow DOM 内按钮坐标要显式计入 card 的 border / padding
- `document` 坐标验收以 `viewport` 真值加固定 `scrollY=640` 推导，且要求 `scrollX=0`
