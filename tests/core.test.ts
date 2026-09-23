import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redact } from '../src/core/logger'
import { availableChannels, filterByChannel, hasMixedPriorities, nextMeetingSoon, nextTask, openCount, orderedSubtasks, orderedTasks } from '../src/core/selectors'
import { getGlanceSummary } from '../src/core/summary'
import { SyncController } from '../src/core/sync'
import { TaskStore } from '../src/core/taskStore'
import { formatClock, msToNextMinute, parseTimeOfDay12h, todayInTz, zonedTimeToUtc } from '../src/core/time'
import { AuthRequiredError } from '../src/core/types'
import type { CalendarEvent, KeyValueStore, Priority, StoreState, Task, TaskProvider, WeeklyObjective } from '../src/core/types'

const task = (id: string, completed = false, priority: Priority = null, channel = ''): Task => ({
  id,
  title: `Task ${id}`,
  completed,
  notes: '',
  subtasks: [],
  subtasksDone: 0,
  subtasksTotal: 0,
  priority,
  channel,
})

const state = (patch: Partial<StoreState> = {}): StoreState => ({
  day: '',
  tz: '',
  tasks: [],
  events: [],
  objectives: [],
  pending: {},
  pendingSubtasks: {},
  status: 'idle',
  auth: 'unknown',
  ...patch,
})

class MemoryKv implements KeyValueStore {
  data = new Map<string, string>()
  async get(key: string) {
    return this.data.get(key) || null
  }
  async set(key: string, value: string) {
    this.data.set(key, value)
  }
  async remove(key: string) {
    this.data.delete(key)
  }
}

function fakeProvider(tasks: Task[], events: CalendarEvent[] = [], objectives: WeeklyObjective[] = []) {
  return {
    getProfile: vi.fn(async () => ({ timezone: 'America/New_York' })),
    listTasks: vi.fn(async (_day: string) => tasks.map(t => ({ ...t, subtasks: t.subtasks.map(s => ({ ...s })) }))),
    getEventsForDay: vi.fn(async (_day: string) => events.map(e => ({ ...e }))),
    getWeeklyObjectives: vi.fn(async (_day: string) => objectives.map(o => ({ ...o }))),
    setCompleted: vi.fn(async (_id: string, _completed: boolean, _day: string) => {}),
    setSubtaskCompleted: vi.fn(async (_taskId: string, _subtaskId: string, _completed: boolean) => {}),
  } satisfies TaskProvider
}

