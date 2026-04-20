export type BossMockPageId = 'jobs' | 'recommend' | 'greet' | 'chat' | 'resume'
export type BossLifecycleStage = 'fresh' | 'greeted' | 'resume_received' | 'contact_received'
export type ChatTag =
  | '全部'
  | '新招呼'
  | '沟通中'
  | '已约面'
  | '已获取简历'
  | '已交换电话'
  | '已交换微信'
  | '收藏'
  | '我发起'
  | '牛人发起'

export interface BossMockQuickAction {
  id: 'request_resume' | 'request_phone' | 'request_wechat' | 'schedule_interview' | 'reject'
  label: string
  confirmTitle?: string
  nextStage?: BossLifecycleStage
}

export interface BossMockDashboard {
  totalCommunications: number
  newGreetings: number
  inProgress: number
  resumeReceived: number
  phoneExchanged: number
  wechatExchanged: number
}

export interface BossMockResumeSection {
  title: string
  items: string[]
}

export interface BossMockOnlineResume {
  summary: string
  selfEvaluation: string
  expectation: string[]
  workExperience: BossMockResumeSection[]
  projectExperience: BossMockResumeSection[]
  education: BossMockResumeSection[]
  skills: string[]
  certificates: string[]
}

export interface BossMockGeekProfile {
  geekId: string
  name: string
  gender: '男' | '女'
  age: number
  activeLabel: string
  experienceLabel: string
  graduationLabel: string
  educationLabel: string
  expectedPosition: string
  expectedCity: string
  expectedSalary: string
  currentStatus: string
  schoolName: string
  major: string
  schoolTag?: string
  rankTag?: string
  recentFocus: string
  currentCompany?: string
  currentRole?: string
  highlightTags: string[]
  attachmentResumeName?: string
  onlineResume: BossMockOnlineResume
}

export interface BossMockRecommendedGeek {
  geekId: string
  salaryExpectation: string
  stageTag: string
  expectationType: '最近关注' | '期望'
  targetPosition: string
  targetCity: string
  educationText: string
  skillHighlights: string[]
  experiencePreview: string[]
  canViewResume: boolean
}

export interface BossMockJob {
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
  status: '开放中' | '待开放' | '已关闭'
  expireAt: string
  stats: {
    viewed: number
    communicated: number
    interested: number
  }
  jd: {
    subtitle: string
    highlights: string[]
    responsibilities: string[]
    requirements: string[]
    tags: string[]
  }
}

export interface BossMockConversationMessageBase {
  id: string
}

export interface BossMockConversationTextMessage extends BossMockConversationMessageBase {
  type: 'text'
  sender: 'boss' | 'geek'
  time?: string
  readStatus?: '已读' | '送达'
  text: string
}

export interface BossMockConversationSystemNote extends BossMockConversationMessageBase {
  type: 'system_note'
  text: string
}

export interface BossMockConversationCard extends BossMockConversationMessageBase {
  type: 'card'
  sender: 'boss' | 'geek' | 'system'
  time?: string
  variant:
    | 'position_header'
    | 'resume_consent'
    | 'resume_file'
    | 'contact_request'
    | 'contact_card_phone'
    | 'contact_card_wechat'
    | 'priority_hint'
  title: string
  description?: string
  number?: string
  buttons: string[]
}

export type BossMockConversationMessage =
  | BossMockConversationTextMessage
  | BossMockConversationSystemNote
  | BossMockConversationCard

export interface BossMockConversation {
  conversationId: string
  geekId: string
  jobId: string
  previewDate: string
  unreadCount: number
  pinned?: boolean
  previewText: string
  tags: ChatTag[]
  relation: 'primary_lifecycle' | 'boss_initiated_sample' | 'geek_initiated_sample' | 'contact_sample'
  messages: BossMockConversationMessage[]
}

export interface BossMockScenario {
  id: BossLifecycleStage
  label: string
  description: string
  defaultPage: BossMockPageId
  primaryJobId: string
  primaryGeekId: string
  dashboard: BossMockDashboard
  jobs: BossMockJob[]
  geeks: BossMockGeekProfile[]
  recommendedGeeks: BossMockRecommendedGeek[]
  conversations: BossMockConversation[]
  quickActions: BossMockQuickAction[]
  greetDraft: string
}
