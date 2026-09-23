export interface Subtask {
  id: string
  title: string
  completed: boolean
}

/** Sunsama's per-day priority. Absent/null means the user hasn't set one. */
export type Priority = 'urgent' | 'important' | 'normal' | 'low' | null

export interface Task {
  id: string
  title: string
  completed: boolean
  /** Raw HTML from Sunsama's rich-text notes field; '' when empty. */
  notes: string
  subtasks: Subtask[]
  subtasksDone: number
  subtasksTotal: number
  priority: Priority
  /** Human string as Sunsama renders it, e.g. "1 hours and 30 minutes"; undefined if unset. */
  timeEstimate?: string
  /** Sunsama channel name, e.g. "Work"; '' if the task has none. */
  channel: string
}

export interface CalendarEvent {
  id: string
  title: string
  /** Wall-clock time in the account's own timezone, e.g. "9:00 AM". No date, no offset. */
  startTime: string
  durationMin: number
  isMeeting: boolean
  isAllDay: boolean
  /**
   * Sunsama's calendar data carries no explicit RSVP/acceptance status. `isBusy` (from
   * transparency !== 'transparent') is the closest available signal to "you're attending" —
   * a declined or free/tentative event typically shows as transparent.
   */
  isBusy: boolean
}

export interface WeeklyObjective {
  id: string
  title: string
  completed: boolean
}

export interface Profile {
  timezone: string
}

/** Anything that can list a day's tasks/events/objectives and manipulate them (Sunsama, mock, future sources). */
export interface TaskProvider {
  getProfile(): Promise<Profile>
  listTasks(day: string): Promise<Task[]>
  getEventsForDay(day: string): Promise<CalendarEvent[]>
  getWeeklyObjectives(day: string): Promise<WeeklyObjective[]>
  /** `day` is today's date (YYYY-MM-DD) in the account timezone; used as the completion day. */
  setCompleted(id: string, completed: boolean, day: string): Promise<void>
  setSubtaskCompleted(taskId: string, subtaskId: string, completed: boolean): Promise<void>
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export type AuthState = 'unknown' | 'signedOut' | 'signedIn' | 'expired'
export type SyncStatus = 'idle' | 'loading' | 'refreshing' | 'error'

export interface StoreState {
  /** YYYY-MM-DD in `tz`. Empty until the first hydrate/refresh. */
  day: string
  tz: string
  tasks: Task[]
  events: CalendarEvent[]
  objectives: WeeklyObjective[]
  /** Task id -> completion value we are still sending to the provider. */
  pending: Record<string, boolean>
  /** Subtask id -> completion value we are still sending to the provider. */
  pendingSubtasks: Record<string, boolean>
  status: SyncStatus
  lastSyncAt?: number
  lastError?: string
  /** Set briefly after a failed check-off so surfaces can flag it. */
  lastToggleFailedAt?: number
  auth: AuthState
}

export type ScreenName = 'face' | 'tasks'

export interface Settings {
  startScreen: ScreenName
  showCompleted: boolean
  clock24h: boolean
  pollSeconds: number
  /** Empty = every channel. Non-empty = only tasks whose channel is in this list. */
  channelFilter: string[]
  meetingReminderEnabled: boolean
  /** Minutes before a meeting starts that the reminder banner appears. */
  meetingReminderLeadMin: number
}

export class AuthRequiredError extends Error {
  constructor(public readonly reason: 'signedOut' | 'expired', message?: string) {
    super(message ?? (reason === 'expired' ? 'Sunsama sign-in expired' : 'Not signed in to Sunsama'))
    this.name = 'AuthRequiredError'
  }
}
