import type {
  BossLifecycleStage,
  BossMockConversation,
  BossMockConversationCard,
  BossMockConversationMessage,
  BossMockGeekProfile,
  BossMockJob,
  BossMockRecommendedGeek,
  BossMockScenario,
} from './types'

const PRIMARY_JOB_ID = 'job-ai-pm-001'
const PRIMARY_GEEK_ID = 'geek-lin-zhixia-001'

const primaryJobBase: BossMockJob = {
  jobId: PRIMARY_JOB_ID,
  title: '大模型数据项目经理',
  label: '竞',
  city: '北京',
  experience: '3-5年',
  education: '本科',
  salary: '18-28K',
  employmentType: '全职',
  status: '开放中',
  expireAt: '2027-03-12到期',
  stats: {
    viewed: 312,
    communicated: 0,
    interested: 0,
  },
  jd: {
    subtitle: '北京 | 3-5年 | 本科 | 18-28K | 全职',
    highlights: ['AI数据项目', '交付管理', '客户协同', '跨团队推进'],
    responsibilities: [
      '负责大模型数据项目的需求澄清、排期推进与交付把控，协调标注、产品、算法与客户团队。',
      '沉淀项目 SOP、质量看板和风险预警机制，保证交付质量、效率与成本可控。',
      '结合客户业务目标，拆解里程碑、定义验收标准，并推动问题闭环。',
    ],
    requirements: [
      '3 年以上项目管理或 AI 数据交付经验，有多角色协同推进经验。',
      '熟悉大模型训练、数据清洗、质检和平台协作流程，具备较强文档与沟通能力。',
      '具备 ToB 项目节奏感，能独立推动需求、风险和资源协调。',
    ],
    tags: ['项目管理', 'AI 数据', '需求分析', '交付管理', '看板运营'],
  },
}

const sideJobs: BossMockJob[] = [
  {
    ...primaryJobBase,
    stats: { viewed: 1447, communicated: 39, interested: 12 },
  },
  {
    jobId: 'job-ai-sales-001',
    title: '国际销售工程师',
    label: '竞',
    city: '北京',
    experience: '3-5年',
    education: '本科',
    salary: '20-40K',
    employmentType: '全职',
    status: '开放中',
    expireAt: '2027-03-12到期',
    stats: { viewed: 957, communicated: 21, interested: 8 },
    jd: {
      subtitle: '北京 | 3-5年 | 本科 | 20-40K | 全职',
      highlights: ['海外销售', '解决方案', '英语沟通', '售前协同'],
      responsibilities: [
        '负责海外客户的解决方案沟通、POC 推进和需求收敛。',
        '和产品、交付、售前团队协同，完成方案设计与商务推进。',
      ],
      requirements: [
        '有海外销售、售前或解决方案经验，英语可作为工作语言。',
        '理解 AI/数据平台类产品，能与技术团队高效协同。',
      ],
      tags: ['海外销售', '售前', '英语', 'AI 产品'],
    },
  },
  {
    jobId: 'job-hr-intern-001',
    title: '人力招聘实习生',
    label: '竞',
    city: '北京',
    experience: '经验不限',
    education: '本科',
    salary: '150-200元/天',
    employmentType: '实习',
    internshipDays: '4天/周',
    internshipDuration: '3个月',
    status: '待开放',
    expireAt: '当前职位可预览推荐牛人',
    stats: { viewed: 15, communicated: 5, interested: 1 },
    jd: {
      subtitle: '北京 | 4天/周 | 3个月 | 本科 | 150-200元/天 | 实习',
      highlights: ['招聘流程协助', '候选人沟通', '数据整理'],
      responsibilities: [
        '协助招聘需求整理、职位发布和候选人初筛。',
        '跟进简历、面试安排和招聘数据看板更新。',
      ],
      requirements: [
        '本科及以上，沟通细致，执行力强。',
        '熟悉 Office，有招聘或学生组织经验加分。',
      ],
      tags: ['招聘', '实习', '沟通', '数据整理'],
    },
  },
]

