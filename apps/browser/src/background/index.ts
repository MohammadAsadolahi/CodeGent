import type {
  FromContent,
  FromPopup,
  PopupStatus,
  SelfTestReport,
  ToContent
} from '../shared/messages'
import { browserName } from './browser-info'
import { CHAT_TAB_PATTERNS, KEEPALIVE_ALARM } from './config'
import { HubLink } from './hub-link'
import { JobRouter, type BrowserApi } from './jobs'
import {
  loadBrowserId,
  loadProfile,
  makeOutboxStore,
  saveProfile,
  WorkerState
} from './state'

const settings = chrome.storage.local
const volatile = chrome.storage.session

const state = new WorkerState(volatile)
let lastEventAt: number | null = null

const api: BrowserApi = {
  tabs: {
    get: (tabId) => chrome.tabs.get(tabId),
    create: async (properties) => {
      try {
        return await chrome.tabs.create(properties)
      } catch (error) {
        // A browser can be running with no windows at all (macOS, or background mode).
        if (!/no current window/i.test(String((error as Error)?.message ?? error)))
          throw error
        const created = await chrome.windows.create({
          url: properties.url,
          focused: true
        })
        const tab = created?.tabs?.[0]
        if (!tab) throw error
        return tab
      }
    },
    update: (tabId, properties) => chrome.tabs.update(tabId, properties),
    reload: (tabId) => chrome.tabs.reload(tabId),
    sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message)
  },
  scripting: {
    executeScript: (injection) => chrome.scripting.executeScript(injection)
  }
}

const identity = async () => ({
  browserId: await loadBrowserId(settings),
  name: browserName(navigator.userAgent),
  profile: await loadProfile(settings),
  userAgent: navigator.userAgent,
  extensionVersion: chrome.runtime.getManifest().version
})

const countChatTabs = async (): Promise<number> =>
  (await chrome.tabs.query({ url: CHAT_TAB_PATTERNS })).length

const announcePresence = async (): Promise<void> => {
  link.sendPresence({
    chatgptTabs: await countChatTabs(),
    profile: (await loadProfile(settings)) || undefined
  })
}

let presenceTimer: ReturnType<typeof setTimeout> | undefined
const schedulePresence = () => {
  if (presenceTimer) clearTimeout(presenceTimer)
  presenceTimer = setTimeout(() => void announcePresence(), 400)
}

const link: HubLink = new HubLink({
  identity,
  outbox: makeOutboxStore(volatile),
  onJob: (job) => void router.handleJob(job),
  onCancel: (cancel) => void router.handleCancel(cancel),
  onConnected: () => void announcePresence()
})

const router: JobRouter = new JobRouter({
  api,
  state,
  send: (message) => {
    lastEventAt = Date.now()
    return link.sendEvent(message)
  }
})

const getStatus = async (): Promise<PopupStatus> => {
  const who = await identity()
  return {
    connected: link.state === 'connected',
    hubPort: link.port,
    browserId: who.browserId,
    profile: who.profile,
    extensionVersion: who.extensionVersion,
    chatgptTabs: await countChatTabs(),
    activeJobs: await router.activeJobCount(),
    lastError: link.lastError,
    lastEventAt
  }
}

const runSelfTest = async (
  probeFill: boolean
): Promise<SelfTestReport | { error: string }> => {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: CHAT_TAB_PATTERNS
  })
  const [any] = active ? [active] : await chrome.tabs.query({ url: CHAT_TAB_PATTERNS })
  if (any?.id === undefined) return { error: 'Open chatgpt.com in a tab first.' }
  try {
    const message: ToContent = { type: 'self-test', probeFill }
    return (await chrome.tabs.sendMessage(any.id, message)) as SelfTestReport
  } catch {
    return { error: 'The page did not answer. Reload the ChatGPT tab and try again.' }
  }
}

const injectIntoOpenTabs = async (): Promise<void> => {
  for (const tab of await chrome.tabs.query({ url: CHAT_TAB_PATTERNS })) {
    if (tab.id === undefined) continue
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      })
    } catch {
      // tab may be discarded or not yet ready; it will load the script by itself
    }
  }
}

// ── listeners (must be registered synchronously so a sleeping worker is woken by them) ──────
chrome.runtime.onMessage.addListener(
  (message: FromContent | FromPopup, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false
    switch (message?.type) {
      case 'content-ready': {
        const tabId = sender.tab?.id
        if (tabId === undefined) {
          sendResponse({ job: null })
          return false
        }
        void router.handleContentReady(tabId).then(sendResponse)
        return true
      }
      case 'content-ping':
        void link.ensureConnected()
        sendResponse({ ok: true })
        return false
      case 'job-event':
        void router.handleContentEvent(message).then(() => sendResponse({ ok: true }))
        return true
      case 'popup:status':
        void getStatus().then(sendResponse)
        return true
      case 'popup:reconnect':
        link.reconnectNow()
        sendResponse({ ok: true })
        return false
      case 'popup:set-profile':
        void saveProfile(settings, message.profile).then(() => {
          link.reconnectNow() // the hub learns the new label from the connection URL
          sendResponse({ ok: true })
        })
        return true
      case 'popup:self-test':
        void runSelfTest(message.probeFill).then(sendResponse)
        return true
      default:
        return false
    }
  }
)

chrome.tabs.onRemoved.addListener((tabId) => {
  void router.onTabRemoved(tabId)
  schedulePresence()
})
chrome.tabs.onCreated.addListener(schedulePresence)
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.status === 'complete') schedulePresence()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  void link.ensureConnected()
  void router.tick()
})

chrome.runtime.onInstalled.addListener(() => void injectIntoOpenTabs())

// ── start ────────────────────────────────────────────────────────────────────────────────────
void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
link.start()
void router.resume()
