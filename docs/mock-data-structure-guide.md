# Zhipin 页面级 Mock 数据结构建议

这份文档面向后续要扩展或重构 BOSS/Zhipin 页面级 mock 包的人。

目标不是描述“当前页面怎么画出来”，而是把已经在真实站点稳定读到的页面级结构，反哺成 mock 数据包的设计约束。

## 分析范围

本次对照基于两类信息：

1. 当前仓库中的 mock 类型、数据包和页面渲染实现
2. 已经验证可稳定读取到的真实页面级结构
   - 职位管理页：看板、职位列表、职位详情
   - 推荐牛人页：职位上下文、候选人卡片列表、卡片动作
   - 沟通页：看板、筛选项、会话列表预览、当前会话详情、快捷动作

说明：

- 仓库里当前没有找到已提交的真实站点 JSON 快照或页面级 schema 文件。
- 因此这里的“真实页面级数据”对照，采用的是已经验收过的稳定读取能力，而不是逐字段对某份静态 JSON 做 diff。

## 当前 mock 结构盘点

当前 mock 结构主要由以下几层组成：

- [src/mock/zhipin/types.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock/zhipin/types.ts:1)
  - 定义 `BossMockScenario / BossMockJob / BossMockGeekProfile / BossMockRecommendedGeek / BossMockConversation`
- [src/mock/zhipin/dataPack.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock/zhipin/dataPack.ts:1)
  - 按阶段构造 `jobs / geeks / recommendedGeeks / conversations / quickActions / dashboard`
- [src/mock-boss.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock-boss.ts:324)
  - 直接消费上述数据并渲染职位管理、推荐牛人、沟通、打招呼、在线简历页面

当前顶层对象实际上是：

- `scenario`
- `jobs[]`
- `geeks[]`
- `recommendedGeeks[]`
- `conversations[]`
- `quickActions[]`
- `dashboard`
- `greetDraft`

这套结构能支撑现有 mock UI，但它更偏“演示数据集合”，还不是“页面级 mock 包 schema”。

## 主要缺口

### 1. 缺少明确的页面级顶层对象

当前数据是按实体分散的：

- `jobs[]`
- `recommendedGeeks[]`
- `conversations[]`

但真实站点已经稳定可读到的是“页面级块结构”：

- 页面 header
- 看板
- 筛选区
- 列表区
- 详情区
- 操作区

建议：

- mock 包顶层应显式有 `pages.jobs / pages.recommend / pages.chat`
- 不要只靠渲染层从全局实体拼装页面

### 2. 页面可读到的列表/卡片/看板信息，很多还停留在渲染层硬编码

当前 hardcode 明显存在于：

- 推荐页筛选项：[src/mock-boss.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock-boss.ts:418)
- 沟通页 tag 列表：[src/mock-boss.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock-boss.ts:516)
- 职位管理页 CTA 文案与结构：[src/mock-boss.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock-boss.ts:370)

这意味着：

- mock 数据包本身并没有完整表达页面结构
- 后续如果真实页面读到更多筛选项、状态文案或动作区变化，mock 包会先失真，再逼着渲染层加分支

建议：

- 把筛选项、看板项、按钮区、空态、列表 meta 都作为数据写进 mock 包

### 3. 推荐页数据拆成 `geeks[] + recommendedGeeks[]`，对页面级 mock 不够直接

当前推荐卡片需要在渲染时 join：

- `recommendedGeeks[].geekId`
- `geeks[]`

问题：

- 页面级读取稳定拿到的是“卡片对象”，不是“两份实体再 join”
- card 层字段和 profile 层字段容易漂移
- 后续如果真实页面出现“同人多卡”“不同来源推荐”“不同职位上下文”会很难表达

建议：

- 推荐页应显式有 `candidateCards[]`
- 每张卡片至少包含当前页面真实能读到的展示字段和动作状态
- 如需复用全量候选人信息，可保留 `entities.candidates`，但页面层应有一份可直接渲染的 card snapshot

### 4. 沟通页把“会话列表预览”和“当前会话详情”塞进同一个 `conversations[]`

当前 `BossMockConversation` 同时承担：

- 左侧列表项预览
- 当前会话 thread
- 业务关系状态

