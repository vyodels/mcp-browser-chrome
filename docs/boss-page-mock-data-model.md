# BOSS 页面级 Mock 数据模型清单

这份文档用于把当前真实 `zhipin.com` 页面快照中已经稳定读取到的页面级结构，直接反哺离线 mock 数据包设计。

目标不是做“接口一比一还原”，而是保证页面级 mock 具备下面三类能力：

1. 能完整渲染页面级结构，而不是只有零散功能点
2. 能表达候选人生命周期的连续状态变化
3. 能为 MCP/AI 提供稳定、结构化、可查询的页面数据

## 当前仓库已有类型

当前 mock 页面主类型定义在 [src/mock/zhipin/types.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock/zhipin/types.ts:1)，核心对象如下：

- `BossMockScenario`
- `BossMockDashboard`
- `BossMockJob`
- `BossMockGeekProfile`
- `BossMockRecommendedGeek`
- `BossMockConversation`
- `BossMockConversationMessage`
- `BossMockQuickAction`

当前数据包实现在 [src/mock/zhipin/dataPack.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock/zhipin/dataPack.ts:1)，页面渲染实现在 [src/mock-boss.ts](/Users/didi/AgentProjects/mcp-browser-chrome/src/mock-boss.ts:1)。

## 真实页面快照已确认可读取的页面级结构

以下结论来自当前对真实站点三类页面的结构化快照读取：

- 职位管理页：可稳定读取职位列表、每个职位的看板统计、状态、到期时间、操作区
- 推荐牛人页：可稳定读取职位上下文、筛选区、候选人列表、候选人卡片摘要信息、打招呼按钮
- 沟通页：可稳定读取分组筛选、职位筛选、候选人沟通列表、聊天预览文本、右侧未选中空态
- 在线简历页：当前 mock 已有独立页面，但真实站点上的“切出在线简历详情”还依赖交互触发，快照阶段主要拿到了候选人卡片中的履历摘要与 mock 内部简历结构

## 推荐的顶层数据模型

建议把 mock 数据包组织为一个“场景 + 页面派生视图”的结构：

```ts
interface BossPageMockPack {
  meta: BossMockMeta
  dictionaries: BossMockDictionaries
  scenarios: BossMockScenarioRecord[]
}
```

```ts
interface BossMockMeta {
  version: string
  source: 'zhipin-real-page-snapshot'
  generatedAt: string
  notes?: string[]
}
```

```ts
interface BossMockDictionaries {
  chatTags: string[]
  jobStatus: string[]
  candidateStageTags: string[]
  quickActionIds: string[]
}
```

```ts
interface BossMockScenarioRecord {
  id: string
  label: string
  description: string
  lifecycleStage: 'fresh' | 'greeted' | 'resume_requested' | 'resume_received' | 'phone_requested' | 'phone_received' | 'wechat_requested' | 'wechat_received'
  primaryJobId: string
  primaryGeekId: string
  pages: {
    jobs: BossJobsPageData
    recommend: BossRecommendPageData
    chat: BossChatPageData
    resume: BossResumePageData
    greet: BossGreetPageData
  }
  entities: {
    jobs: BossJobEntity[]
    geeks: BossGeekEntity[]
    conversations: BossConversationEntity[]
  }
}
```

这种结构有两个好处：

- `entities` 负责沉淀可复用业务实体
- `pages` 负责承载页面级列表、看板、筛选、空态、选中态、入口关系

## 页面一：职位管理

真实快照里，职位管理页不是只有一个 `jobs[]`，而是一个完整页面：

- 页面头部：`发布职位`
- 顶部筛选：职位类型、职位状态
- 页面级看板：开放中、待开放、已关闭
- 职位列表：每条职位卡含标题、标签、城市、经验、学历、薪资、用工类型
- 职位卡统计：`看过我 / 沟通过 / 感兴趣`
- 职位状态：`开放中 / 待开放 / 已关闭`
- 时间/说明：如 `2027-03-12到期`、`当前职位可预览推荐牛人`
- 操作区：`编辑 / 关闭 / 打开 / 预览 / 分享 / 复制 / 删除 / 上传到职位库`
- 分页信息：`共108个职位/每页20个`

建议的数据结构：

```ts
interface BossJobsPageData {
  pageTitle: string
  dashboard: {
    openCount: number
    pendingCount: number
    closedCount: number
  }
  filters: {
    typeOptions: string[]
    statusOptions: string[]
    selectedType: string
    selectedStatus: string
  }
  pagination: {
    totalJobs: number
    pageSize: number
    currentPage: number
    totalPages: number
  }
  list: BossJobListItem[]
  selectedJobId: string | null
  detailPanel?: BossJobDetailPanel
  hiddenModal?: BossHiddenLayerHint[]
}
```