const primaryGeekBase: BossMockGeekProfile = {
  geekId: PRIMARY_GEEK_ID,
  name: '林知夏',
  gender: '女',
  age: 27,
  activeLabel: '刚刚活跃',
  experienceLabel: '3年',
  graduationLabel: '25届',
  educationLabel: '硕士',
  expectedPosition: '北京 · 项目经理/主管',
  expectedCity: '北京',
  expectedSalary: '18-25K',
  currentStatus: '在职-考虑机会',
  schoolName: '北京邮电大学',
  major: '智能科学与技术',
  schoolTag: '211院校',
  rankTag: '专业前10%',
  recentFocus: '北京 · 项目经理/主管 18-25K',
  currentCompany: '星瀚智能',
  currentRole: 'AI 数据项目主管',
  highlightTags: ['项目管理', '交付推进', '需求分析', '数据标注', '客户沟通'],
  attachmentResumeName: '林知夏-大模型数据项目经理-简历.pdf',
  onlineResume: {
    summary:
      '3 年 AI 数据与项目交付经验，做过大模型数据清洗、标注、质检与平台协同，熟悉从需求拆解到交付验收的完整流程。',
    selfEvaluation:
      '擅长在多角色协同环境下推进复杂项目，能够把需求、排期、资源和风险收敛成可执行计划；对 AI 数据项目的质量看板、SOP 和交付机制有沉淀经验。',
    expectation: ['北京', '项目经理/主管', '18-25K', '全职', '可 2 周内到岗'],
    workExperience: [
      {
        title: '2024.04-至今  星瀚智能 · AI 数据项目主管',
        items: [
          '负责 6 个大模型数据项目交付，搭建项目看板与风险分层机制，平均缩短 18% 交付周期。',
          '对接产品、算法和客户侧负责人，推动需求确认、质量校验与版本验收。',
        ],
      },
      {
        title: '2022.07-2024.03  智源跃动科技 · 项目经理',
        items: [
          '管理众包和全职标注团队，优化质检规则，稳定提升项目准确率。',
          '沉淀标签规范、培训材料和交付复盘模板。',
        ],
      },
    ],
    projectExperience: [
      {
        title: '金融客服大模型数据构建项目',
        items: [
          '负责意图体系、数据切片、难例回流和验收机制，支持模型多轮问答训练。',
          '建立周粒度风险预警和日报机制，减少跨团队信息延迟。',
        ],
      },
      {
        title: '企业知识库问答项目',
        items: [
          '推动检索增强场景的数据结构设计、清洗策略和交付排期。',
          '协同算法团队完成评测集建设和上线前验收。',
        ],
      },
    ],
    education: [
      {
        title: '2020-2022  北京邮电大学 · 智能科学与技术 · 硕士',
        items: ['研究方向：机器学习与智能系统应用。'],
      },
      {
        title: '2016-2020  华中科技大学 · 信息管理与信息系统 · 本科',
        items: ['有完整项目管理与数据分析课程背景。'],
      },
    ],
    skills: ['项目管理', '需求分析', 'AI 数据交付', '标注平台', 'Excel', 'SQL', 'Notion', '飞书多维表'],
    certificates: ['PMP（在考）', '英语六级'],
  },
}

const bossInitiatedGeek: BossMockGeekProfile = {
  geekId: 'geek-zou-yanqin-001',
  name: '邹燕琴',
  gender: '女',
  age: 40,
  activeLabel: '3日内活跃',
  experienceLabel: '10年以上',
  graduationLabel: '资深',
  educationLabel: '本科',
  expectedPosition: '北京 · 海外销售',
  expectedCity: '北京',
  expectedSalary: '面议',
  currentStatus: '在职',
  schoolName: '南昌大学',
  major: '自动化',
  recentFocus: '北京 · 海外销售 面议',
  currentCompany: '睿尔曼智能科技',
  currentRole: '海外销售',
  highlightTags: ['海外销售', '解决方案', '英语沟通'],
  attachmentResumeName: '邹燕琴-国际销售工程师-简历.pdf',
  onlineResume: {
    summary: '长期从事海外业务与解决方案协同，对技术型销售流程熟悉。',
    selfEvaluation: '能够把客户需求翻译成落地方案，擅长跨团队沟通。',
    expectation: ['北京', '海外销售', '面议'],
    workExperience: [
      {
        title: '2025.02-至今  睿尔曼智能科技 · 海外销售',
        items: ['负责重点海外客户跟进与商机推进。'],
      },
    ],
    projectExperience: [
      {
        title: '机器人解决方案出海项目',
        items: ['参与售前支持、方案讲解和商务推进。'],
      },
    ],
    education: [
      {
        title: '2004-2008  南昌大学 · 自动化 · 本科',
        items: ['自动化与电气基础扎实。'],
      },
    ],
    skills: ['海外销售', '英语', '售前沟通'],
    certificates: [],
  },
}

