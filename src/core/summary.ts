import { doneTasks, nextTask, openCount, orderedTasks } from './selectors'
import type { AuthState, StoreState } from './types'

/** Data older than this is flagged as stale on glance surfaces. */
export const STALE_AFTER_MS = 10 * 60_000

/**
 * Everything a glance surface needs (face screen today; dashboard widgets and
 * layouts when Even Hub opens them to third parties).
 */
export interface GlanceSummary {
  openCount: number
  doneCount: number
  nextTitle?: string
  updatedAt?: number
  stale: boolean
  syncing: boolean
  auth: AuthState
}

export function getGlanceSummary(state: StoreState, now: number = Date.now()): GlanceSummary {
  return {
    openCount: openCount(state.tasks),
    doneCount: doneTasks(state.tasks).length,
    // Highest-priority open task, not just the first in Sunsama's manual order.
    nextTitle: nextTask(orderedTasks(state.tasks, false))?.title,
    updatedAt: state.lastSyncAt,
    stale: state.status === 'error' || (state.lastSyncAt !== undefined && now - state.lastSyncAt > STALE_AFTER_MS),
    syncing: state.status === 'loading' || state.status === 'refreshing',
    auth: state.auth,
  }
}