```ts
interface BossJobListItem {
  jobId: string
  title: string
  label: '竞' | '普'
  city: string
  experience: string
  education: string
  salary: string
  employmentType: string
  internshipDays?: string
  internshipDuration?: string
  stats: {
    viewed: number
    communicated: number
    interested: number
  }
  status: '开放中' | '待开放' | '已关闭'
  expireAt?: string
  hints?: string[]
  actions: string[]
}
```

```ts
interface BossJobDetailPanel {
  jobId: string
  title: string
  subtitle: string
  highlights: string[]
  responsibilities: string[]
  requirements: string[]
  tags: string[]
}
```

### 对当前已有类型的补充建议

当前 `BossMockJob` 已覆盖：

- 基本信息
- 状态
- 三个统计字段
- JD 摘要

当前还缺：

- 页面级筛选区
- 页面级分页信息
- 职位卡操作区
- 页面级已选职位态和详情面板态
- 隐藏但可能影响页面层级判断的挂载层信息

## 页面二：推荐牛人

真实快照里，推荐牛人页至少包含下面几层：

- 当前职位上下文：职位名、城市、薪资
- 页面头部 tab：`推荐 / 精选 / 最新`
- 区域筛选：城市、项目类型等
- 筛选问答区：如“该职位负责的项目类型是？”
- 推荐候选人列表
- 每张卡片上的 `打招呼`
- 卡片上的履历摘要与标签

建议的数据结构：

```ts
interface BossRecommendPageData {
  pageTitle: string
  tabs: string[]
  activeTab: string
  selectedJobId: string
  jobSummary: {
    title: string
    city: string
    salary: string
  }
  filters: {
    cityOptions: string[]
    selectedCity: string
    questionPrompts: BossRecommendQuestionPrompt[]
  }
  list: BossRecommendCard[]
  selectedGeekId: string | null
  resumePreviewState: 'closed' | 'opened'
}
```

```ts
interface BossRecommendQuestionPrompt {
  id: string
  title: string
  description?: string
  options: string[]
  selectedOptions: string[]
}
```

```ts
interface BossRecommendCard {
  geekId: string
  salaryExpectation: string
  stageTag: string
  name: string
  age: number
  graduationLabel: string
  educationLabel: string
  activeLabel: string
  expectationType: '最近关注' | '期望'
  targetCity: string
  targetPosition: string
  educationText: string
  skillHighlights: string[]
  experiencePreview: string[]
  schoolTags?: string[]
  canViewResume: boolean
  primaryActions: Array<'detail' | 'greet'>
}
```

### 对当前已有类型的补充建议

当前 `BossMockRecommendedGeek` 已覆盖：

- 候选人卡片摘要
- 薪资期望
- 阶段标签
- 期望类型
- 履历预览

当前还缺：

- 页面级职位上下文
- 推荐页顶部 tab 与当前激活 tab
- 筛选区与问答引导区
- 当前卡片是否已打开在线简历
- 页面上“候选人生命周期来源”区分，比如来自推荐、来自牛人主动打招呼

## 页面三：沟通

真实快照里，沟通页是一个典型三段式页面：

- 顶部页面标题与大类导航
- 沟通看板与标签筛选
- 左侧会话列表
- 右侧详情区或空态区

当前快照稳定拿到的字段：

- 总沟通数，例如 `沟通 76`
- 标签组：`新招呼 / 沟通中 / 已约面 / 已获取简历 / 已交换电话 / 已交换微信 / 收藏 / 更多`
- 页面级看板文案和辅助区块
- 会话列表项：日期、候选人姓名、职位名、预览文本、未读数
- 页面空态：`未选中联系人`

建议的数据结构：

```ts
interface BossChatPageData {
  pageTitle: string
  totalCommunications: number
  dashboard: {
    newGreetings: number
    inProgress: number
    resumeReceived: number
    phoneExchanged: number
    wechatExchanged: number
  }
  filters: {
    chatTags: BossChatTagCount[]
    selectedTag: string
    jobOptions: string[]
    selectedJobFilter: string
    subFilters: string[]
    selectedSubFilter: string
  }
  list: BossConversationListItem[]
  selectedConversationId: string | null
  detailPanel: BossConversationDetailPanel | BossChatEmptyState
}
```

```ts
interface BossChatTagCount {
  tag: string
  count: number | null
}
```

```ts
interface BossConversationListItem {
  conversationId: string
  geekId: string
  jobId: string
  previewDate: string
  previewText: string
  unreadCount: number
  pinned?: boolean
  tags: string[]
  source: 'boss_initiated' | 'geek_initiated' | 'system_push'
}
```

