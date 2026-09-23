import { parseTimeOfDay12h, zonedTimeToUtc } from './time'
import type { CalendarEvent, Priority, Subtask, Task } from './types'

export const openTasks = (tasks: Task[]): Task[] => tasks.filter(t => !t.completed)
export const doneTasks = (tasks: Task[]): Task[] => tasks.filter(t => t.completed)
export const openCount = (tasks: Task[]): number => openTasks(tasks).length
export const nextTask = (tasks: Task[]): Task | undefined => tasks.find(t => !t.completed)

/**
 * The channel filter, applied ahead of everything else (open/done, priority,
 * grouping): every screen that reads `state.tasks` for display should run it
 * through this first. Empty filter = no restriction.
 */
export function filterByChannel(tasks: Task[], channelFilter: string[]): Task[] {
  return channelFilter.length === 0 ? tasks : tasks.filter(t => channelFilter.includes(t.channel))
}

/** Distinct channel names present today, in first-seen order — what the phone settings list offers. */
export function availableChannels(tasks: Task[]): string[] {
  const seen = new Set<string>()
  for (const t of tasks) if (t.channel) seen.add(t.channel)
  return [...seen]
}

/** Highest first. Absent priority sorts with "normal" — present but unremarkable. */
export const PRIORITY_RANK: Record<Exclude<Priority, null>, number> = { urgent: 0, important: 1, normal: 2, low: 3 }
export const priorityRank = (p: Priority): number => PRIORITY_RANK[p ?? 'normal']

/**
 * Open tasks ordered by priority (stable within each priority), then completed
 * ones unless hidden. Sunsama's own manual ordering is kept as the tiebreaker,
 * so setting a priority reorders the list without scrambling same-priority tasks.
 */
export function orderedTasks(tasks: Task[], showCompleted: boolean): Task[] {
  const open = [...openTasks(tasks)].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
  return showCompleted ? [...open, ...doneTasks(tasks)] : open
}

/**
 * Open subtasks first, done ones after — same "sink to the bottom" rule as
 * `orderedTasks`. A list rebuild resets the OS cursor to row 0, so without this,
 * checking off several subtasks in a row keeps landing back on one you just did.
 */
export function orderedSubtasks(subtasks: Subtask[]): Subtask[] {
  return [...subtasks].sort((a, b) => Number(a.completed) - Number(b.completed))
}

/** Whether `tasks` has more than one distinct priority among its open items — grouping is only useful then. */
export function hasMixedPriorities(tasks: Task[]): boolean {
  return new Set(openTasks(tasks).map(t => t.priority ?? 'normal')).size > 1
}

export interface UpcomingMeeting {
  title: string
  minutesUntil: number
  /** True once the meeting has started but not yet ended. */
  inProgress: boolean
}

/**
 * The soonest real meeting (not an all-day event) that starts within
 * `thresholdMin` minutes, or has started within its own duration. Returns
 * null once nothing qualifies, so callers can just check truthiness.
 */
export function nextMeetingSoon(events: CalendarEvent[], day: string, tz: string, now: Date, thresholdMin = 10): UpcomingMeeting | null {
  let best: UpcomingMeeting | null = null
  for (const event of events) {
    if (!event.isMeeting || event.isAllDay) continue
    const hm = parseTimeOfDay12h(event.startTime)
    if (!hm) continue
    const start = zonedTimeToUtc(day, hm, tz)
    const minutesUntil = Math.round((start.getTime() - now.getTime()) / 60_000)
    const minutesSinceStart = -minutesUntil
    const inProgress = minutesSinceStart >= 0 && minutesSinceStart < event.durationMin
    if (!inProgress && (minutesUntil < 0 || minutesUntil > thresholdMin)) continue
    if (!best || minutesUntil < best.minutesUntil) best = { title: event.title, minutesUntil: Math.max(0, minutesUntil), inProgress }
  }
  return best
}