const geekInitiatedGeek: BossMockGeekProfile = {
  geekId: 'geek-zhao-yunlong-001',
  name: '赵云龙',
  gender: '男',
  age: 30,
  activeLabel: '刚刚活跃',
  experienceLabel: '2年',
  graduationLabel: '24届',
  educationLabel: '硕士',
  expectedPosition: '北京 · 销售工程师',
  expectedCity: '北京',
  expectedSalary: '45-70K',
  currentStatus: '在职',
  schoolName: '杜伊斯堡-埃森大学',
  major: '智能网络系统',
  recentFocus: '北京 · 销售工程师 45-70K',
  currentCompany: '汉朔科技股份有限公司（德国）',
  currentRole: '售前经理',
  highlightTags: ['售前', '英语', '海外项目', '技术支持'],
  attachmentResumeName: '赵云龙-国际销售工程师-简历.pdf',
  onlineResume: {
    summary: '海外售前与技术支持经验，熟悉解决方案讲解和客户沟通。',
    selfEvaluation: '能独立推进售前交流并处理技术问题。',
    expectation: ['北京', '销售工程师', '45-70K'],
    workExperience: [
      {
        title: '2024.05-至今  汉朔科技股份有限公司（德国） · 售前经理',
        items: ['负责海外客户售前沟通与 demo 支持。'],
      },
    ],
    projectExperience: [
      {
        title: '零售 IoT 海外部署项目',
        items: ['对接客户需求，推进方案与交付接口。'],
      },
    ],
    education: [
      {
        title: '2019-2024  杜伊斯堡-埃森大学 · 智能网络系统 · 硕士',
        items: ['德国项目经历，英语/德语可沟通。'],
      },
    ],
    skills: ['售前支持', '英语沟通', '客户需求分析'],
    certificates: [],
  },
}

const phoneSampleGeek: BossMockGeekProfile = {
  geekId: 'geek-sun-chiye-001',
  name: '孙驰野',
  gender: '男',
  age: 35,
  activeLabel: '刚刚活跃',
  experienceLabel: '10年',
  graduationLabel: '资深',
  educationLabel: '硕士',
  expectedPosition: '北京 · 海外市场',
  expectedCity: '北京',
  expectedSalary: '面议',
  currentStatus: '创业中',
  schoolName: '美国东北大学',
  major: '电气及计算机工程',
  recentFocus: '北京 · 海外市场 面议',
  currentCompany: '种子智能体互联科技',
  currentRole: '联合创始人',
  highlightTags: ['创业', '海外市场', '商务拓展'],
  attachmentResumeName: '孙驰野-国际商务经理-简历.pdf',
  onlineResume: {
    summary: '创业与海外市场拓展背景，对商务合作和项目推进节奏敏感。',
    selfEvaluation: '偏商务与资源整合型人才，适合高沟通密度岗位。',
    expectation: ['北京', '海外市场', '面议'],
    workExperience: [
      {
        title: '2025.03-2026.01  Bitdance 比特跳动 · 合伙人',
        items: ['负责国际合作与增长方向。'],
      },
    ],
    projectExperience: [
      {
        title: '海外渠道合作项目',
        items: ['负责合作谈判与资源协调。'],
      },
    ],
    education: [
      {
        title: '2013-2015  美国东北大学 · 电气及计算机工程 · 硕士',
        items: ['理工背景，兼具技术理解与商务推进能力。'],
      },
    ],
    skills: ['商务沟通', '资源整合', '海外合作'],
    certificates: [],
  },
}

