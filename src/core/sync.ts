import { todayInTz } from './time'
import type { TaskStore } from './taskStore'

const BACKOFF_START_MS = 5_000
const BACKOFF_MAX_MS = 300_000

export interface SyncDeps {
  store: TaskStore
  pollMs: () => number
  now?: () => Date
}

/**
 * Decides when the store refreshes while the plugin is in the foreground:
 * on an interval, with error backoff, on demand, and on day rollover.
 * Even Hub has no background execution, so pause() simply stops the timer.
 */
export class SyncController {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private backoffMs = 0
  private readonly store: TaskStore
  private readonly pollMs: () => number
  private readonly now: () => Date

  constructor(deps: SyncDeps) {
    this.store = deps.store
    this.pollMs = deps.pollMs
    this.now = deps.now ?? (() => new Date())
  }

  start(): void {
    this.running = true
    void this.refreshNow()
  }

  pause(): void {
    this.running = false
    this.clear()
  }

  /** Safe to call repeatedly; refreshes only if the data is older than `maxAgeMs`. */
  resume(maxAgeMs = 20_000): void {
    this.running = true
    if (!this.refreshIfStale(maxAgeMs)) this.schedule(this.pollMs())
  }

  refreshIfStale(maxAgeMs: number): boolean {
    const last = this.store.getState().lastSyncAt
    if (last !== undefined && this.now().getTime() - last < maxAgeMs) return false
    void this.refreshNow()
    return true
  }

  /** Called on the minute tick: a new day in the account timezone means a new task list. */
  tick(): void {
    const { day, tz } = this.store.getState()
    if (day && tz && todayInTz(tz, this.now()) !== day) void this.refreshNow()
  }

  async refreshNow(): Promise<void> {
    this.clear()
    try {
      await this.store.refresh()
      this.backoffMs = 0
    } catch {
      this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS
    }
    if (!this.running) return
    // Without a sign-in there is nothing to poll; a new sign-in calls refreshNow().
    const auth = this.store.getState().auth
    if (auth === 'signedOut' || auth === 'expired') return
    this.schedule(this.backoffMs || this.pollMs())
  }

  private schedule(ms: number): void {
    this.clear()
    this.timer = setTimeout(() => void this.refreshNow(), ms)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