```ts
interface BossConversationDetailPanel {
  conversationId: string
  geekId: string
  jobId: string
  geekSummary: {
    name: string
    age: number
    activeLabel: string
    experienceLabel: string
    educationLabel: string
    recentFocus?: string
  }
  resumeEntry: {
    onlineResumeVisible: boolean
    attachmentResumeName?: string
  }
  messageGroups: BossConversationMessage[]
  composer: {
    placeholder: string
    quickActions: Array<'request_resume' | 'request_phone' | 'request_wechat' | 'schedule_interview' | 'reject'>
    draft?: string
  }
}
```

```ts
interface BossChatEmptyState {
  kind: 'empty'
  title: '未选中联系人'
  description?: string
}
```

### 对当前已有类型的补充建议

当前 `BossMockConversation` 已覆盖：

- 会话实体
- 预览文本
- 标签
- 消息体

当前还缺：

- 页面级职位筛选
- 页面级二级筛选
- 页面级空态区与详情区的显式切换结构
- 会话来源字段的页面语义化枚举
- 输入区 placeholder 与快捷动作配置
- 右侧详情头部独立结构

## 页面四：在线简历

当前 mock 里已经有独立在线简历页，这个方向是对的。真实快照阶段虽然还没稳定切出站点的简历详情 frame，但从推荐卡片和沟通页右侧简历入口可以确认，在线简历至少需要承载：

- 基础信息
- 求职期望
- 个人概述
- 自我评价
- 工作经历
- 项目经历
- 教育经历
- 技能
- 证书

建议的数据结构：

```ts
interface BossResumePageData {
  geekId: string
  fromPage: 'recommend' | 'chat' | 'greet'
  baseProfile: {
    name: string
    age: number
    gender: '男' | '女'
    educationLabel: string
    experienceLabel: string
    currentStatus: string
    schoolName?: string
    major?: string
    schoolTags?: string[]
  }
  expectation: string[]
  summary: string
  selfEvaluation: string
  workExperience: BossResumeSection[]
  projectExperience: BossResumeSection[]
  education: BossResumeSection[]
  skills: string[]
  certificates: string[]
  attachmentResumeName?: string
}
```

当前 `BossMockOnlineResume` 和 `BossMockGeekProfile` 已基本覆盖这一层，主要缺的是“从哪个页面进入”和“页面入口关系”。

## 页面五：打招呼

真实站点上 `打招呼` 仍依赖交互触发，但从业务流程看，这页不应只是一个字符串输入框，而应该带候选人摘要和上下文。

建议的数据结构：

```ts
interface BossGreetPageData {
  geekId: string
  jobId: string
  candidateSummary: {
    name: string
    age: number
    educationLabel: string
    activeLabel: string
    expectedPosition: string
    expectedSalary: string
    recentFocus: string
    currentCompany?: string
    currentRole?: string
    highlightTags: string[]
  }
  presetGreeting: string
  availableActions: Array<'view_resume' | 'cancel' | 'send_greet'>
}
```

## 候选人生命周期建模建议

当前仓库已有的阶段：

- `fresh`
- `greeted`
- `resume_received`
- `contact_received`

这对页面级 mock 不够细。建议至少扩成下面这条主链：

1. `fresh`
2. `greet_ready`
3. `greeted`
4. `resume_requested`
5. `resume_received`
6. `phone_requested`
7. `phone_received`
8. `wechat_requested`
9. `wechat_received`

同时给每个候选人保留来源字段：

```ts
type BossCandidateSource =
  | 'recommend'
  | 'geek_greet'
  | 'boss_greet'
  | 'resume_push'
  | 'contact_push'
```

## 当前 mock 包与真实页面快照的主要缺口

最主要的缺口不在单个实体，而在页面级容器：

- 缺页面级筛选区数据
- 缺页面级 tab / 二级筛选 / 空态结构
- 缺职位管理页的操作区和分页结构
- 缺推荐页的顶部 tab、筛选问答区和职位上下文
- 缺沟通页的页面级过滤器、详情区显式结构和空态结构
- 缺候选人来源字段与更细粒度生命周期阶段
- 缺“页面进入关系”，比如推荐页点详情进入在线简历，沟通页点在线简历也能进入同一份简历页

## 直接落地建议

后续实现 mock 数据包时，建议按这个顺序补：

1. 先保留现有 `entities` 类型，不推翻已有 `BossMockJob / BossMockGeekProfile / BossMockConversation`
2. 在此之上新增 `BossJobsPageData / BossRecommendPageData / BossChatPageData / BossResumePageData / BossGreetPageData`
3. 再把 `BossMockScenario` 从“实体聚合”升级成“实体 + 页面派生视图”
4. 最后补齐更细的生命周期阶段和来源字段

这样改动最小，而且能直接服务“页面级 mock，而不是单点功能 mock”的目标。
