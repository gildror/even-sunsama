export interface Task {
  id: string
  title: string
  completed: boolean
  subtasksDone: number
  subtasksTotal: number
}

export interface Profile {
  timezone: string
}

/** Anything that can list and check off a day's tasks (Sunsama, mock, future sources). */
export interface TaskProvider {
  getProfile(): Promise<Profile>
  listTasks(day: string): Promise<Task[]>
  /** `day` is today's date (YYYY-MM-DD) in the account timezone; used as the completion day. */
  setCompleted(id: string, completed: boolean, day: string): Promise<void>
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
  /** Task id -> completion value we are still sending to the provider. */
  pending: Record<string, boolean>
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
  faceClockMode: 'image' | 'text'
}

export class AuthRequiredError extends Error {
  constructor(public readonly reason: 'signedOut' | 'expired', message?: string) {
    super(message ?? (reason === 'expired' ? 'Sunsama sign-in expired' : 'Not signed in to Sunsama'))
    this.name = 'AuthRequiredError'
  }
}