const geeks: BossMockGeekProfile[] = [
  primaryGeekBase,
  bossInitiatedGeek,
  geekInitiatedGeek,
  phoneSampleGeek,
]

const recommendedBase: BossMockRecommendedGeek[] = [
  {
    geekId: PRIMARY_GEEK_ID,
    salaryExpectation: '18-25K',
    stageTag: '待打招呼',
    expectationType: '最近关注',
    targetPosition: '北京 项目经理/主管',
    targetCity: '北京',
    educationText: '北京邮电大学 智能科学与技术 硕士',
    skillHighlights: ['项目管理', '数据标注', '交付推进'],
    experiencePreview: ['2024.04-至今 星瀚智能 AI 数据项目主管', '2022.07-2024.03 智源跃动科技 项目经理'],
    canViewResume: true,
  },
  {
    geekId: bossInitiatedGeek.geekId,
    salaryExpectation: '面议',
    stageTag: '已沟通',
    expectationType: '期望',
    targetPosition: '北京 海外销售',
    targetCity: '北京',
    educationText: '南昌大学 自动化 本科',
    skillHighlights: ['海外销售', '售前沟通', '英语'],
    experiencePreview: ['2025.02-至今 睿尔曼智能科技 海外销售'],
    canViewResume: true,
  },
  {
    geekId: geekInitiatedGeek.geekId,
    salaryExpectation: '45-70K',
    stageTag: '牛人发起',
    expectationType: '期望',
    targetPosition: '北京 销售工程师',
    targetCity: '北京',
    educationText: '杜伊斯堡-埃森大学 智能网络系统 硕士',
    skillHighlights: ['售前支持', '海外项目', '英语沟通'],
    experiencePreview: ['2024.05-至今 汉朔科技股份有限公司（德国） 售前经理'],
    canViewResume: true,
  },
]

function textMessage(
  id: string,
  sender: 'boss' | 'geek',
  text: string,
  time?: string,
  readStatus?: '已读' | '送达'
): BossMockConversationMessage {
  return { id, type: 'text', sender, text, time, readStatus }
}

function systemNote(id: string, text: string): BossMockConversationMessage {
  return { id, type: 'system_note', text }
}

function cardMessage(
  id: string,
  sender: 'boss' | 'geek' | 'system',
  variant: BossMockConversationCard['variant'],
  title: string,
  buttons: string[],
  time?: string,
  description?: string,
  number?: string
): BossMockConversationMessage {
  return {
    id,
    type: 'card',
    sender,
    variant,
    title,
    buttons,
    time,
    description,
    number,
  }
}

