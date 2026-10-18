import type { FromPopup, PopupStatus, SelfTestReport } from '../shared/messages'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const ask = <T>(message: FromPopup): Promise<T> =>
  chrome.runtime.sendMessage(message) as Promise<T>

const ago = (at: number | null): string => {
  if (!at) return 'none yet'
  const seconds = Math.round((Date.now() - at) / 1000)
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`
}

const render = (status: PopupStatus): void => {
  $('version').textContent = `v${status.extensionVersion}`
  const dot = $('dot')
  dot.className = `dot ${status.connected ? 'ok' : 'bad'}`
  $('state').textContent = status.connected ? 'Connected to VS Code' : 'Not connected'
  $('hint').textContent = status.connected
    ? status.chatgptTabs === 0
      ? 'Open chatgpt.com in a tab and sign in.'
      : 'Ready. Start a run from the CodeGent panel in VS Code.'
    : (status.lastError ??
      'Open VS Code with the CodeGent extension; this connects automatically.')
  $('hub').textContent =
    status.connected && status.hubPort ? `127.0.0.1:${status.hubPort}` : '–'
  $('tabs').textContent = String(status.chatgptTabs)
  $('jobs').textContent =
    `${status.activeJobs}  (last activity: ${ago(status.lastEventAt)})`
  $('browserId').textContent = status.browserId.slice(0, 8)
  const profile = $<HTMLInputElement>('profile')
  if (document.activeElement !== profile && profile.value !== status.profile) {
    profile.value = status.profile
  }
}

const refresh = async (): Promise<void> => {
  try {
    render(await ask<PopupStatus>({ type: 'popup:status' }))
  } catch {
    $('state').textContent = 'Extension is restarting…'
  }
}

/** The report as plain text, so it can be pasted into a bug report. */
const reportAsText = (report: SelfTestReport): string =>
  [
    `CodeGent self-test ${report.at} ${report.url}`,
    ...report.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`),
    ...(report.outline ? ['', report.outline] : [])
  ].join('\n')

let reportText = ''

const showReport = (report: SelfTestReport | { error: string }): void => {
  const list = $('report')
  list.hidden = false
  list.replaceChildren()
  reportText = 'error' in report ? '' : reportAsText(report)
  $('copyreport').hidden = reportText === ''
  if ('error' in report) {
    const item = document.createElement('li')
    item.innerHTML = '<span class="fail">✗</span><div><div class="name"></div></div>'
    item.querySelector('.name')!.textContent = report.error
    list.append(item)
    return
  }
  for (const check of report.checks) {
    const item = document.createElement('li')
    item.innerHTML =
      '<span></span><div><div class="name"></div><div class="detail"></div></div>'
    const mark = item.querySelector('span')!
    mark.textContent = check.ok ? '✓' : '✗'
    mark.className = check.ok ? 'pass' : 'fail'
    item.querySelector('.name')!.textContent = check.name
    item.querySelector('.detail')!.textContent = check.detail
    list.append(item)
  }
}

$('reconnect').addEventListener('click', async () => {
  await ask({ type: 'popup:reconnect' })
  setTimeout(refresh, 600)
})

$('copyreport').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('copyreport')
  try {
    await navigator.clipboard.writeText(reportText)
    button.textContent = 'Copied'
  } catch {
    button.textContent = 'Copy failed'
  }
  setTimeout(() => (button.textContent = 'Copy report'), 1_500)
})

$('selftest').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('selftest')
  button.disabled = true
  button.textContent = 'Testing…'
  try {
    const probeFill = $<HTMLInputElement>('probe').checked
    showReport(
      await ask<SelfTestReport | { error: string }>({
        type: 'popup:self-test',
        probeFill
      })
    )
  } finally {
    button.disabled = false
    button.textContent = 'Test ChatGPT page'
  }
})

$<HTMLInputElement>('profile').addEventListener('change', async (event) => {
  await ask({
    type: 'popup:set-profile',
    profile: (event.target as HTMLInputElement).value
  })
  void refresh()
})

void refresh()
setInterval(refresh, 1_500)
