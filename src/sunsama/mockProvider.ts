import type { Profile, Task, TaskProvider } from '../core/types'

const TITLES = [
  'Review quarterly budget',
  'Reply to supplier about the delayed shipment and new delivery dates for October',
  'Weekly prep',
  'Book dentist appointment',
  'Draft panel questions',
  'Pick up dry cleaning',
  'Read architecture proposal',
]

export interface MockOptions {
  /** Number of tasks (default 5; the last two start completed). */
  tasks?: number
  fail?: 'toggle' | 'list' | null
  latencyMs?: number
}

/** `?tasks=N&fail=toggle|list` on the page URL tunes the mock, e.g. for the e2e script. */
export function mockOptionsFromUrl(search: string): MockOptions {
  const params = new URLSearchParams(search)
  const fail = params.get('fail')
  return {
    tasks: params.has('tasks') ? Math.max(0, Number(params.get('tasks')) || 0) : undefined,
    fail: fail === 'toggle' || fail === 'list' ? fail : null,
  }
}

/** In-memory tasks so the simulator and tests run without a Sunsama account. */
export class MockProvider implements TaskProvider {
  private tasks: Task[]
  private readonly fail: MockOptions['fail']
  private readonly latencyMs: number

  constructor(options: MockOptions = {}) {
    const count = options.tasks ?? 5
    this.fail = options.fail ?? null
    this.latencyMs = options.latencyMs ?? 150
    this.tasks = Array.from({ length: count }, (_, i) => ({
      id: `t${i + 1}`,
      title: i < TITLES.length ? TITLES[i] : `Task ${i + 1}`,
      completed: count > 2 && i >= count - 2,
      subtasksDone: i === 2 ? 1 : 0,
      subtasksTotal: i === 2 ? 3 : 0,
    }))
  }

  async getProfile(): Promise<Profile> {
    await this.delay()
    return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
  }

  async listTasks(_day: string): Promise<Task[]> {
    await this.delay()
    if (this.fail === 'list') throw new Error('mock: list failed')
    return this.tasks.map(t => ({ ...t }))
  }

  async setCompleted(id: string, completed: boolean, _day: string): Promise<void> {
    await this.delay()
    if (this.fail === 'toggle') throw new Error('mock: toggle failed')
    this.tasks = this.tasks.map(t => (t.id === id ? { ...t, completed } : t))
  }

  private delay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, this.latencyMs))
  }
}
