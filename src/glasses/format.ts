import { formatDayShort } from '../core/time'
import { doneTasks, openCount } from '../core/selectors'
import { STALE_AFTER_MS } from '../core/summary'
import type { StoreState, Task } from '../core/types'

/** Glyphs the G2 font is documented to render. Fallback if hardware disagrees: '[ ]' / '[x]'. */
export const GLYPHS = { open: '○', done: '●', next: '▶', up: '▲', down: '▼' } as const

/** Firmware limit for a list row. */
export const LIST_ITEM_MAX_BYTES = 63
const FAILED_FLAG_MS = 3_000

const encoder = new TextEncoder()
export const utf8Length = (text: string): number => encoder.encode(text).length

/** Cuts on code-point boundaries and ends with an ellipsis when something was removed. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text
  const ellipsis = '…'
  const budget = maxBytes - utf8Length(ellipsis)
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = utf8Length(ch)
    if (used + size > budget) break
    out += ch
    used += size
  }
  return out.trimEnd() + ellipsis
}

/** The glasses font has no emoji; drop them rather than show placeholder boxes. */
export function cleanTitle(title: string): string {
  return title
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `○ Title (2/5)`, always within the list row limit; the subtask suffix survives truncation. */
export function taskRowLabel(task: Task): string {
  const prefix = `${task.completed ? GLYPHS.done : GLYPHS.open} `
  const suffix = task.subtasksTotal > 0 ? ` (${task.subtasksDone}/${task.subtasksTotal})` : ''
  const room = LIST_ITEM_MAX_BYTES - utf8Length(prefix) - utf8Length(suffix)
  return prefix + truncateUtf8(cleanTitle(task.title) || '(untitled)', room) + suffix
}

/** `~` syncing, `! failed` right after a rollback, `! offline` when data is stale. */
export function statusMarker(state: StoreState, now: number): string {
  if (state.lastToggleFailedAt !== undefined && now - state.lastToggleFailedAt < FAILED_FLAG_MS) return '! failed'
  if (state.status === 'loading' || state.status === 'refreshing') return '~'
  if (state.status === 'error') return '! offline'
  if (state.lastSyncAt !== undefined && now - state.lastSyncAt > STALE_AFTER_MS) return '! stale'
  return ''
}

/** `Sun 20 Sep  3 open · 4 done  ~` */
export function headerLine(state: StoreState, now: number): string {
  const counts = `${openCount(state.tasks)} open · ${doneTasks(state.tasks).length} done`
  return [state.day ? formatDayShort(state.day) : '', counts, statusMarker(state, now)].filter(Boolean).join('  ')
}
