import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import type { Priority, StoreState, Subtask, Task } from '../src/core/types'
import { Os, normalizeEvent } from '../src/glasses/events'
import {
  LIST_ITEM_MAX_BYTES,
  cleanTitle,
  formatMeetingBanner,
  headerLine,
  priorityLabel,
  priorityPrefix,
  stripHtml,
  subtaskRowLabel,
  taskRowLabel,
  truncateUtf8,
  utf8Length,
} from '../src/glasses/format'
import { buildFaceView } from '../src/glasses/screens/face'
import { messageFor } from '../src/glasses/screens/message'
import { MAX_ROWS, PAGE_SIZE, buildTasksView } from '../src/glasses/screens/tasks'

const task = (id: string, completed = false, title = `Task ${id}`, priority: Priority = null, channel = ''): Task => ({
  id,
  title,
  completed,
  notes: '',
  subtasks: [],
  subtasksDone: 0,
  subtasksTotal: 0,
  priority,
  channel,
})
const state = (tasks: Task[], patch: Partial<StoreState> = {}): StoreState => ({
  day: '2026-09-20',
  tz: 'America/New_York',
  tasks,
  events: [],
  objectives: [],
  pending: {},
  pendingSubtasks: {},
  status: 'idle',
  lastSyncAt: 1_000,
  auth: 'signedIn',
  ...patch,
})

describe('normalizeEvent', () => {
  it('ignores events without a known envelope (audio frames must not become taps)', () => {
    expect(normalizeEvent({})).toBeNull()
    expect(normalizeEvent({ audioEvent: { pcm: [1, 2] } })).toBeNull()
  })

  it('treats an envelope without eventType as a click (protobuf drops zero values)', () => {
    expect(normalizeEvent({ sysEvent: {} })).toEqual({ t: 'click' })
    expect(normalizeEvent({ textEvent: {} })).toEqual({ t: 'click' })
  })

  it('defaults a missing list index to the first row', () => {
    expect(normalizeEvent({ listEvent: {} })).toEqual({ t: 'listSelect', index: 0, name: undefined })
    expect(normalizeEvent({ listEvent: { currentSelectItemIndex: 3, currentSelectItemName: 'x' } })).toEqual({ t: 'listSelect', index: 3, name: 'x' })
  })

  it('checks double-click before click in every envelope', () => {
    expect(normalizeEvent({ sysEvent: { eventType: Os.DOUBLE_CLICK } })).toEqual({ t: 'doubleClick' })
    expect(normalizeEvent({ listEvent: { eventType: Os.DOUBLE_CLICK } })).toEqual({ t: 'doubleClick' })
  })

  it('maps scrolls, menu clicks and lifecycle events', () => {
    expect(normalizeEvent({ textEvent: { eventType: Os.SCROLL_TOP } })).toEqual({ t: 'scrollUp' })
    expect(normalizeEvent({ textEvent: { eventType: Os.SCROLL_BOTTOM } })).toEqual({ t: 'scrollDown' })
    expect(normalizeEvent({ menuItemClickEvent: { itemID: 2 } })).toEqual({ t: 'menu', itemID: 2 })
    expect(normalizeEvent({ sysEvent: { eventType: Os.FOREGROUND_ENTER } })).toEqual({ t: 'fgEnter' })
    expect(normalizeEvent({ sysEvent: { eventType: Os.FOREGROUND_EXIT } })).toEqual({ t: 'fgExit' })
    expect(normalizeEvent({ sysEvent: { eventType: Os.SYSTEM_EXIT } })).toEqual({ t: 'exit' })
    expect(normalizeEvent({ sysEvent: { eventType: 8 } })).toBeNull() // IMU report
  })
})

