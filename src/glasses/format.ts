import { formatDayShort } from '../core/time'
import { doneTasks, filterByChannel, openCount } from '../core/selectors'
import type { UpcomingMeeting } from '../core/selectors'
import { STALE_AFTER_MS } from '../core/summary'
import type { Priority, StoreState, Subtask, Task } from '../core/types'

/** Glyphs the G2 font is documented to render. Fallback if hardware disagrees: '[ ]' / '[x]'. */
export const GLYPHS = { open: '○', done: '●', next: '▶', up: '▲', down: '▼', meeting: '◆' } as const

/** Plain-ASCII so it renders regardless of glyph support; empty for normal/unset so most rows stay quiet. */
export function priorityPrefix(priority: Priority): string {
  switch (priority) {
    case 'urgent':
      return '!! '
    case 'important':
      return '! '
    case 'low':
      return '· '
    default:
      return ''
  }
}

/** One line per priority group header, e.g. "— Urgent —". */
export function priorityLabel(priority: Priority): string {
  switch (priority) {
    case 'urgent':
      return 'Urgent'
    case 'important':
      return 'Important'
    case 'low':
      return 'Low'
    default:
      return 'Normal'
  }
}

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

/** `○ !! Title (2/5)`, always within the list row limit; the subtask suffix survives truncation. */
export function taskRowLabel(task: Task): string {
  const prefix = `${task.completed ? GLYPHS.done : GLYPHS.open} ${priorityPrefix(task.priority)}`
  const suffix = task.subtasksTotal > 0 ? ` (${task.subtasksDone}/${task.subtasksTotal})` : ''
  const room = LIST_ITEM_MAX_BYTES - utf8Length(prefix) - utf8Length(suffix)
  return prefix + truncateUtf8(cleanTitle(task.title) || '(untitled)', room) + suffix
}

/** `○ Title`, for a task's own subtasks (no nested counts or priority — Sunsama has none at that level). */
export function subtaskRowLabel(subtask: Subtask): string {
  const prefix = `${subtask.completed ? GLYPHS.done : GLYPHS.open} `
  const room = LIST_ITEM_MAX_BYTES - utf8Length(prefix)
  return prefix + truncateUtf8(cleanTitle(subtask.title) || '(untitled)', room)
}

/** `○ Ship the redesign`, for a plain-text line rather than a list row — a wider budget than {@link subtaskRowLabel}. */
export function objectiveRowLabel(objective: { title: string; completed: boolean }, maxBytes = 56): string {
  const prefix = `${objective.completed ? GLYPHS.done : GLYPHS.open} `
  const room = maxBytes - utf8Length(prefix)
  return prefix + truncateUtf8(cleanTitle(objective.title) || '(untitled)', room)
}

/** Strips Sunsama's rich-text HTML notes down to plain, glasses-safe text. */
export function stripHtml(html: string): string {
  if (!html) return ''
  const withBreaks = html
    .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ') // plain ASCII: '•' isn't in the glasses font's documented glyph set
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '')
  const decoded = withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return decoded
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
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
export function headerLine(state: StoreState, channelFilter: string[], now: number): string {
  const tasks = filterByChannel(state.tasks, channelFilter)
  const counts = `${openCount(tasks)} open · ${doneTasks(tasks).length} done`
  return [state.day ? formatDayShort(state.day) : '', counts, statusMarker(state, now)].filter(Boolean).join('  ')
}

/** `◆ Meeting in 10 minutes` / `◆ Meeting now`. */
export function formatMeetingBanner(meeting: UpcomingMeeting): string {
  if (meeting.inProgress) return `${GLYPHS.meeting} Meeting now`
  const n = meeting.minutesUntil
  return `${GLYPHS.meeting} Meeting in ${n} minute${n === 1 ? '' : 's'}`
}
