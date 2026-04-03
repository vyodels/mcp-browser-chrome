// ============================================================
// workflow.ts — 工作流数据结构和执行辅助
// ============================================================
import type { Workflow, WorkflowStep, Skill, WorkspaceField } from './types'

export type { Workflow, WorkflowStep }

// ---- 预设工作区 Schema ----

const RECRUIT_WORKSPACE_FIELDS: WorkspaceField[] = [
  { id: 'name',           name: '姓名',     type: 'text',   required: true },
  { id: 'status',         name: '状态',     type: 'status', required: true,
    options: ['筛选中', '已沟通', '待收简历', '已收简历', '待面试', '通过', '淘汰'] },
  { id: 'position',       name: '职位',     type: 'text' },
  { id: 'company',        name: '公司',     type: 'text' },
  { id: 'experience',     name: '工作年限', type: 'text' },
  { id: 'education',      name: '学历',     type: 'text' },
  { id: 'salary',         name: '期望薪资', type: 'text' },
  { id: 'score',          name: '综合评分', type: 'number' },
  { id: 'interview_time', name: '面试时间', type: 'date' },
  { id: 'tags',           name: '标签',     type: 'tags' },
  { id: 'notes',          name: '备注',     type: 'text' },
  { id: 'resume_file',    name: '简历文件', type: 'text' },
]

const XIAOHONGSHU_WORKSPACE_FIELDS: WorkspaceField[] = [
  { id: 'title',    name: '标题',   type: 'text',   required: true },
  { id: 'author',   name: '作者',   type: 'text' },
  { id: 'likes',    name: '点赞数', type: 'number' },
  { id: 'comments', name: '评论数', type: 'number' },
  { id: 'tags',     name: '话题',   type: 'tags' },
  { id: 'summary',  name: '正文摘要', type: 'text' },
  { id: 'url',      name: '帖子链接', type: 'url' },
]

// 工作流执行状态（侧边栏持有）
export interface WorkflowRunState {
  workflow: Workflow
  currentStepIndex: number
  completedSteps: string[]   // 已完成步骤的 id
  startedAt: number
}

// 生成唯一 ID
function genId(): string { return Math.random().toString(36).slice(2, 10) }

// ---- 内置工作流模板 ----