describe('format', () => {
  it('truncates on code-point boundaries within the byte budget', () => {
    expect(truncateUtf8('short', 63)).toBe('short')
    const hebrew = 'משימה '.repeat(20)
    const cut = truncateUtf8(hebrew, 30)
    expect(utf8Length(cut)).toBeLessThanOrEqual(30)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toContain('�')
  })

  it('drops emoji the glasses font cannot draw', () => {
    expect(cleanTitle('🎯 Weekly   Prep ✅')).toBe('Weekly Prep')
  })

  it('keeps row labels within the firmware limit and preserves the subtask suffix', () => {
    const long = { ...task('1', false, 'x'.repeat(200)), subtasksDone: 2, subtasksTotal: 5 }
    const label = taskRowLabel(long)
    expect(utf8Length(label)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    expect(label.startsWith('○ ')).toBe(true)
    expect(label.endsWith(' (2/5)')).toBe(true)
    expect(taskRowLabel(task('2', true, 'Done'))).toBe('● Done')
  })

  it('prefixes rows by priority and stays within budget even for urgent + subtasks', () => {
    expect(priorityPrefix('urgent')).toBe('!! ')
    expect(priorityPrefix('important')).toBe('! ')
    expect(priorityPrefix('low')).toBe('· ')
    expect(priorityPrefix('normal')).toBe('')
    expect(priorityPrefix(null)).toBe('')
    expect(priorityLabel('urgent')).toBe('Urgent')
    expect(priorityLabel(null)).toBe('Normal')

    const urgent = { ...task('1', false, 'x'.repeat(200), 'urgent'), subtasksDone: 1, subtasksTotal: 9 }
    const label = taskRowLabel(urgent)
    expect(utf8Length(label)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    expect(label.startsWith('○ !! ')).toBe(true)
    expect(label.endsWith(' (1/9)')).toBe(true)
  })

  it('formats subtask rows without counts or priority', () => {
    const subtask: Subtask = { id: 's1', title: 'x'.repeat(200), completed: true }
    const label = subtaskRowLabel(subtask)
    expect(utf8Length(label)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    expect(label.startsWith('● ')).toBe(true)
  })

  it('strips Sunsama rich-text HTML down to plain lines', () => {
    expect(stripHtml('<p><strong>Planned</strong></p><ul><li>One</li><li>Two</li></ul>')).toBe('Planned\n- One\n- Two')
    expect(stripHtml('Line one<br/>Line two &amp; more &nbsp;padded')).toBe('Line one\nLine two & more  padded')
    expect(stripHtml('')).toBe('')
    expect(stripHtml('<p></p>')).toBe('')
  })

  it('formats the meeting banner', () => {
    expect(formatMeetingBanner({ title: 'Standup', minutesUntil: 10, inProgress: false })).toBe('◆ Meeting in 10 minutes')
    expect(formatMeetingBanner({ title: 'Standup', minutesUntil: 1, inProgress: false })).toBe('◆ Meeting in 1 minute')
    expect(formatMeetingBanner({ title: 'Standup', minutesUntil: 0, inProgress: true })).toBe('◆ Meeting now')
  })

  it('builds the header with counts and status markers', () => {
    const tasks = [task('1'), task('2', true)]
    expect(headerLine(state(tasks), [], 2_000)).toBe('Sun 20 Sep  1 open · 1 done')
    expect(headerLine(state(tasks, { status: 'refreshing' }), [], 2_000)).toContain('~')
    expect(headerLine(state(tasks, { status: 'error' }), [], 2_000)).toContain('! offline')
    expect(headerLine(state(tasks, { lastToggleFailedAt: 1_500 }), [], 2_000)).toContain('! failed')
    expect(headerLine(state(tasks, { lastToggleFailedAt: 1_500 }), [], 9_000)).not.toContain('! failed')
  })
})

describe('buildTasksView', () => {
  it('lists open tasks first and can hide completed ones', () => {
    const tasks = [task('a', true), task('b'), task('c', true), task('d')]
    const all = buildTasksView(state(tasks), true, [], 0, 2_000)
    expect(all.rows).toEqual([{ k: 'task', id: 'b' }, { k: 'task', id: 'd' }, { k: 'task', id: 'a' }, { k: 'task', id: 'c' }])
    expect(buildTasksView(state(tasks), false, [], 0, 2_000).rows.map(r => (r.k === 'task' ? r.id : r.k))).toEqual(['b', 'd'])
  })

  it('shows a message instead of an empty list', () => {
    expect(buildTasksView(state([]), true, [], 0, 2_000).emptyMessage).toBe('No tasks today')
    expect(buildTasksView(state([task('a', true)]), false, [], 0, 2_000).emptyMessage).toContain('All done (1)')
  })

  it('groups open tasks by priority with header rows when it fits on one page', () => {
    const tasks = [task('a', false, 'A', 'normal'), task('b', false, 'B', 'urgent'), task('c', false, 'C', 'important')]
    const view = buildTasksView(state(tasks), true, [], 0, 0)
    expect(view.rows).toEqual([
      { k: 'group', priority: 'urgent' },
      { k: 'task', id: 'b' },
      { k: 'group', priority: 'important' },
      { k: 'task', id: 'c' },
      { k: 'group', priority: 'normal' },
      { k: 'task', id: 'a' },
    ])
    expect(view.itemNames[0]).toBe('— Urgent —')
  })

  it('applies the channel filter before anything else', () => {
    const tasks = [task('a', false, 'A', null, 'Work'), task('b', true, 'B', null, 'Work'), task('c', false, 'C', null, 'Personal')]
    const filtered = buildTasksView(state(tasks), true, ['Work'], 0, 0)
    expect(filtered.rows.map(r => (r.k === 'task' ? r.id : r.k))).toEqual(['a', 'b'])
    expect(filtered.header).toContain('1 open · 1 done')
    expect(buildTasksView(state(tasks), true, [], 0, 0).rows).toHaveLength(3)
    expect(buildTasksView(state(tasks), true, ['Nope'], 0, 0).emptyMessage).toBe('No tasks today')
  })

  it('falls back to a flat list when a single priority is in play', () => {
    const tasks = [task('a', false, 'A', 'normal'), task('b', false, 'B', 'normal')]
    expect(buildTasksView(state(tasks), true, [], 0, 0).rows.every(r => r.k === 'task')).toBe(true)
  })

  it('drops group headers instead of overflowing the row budget', () => {
    const many = Array.from({ length: MAX_ROWS }, (_, i) => task(String(i), false, `T${i}`, i % 2 === 0 ? 'urgent' : 'low'))
    const view = buildTasksView(state(many), true, [], 0, 0)
    expect(view.rows.every(r => r.k === 'task')).toBe(true) // headers would have pushed this over 20
    expect(view.rows).toHaveLength(MAX_ROWS)
  })

  it('fits exactly 20 tasks on one page and pages beyond that', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => task(String(i)))
    expect(buildTasksView(state(many(MAX_ROWS)), true, [], 0, 0).rows).toHaveLength(MAX_ROWS)

    const first = buildTasksView(state(many(40)), true, [], 0, 0)
    expect(first.pageCount).toBe(3)
    expect(first.rows).toHaveLength(PAGE_SIZE + 1)
    expect(first.rows.at(-1)).toEqual({ k: 'next' })

    const middle = buildTasksView(state(many(40)), true, [], 1, 0)
    expect(middle.rows[0]).toEqual({ k: 'prev' })
    expect(middle.rows.at(-1)).toEqual({ k: 'next' })
    expect(middle.rows.length).toBeLessThanOrEqual(MAX_ROWS)

    const last = buildTasksView(state(many(40)), true, [], 9, 0)
    expect(last.page).toBe(2) // clamped
    expect(last.rows.at(-1)).toEqual({ k: 'task', id: '39' })
  })
})

describe('face and message views', () => {
  it('shows the open count, date/time, weekly objectives and meeting count', () => {
    const now = new Date(2026, 8, 20, 14, 5)
    const tasks = [task('a', true), task('b', false, '🎯 Plan week', 'normal'), task('c', false, 'Urgent thing', 'urgent')]
    const objectives = [
      { id: 'o1', title: 'Ship redesign', completed: true },
      { id: 'o2', title: 'Hire lead', completed: false },
    ]
    const events = [
      { id: 'e1', title: 'Standup', startTime: '9:00 AM', durationMin: 15, isMeeting: true, isAllDay: false, isBusy: true },
      { id: 'e2', title: 'Declined', startTime: '1:00 PM', durationMin: 30, isMeeting: true, isAllDay: false, isBusy: false },
    ]
    const view = buildFaceView(state(tasks, { lastSyncAt: now.getTime(), objectives, events }), DEFAULT_SETTINGS, now)
    expect(view.openLine).toBe('2 open')
    expect(view.dateTime).toBe('Sun 20 Sep · 2:05')
    expect(view.objectivesLine).toBe('This week (1/2):\n● Ship redesign\n○ Hire lead')
    expect(view.meetingsLine).toBe('1 meeting today')

    expect(buildFaceView(state([task('a', true)], { objectives: [], events: [], lastSyncAt: now.getTime() }), { ...DEFAULT_SETTINGS, clock24h: true }, now)).toMatchObject({
      openLine: '0 open',
      dateTime: 'Sun 20 Sep · 14:05',
      objectivesLine: 'No weekly objectives set',
      meetingsLine: 'No meetings today',
    })
  })

  it('respects the channel filter and shows a sync status marker', () => {
    const now = new Date(2026, 8, 20, 14, 5)
    const tasks = [task('a', false, 'Work task', null, 'Work'), task('b', false, 'Personal task', null, 'Personal')]
    const view = buildFaceView(state(tasks, { lastSyncAt: now.getTime(), status: 'error' }), { ...DEFAULT_SETTINGS, channelFilter: ['Work'] }, now)
    expect(view.openLine).toBe('1 open  ! offline')
  })

  it('explains why there is nothing to show', () => {
    expect(messageFor(state([], { auth: 'signedOut' }))).toContain('not connected')
    expect(messageFor(state([], { auth: 'expired' }))).toContain('expired')
    expect(messageFor(state([], { lastSyncAt: undefined, status: 'loading' }))).toBe('Loading…')
    expect(messageFor(state([], { lastSyncAt: undefined, status: 'error' }))).toContain('Tap to retry')
    expect(messageFor(state([]))).toBeNull()
  })
})
