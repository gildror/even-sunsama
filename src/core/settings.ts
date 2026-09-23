import type { KeyValueStore, Settings } from './types'

const KEY = 'settings.v1'

export const DEFAULT_SETTINGS: Settings = {
  startScreen: 'face',
  showCompleted: true,
  clock24h: false,
  pollSeconds: 120,
  faceClockMode: 'image',
  channelFilter: [],
  meetingReminderEnabled: true,
  meetingReminderLeadMin: 10,
}

export class SettingsStore {
  private value: Settings = { ...DEFAULT_SETTINGS }
  private listeners = new Set<() => void>()

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    try {
      const raw = await this.kv.get(KEY)
      if (raw) this.value = sanitize({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) })
    } catch {
      this.value = { ...DEFAULT_SETTINGS }
    }
  }

  get(): Settings {
    return this.value
  }

  update(patch: Partial<Settings>): void {
    this.value = sanitize({ ...this.value, ...patch })
    void this.kv.set(KEY, JSON.stringify(this.value))
    this.listeners.forEach(fn => fn())
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

function sanitize(s: Settings): Settings {
  const poll = Number(s.pollSeconds)
  const lead = Number(s.meetingReminderLeadMin)
  return {
    startScreen: s.startScreen === 'tasks' ? 'tasks' : 'face',
    showCompleted: Boolean(s.showCompleted),
    clock24h: Boolean(s.clock24h),
    pollSeconds: Number.isFinite(poll) ? Math.min(3600, Math.max(30, Math.round(poll))) : DEFAULT_SETTINGS.pollSeconds,
    faceClockMode: s.faceClockMode === 'text' ? 'text' : 'image',
    channelFilter: Array.isArray(s.channelFilter) ? [...new Set(s.channelFilter.filter((c): c is string => typeof c === 'string' && c !== ''))] : [],
    meetingReminderEnabled: Boolean(s.meetingReminderEnabled ?? DEFAULT_SETTINGS.meetingReminderEnabled),
    meetingReminderLeadMin: Number.isFinite(lead) ? Math.min(60, Math.max(1, Math.round(lead))) : DEFAULT_SETTINGS.meetingReminderLeadMin,
  }
}
