import { availableChannels, filterByChannel, orderedTasks } from '../core/selectors'
import type { Logger } from '../core/logger'
import type { SettingsStore } from '../core/settings'
import type { SyncController } from '../core/sync'
import type { TaskStore } from '../core/taskStore'
import type { Settings } from '../core/types'
import { APP_NAME, CONNECT_URL, PRIVACY_URL } from '../core/config'

export interface PhoneUiDeps {
  root: HTMLElement
  store: TaskStore
  settings: SettingsStore
  sync: SyncController
  logger: Logger
  providerName: 'mock' | 'sunsama'
  hasBridge: boolean
  /** Null in mock mode, where there is nothing to connect. */
  auth: { connect(bundle: string): Promise<void>; disconnect(): Promise<void> } | null
}

const AUTH_LABEL = { unknown: 'Checking…', signedOut: 'Not connected', signedIn: 'Connected', expired: 'Sign-in expired' }

/** The page shown inside the Even phone app: status, sign-in, a mirror of today's tasks, settings. */
export function mountPhoneUi(deps: PhoneUiDeps): { focusConnect(): void } {
  const { root, store, settings, sync, logger } = deps
  root.innerHTML = `
    <header><h1>${APP_NAME}</h1><p id="status"></p></header>
    <section id="connect" ${deps.auth ? '' : 'hidden'}>
      <h2>Connect</h2>
      <ol class="hint steps">
        <li>In your phone's browser open <a href="${CONNECT_URL}" target="_blank" rel="noopener">${CONNECT_URL.replace('https://', '')}</a> and sign in to Sunsama (requires Sunsama Pro).</li>
        <li>Copy the sign-in code it shows.</li>
        <li>Paste it here and tap Save.</li>
      </ol>
      <textarea id="bundle" rows="3" placeholder="Paste the sign-in code (starts with es1.)" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      <div class="row">
        <button id="save">Save</button>
        <button id="disconnect" class="quiet">Disconnect</button>
      </div>
      <p id="connectMsg" class="hint"></p>
    </section>
    <section>
      <h2>Today <button id="refresh" class="quiet small">Refresh</button></h2>
      <ul id="tasks"></ul>
    </section>
    <section>
      <h2>Channels</h2>
      <p class="hint">Choose which channels show up on the glasses. Nothing checked off here means every channel.</p>
      <div id="channels"></div>
    </section>
    <section>
      <h2>Meeting reminder</h2>
      <label class="check"><input id="meetingReminderEnabled" type="checkbox" /> Show a banner before meetings</label>
      <label>Minutes before the meeting <input id="meetingReminderLeadMin" type="number" min="1" max="60" step="1" /></label>
    </section>
    <section>
      <h2>Settings</h2>
      <label>Start screen
        <select id="startScreen"><option value="face">Face</option><option value="tasks">Tasks</option></select>
      </label>
      <label>Face numbers
        <select id="faceClockMode"><option value="image">Large (image)</option><option value="text">Plain text</option></select>
      </label>
      <label>Refresh every (seconds) <input id="pollSeconds" type="number" min="30" max="3600" step="30" /></label>
      <label class="check"><input id="showCompleted" type="checkbox" /> Show completed tasks</label>
      <label class="check"><input id="clock24h" type="checkbox" /> 24-hour clock</label>
    </section>
    <section>
      <h2>Log</h2>
      <pre id="log"></pre>
    </section>
    <p class="hint footer">Not affiliated with Sunsama. <a href="${PRIVACY_URL}" target="_blank" rel="noopener">Privacy policy</a></p>`

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`) as T
  const statusEl = $('status')
  const tasksEl = $<HTMLUListElement>('tasks')
  const channelsEl = $('channels')
  const logEl = $('log')
  const connectMsg = $('connectMsg')
  const bundleEl = $<HTMLTextAreaElement>('bundle')

  function renderStatus(): void {
    const s = store.getState()
    const synced = s.lastSyncAt ? `synced ${new Date(s.lastSyncAt).toLocaleTimeString()}` : 'not synced yet'
    statusEl.textContent = [
      deps.providerName === 'mock' ? 'Mock data' : AUTH_LABEL[s.auth],
      s.tz,
      s.status === 'error' ? `error: ${s.lastError}` : synced,
      deps.hasBridge ? 'glasses bridge ready' : 'no glasses bridge (browser only)',
    ]
      .filter(Boolean)
      .join(' · ')
  }

  function renderTasks(): void {
    const s = store.getState()
    const visible = filterByChannel(s.tasks, settings.get().channelFilter)
    tasksEl.replaceChildren(
      ...orderedTasks(visible, settings.get().showCompleted).map(task => {
        const li = document.createElement('li')
        const label = document.createElement('label')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = task.completed
        box.disabled = task.id in s.pending
        box.addEventListener('change', () => void store.toggle(task.id))
        const text = document.createElement('span')
        text.textContent = task.subtasksTotal ? `${task.title} (${task.subtasksDone}/${task.subtasksTotal})` : task.title
        if (task.completed) text.className = 'done'
        label.append(box, text)
        li.append(label)
        return li
      }),
    )
    if (!visible.length) tasksEl.innerHTML = `<li class="hint">${s.tasks.length ? 'No tasks in the selected channels' : 'No tasks loaded'}</li>`
  }

  function renderChannels(): void {
    const channels = availableChannels(store.getState().tasks)
    const filter = settings.get().channelFilter
    channelsEl.replaceChildren(
      ...(channels.length ? channels : ['(none yet — refresh once tasks load)']).map(channel => {
        const label = document.createElement('label')
        label.className = 'check'
        if (!channels.length) {
          label.className = 'hint'
          label.textContent = channel
          return label
        }
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = filter.length === 0 || filter.includes(channel)
        box.addEventListener('change', () => {
          const current = filter.length === 0 ? channels : filter
          const next = box.checked ? [...new Set([...current, channel])] : current.filter(c => c !== channel)
          // Every available channel checked is the same as no filter at all — and keeps a channel
          // that shows up tomorrow visible by default, instead of silently hiding it.
          settings.update({ channelFilter: next.length >= channels.length ? [] : next })
        })
        label.append(box, document.createTextNode(channel))
        return label
      }),
    )
  }

  function renderSettings(): void {
    const v = settings.get()
    $<HTMLSelectElement>('startScreen').value = v.startScreen
    $<HTMLSelectElement>('faceClockMode').value = v.faceClockMode
    $<HTMLInputElement>('pollSeconds').value = String(v.pollSeconds)
    $<HTMLInputElement>('showCompleted').checked = v.showCompleted
    $<HTMLInputElement>('clock24h').checked = v.clock24h
    $<HTMLInputElement>('meetingReminderEnabled').checked = v.meetingReminderEnabled
    $<HTMLInputElement>('meetingReminderLeadMin').value = String(v.meetingReminderLeadMin)
  }

  function bind<K extends keyof Settings>(id: string, key: K, read: (el: any) => Settings[K]): void {
    $(id).addEventListener('change', e => settings.update({ [key]: read(e.target) } as Partial<Settings>))
  }
  bind('startScreen', 'startScreen', el => el.value)
  bind('faceClockMode', 'faceClockMode', el => el.value)
  bind('pollSeconds', 'pollSeconds', el => Number(el.value))
  bind('showCompleted', 'showCompleted', el => el.checked)
  bind('clock24h', 'clock24h', el => el.checked)
  bind('meetingReminderEnabled', 'meetingReminderEnabled', el => el.checked)
  bind('meetingReminderLeadMin', 'meetingReminderLeadMin', el => Number(el.value))

  $('refresh').addEventListener('click', () => void sync.refreshNow())

  $('save').addEventListener('click', async () => {
    if (!deps.auth) return
    connectMsg.textContent = 'Connecting…'
    try {
      await deps.auth.connect(bundleEl.value)
      bundleEl.value = ''
      connectMsg.textContent = 'Connected.'
    } catch (err) {
      connectMsg.textContent = err instanceof Error ? err.message : String(err)
    }
  })

  $('disconnect').addEventListener('click', async () => {
    await deps.auth?.disconnect()
    connectMsg.textContent = 'Disconnected.'
  })

  store.subscribe(() => {
    renderStatus()
    renderTasks()
    renderChannels() // new channels can appear as tasks load
  })
  settings.subscribe(() => {
    renderSettings()
    renderTasks() // "Show completed" and the channel filter change which rows this list has
    renderChannels()
  })
  logger.subscribe(() => {
    logEl.textContent = logger.getLines().join('\n')
  })
  renderStatus()
  renderTasks()
  renderChannels()
  renderSettings()
  logEl.textContent = logger.getLines().join('\n')

  return {
    focusConnect: () => $('connect').scrollIntoView({ behavior: 'smooth' }),
  }
}
