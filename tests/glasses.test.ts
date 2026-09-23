import { describe, expect, it } from 'vitest'
import type { StoreState, Task } from '../src/core/types'
import { Os, normalizeEvent } from '../src/glasses/events'
import { LIST_ITEM_MAX_BYTES, cleanTitle, headerLine, taskRowLabel, truncateUtf8, utf8Length } from '../src/glasses/format'
import { buildFaceView } from '../src/glasses/screens/face'
import { messageFor } from '../src/glasses/screens/message'
import { MAX_ROWS, PAGE_SIZE, buildTasksView } from '../src/glasses/screens/tasks'
import { DEFAULT_SETTINGS } from '../src/core/settings'

const task = (id: string, completed = false, title = `Task ${id}`): Task => ({ id, title, completed, subtasksDone: 0, subtasksTotal: 0 })
const state = (tasks: Task[], patch: Partial<StoreState> = {}): StoreState => ({
  day: '2026-09-20',
  tz: 'America/New_York',
  tasks,
  pending: {},
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

  it('builds the header with counts and status markers', () => {
    const tasks = [task('1'), task('2', true)]
    expect(headerLine(state(tasks), 2_000)).toBe('Sun 20 Sep  1 open · 1 done')
    expect(headerLine(state(tasks, { status: 'refreshing' }), 2_000)).toContain('~')
    expect(headerLine(state(tasks, { status: 'error' }), 2_000)).toContain('! offline')
    expect(headerLine(state(tasks, { lastToggleFailedAt: 1_500 }), 2_000)).toContain('! failed')
    expect(headerLine(state(tasks, { lastToggleFailedAt: 1_500 }), 9_000)).not.toContain('! failed')
  })
})

describe('buildTasksView', () => {
  it('lists open tasks first and can hide completed ones', () => {
    const tasks = [task('a', true), task('b'), task('c', true), task('d')]
    const all = buildTasksView(state(tasks), true, 0, 2_000)
    expect(all.rows).toEqual([{ k: 'task', id: 'b' }, { k: 'task', id: 'd' }, { k: 'task', id: 'a' }, { k: 'task', id: 'c' }])
    expect(buildTasksView(state(tasks), false, 0, 2_000).rows.map(r => (r.k === 'task' ? r.id : r.k))).toEqual(['b', 'd'])
  })

  it('shows a message instead of an empty list', () => {
    expect(buildTasksView(state([]), true, 0, 2_000).emptyMessage).toBe('No tasks today')
    expect(buildTasksView(state([task('a', true)]), false, 0, 2_000).emptyMessage).toContain('All done (1)')
  })

  it('fits exactly 20 tasks on one page and pages beyond that', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => task(String(i)))
    expect(buildTasksView(state(many(MAX_ROWS)), true, 0, 0).rows).toHaveLength(MAX_ROWS)

    const first = buildTasksView(state(many(40)), true, 0, 0)
    expect(first.pageCount).toBe(3)
    expect(first.rows).toHaveLength(PAGE_SIZE + 1)
    expect(first.rows.at(-1)).toEqual({ k: 'next' })

    const middle = buildTasksView(state(many(40)), true, 1, 0)
    expect(middle.rows[0]).toEqual({ k: 'prev' })
    expect(middle.rows.at(-1)).toEqual({ k: 'next' })
    expect(middle.rows.length).toBeLessThanOrEqual(MAX_ROWS)

    const last = buildTasksView(state(many(40)), true, 9, 0)
    expect(last.page).toBe(2) // clamped
    expect(last.rows.at(-1)).toEqual({ k: 'task', id: '39' })
  })
})

describe('face and message views', () => {
  it('puts the open count and the next task on the face', () => {
    const now = new Date(2026, 8, 20, 14, 5)
    const view = buildFaceView(state([task('a', true), task('b', false, '🎯 Plan week')], { lastSyncAt: now.getTime() }), DEFAULT_SETTINGS, now)
    expect(view).toMatchObject({ count: '1', caption: 'open · 1 done', clock: '2:05', date: 'Sun 20 Sep', next: '▶ Plan week', status: '' })
    expect(buildFaceView(state([task('a', true)]), { ...DEFAULT_SETTINGS, clock24h: true }, now)).toMatchObject({ count: '0', caption: 'all done · 1', clock: '14:05', next: '' })
  })

  it('explains why there is nothing to show', () => {
    expect(messageFor(state([], { auth: 'signedOut' }))).toContain('not connected')
    expect(messageFor(state([], { auth: 'expired' }))).toContain('expired')
    expect(messageFor(state([], { lastSyncAt: undefined, status: 'loading' }))).toBe('Loading…')
    expect(messageFor(state([], { lastSyncAt: undefined, status: 'error' }))).toContain('Tap to retry')
    expect(messageFor(state([]))).toBeNull()
  })
})
