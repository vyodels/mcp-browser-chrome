// ============================================================
// workflow.ts — 工作流数据结构和执行辅助
// ============================================================
import type { Workflow, WorkflowStep } from './types'

export type { Workflow, WorkflowStep }

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
      description: '作为招聘者，按简历要求筛选候选人、沟通、索简历、分析匹配度、预约面试',
      startUrl: 'https://www.zhipin.com',
      createdAt: Date.now(),
      steps: [
        {
          id: genId(),
          name: '打开招聘页面',
          instructions: `打开 BOSS直聘，进入招聘管理页面。
找到待筛选的候选人列表（待沟通/新候选人区域）。
调用 get_page_content 了解页面结构，确认已登录。
如果未登录，调用 ask_user 提示用户手动登录后继续。`,
          intervention: 'optional',
          completionHint: '成功看到候选人列表，并已登录',
        },
        {
          id: genId(),
          name: '筛选候选人',
          instructions: `根据 Skills 中定义的岗位要求，逐一查看候选人简介。
对每个候选人：
1. 点击查看其详情页
2. 提取：姓名、当前职位、工作年限、教育背景、期望薪资
3. 判断是否符合要求（调用 ask_user 汇报当前候选人信息，请用户确认是否继续沟通）
4. 符合则标记，不符合则跳过
重复直到看完当前列表。`,
          intervention: 'required',
          completionHint: '已完成对候选人列表的初步筛选，有符合条件的候选人',
        },
        {
          id: genId(),
          name: '发起沟通',
          instructions: `对筛选通过的候选人逐一发送初始沟通消息。
消息内容根据候选人背景个性化，包含：
- 说明招聘岗位
- 简要描述岗位亮点
- 询问候选人当前状态和意向
调用 ask_user 让用户确认消息内容后再发送。`,
          intervention: 'required',
          completionHint: '已向符合条件的候选人发送沟通消息',
        },
        {
          id: genId(),
          name: '索取简历',
          instructions: `对于回复并表示有意向的候选人，礼貌地索取详细简历。
发送简历索取消息，等待候选人回复。
如果候选人发来简历附件，尝试下载并调用 download_data 保存到本地。`,
          intervention: 'optional',
          completionHint: '已索取简历，至少有一份简历待分析',
        },
        {
          id: genId(),
          name: '简历匹配分析',
          instructions: `对收到的简历进行深度匹配分析：
1. 提取简历关键信息（工作经历、技能、项目、教育）
2. 对照岗位要求评分（0-10分）
3. 汇总匹配报告
4. 调用 download_data 将分析结果保存为 JSON 文件
5. 调用 ask_user 向用户展示分析结果，请用户决定哪些候选人进入面试`,
          intervention: 'required',
          completionHint: '简历分析完成，用户已确认面试名单',
        },
        {
          id: genId(),
          name: '预约面试',
          instructions: `对面试名单上的候选人，发送面试邀约消息。
调用 ask_user 请用户提供具体面试时间段（如"周三下午2点或周四上午10点"）。
根据用户提供的时间，与候选人协商确认面试时间。
如候选人反馈不可用时间，调用 ask_user 再次请用户提供备选时间。`,
          intervention: 'required',
          completionHint: '所有面试名单候选人的面试时间已确认',
        },
      ],
    },
    {
      id: 'wf-xiaohongshu-collect',
      name: '小红书内容采集',
      description: '采集小红书首页推荐帖子的标题、内容和数据，导出为 CSV 文件',
      startUrl: 'https://www.xiaohongshu.com',
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
3. 向下滚动加载更多内容（scroll_page，重复3-5次）
4. 每次滚动后再次提取新帖子
5. 去重后汇总所有帖子数据
目标采集不少于20条帖子。`,
          intervention: 'none',
          completionHint: '已采集至少20条帖子的基本信息',
        },
        {
          id: genId(),
          name: '查看帖子详情',
          instructions: `对采集到的帖子，逐一点击查看详情页：
1. 点击帖子进入详情
2. 提取完整正文内容
3. 提取标签（话题标签）
4. 返回列表继续下一条
处理前20条帖子即可。`,
          intervention: 'none',
          completionHint: '已获取帖子详情内容',
        },
        {
          id: genId(),
          name: '导出数据',
          instructions: `将采集到的所有帖子数据整理为 CSV 格式：
列名：标题,正文摘要,作者,点赞数,评论数,话题标签,帖子链接
调用 download_data 保存为 xiaohongshu_posts.csv
同时调用 download_data 保存 JSON 格式备份。
最后调用 ask_user 告知用户采集完成和文件保存位置。`,
          intervention: 'optional',
          completionHint: '数据已成功导出到本地文件',
        },
      ],
    },
  ]
}

// 构建工作流步骤的系统提示词
export function buildStepSystemPrompt(step: WorkflowStep, workflow: Workflow, stepIndex: number): string {
  return `你正在执行工作流「${workflow.name}」的第 ${stepIndex + 1} 步：「${step.name}」

## 当前步骤任务
${step.instructions}

## 完成判定
当满足以下条件时，停止调用工具并返回步骤完成总结：
${step.completionHint}

## 重要说明
- 优先使用工具完成任务，不要假设页面状态，每次操作前先调用 get_page_content
- 如果遇到需要用户判断的情况，使用 ask_user 工具
- 操作失败时最多重试2次，失败后使用 ask_user 告知用户并请求指示
- 完成后给出简洁的步骤总结`
}
