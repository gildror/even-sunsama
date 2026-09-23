import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redact } from '../src/core/logger'
import { nextTask, openCount, orderedTasks } from '../src/core/selectors'
import { getGlanceSummary } from '../src/core/summary'
import { SyncController } from '../src/core/sync'
import { TaskStore } from '../src/core/taskStore'
import { formatClock, msToNextMinute, todayInTz } from '../src/core/time'
import { AuthRequiredError } from '../src/core/types'
import type { KeyValueStore, Task, TaskProvider } from '../src/core/types'

const task = (id: string, completed = false): Task => ({ id, title: `Task ${id}`, completed, subtasksDone: 0, subtasksTotal: 0 })

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

function fakeProvider(tasks: Task[]) {
  return {
    getProfile: vi.fn(async () => ({ timezone: 'America/New_York' })),
    listTasks: vi.fn(async (_day: string) => tasks.map(t => ({ ...t }))),
    setCompleted: vi.fn(async (_id: string, _completed: boolean, _day: string) => {}),
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
})

describe('selectors and summary', () => {
  const tasks = [task('a', true), task('b'), task('c')]
  it('counts open tasks and finds the next one', () => {
    expect(openCount(tasks)).toBe(2)
    expect(nextTask(tasks)?.id).toBe('b')
    expect(orderedTasks(tasks, true).map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('summarises for glance surfaces', () => {
    const base = { day: 'd', tz: 'UTC', tasks, pending: {}, status: 'idle' as const, auth: 'signedIn' as const }
    expect(getGlanceSummary({ ...base, lastSyncAt: 1_000 }, 2_000)).toMatchObject({ openCount: 2, doneCount: 1, nextTitle: 'Task b', stale: false })
    expect(getGlanceSummary({ ...base, lastSyncAt: 1_000 }, 1_000 + 11 * 60_000).stale).toBe(true)
    expect(getGlanceSummary({ ...base, status: 'error' }, 0).stale).toBe(true)
  })
})

describe('TaskStore', () => {
  const now = () => new Date('2026-09-21T03:30:00Z') // still the 20th in New York

  it('refreshes using the day in the account timezone and caches the result', async () => {
    const provider = fakeProvider([task('a'), task('b', true)])
    const kv = new MemoryKv()
    const store = new TaskStore({ provider, kv, now })
    await store.refresh()
    expect(provider.listTasks).toHaveBeenCalledWith('2026-09-20')
    expect(store.getState()).toMatchObject({ day: '2026-09-20', tz: 'America/New_York', status: 'idle', auth: 'signedIn' })

    const restored = new TaskStore({ provider, kv, now })
    await restored.hydrate()
    expect(restored.getState().tasks).toHaveLength(2)
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