export function createDefaultWorkflows(): Workflow[] {
  return [
    {
      id: 'wf-boss-recruit',
      name: 'BOSS直聘招聘工作流',
      description: '作为招聘者，筛选候选人、发起沟通、索取简历、分析匹配度、预约面试，支持并行追踪多个候选人',
      context: `## 招聘背景（请根据实际情况修改）
岗位：高级前端工程师
核心要求：
- 工作年限 ≥ 3年，熟悉 React/Vue
- 有过大型项目独立负责经验
- 薪资预算：20-30k

候选人评估维度：
1. 技术匹配度（工作年限、技术栈）
2. 项目经验质量（独立负责 or 参与）
3. 稳定性（跳槽频率、离职原因）
4. 薪资匹配

候选人状态流转：筛选中 → 已沟通 → 待收简历 → 已收简历 → 安排面试 → 通过/淘汰

重要：每处理完一个候选人，无论结果如何，都必须调用 log_candidate 工具记录其信息和当前状态。`,
      startUrl: 'https://www.zhipin.com/web/geek/chat',
      workspace: { fields: RECRUIT_WORKSPACE_FIELDS },
      createdAt: Date.now(),
      steps: [
        {
          id: genId(),
          name: '打开招聘管理页面',
          instructions: `打开 BOSS直聘招聘管理页，进入候选人管理/消息列表。

操作步骤：
1. 调用 get_page_content 查看当前页面状态
2. 确认已登录（有消息列表、候选人列表）
3. 如未登录，调用 ask_user 提示用户完成登录后继续
4. 确认后报告当前待处理的新消息数量和候选人数量

目标：确认系统可用，为后续批量处理候选人做好准备。`,
          intervention: 'optional',
          completionHint: '已确认登录状态，可以看到候选人消息列表',
        },
        {
          id: genId(),
          name: '批量筛选候选人',
          instructions: `系统地逐一查看所有新候选人/新消息，对每个候选人进行初步筛选。

对每个候选人执行以下流程：
1. 点击进入其资料页或聊天页
2. 提取关键信息：姓名、当前职位、工作年限、教育背景、期望薪资、技能标签
3. 对照工作流全局要求进行评估，打分 1-10
4. 调用 log_candidate 工具记录：
   - name: 候选人姓名
   - status: "screening"
   - position: 当前职位
   - experience: 工作年限
   - education: 学历
   - salary: 期望薪资
   - notes: 评分和初步评估意见
5. 调用 ask_user，汇报该候选人信息和评分，询问是否发起沟通

不符合基本条件（年限不足/薪资偏差过大）的候选人，直接 log_candidate status=rejected，无需 ask_user 确认。

处理完所有候选人后，汇总已筛选数量、通过数量、淘汰数量。`,
          intervention: 'required',
          completionHint: '已遍历所有新候选人，每位都有 log_candidate 记录，用户已确认哪些进入沟通环节',
        },
        {
          id: genId(),
          name: '发送个性化沟通消息',
          instructions: `对上一步用户确认"发起沟通"的候选人，逐一发送个性化初始消息。

每位候选人的消息模板（根据其背景动态调整）：
---
你好 [姓名]！

我是 [公司名] 的招聘负责人，看到你的资料很感兴趣。
我们目前在招 [岗位]，薪资范围 [范围]。

看到你有 [X年] [技术栈] 经验，[简短的一句肯定]。

请问你目前的求职状态方便沟通一下吗？
---

操作：
1. 进入候选人聊天页面
2. 调用 ask_user 展示准备发送的消息，请用户确认或修改
3. 用户确认后，填写并发送消息
4. 调用 log_candidate 更新 status="contacted"，notes 追加"已发送初始消息"
5. 继续下一位候选人

发完所有人后，汇报已发送数量。`,
          intervention: 'required',
          completionHint: '所有通过筛选的候选人均已收到沟通消息，记录已更新',
        },
        {
          id: genId(),
          name: '跟进回复 & 索取简历',
          instructions: `查看有回复的候选人消息，进行跟进对话并索取简历。

操作流程：
1. 刷新页面，找到有新回复的候选人
2. 阅读候选人回复内容
3. 根据回复情况：
   - 有意向的：礼貌地请求发送简历
     消息：「太好了！方便发一份你的简历吗？PDF 或 Word 均可。」
   - 暂时不考虑的：礼貌回复，更新 log_candidate status="rejected"
   - 回复模糊的：调用 ask_user 请用户给出回复建议
4. 如候选人发来简历附件：
   - 尝试下载，调用 download_data 保存到本地
   - 调用 log_candidate 更新 status="resume_received"，resumeFile 填写文件名
5. 如简历是在线链接：记录链接到 notes

每处理一位，更新 log_candidate 记录。`,
          intervention: 'optional',
          completionHint: '已处理所有回复，至少有一份简历记录在案',
        },
        {
          id: genId(),
          name: '简历深度分析 & 面试决策',
          instructions: `对已收到简历的候选人进行结构化分析，输出面试建议。

对每位候选人的简历：
1. 提取关键信息：
   - 工作经历（公司、职位、时间、核心职责）
   - 技能列表
   - 项目经历（规模、独立/协作、技术亮点）
   - 教育背景
2. 对照工作流全局要求逐维度评分（满分10分）：
   - 技术匹配度：X/10
   - 项目质量：X/10
   - 稳定性：X/10
   - 综合推荐：强推/推荐/待定/不推荐
3. 生成分析报告，调用 download_data 保存为 JSON（文件名：候选人姓名_分析.json）
4. 更新 log_candidate notes="综合评分 X/10，[推荐等级]，[核心理由]"
5. 汇总所有候选人分析，调用 ask_user 展示面试候选名单，请用户最终确认

调用 download_data 保存整体候选人对比表（candidates_comparison.csv）。`,
          intervention: 'required',
          completionHint: '所有简历已分析完毕，用户已确认面试名单',
        },
        {
          id: genId(),
          name: '预约面试',
          instructions: `对面试名单上的候选人，协商并确认面试时间。

操作流程：
1. 调用 ask_user 请用户提供可用面试时间段（如"周三下午2-5点、周四上午10-12点"）
2. 对每位候选人发送面试邀约消息：
   「你好！我们对你的背景很感兴趣，想邀请你参加一轮面试（约45-60分钟，线上/电话）。
    我们可以安排的时间有：[时间选项1] 或 [时间选项2]，请问哪个时间方便？」
3. 等待候选人回复确认时间
4. 候选人确认后：
   - 调用 log_candidate 更新 status="interview_scheduled"，interviewTime="具体时间"
   - 发送确认消息和面试细节
5. 候选人时间不合适：调用 ask_user 请用户提供备选时间
6. 完成后汇总面试日程表，调用 download_data 保存为 interview_schedule.json`,
          intervention: 'required',
          completionHint: '所有面试名单候选人的面试时间已确认，日程表已保存',
        },
      ],
    },
    {
      id: 'wf-xiaohongshu-collect',
      name: '小红书内容采集',
      description: '采集小红书推荐帖子的标题、内容和数据，导出为 CSV 文件',
      context: `采集目标：小红书首页推荐内容
数据字段：标题、正文、作者、点赞数、评论数、话题标签、帖子链接
目标数量：≥20条`,
      startUrl: 'https://www.xiaohongshu.com',
      workspace: { fields: XIAOHONGSHU_WORKSPACE_FIELDS },
      createdAt: Date.now(),
      steps: [
        {
          id: genId(),
          name: '打开小红书',
          instructions: `打开小红书首页，等待内容加载完成。
调用 get_page_content 确认页面已加载推荐帖子列表。
如需登录，调用 ask_user 提示用户处理。`,
          intervention: 'optional',
          completionHint: '小红书首页已加载，可以看到帖子列表',
        },
        {
          id: genId(),
          name: '采集帖子列表',
          instructions: `系统地采集当前页面所有推荐帖子：
1. 调用 get_page_content 获取当前可见帖子
2. 提取每个帖子的：标题、封面描述、作者、点赞数、评论数
3. 向下滚动加载更多（scroll_page，重复3-5次）
4. 每次滚动后再次提取新帖子
5. 去重后汇总，目标采集不少于20条`,
          intervention: 'none',
          completionHint: '已采集至少20条帖子的基本信息',
        },
        {
          id: genId(),
          name: '查看帖子详情',
          instructions: `对采集到的帖子，逐一点击查看详情页：
1. 点击帖子进入详情
2. 提取完整正文内容和标签
3. 返回列表继续下一条
处理前20条帖子。`,
          intervention: 'none',
          completionHint: '已获取帖子详情内容',
        },
        {
          id: genId(),
          name: '导出数据',
          instructions: `整理为 CSV 格式，列名：标题,正文摘要,作者,点赞数,评论数,话题标签,帖子链接
调用 download_data 保存为 xiaohongshu_posts.csv
同时保存 JSON 格式备份。
调用 ask_user 告知用户采集完成和文件位置。`,
          intervention: 'optional',
          completionHint: '数据已成功导出到本地文件',
        },
      ],
    },
  ]
}

