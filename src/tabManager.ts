// ============================================================
// tabManager.ts — Chrome 标签页分组管理
// 每个 Agent 任务创建独立的标签组，与用户其他标签页隔离
// ============================================================

export interface ManagedTab {
  id: number
  url: string
  title: string
  favIconUrl?: string
  groupId?: number
}

// 发送消息的辅助函数（由 sidepanel 注入）
type SendMsg = (msg: object) => Promise<unknown>

// 获取当前窗口所有标签页
export async function getAllTabs(sendMsg: SendMsg): Promise<ManagedTab[]> {
  const resp = await sendMsg({ type: 'GET_ALL_TABS' }) as {
    success: boolean
    tabs?: ManagedTab[]
  }
  return resp.tabs ?? []
}

// 为任务创建标签组，将指定 tabIds 加入组
export async function createTaskTabGroup(
  sendMsg: SendMsg,
  tabIds: number[],
  taskName: string
): Promise<number | null> {
  const resp = await sendMsg({
    type: 'CREATE_TAB_GROUP',
    payload: {
      tabIds,
      title: `Agent: ${taskName}`,
      color: 'blue',
    },
  }) as { success: boolean; groupId?: number; error?: string }

  if (!resp.success) {
    console.error('创建标签组失败:', resp.error)
    return null
  }
  return resp.groupId ?? null
}

// 在指定标签组中打开新标签页
export async function openTabInGroup(
  sendMsg: SendMsg,
  url: string | undefined,
  groupId: number
): Promise<number | null> {
  const resp = await sendMsg({
    type: 'OPEN_TAB',
    payload: { url, groupId },
  }) as { success: boolean; tabId?: number; error?: string }

  if (!resp.success) return null
  return resp.tabId ?? null
}

// 关闭整个任务标签组（关闭组内所有标签页）
export async function closeTaskTabGroup(sendMsg: SendMsg, groupId: number): Promise<void> {
  await sendMsg({ type: 'CLOSE_TAB_GROUP', payload: { groupId } })
}