function buildPrimaryMessages(stage: BossLifecycleStage): BossMockConversationMessage[] {
  const messages: BossMockConversationMessage[] = [
    cardMessage(
      'msg-primary-pos',
      'system',
      'position_header',
      '4月20日 沟通的职位-大模型数据项目经理',
      []
    ),
  ]

  if (stage === 'fresh') {
    return messages
  }

  messages.push(
    textMessage(
      'msg-primary-boss-greet',
      'boss',
      '你好，刚刚看了你的简历，觉得你很适合我们的岗位，不知道你方不方便聊一聊呢',
      '04-20 10:01',
      '已读'
    ),
    textMessage('msg-primary-geek-reply', 'geek', '您好，可以先了解下业务方向和团队配置吗？', '04-20 10:08')
  )

  if (stage === 'greeted') {
    return messages
  }

  messages.push(
    textMessage(
      'msg-primary-boss-resume',
      'boss',
      '方便发一份简历过来吗？',
      '04-20 10:12',
      '已读'
    ),
    textMessage('msg-primary-geek-resume-text', 'geek', '可以的，这是我的简历，您看看', '04-20 10:14'),
    cardMessage(
      'msg-primary-geek-resume-consent',
      'geek',
      'resume_consent',
      '对方想发送附件简历给您，您是否同意',
      ['拒绝', '同意'],
      undefined
    ),
    cardMessage(
      'msg-primary-geek-resume-file',
      'geek',
      'resume_file',
      '林知夏-大模型数据项目经理-简历.pdf',
      ['点击预览附件简历']
    ),
    textMessage('msg-primary-boss-qa-1', 'boss', '目前是在职还是离职呐', undefined, '已读'),
    textMessage('msg-primary-geek-qa-1', 'geek', '在职，能在 2 周内完成交接。', '04-20 10:20'),
    textMessage('msg-primary-boss-qa-2', 'boss', '毕业之前可先开始实习/试岗吗？', '04-20 10:26', '已读'),
    textMessage('msg-primary-geek-qa-2', 'geek', '可以，本周就能安排时间。')
  )

  if (stage === 'resume_received') {
    return messages
  }

  messages.push(
    systemNote('msg-primary-request-wechat-note', '请求交换微信已发送'),
    textMessage('msg-primary-boss-wechat-text', 'boss', '您加我个微信，咱们简单线上沟通下', undefined, '已读'),
    cardMessage(
      'msg-primary-geek-wechat-card',
      'system',
      'contact_card_wechat',
      '林知夏的微信号：\nlinzhixia_ai_pm',
      ['复制微信号'],
      undefined,
      undefined,
      'linzhixia_ai_pm'
    )
  )

  return messages
}

function buildPrimaryConversation(stage: BossLifecycleStage): BossMockConversation | null {
  if (stage === 'fresh') {
    return null
  }

  const previewByStage: Record<Exclude<BossLifecycleStage, 'fresh'>, string> = {
    greeted: '您好，可以先了解下业务方向和团队配置吗？',
    resume_received: '林知夏-大模型数据项目经理-简历.pdf',
    contact_received: '林知夏的微信号：linzhixia_ai_pm',
  }

  const tagsByStage: Record<Exclude<BossLifecycleStage, 'fresh'>, BossMockConversation['tags']> = {
    greeted: ['全部', '沟通中', '我发起'],
    resume_received: ['全部', '沟通中', '我发起', '已获取简历'],
    contact_received: ['全部', '沟通中', '我发起', '已获取简历', '已交换微信'],
  }

  return {
    conversationId: `conv-primary-${stage}`,
    geekId: PRIMARY_GEEK_ID,
    jobId: PRIMARY_JOB_ID,
    previewDate: '今天',
    unreadCount: 0,
    pinned: true,
    previewText: previewByStage[stage],
    tags: tagsByStage[stage],
    relation: 'primary_lifecycle',
    messages: buildPrimaryMessages(stage),
  }
}

