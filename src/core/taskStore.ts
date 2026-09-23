import { todayInTz } from './time'
import { AuthRequiredError } from './types'
import type { AuthState, KeyValueStore, StoreState, Task, TaskProvider } from './types'

const CACHE_KEY = 'tasks.cache.v1'

interface Cache {
  day: string
  tz: string
  tasks: Task[]
  lastSyncAt?: number
}

export interface TaskStoreDeps {
  provider: TaskProvider
  kv: KeyValueStore
  now?: () => Date
  log?: (message: string) => void
}

/**
 * Today's tasks, UI-agnostic. Surfaces (glasses screens, phone page, future
 * widgets) subscribe and render; they never talk to the provider directly.
 */
export class TaskStore {
  private state: StoreState = { day: '', tz: '', tasks: [], pending: {}, status: 'idle', auth: 'unknown' }
  private listeners = new Set<() => void>()
  private refreshing: Promise<void> | null = null
  private profileLoaded = false
  private readonly provider: TaskProvider
  private readonly kv: KeyValueStore
  private readonly now: () => Date
  private readonly log: (message: string) => void

  constructor(deps: TaskStoreDeps) {
    this.provider = deps.provider
    this.kv = deps.kv
    this.now = deps.now ?? (() => new Date())
    this.log = deps.log ?? (() => {})
  }

  getState(): StoreState {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setAuth(auth: AuthState): void {
    if (this.state.auth !== auth) this.patch({ auth })
  }

  /** Instant render from the last session. Yesterday's tasks are dropped, the timezone is kept. */
  async hydrate(): Promise<void> {
    try {
      const raw = await this.kv.get(CACHE_KEY)
      if (!raw) return
      const cache = JSON.parse(raw) as Cache
      if (!cache.tz || !Array.isArray(cache.tasks)) return
      const today = todayInTz(cache.tz, this.now())
      if (cache.day === today) {
        this.patch({ day: cache.day, tz: cache.tz, tasks: cache.tasks, lastSyncAt: cache.lastSyncAt })
      } else {
        this.patch({ day: today, tz: cache.tz })
      }
    } catch {
      // A corrupt cache only costs the instant render.
    }
  }

  /** Concurrent callers share one in-flight refresh. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    this.patch({ status: this.state.lastSyncAt ? 'refreshing' : 'loading' })
    try {
      let tz = this.state.tz
      if (!this.profileLoaded || !tz) {
        tz = (await this.provider.getProfile()).timezone
        this.profileLoaded = true
      }
      const day = todayInTz(tz, this.now())
      const fetched = await this.provider.listTasks(day)
      // Keep our value for tasks whose check-off is still in flight.
      const pending = this.state.pending
      const tasks = fetched.map(t => (t.id in pending ? { ...t, completed: pending[t.id] } : t))
      this.patch({ day, tz, tasks, status: 'idle', lastSyncAt: this.now().getTime(), lastError: undefined, auth: 'signedIn' })
      this.persist()
      this.log(`refresh ok day=${day} tasks=${tasks.length}`)
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  /** Optimistic check-off / un-check. Resolves to false when ignored or rolled back. */
  async toggle(id: string): Promise<boolean> {
    const task = this.state.tasks.find(t => t.id === id)
    if (!task || id in this.state.pending) return false
    const target = !task.completed
    const day = this.state.day || todayInTz(this.state.tz, this.now())
    this.patch({ tasks: this.withCompleted(id, target), pending: { ...this.state.pending, [id]: target } })
    try {
      await this.provider.setCompleted(id, target, day)
      this.patch({ pending: this.withoutPending(id) })
      this.persist()
      this.log(`toggle ${id} -> ${target} ok`)
      return true
    } catch (err) {
      this.patch({
        tasks: this.withCompleted(id, !target),
        pending: this.withoutPending(id),
        lastToggleFailedAt: this.now().getTime(),
      })
      this.fail(err)
      this.log(`toggle ${id} -> ${target} failed, rolled back`)
      return false
    }
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof AuthRequiredError) {
      this.patch({ status: 'error', lastError: message, auth: err.reason })
    } else {
      this.patch({ status: 'error', lastError: message })
    }
    this.log(`error: ${message}`)
  }

  private withCompleted(id: string, completed: boolean): Task[] {
    return this.state.tasks.map(t => (t.id === id ? { ...t, completed } : t))
  }

  private withoutPending(id: string): Record<string, boolean> {
    const { [id]: _done, ...rest } = this.state.pending
    return rest
  }

  private persist(): void {
    const { day, tz, tasks, lastSyncAt } = this.state
    const cache: Cache = { day, tz, tasks, lastSyncAt }
    void this.kv.set(CACHE_KEY, JSON.stringify(cache)).catch(() => {})
  }

  private patch(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(fn => fn())
  }
}