问题：

- 真实站点已稳定可读到的左侧列表和右侧详情，本质上是两个层级
- 列表预览字段与详情 thread 字段的变化频率不同
- 后续若要模拟“只加载预览，不立即加载完整消息列表”，当前结构不够自然

建议：

- 拆成 `conversationList[]` 和 `activeThread`
- 或者保留 `entities.conversations`，但 `pages.chat` 里必须有：
  - `conversationList`
  - `activeConversationId`
  - `thread`
  - `quickActions`
  - `composer`
  - `modalState`

### 5. 现有 dashboard 更偏聊天页，不足以覆盖三页真实页面结构

当前 `BossMockDashboard` 只有：

- `totalCommunications`
- `newGreetings`
- `inProgress`
- `resumeReceived`
- `phoneExchanged`
- `wechatExchanged`

问题：

- 这基本是沟通页 dashboard
- 职位管理页真实可读到的“开放中 / 待开放 / 已关闭”并没有独立 page dashboard schema
- 推荐页未来如果有推荐数、已沟通数、已处理数，也没有位置落

建议：

- dashboard 应按页面拆分，而不是全局复用一份结构

### 6. 缺少页面选择态和 UI 状态对象

当前选择态存在运行时 state，不在数据包里：

- `selectedJobId`
- `selectedGeekId`
- `selectedConversationId`
- `activeChatTag`
- `modal`

问题：

- 真实页面级读取能稳定看到“当前选中哪个职位/会话/筛选”
- 但 mock 包本身没有把这些状态作为 schema 的一部分
- 后续要做“页面快照对齐 mock 包”，无法直接一一映射

建议：

- 顶层要有 `uiState` 或每页自己的 `selection`

### 7. 缺少显式的 modal / overlay / empty / loading / pagination 结构

当前页面 mock 已经有 modal 渲染，但 modal 不是数据 schema 的正式一部分，只是运行时 state。

问题：

- 真实页面读取里，遮挡层、确认弹层、空态、加载态都属于重要页面级对象
- 这些对象对后续交互测试也最关键

建议：

- mock 包要显式建模：
  - `modalState`
  - `overlayState`
  - `emptyState`
  - `loadingState`
  - `listMeta`

## 三类页面的建议补齐对象

### 职位管理页

当前真实页已稳定可读到的页面级对象：

- 页面 header
- 看板
- 职位列表
- 选中职位详情
- 详情区主动作

建议 `pages.jobs` 至少包含：

- `header`
  - `title`
  - `subtitle`
- `dashboardCards[]`
  - `id`
  - `label`
  - `value`
- `filters[]`
  - `id`
  - `label`
  - `count`
  - `active`
- `jobList`
  - `items[]`
  - `total`
  - `returned`
  - `hasMore`
  - `emptyState`
- `selectedJobId`
- `detailPanel`
  - `jobId`
  - `title`
  - `subtitle`
  - `highlights[]`
  - `responsibilities[]`
  - `requirements[]`
  - `tags[]`
  - `primaryActions[]`

建议 `jobList.items[]` 至少包含：

- `jobId`
- `title`
- `label`
- `metaLine`
- `status`
- `expireText`
- `stats`
  - `viewed`
  - `communicated`
  - `interested`
- `selected`

### 推荐牛人页

当前真实页已稳定可读到的页面级对象：

- 页面 header
- 当前职位上下文
- 筛选条
- 候选人卡片列表
- 卡片动作区

建议 `pages.recommend` 至少包含：

- `header`
  - `title`
  - `subtitle`
- `jobContext`
  - `jobId`
  - `title`
  - `city`
  - `salary`
- `filters`
  - `groups[]`
  - `activeValues`
- `candidateList`
  - `items[]`
  - `total`
  - `returned`
  - `hasMore`
  - `emptyState`

建议 `candidateList.items[]` 至少包含：

- `candidateId`
- `jobId`
- `name`
- `basicInfo`
  - `age`
  - `graduationLabel`
  - `educationLabel`
  - `activeLabel`
- `salaryExpectation`
- `stageTag`
- `expectationType`
- `targetCity`
- `targetPosition`
- `educationText`
- `skillHighlights[]`
- `experiencePreview[]`
- `actions[]`
  - `id`
  - `label`
  - `kind`
  - `enabled`
  - `targetPage?`
  - `disabledReason?`