const sampleConversations: BossMockConversation[] = [
  {
    conversationId: 'conv-boss-initiated-001',
    geekId: bossInitiatedGeek.geekId,
    jobId: 'job-ai-sales-001',
    previewDate: '04月16日',
    unreadCount: 0,
    previewText: '谢谢，什么产品线方向呢？',
    tags: ['全部', '沟通中', '我发起'],
    relation: 'boss_initiated_sample',
    messages: [
      cardMessage('msg-zou-pos', 'system', 'position_header', '4月16日 沟通的职位-国际销售工程师', []),
      textMessage(
        'msg-zou-boss-greet',
        'boss',
        '你好，刚刚看了你的简历，觉得你很适合我们的岗位，不知道你方不方便聊一聊呢',
        '04-16 09:24',
        '已读'
      ),
      cardMessage(
        'msg-zou-priority',
        'system',
        'priority_hint',
        '此牛人近日被开聊较多，是否让您的消息 优先提醒Ta？',
        ['优先提醒Ta']
      ),
      systemNote('msg-zou-recall', '邹燕琴撤回了一条消息'),
      textMessage('msg-zou-reply', 'geek', '谢谢，什么产品线方向呢？', '04-16 09:33'),
    ],
  },
  {
    conversationId: 'conv-geek-initiated-001',
    geekId: geekInitiatedGeek.geekId,
    jobId: 'job-ai-sales-001',
    previewDate: '昨天',
    unreadCount: 1,
    previewText: '我想要和您交换微信，您是否同意',
    tags: ['全部', '沟通中', '牛人发起'],
    relation: 'geek_initiated_sample',
    messages: [
      cardMessage('msg-zhao-pos', 'system', 'position_header', '4月15日 沟通的职位-国际销售工程师', []),
      textMessage(
        'msg-zhao-boss-greet',
        'boss',
        '你好，刚刚看了你的简历，觉得你很适合我们的岗位，不知道你方不方便聊一聊呢',
        '04-15 21:56',
        '已读'
      ),
      textMessage('msg-zhao-geek-text', 'geek', '您好，这是我的微信', '昨天 17:18'),
      cardMessage(
        'msg-zhao-contact-request',
        'geek',
        'contact_request',
        '我想要和您交换微信，您是否同意',
        ['拒绝', '同意']
      ),
    ],
  },
  {
    conversationId: 'conv-phone-sample-001',
    geekId: phoneSampleGeek.geekId,
    jobId: 'job-ai-sales-001',
    previewDate: '04月08日',
    unreadCount: 0,
    previewText: '孙驰野的手机号：13800001234',
    tags: ['全部', '沟通中', '已交换电话'],
    relation: 'contact_sample',
    messages: [
      textMessage('msg-sun-1', 'boss', '咱们电话沟通一下？', '04-08 10:43', '已读'),
      textMessage('msg-sun-2', 'geek', '稍晚一会可以不', '04-08 10:45'),
      textMessage('msg-sun-3', 'boss', '可以的，您今天有时间可以沟通下吗', '04-08 10:52', '已读'),
      textMessage('msg-sun-4', 'geek', '11点？'),
      cardMessage(
        'msg-sun-contact-request',
        'geek',
        'contact_request',
        '我想要和您交换联系方式，您是否同意',
        ['拒绝', '同意'],
        '04-08 10:59'
      ),
      textMessage('msg-sun-5', 'geek', '我打给您？'),
      textMessage('msg-sun-6', 'boss', '我现在打给您', undefined, '已读'),
      textMessage('msg-sun-7', 'geek', '好的'),
      cardMessage(
        'msg-sun-contact-card',
        'system',
        'contact_card_phone',
        '孙驰野的手机号：\n13800001234',
        ['复制手机号'],
        undefined,
        undefined,
        '13800001234'
      ),
    ],
  },
]

function cloneConversation(conversation: BossMockConversation): BossMockConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({ ...message })),
    tags: [...conversation.tags],
  }
}

function buildJobs(stage: BossLifecycleStage): BossMockJob[] {
  const communicatedByStage: Record<BossLifecycleStage, number> = {
    fresh: 0,
    greeted: 1,
    resume_received: 1,
    contact_received: 1,
  }
  const interestedByStage: Record<BossLifecycleStage, number> = {
    fresh: 0,
    greeted: 1,
    resume_received: 1,
    contact_received: 1,
  }

  const primary = {
    ...primaryJobBase,
    stats: {
      ...primaryJobBase.stats,
      communicated: communicatedByStage[stage],
      interested: interestedByStage[stage],
    },
  }

  return [primary, ...sideJobs]
}

function buildRecommendedGeeks(stage: BossLifecycleStage): BossMockRecommendedGeek[] {
  const primaryTagByStage: Record<BossLifecycleStage, string> = {
    fresh: '待打招呼',
    greeted: '已沟通',
    resume_received: '已收简历',
    contact_received: '已交换微信',
  }

  return recommendedBase.map((item) => {
    if (item.geekId !== PRIMARY_GEEK_ID) return { ...item, skillHighlights: [...item.skillHighlights], experiencePreview: [...item.experiencePreview] }
    return {
      ...item,
      stageTag: primaryTagByStage[stage],
      skillHighlights: [...item.skillHighlights],
      experiencePreview: [...item.experiencePreview],
    }
  })
}

