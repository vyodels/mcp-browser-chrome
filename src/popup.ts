type BossLifecycleStage = 'fresh' | 'greeted' | 'resume_received' | 'contact_received'

interface BossMockConfig {
  enabled: boolean
  scenarioId: BossLifecycleStage
  page: 'jobs' | 'recommend' | 'greet' | 'chat' | 'resume'
}

const STORAGE_KEY = 'bossMockConfig'
const DEFAULT_CONFIG: BossMockConfig = {
  enabled: false,
  scenarioId: 'fresh',
  page: 'recommend',
}

const mockEnabled = document.getElementById('mockEnabled') as HTMLInputElement
const scenarioSelect = document.getElementById('scenarioSelect') as HTMLSelectElement
const applyBtn = document.getElementById('applyBtn') as HTMLButtonElement
const disableBtn = document.getElementById('disableBtn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement

function setStatus(text: string) {
  statusEl.textContent = text
}

function mockUrl(config: BossMockConfig) {
  const url = new URL(chrome.runtime.getURL('mock-boss.html'))
  url.searchParams.set('scenario', config.scenarioId)
  url.searchParams.set('page', config.page)
  return url.toString()
}

async function readConfig(): Promise<BossMockConfig> {
  const data = await chrome.storage.local.get(STORAGE_KEY)
  return {
    ...DEFAULT_CONFIG,
    ...(data[STORAGE_KEY] as Partial<BossMockConfig> | undefined),
  }
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id
}

async function renderFromStorage() {
  const config = await readConfig()
  mockEnabled.checked = config.enabled
  scenarioSelect.value = config.scenarioId
  setStatus(config.enabled ? '当前可切换到 BOSS Mock 页面' : '当前为真实页面模式')
}

async function applyMock(enabled: boolean) {
  const tabId = await activeTabId()
  if (!tabId) {
    setStatus('没有找到当前标签页')
    return
  }

  const nextConfig: BossMockConfig = {
    enabled,
    scenarioId: scenarioSelect.value as BossLifecycleStage,
    page: enabled ? (scenarioSelect.value === 'fresh' ? 'recommend' : 'chat') : 'jobs',
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: nextConfig })

  if (enabled) {
    await chrome.tabs.update(tabId, { url: mockUrl(nextConfig) })
    setStatus('已切到页面级 mock')
  } else {
    await chrome.tabs.update(tabId, { url: 'https://www.zhipin.com/web/chat/job/list' })
    setStatus('已切回 zhipin.com')
  }
}

applyBtn.addEventListener('click', () => {
  void applyMock(mockEnabled.checked)
})

disableBtn.addEventListener('click', () => {
  mockEnabled.checked = false
  void applyMock(false)
})

mockEnabled.addEventListener('change', () => {
  setStatus(mockEnabled.checked ? '点击“应用到当前页”后将切到 mock' : '点击“应用到当前页”后将切回真实页面')
})

scenarioSelect.addEventListener('change', () => {
  setStatus(`已选择 ${scenarioSelect.options[scenarioSelect.selectedIndex]?.text ?? ''}`)
})

void renderFromStorage()
