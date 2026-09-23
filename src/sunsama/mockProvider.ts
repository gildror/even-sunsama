import type { CalendarEvent, Priority, Profile, Subtask, Task, TaskProvider, WeeklyObjective } from '../core/types'

const OBJECTIVES: WeeklyObjective[] = [
  { id: 'obj1', title: 'Ship the onboarding redesign', completed: true },
  { id: 'obj2', title: 'Close out Q3 planning', completed: true },
  { id: 'obj3', title: 'Hire the design lead', completed: false },
  { id: 'obj4', title: 'Draft the roadmap review deck', completed: false },
]

/** A quiet, meeting-free day unless a scenario asks for one. */
const BACKGROUND_MEETINGS: CalendarEvent[] = [
  { id: 'ev-standup', title: 'Team standup', startTime: '9:00 AM', durationMin: 15, isMeeting: true, isAllDay: false, isBusy: true },
  { id: 'ev-1on1', title: '1:1', startTime: '2:00 PM', durationMin: 30, isMeeting: true, isAllDay: false, isBusy: true },
  { id: 'ev-declined', title: 'Optional sync', startTime: '4:00 PM', durationMin: 30, isMeeting: true, isAllDay: false, isBusy: false },
]

interface Fixture {
  title: string
  priority: Priority
  notes: string
  channel: string
  subtasks: Array<{ title: string; completed: boolean }>
}

const FIXTURES: Fixture[] = [
  {
    title: 'Review quarterly budget',
    priority: 'urgent',
    notes: 'Pull the Q3 actuals and compare against forecast. Flag anything over 10% variance before the leadership sync.',
    channel: 'Work',
    subtasks: [
      { title: 'Export actuals from the Finance channel', completed: true },
      { title: 'Compare against forecast', completed: false },
      { title: 'Flag variances over 10%', completed: false },
    ],
  },
  {
    title: 'Reply to supplier about the delayed shipment and new delivery dates for October',
    priority: 'important',
    notes: '',
    channel: 'Work',
    subtasks: [],
  },
  {
    title: 'Weekly prep',
    priority: null,
    notes: 'Standing Sunday prep before the week starts.',
    channel: 'Personal',
    subtasks: [
      { title: 'Inbox zero', completed: false },
      { title: 'Review calendar', completed: false },
      { title: 'Review goals / backlog', completed: false },
    ],
  },
  { title: 'Book dentist appointment', priority: 'low', notes: '', channel: 'Personal', subtasks: [] },
  { title: 'Draft panel questions', priority: 'normal', notes: '', channel: 'Work', subtasks: [] },
  { title: 'Pick up dry cleaning', priority: 'low', notes: '', channel: 'Personal', subtasks: [] },
  { title: 'Read architecture proposal', priority: 'normal', notes: '', channel: 'Work', subtasks: [] },
]

export interface MockOptions {
  /** Number of tasks (default 5; the last two start completed). */
  tasks?: number
  fail?: 'toggle' | 'list' | null
  latencyMs?: number
  /** Minutes from now for a fake meeting event, so the reminder banner is testable; omit for no meeting. */
  meetingInMin?: number
  /** `false` gives every task 'normal' priority, so the list stays flat (no grouping) — useful for e2e scenarios that predate priority. */
  varyPriority?: boolean
}

/** `?tasks=N&fail=toggle|list&meeting=N&priority=flat` on the page URL tunes the mock, e.g. for the e2e script. */
export function mockOptionsFromUrl(search: string): MockOptions {
  const params = new URLSearchParams(search)
  const fail = params.get('fail')
  const meeting = params.get('meeting')
  return {
    tasks: params.has('tasks') ? Math.max(0, Number(params.get('tasks')) || 0) : undefined,
    fail: fail === 'toggle' || fail === 'list' ? fail : null,
    meetingInMin: meeting !== null && meeting !== 'none' ? Number(meeting) : undefined,
    varyPriority: params.get('priority') !== 'flat',
  }
}

const format12h = (date: Date): string => {
  const h = date.getHours()
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h % 12 || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`
}

/** In-memory tasks so the simulator and tests run without a Sunsama account. */
export class MockProvider implements TaskProvider {
  private tasks: Task[]
  private readonly fail: MockOptions['fail']
  private readonly latencyMs: number
  private readonly meetingInMin: number | undefined

  constructor(options: MockOptions = {}) {
    const count = options.tasks ?? 5
    this.fail = options.fail ?? null
    this.latencyMs = options.latencyMs ?? 150
    this.meetingInMin = options.meetingInMin
    const varyPriority = options.varyPriority ?? true
    this.tasks = Array.from({ length: count }, (_, i) => {
      const fixture = i < FIXTURES.length ? FIXTURES[i] : { title: `Task ${i + 1}`, priority: null, notes: '', channel: 'Work', subtasks: [] }
      const priority = varyPriority ? fixture.priority : null
      const subtasks: Subtask[] = fixture.subtasks.map((s, j) => ({ id: `t${i + 1}-s${j + 1}`, title: s.title, completed: s.completed }))
      return {
        id: `t${i + 1}`,
        title: fixture.title,
        completed: count > 2 && i >= count - 2,
        notes: fixture.notes,
        subtasks,
        subtasksDone: subtasks.filter(s => s.completed).length,
        subtasksTotal: subtasks.length,
        priority,
        timeEstimate: i === 0 ? '45 minutes' : undefined,
        channel: fixture.channel,
      }
    })
  }

  async getProfile(): Promise<Profile> {
    await this.delay()
    return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
  }

  async listTasks(_day: string): Promise<Task[]> {
    await this.delay()
    if (this.fail === 'list') throw new Error('mock: list failed')
    return this.tasks.map(t => ({ ...t, subtasks: t.subtasks.map(s => ({ ...s })) }))
  }

  async getEventsForDay(_day: string): Promise<CalendarEvent[]> {
    await this.delay()
    const events = BACKGROUND_MEETINGS.map(e => ({ ...e }))
    if (this.meetingInMin !== undefined) {
      const start = new Date(Date.now() + this.meetingInMin * 60_000)
      events.push({ id: 'ev-soon', title: 'Standup', startTime: format12h(start), durationMin: 30, isMeeting: true, isAllDay: false, isBusy: true })
    }
    return events
  }

  async getWeeklyObjectives(_day: string): Promise<WeeklyObjective[]> {
    await this.delay()
    return OBJECTIVES.map(o => ({ ...o }))
  }

  async setCompleted(id: string, completed: boolean, _day: string): Promise<void> {
    await this.delay()
    if (this.fail === 'toggle') throw new Error('mock: toggle failed')
    this.tasks = this.tasks.map(t => (t.id === id ? { ...t, completed } : t))
  }

  async setSubtaskCompleted(taskId: string, subtaskId: string, completed: boolean): Promise<void> {
    await this.delay()
    if (this.fail === 'toggle') throw new Error('mock: subtask toggle failed')
    this.tasks = this.tasks.map(t => {
      if (t.id !== taskId) return t
      const subtasks = t.subtasks.map(s => (s.id === subtaskId ? { ...s, completed } : s))
      return { ...t, subtasks, subtasksDone: subtasks.filter(s => s.completed).length }
    })
  }

  private delay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, this.latencyMs))
  }
}