function buildDashboard(stage: BossLifecycleStage) {
  return {
    totalCommunications: stage === 'fresh' ? 3 : 4,
    newGreetings: stage === 'fresh' ? 1 : 0,
    inProgress: 3,
    resumeReceived: stage === 'resume_received' || stage === 'contact_received' ? 2 : 1,
    phoneExchanged: 1,
    wechatExchanged: stage === 'contact_received' ? 1 : 0,
  }
}

const greetDraft =
  '你好，刚刚看了你的简历，觉得你很适合我们的岗位，不知道你方不方便聊一聊呢'

function buildScenario(stage: BossLifecycleStage): BossMockScenario {
  const primaryConversation = buildPrimaryConversation(stage)
  const conversations = [
    ...(primaryConversation ? [primaryConversation] : []),
    ...sampleConversations.map(cloneConversation),
  ]

  return {
    id: stage,
    label:
      stage === 'fresh'
        ? '阶段 0：未沟通'
        : stage === 'greeted'
          ? '阶段 1：已打招呼'
          : stage === 'resume_received'
            ? '阶段 2：已收简历'
            : '阶段 3：已收联系方式',
    description:
      stage === 'fresh'
        ? '主候选人还停留在推荐牛人池，可从推荐页进入打招呼页。'
        : stage === 'greeted'
          ? '主候选人已建立初次沟通，适合测试沟通列表与消息详情。'
          : stage === 'resume_received'
            ? '主候选人已完成索要简历与附件简历接收。'
            : '主候选人已完成微信交换，形成完整链路。',
    defaultPage: stage === 'fresh' ? 'recommend' : 'chat',
    primaryJobId: PRIMARY_JOB_ID,
    primaryGeekId: PRIMARY_GEEK_ID,
    dashboard: buildDashboard(stage),
    jobs: buildJobs(stage),
    geeks: geeks.map((geek) => ({
      ...geek,
      highlightTags: [...geek.highlightTags],
      onlineResume: {
        ...geek.onlineResume,
        expectation: [...geek.onlineResume.expectation],
        skills: [...geek.onlineResume.skills],
        certificates: [...geek.onlineResume.certificates],
        workExperience: geek.onlineResume.workExperience.map((section) => ({ ...section, items: [...section.items] })),
        projectExperience: geek.onlineResume.projectExperience.map((section) => ({ ...section, items: [...section.items] })),
        education: geek.onlineResume.education.map((section) => ({ ...section, items: [...section.items] })),
      },
    })),
    recommendedGeeks: buildRecommendedGeeks(stage),
    conversations,
    quickActions: [
      {
        id: 'request_resume',
        label: '求简历',
        confirmTitle: '确定向牛人索取简历吗？',
        nextStage: stage === 'greeted' ? 'resume_received' : undefined,
      },
      {
        id: 'request_phone',
        label: '换电话',
        confirmTitle: '确定向牛人索取手机联系方式吗？',
      },
      {
        id: 'request_wechat',
        label: '换微信',
        confirmTitle: '确定向牛人发起交换微信吗？',
        nextStage: stage === 'resume_received' ? 'contact_received' : undefined,
      },
      {
        id: 'schedule_interview',
        label: '约面试',
        confirmTitle: '确定向牛人发起约面试吗？',
      },
      {
        id: 'reject',
        label: '不合适',
        confirmTitle: '确定将该牛人标记为不合适吗？',
      },
    ],
    greetDraft,
  }
}

export const BOSS_MOCK_SCENARIOS: BossMockScenario[] = [
  buildScenario('fresh'),
  buildScenario('greeted'),
  buildScenario('resume_received'),
  buildScenario('contact_received'),
]

export function getBossMockScenario(stage: BossLifecycleStage): BossMockScenario {
  return BOSS_MOCK_SCENARIOS.find((scenario) => scenario.id === stage) ?? BOSS_MOCK_SCENARIOS[0]
}

export const BOSS_MOCK_DEFAULT_STAGE: BossLifecycleStage = 'fresh'