// 构建工作流步骤的系统提示词（注入 context + 引用 skills）
export function buildStepSystemPrompt(
  step: WorkflowStep,
  workflow: Workflow,
  stepIndex: number,
  allSkills: Skill[] = []
): string {
  // 查找本步骤引用的 skills
  const referencedSkills = (step.skillIds ?? [])
    .map((id) => allSkills.find((s) => s.id === id && s.status === 'active'))
    .filter(Boolean) as Skill[]

  const skillsSection = referencedSkills.length > 0
    ? `\n## 本步骤引用的 Skills\n${referencedSkills.map((s) => `### ${s.name}\n${s.instructions}`).join('\n\n')}\n`
    : ''

  const contextSection = workflow.context
    ? `\n## 工作流全局背景与要求\n${workflow.context}\n`
    : ''

  // 工作区 schema 注入：告知 AI 当前工作流有哪些字段可以记录
  const workspaceSection = workflow.workspace?.fields.length
    ? `\n## 工作区数据字段（调用 log_record 时使用这些字段名）\n${
        workflow.workspace.fields.map((f) =>
          `- **${f.name}**（id: \`${f.id}\`）：${f.type}${f.options?.length ? `，可选值: ${f.options.join('/')}` : ''}${f.required ? '（必填）' : ''}`
        ).join('\n')
      }\n\n调用 log_record 时，data 参数传 JSON：{"${workflow.workspace.fields[0]?.id}": "值", ...}\n`
    : ''

  return `你正在执行工作流「${workflow.name}」的第 ${stepIndex + 1}/${workflow.steps.length} 步：「${step.name}」
${contextSection}${workspaceSection}${skillsSection}
## 当前步骤任务
${step.instructions}

## 完成判定
当满足以下条件时，停止调用工具并返回步骤完成总结：
${step.completionHint}

## 操作规范
- 每次操作前先调用 get_page_content 了解页面当前状态
- 遇到需要用户判断的关键节点，使用 ask_user 工具
- 操作失败最多重试2次，之后使用 ask_user 告知用户并请求指示
- 处理候选人时，每位都必须调用 log_candidate 记录
- 步骤完成后给出简洁的执行总结`
}
