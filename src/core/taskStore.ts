import { todayInTz } from './time'
import { AuthRequiredError } from './types'
import type { AuthState, CalendarEvent, KeyValueStore, StoreState, Subtask, Task, TaskProvider, WeeklyObjective } from './types'

const CACHE_KEY = 'tasks.cache.v1'

interface Cache {
  day: string
  tz: string
  tasks: Task[]
  events?: CalendarEvent[]
  objectives?: WeeklyObjective[]
  lastSyncAt?: number
}

export interface TaskStoreDeps {
  provider: TaskProvider
  kv: KeyValueStore
  now?: () => Date
  log?: (message: string) => void
}

/**
 * Today's tasks and events, UI-agnostic. Surfaces (glasses screens, phone
 * page, future widgets) subscribe and render; they never talk to the
 * provider directly.
 */
export class TaskStore {
  private state: StoreState = {
    day: '',
    tz: '',
    tasks: [],
    events: [],
    objectives: [],
    pending: {},
    pendingSubtasks: {},
    status: 'idle',
    auth: 'unknown',
  }
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
        this.patch({
          day: cache.day,
          tz: cache.tz,
          tasks: cache.tasks,
          events: cache.events ?? [],
          objectives: cache.objectives ?? [],
          lastSyncAt: cache.lastSyncAt,
        })
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
      const [fetchedTasks, events, objectives] = await Promise.all([
        this.provider.listTasks(day),
        this.provider.getEventsForDay(day),
        this.provider.getWeeklyObjectives(day),
      ])
      const tasks = fetchedTasks.map(t => this.withLocalOverrides(t))
      this.patch({ day, tz, tasks, events, objectives, status: 'idle', lastSyncAt: this.now().getTime(), lastError: undefined, auth: 'signedIn' })
      this.persist()
      this.log(`refresh ok day=${day} tasks=${tasks.length} events=${events.length} objectives=${objectives.length}`)
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  /** Reapplies task/subtask changes still in flight, so a background refresh can't clobber them. */
  private withLocalOverrides(task: Task): Task {
    let next = task.id in this.state.pending ? { ...task, completed: this.state.pending[task.id] } : task
    if (next.subtasks.some(s => s.id in this.state.pendingSubtasks)) {
      const subtasks = next.subtasks.map(s => (s.id in this.state.pendingSubtasks ? { ...s, completed: this.state.pendingSubtasks[s.id] } : s))
      next = { ...next, subtasks, subtasksDone: subtasks.filter(s => s.completed).length }
    }
    return next
  }

  /** Optimistic check-off / un-check. Resolves to false when ignored or rolled back. */
  async toggle(id: string): Promise<boolean> {
    const task = this.state.tasks.find(t => t.id === id)
    if (!task || id in this.state.pending) return false
    return this.applyCompleted(id, !task.completed)
  }

  /** The shared optimistic apply/rollback for a task's completion, however it was decided. */
  private async applyCompleted(id: string, target: boolean): Promise<boolean> {
    const day = this.state.day || todayInTz(this.state.tz, this.now())
    this.patch({ tasks: this.withCompleted(id, target), pending: { ...this.state.pending, [id]: target } })
    try {
      await this.provider.setCompleted(id, target, day)
      this.patch({ pending: withoutKey(this.state.pending, id) })
      this.persist()
      this.log(`toggle ${id} -> ${target} ok`)
      return true
    } catch (err) {
      this.patch({
        tasks: this.withCompleted(id, !target),
        pending: withoutKey(this.state.pending, id),
        lastToggleFailedAt: this.now().getTime(),
      })
      this.fail(err)
      this.log(`toggle ${id} -> ${target} failed, rolled back`)
      return false
    }
  }

  /**
   * Same optimistic pattern as `toggle`, for one subtask of a task. On
   * success, also keeps the parent task's completion in sync with "are all
   * its subtasks done?" — Task View has no other way to complete a task
   * that has subtasks (see TasksScreen for the matching rule on the list).
   */
  async toggleSubtask(taskId: string, subtaskId: string): Promise<boolean> {
    const task = this.state.tasks.find(t => t.id === taskId)
    const subtask = task?.subtasks.find(s => s.id === subtaskId)
    if (!task || !subtask || subtaskId in this.state.pendingSubtasks) return false
    const target = !subtask.completed
    this.patch({
      tasks: this.withSubtaskCompleted(taskId, subtaskId, target),
      pendingSubtasks: { ...this.state.pendingSubtasks, [subtaskId]: target },
    })
    try {
      await this.provider.setSubtaskCompleted(taskId, subtaskId, target)
      this.patch({ pendingSubtasks: withoutKey(this.state.pendingSubtasks, subtaskId) })
      this.persist()
      this.log(`toggle subtask ${subtaskId} -> ${target} ok`)
      void this.syncCompletionFromSubtasks(taskId)
      return true
    } catch (err) {
      this.patch({
        tasks: this.withSubtaskCompleted(taskId, subtaskId, !target),
        pendingSubtasks: withoutKey(this.state.pendingSubtasks, subtaskId),
        lastToggleFailedAt: this.now().getTime(),
      })
      this.fail(err)
      this.log(`toggle subtask ${subtaskId} -> ${target} failed, rolled back`)
      return false
    }
  }

  /** "All subtasks done" <=> completed, applied only when it's out of sync and nothing else is mid-flight for this task. */
  private async syncCompletionFromSubtasks(taskId: string): Promise<void> {
    const task = this.state.tasks.find(t => t.id === taskId)
    if (!task || task.subtasksTotal === 0 || taskId in this.state.pending) return
    const shouldBeComplete = task.subtasksDone === task.subtasksTotal
    if (task.completed === shouldBeComplete) return
    await this.applyCompleted(taskId, shouldBeComplete)
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

  private withSubtaskCompleted(taskId: string, subtaskId: string, completed: boolean): Task[] {
    return this.state.tasks.map(t => {
      if (t.id !== taskId) return t
      const subtasks: Subtask[] = t.subtasks.map(s => (s.id === subtaskId ? { ...s, completed } : s))
      return { ...t, subtasks, subtasksDone: subtasks.filter(s => s.completed).length }
    })
  }

  private persist(): void {
    const { day, tz, tasks, events, objectives, lastSyncAt } = this.state
    const cache: Cache = { day, tz, tasks, events, objectives, lastSyncAt }
    void this.kv.set(CACHE_KEY, JSON.stringify(cache)).catch(() => {})
  }

  private patch(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(fn => fn())
  }
}

function withoutKey(record: Record<string, boolean>, key: string): Record<string, boolean> {
  const { [key]: _removed, ...rest } = record
  return rest
}