describe('time', () => {
  it('computes the day in the account timezone, not the device one', () => {
    const lateEveningNY = new Date('2026-09-21T03:30:00Z') // 23:30 on the 20th in New York
    expect(todayInTz('America/New_York', lateEveningNY)).toBe('2026-09-20')
    expect(todayInTz('Asia/Jerusalem', lateEveningNY)).toBe('2026-09-21')
  })

  it('handles DST changes and unknown zones', () => {
    expect(todayInTz('America/New_York', new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-08')
    expect(todayInTz('Not/AZone', new Date())).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('formats the clock and finds the next minute', () => {
    expect(formatClock(new Date(2026, 0, 1, 0, 7), false)).toBe('12:07')
    expect(formatClock(new Date(2026, 0, 1, 0, 7), true)).toBe('00:07')
    expect(msToNextMinute(new Date(2026, 0, 1, 0, 0, 45, 500))).toBe(14_500)
  })

  it('parses Sunsama event time strings, including noon/midnight', () => {
    expect(parseTimeOfDay12h('9:00 AM')).toEqual({ h: 9, m: 0 })
    expect(parseTimeOfDay12h('12:30 PM')).toEqual({ h: 12, m: 30 })
    expect(parseTimeOfDay12h('12:00 AM')).toEqual({ h: 0, m: 0 })
    expect(parseTimeOfDay12h('11:05 pm')).toEqual({ h: 23, m: 5 })
    expect(parseTimeOfDay12h('not a time')).toBeNull()
    expect(parseTimeOfDay12h('13:00 AM')).toBeNull()
  })

  it('converts a wall-clock time in a zone to the right absolute instant', () => {
    // 9:00 AM in New York on 2026-09-23 is 13:00 UTC (EDT, UTC-4).
    const instant = zonedTimeToUtc('2026-09-23', { h: 9, m: 0 }, 'America/New_York')
    expect(instant.toISOString()).toBe('2026-09-23T13:00:00.000Z')
    // Round-trips through a non-device zone too.
    const tokyo = zonedTimeToUtc('2026-09-23', { h: 9, m: 0 }, 'Asia/Tokyo')
    expect(tokyo.toISOString()).toBe('2026-09-23T00:00:00.000Z')
  })
})

describe('selectors and summary', () => {
  it('counts open tasks and finds the next one', () => {
    const tasks = [task('a', true), task('b'), task('c')]
    expect(openCount(tasks)).toBe(2)
    expect(nextTask(tasks)?.id).toBe('b')
    expect(orderedTasks(tasks, true).map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('orders open tasks by priority, keeping Sunsama order within a priority', () => {
    const tasks = [task('a', false, 'normal'), task('b', false, 'urgent'), task('c', false, 'important'), task('d', false, 'urgent')]
    expect(orderedTasks(tasks, false).map(t => t.id)).toEqual(['b', 'd', 'c', 'a'])
    expect(hasMixedPriorities(tasks)).toBe(true)
    expect(hasMixedPriorities([task('a', false, 'normal'), task('b')])).toBe(false)
    expect(hasMixedPriorities([task('a', true, 'urgent'), task('b', false, 'normal')])).toBe(false) // completed tasks don't count
  })

  it('sinks completed subtasks to the bottom, keeping order within each group', () => {
    const subtasks = [
      { id: 's1', title: 'One', completed: true },
      { id: 's2', title: 'Two', completed: false },
      { id: 's3', title: 'Three', completed: false },
      { id: 's4', title: 'Four', completed: true },
    ]
    expect(orderedSubtasks(subtasks).map(s => s.id)).toEqual(['s2', 's3', 's1', 's4'])
  })

  it('summarises for glance surfaces using priority-ordered "next"', () => {
    const tasks = [task('a', true), task('b', false, 'normal'), task('c', false, 'urgent')]
    const base = state({ day: 'd', tz: 'UTC', tasks, auth: 'signedIn' })
    expect(getGlanceSummary({ ...base, lastSyncAt: 1_000 }, [], 2_000)).toMatchObject({ openCount: 2, doneCount: 1, nextTitle: 'Task c', stale: false })
    expect(getGlanceSummary({ ...base, lastSyncAt: 1_000 }, [], 1_000 + 11 * 60_000).stale).toBe(true)
    expect(getGlanceSummary({ ...base, status: 'error' }, [], 0).stale).toBe(true)
  })

  it('summary respects the channel filter', () => {
    const tasks = [task('a', false, null, 'Work'), task('b', false, null, 'Personal')]
    const base = state({ day: 'd', tz: 'UTC', tasks, auth: 'signedIn' })
    expect(getGlanceSummary(base, ['Work'], 0).openCount).toBe(1)
    expect(getGlanceSummary(base, [], 0).openCount).toBe(2)
  })

  it('filterByChannel and availableChannels', () => {
    const tasks = [task('a', false, null, 'Work'), task('b', false, null, 'Personal'), task('c', false, null, 'Work'), task('d')]
    expect(filterByChannel(tasks, []).map(t => t.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterByChannel(tasks, ['Work']).map(t => t.id)).toEqual(['a', 'c'])
    expect(filterByChannel(tasks, ['Personal', 'Work']).map(t => t.id)).toEqual(['a', 'b', 'c'])
    expect(availableChannels(tasks)).toEqual(['Work', 'Personal'])
  })

  it('finds the soonest meeting starting within the threshold, in the account timezone', () => {
    const now = new Date('2026-09-23T12:55:00Z') // 8:55 AM in New York
    const events: CalendarEvent[] = [
      { id: '1', title: 'All day', startTime: '12:00 AM', durationMin: 0, isMeeting: true, isAllDay: true, isBusy: true },
      { id: '2', title: 'Focus block', startTime: '9:30 AM', durationMin: 30, isMeeting: false, isAllDay: false, isBusy: true },
      { id: '3', title: 'Standup', startTime: '9:00 AM', durationMin: 15, isMeeting: true, isAllDay: false, isBusy: true }, // 5 min away
      { id: '4', title: 'Later sync', startTime: '10:00 AM', durationMin: 30, isMeeting: true, isAllDay: false, isBusy: true },
    ]
    const soon = nextMeetingSoon(events, '2026-09-23', 'America/New_York', now, 10)
    expect(soon).toEqual({ title: 'Standup', minutesUntil: 5, inProgress: false })
    expect(nextMeetingSoon(events, '2026-09-23', 'America/New_York', now, 4)).toBeNull()
  })

  it('flags an in-progress meeting instead of treating it as past', () => {
    const now = new Date('2026-09-23T13:05:00Z') // 9:05 AM in New York, 5 min into a 15-min meeting
    const events: CalendarEvent[] = [{ id: '1', title: 'Standup', startTime: '9:00 AM', durationMin: 15, isMeeting: true, isAllDay: false, isBusy: true }]
    expect(nextMeetingSoon(events, '2026-09-23', 'America/New_York', now, 10)).toEqual({ title: 'Standup', minutesUntil: 0, inProgress: true })
  })
})

describe('TaskStore', () => {
  const now = () => new Date('2026-09-21T03:30:00Z') // still the 20th in New York

  it('refreshes using the day in the account timezone and caches tasks and events', async () => {
    const events: CalendarEvent[] = [{ id: 'e1', title: 'Sync', startTime: '9:00 AM', durationMin: 30, isMeeting: true, isAllDay: false, isBusy: true }]
    const provider = fakeProvider([task('a'), task('b', true)], events)
    const kv = new MemoryKv()
    const store = new TaskStore({ provider, kv, now })
    await store.refresh()
    expect(provider.listTasks).toHaveBeenCalledWith('2026-09-20')
    expect(provider.getEventsForDay).toHaveBeenCalledWith('2026-09-20')
    expect(store.getState()).toMatchObject({ day: '2026-09-20', tz: 'America/New_York', status: 'idle', auth: 'signedIn', events })

    const restored = new TaskStore({ provider, kv, now })
    await restored.hydrate()
    expect(restored.getState().tasks).toHaveLength(2)
    expect(restored.getState().events).toEqual(events)
  })

  it("drops yesterday's cached tasks but keeps the timezone", async () => {
    const kv = new MemoryKv()
    await kv.set('tasks.cache.v1', JSON.stringify({ day: '2026-09-19', tz: 'America/New_York', tasks: [task('old')], lastSyncAt: 1 }))
    const store = new TaskStore({ provider: fakeProvider([]), kv, now })
    await store.hydrate()
    expect(store.getState()).toMatchObject({ tasks: [], tz: 'America/New_York', day: '2026-09-20' })
  })

  it('checks off optimistically and passes the completion day', async () => {
    const provider = fakeProvider([task('a')])
    let finish!: () => void
    provider.setCompleted.mockImplementation(() => new Promise<void>(resolve => (finish = resolve)))
    const store = new TaskStore({ provider, kv: new MemoryKv(), now })
    await store.refresh()

    const toggling = store.toggle('a')
    expect(store.getState().tasks[0].completed).toBe(true)
    expect(store.getState().pending).toEqual({ a: true })
    expect(await store.toggle('a')).toBe(false) // ignored while pending
    finish()
    expect(await toggling).toBe(true)
    expect(provider.setCompleted).toHaveBeenCalledTimes(1)
    expect(provider.setCompleted).toHaveBeenCalledWith('a', true, '2026-09-20')
    expect(store.getState().pending).toEqual({})
  })

  it('rolls back when the provider rejects', async () => {
    const provider = fakeProvider([task('a')])
    provider.setCompleted.mockRejectedValue(new Error('offline'))
    const store = new TaskStore({ provider, kv: new MemoryKv(), now })
    await store.refresh()
    expect(await store.toggle('a')).toBe(false)
    expect(store.getState().tasks[0].completed).toBe(false)
    expect(store.getState()).toMatchObject({ status: 'error', lastError: 'offline', pending: {} })
    expect(store.getState().lastToggleFailedAt).toBeDefined()
  })

  it('keeps the local value for a task whose check-off is still in flight during a refresh', async () => {
    const provider = fakeProvider([task('a')])
    let finish!: () => void
    provider.setCompleted.mockImplementation(() => new Promise<void>(resolve => (finish = resolve)))
    const store = new TaskStore({ provider, kv: new MemoryKv(), now })
    await store.refresh()
    const toggling = store.toggle('a')
    await store.refresh() // server still says "open"
    expect(store.getState().tasks[0].completed).toBe(true)
    finish()
    await toggling
  })

  it('surfaces auth problems as auth state', async () => {
    const provider = fakeProvider([])
    provider.listTasks.mockRejectedValue(new AuthRequiredError('expired'))
    const store = new TaskStore({ provider, kv: new MemoryKv(), now })
    await expect(store.refresh()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(store.getState().auth).toBe('expired')
  })

  describe('subtasks', () => {
    const withSubtask = { ...task('a'), subtasks: [{ id: 's1', title: 'Sub', completed: false }], subtasksTotal: 1 }

    it('toggles a subtask optimistically and recomputes the done count', async () => {
      const provider = fakeProvider([withSubtask])
      let finish!: () => void
      provider.setSubtaskCompleted.mockImplementation(() => new Promise<void>(resolve => (finish = resolve)))
      const store = new TaskStore({ provider, kv: new MemoryKv(), now })
      await store.refresh()

      const toggling = store.toggleSubtask('a', 's1')
      expect(store.getState().tasks[0].subtasks[0].completed).toBe(true)
      expect(store.getState().tasks[0].subtasksDone).toBe(1)
      expect(store.getState().pendingSubtasks).toEqual({ s1: true })
      expect(await store.toggleSubtask('a', 's1')).toBe(false) // ignored while pending
      finish()
      expect(await toggling).toBe(true)
      expect(provider.setSubtaskCompleted).toHaveBeenCalledWith('a', 's1', true)
      expect(store.getState().pendingSubtasks).toEqual({})
    })

    it('rolls back a failed subtask toggle', async () => {
      const provider = fakeProvider([withSubtask])
      provider.setSubtaskCompleted.mockRejectedValue(new Error('offline'))
      const store = new TaskStore({ provider, kv: new MemoryKv(), now })
      await store.refresh()
      expect(await store.toggleSubtask('a', 's1')).toBe(false)
      expect(store.getState().tasks[0].subtasks[0].completed).toBe(false)
      expect(store.getState().tasks[0].subtasksDone).toBe(0)
      expect(store.getState().pendingSubtasks).toEqual({})
      expect(store.getState().lastToggleFailedAt).toBeDefined()
    })

    it('keeps a subtask toggle that is still in flight across a refresh', async () => {
      const provider = fakeProvider([withSubtask])
      let finish!: () => void
      provider.setSubtaskCompleted.mockImplementation(() => new Promise<void>(resolve => (finish = resolve)))
      const store = new TaskStore({ provider, kv: new MemoryKv(), now })
      await store.refresh()
      const toggling = store.toggleSubtask('a', 's1')
      await store.refresh()
      expect(store.getState().tasks[0].subtasks[0].completed).toBe(true)
      expect(store.getState().tasks[0].subtasksDone).toBe(1)
      finish()
      await toggling
    })

    it('ignores a toggle for a subtask that does not exist', async () => {
      const store = new TaskStore({ provider: fakeProvider([withSubtask]), kv: new MemoryKv(), now })
      await store.refresh()
      expect(await store.toggleSubtask('a', 'nope')).toBe(false)
      expect(await store.toggleSubtask('missing-task', 's1')).toBe(false)
    })

    describe('completion sync', () => {
      // Two subtasks, one already done: a task with subtasks can only complete via its subtasks.
      const partial = {
        ...task('a'),
        subtasks: [
          { id: 's1', title: 'One', completed: true },
          { id: 's2', title: 'Two', completed: false },
        ],
        subtasksDone: 1,
        subtasksTotal: 2,
      }

      it('auto-completes the task once its last subtask is checked off', async () => {
        const provider = fakeProvider([partial])
        const store = new TaskStore({ provider, kv: new MemoryKv(), now })
        await store.refresh()
        expect(await store.toggleSubtask('a', 's2')).toBe(true)
        expect(provider.setCompleted).toHaveBeenCalledWith('a', true, '2026-09-20')
        expect(store.getState().tasks[0].completed).toBe(true)
        expect(store.getState().pending).toEqual({})
      })

      it('auto-uncompletes an already-complete task when a subtask is unchecked', async () => {
        const done = { ...partial, completed: true, subtasks: partial.subtasks.map(s => ({ ...s, completed: true })), subtasksDone: 2 }
        const provider = fakeProvider([done])
        const store = new TaskStore({ provider, kv: new MemoryKv(), now })
        await store.refresh()
        expect(await store.toggleSubtask('a', 's1')).toBe(true)
        expect(provider.setCompleted).toHaveBeenCalledWith('a', false, '2026-09-20')
        expect(store.getState().tasks[0].completed).toBe(false)
      })

      it('leaves task completion alone when some subtasks are still open', async () => {
        const provider = fakeProvider([partial])
        const store = new TaskStore({ provider, kv: new MemoryKv(), now })
        await store.refresh()
        expect(await store.toggleSubtask('a', 's1')).toBe(true) // un-checks the one that was done; still not "all done"
        expect(provider.setCompleted).not.toHaveBeenCalled()
        expect(store.getState().tasks[0].completed).toBe(false)
      })

      it('rolls back just the completion sync if it fails, keeping the subtask toggle that already succeeded', async () => {
        const provider = fakeProvider([partial])
        provider.setCompleted.mockRejectedValue(new Error('offline'))
        const store = new TaskStore({ provider, kv: new MemoryKv(), now })
        await store.refresh()
        expect(await store.toggleSubtask('a', 's2')).toBe(true) // the subtask call itself succeeded
        const finalTask = store.getState().tasks[0]
        expect(finalTask.subtasks.find(s => s.id === 's2')?.completed).toBe(true)
        expect(finalTask.completed).toBe(false) // rolled back
        expect(store.getState().lastToggleFailedAt).toBeDefined()
      })

      it('does not fire a second completion call while one is already in flight for the task', async () => {
        const provider = fakeProvider([partial])
        let finishComplete!: () => void
        provider.setCompleted.mockImplementation(() => new Promise<void>(resolve => (finishComplete = resolve)))
        const store = new TaskStore({ provider, kv: new MemoryKv(), now })
        await store.refresh()

        const completing = store.toggle('a') // unrelated manual completion toggle, still in flight
        await store.toggleSubtask('a', 's2') // would otherwise also want to complete the task
        expect(provider.setCompleted).toHaveBeenCalledTimes(1)
        finishComplete()
        await completing
      })
    })
  })
})

describe('SyncController', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls on the interval and backs off after errors', async () => {
    const provider = fakeProvider([task('a')])
    const store = new TaskStore({ provider, kv: new MemoryKv() })
    const sync = new SyncController({ store, pollMs: () => 120_000 })
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.listTasks).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(provider.listTasks).toHaveBeenCalledTimes(2)

    provider.listTasks.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(120_000) // fails -> retry in 5 s
    await vi.advanceTimersByTimeAsync(5_000) // fails -> retry in 10 s
    expect(provider.listTasks).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(provider.listTasks).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.listTasks).toHaveBeenCalledTimes(5)
  })

  it('stops while paused and resumes without refetching fresh data', async () => {
    const provider = fakeProvider([task('a')])
    const store = new TaskStore({ provider, kv: new MemoryKv() })
    const sync = new SyncController({ store, pollMs: () => 60_000 })
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    sync.pause()
    sync.pause() // idempotent
    await vi.advanceTimersByTimeAsync(600_000)
    expect(provider.listTasks).toHaveBeenCalledTimes(1)

    sync.resume() // stale by now
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.listTasks).toHaveBeenCalledTimes(2)
    sync.resume() // fresh: no extra call
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.listTasks).toHaveBeenCalledTimes(2)
  })

  it('refetches when the day rolls over in the account timezone', async () => {
    vi.setSystemTime(new Date('2026-09-21T03:30:00Z'))
    const provider = fakeProvider([task('a')])
    const store = new TaskStore({ provider, kv: new MemoryKv() })
    const sync = new SyncController({ store, pollMs: () => 3_600_000 })
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    sync.tick()
    expect(provider.listTasks).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-21T04:01:00Z')) // just past midnight in New York
    sync.tick()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.listTasks).toHaveBeenLastCalledWith('2026-09-21')
  })
})

describe('logger redaction', () => {
  it('never lets token material through', () => {
    expect(redact('bundle es1.abcDEF-123_x and Bearer abc.def.ghi')).toBe('bundle es1.<redacted> and Bearer <redacted>')
    expect(redact('{"refresh_token":"secret123","x":1}')).not.toContain('secret123')
  })
})