- `selected`

与当前结构相比，缺的关键不是“候选人全量 profile”，而是“页面上当前这张卡片长什么样、可做什么动作”。

### 沟通页

当前真实页已稳定可读到的页面级对象：

- 页面 header
- 看板
- 筛选 tag
- 左侧会话列表预览
- 当前会话概要
- 当前消息列表
- 快捷动作区
- 输入区
- 确认弹层

建议 `pages.chat` 至少包含：

- `header`
  - `title`
  - `subtitle`
- `dashboardCards[]`
  - `id`
  - `label`
  - `value`
- `filters[]`
  - `id`
  - `label`
  - `count?`
  - `active`
- `conversationList`
  - `items[]`
  - `total`
  - `returned`
  - `emptyState`
- `activeConversationId`
- `thread`
  - `conversationId`
  - `candidateSummary`
  - `jobSummary`
  - `messages[]`
- `quickActions[]`
- `composer`
  - `draft`
  - `placeholder`
  - `canSend`
- `modalState`

建议 `conversationList.items[]` 至少包含：

- `conversationId`
- `candidateId`
- `jobId`
- `previewDate`
- `unreadCount`
- `previewText`
- `tags[]`
- `relation`
- `pinned`
- `selected`

建议 `thread.messages[]` 至少包含：

- `id`
- `type`
- `sender`
- `time?`
- `readStatus?`
- `text?`
- `variant?`
- `title?`
- `description?`
- `number?`
- `buttons[]`

建议 `quickActions[]` 至少包含：

- `id`
- `label`
- `enabled`
- `disabledReason?`
- `confirmDialogId?`
- `nextStateHint?`

建议 `modalState` 至少包含：

- `visible`
- `kind`
- `title`
- `body?`
- `primaryAction`
- `secondaryAction`

## 推荐的 mock 包顶层结构

建议后续 mock 包显式采用如下顶层 shape：

```ts
interface BossPageMockPackage {
  meta: {
    version: string
    scenarioId: string
    scenarioLabel: string
    description: string
  }
  uiState: {
    currentPage: 'jobs' | 'recommend' | 'greet' | 'chat' | 'resume'
    selectedJobId?: string
    selectedCandidateId?: string
    selectedConversationId?: string
  }
  entities: {
    jobs: Record<string, JobEntity>
    candidates: Record<string, CandidateEntity>
    resumes: Record<string, ResumeEntity>
    conversations: Record<string, ConversationEntity>
  }
  pages: {
    jobs: JobsPageMockData
    recommend: RecommendPageMockData
    chat: ChatPageMockData
    greet?: GreetPageMockData
    resume?: ResumePageMockData
  }
  overlays?: {
    modalState?: ModalState
    toastList?: ToastState[]
    guideOverlays?: OverlayState[]
  }
}
```

设计原则：

- `entities` 负责复用
- `pages` 负责“真实页面当前能读到什么”
- `uiState` 负责选择态
- `overlays` 负责遮挡和确认层

不要再让渲染层自己从散落字段推导页面结构。

## 最值得优先补齐的字段

如果这轮只补最小集，优先补这些：

1. `pages.jobs / pages.recommend / pages.chat`
2. 每页自己的 `header / filters / dashboard / listMeta`
3. 推荐页的 `candidateCards[]`
4. 沟通页的 `conversationList[] + activeConversationId + thread + composer + modalState`
5. `uiState`
6. 动作对象上的 `enabled / disabledReason / confirmDialogId`

## 对当前实现的直接建议

如果后续要继续沿用当前 `BossMockScenario`：

- 不要继续把筛选项、tag、空态、CTA 文案写死在 [src/mock-boss.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock-boss.ts:324)
- 优先把这些页面结构先迁到 `dataPack.ts`
- 然后再考虑是否把 `BossMockScenario` 升级成 `entities + pages + uiState` 的双层结构

这样做的收益是：

- mock 包能更自然对齐真实页面读取结果
- 后续状态切换不稳定时，也能先用页面级结构回归
- AI 可以直接把真实页读取出的页面对象映射回 mock，而不是跨多份实体做 join
