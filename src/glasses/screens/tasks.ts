import { orderedTasks } from '../../core/selectors'
import type { StoreState } from '../../core/types'
import type { GlassesInput } from '../events'
import { GLYPHS, headerLine, taskRowLabel } from '../format'
import { buildMenu } from '../menu'
import { SCREEN_W } from '../page'
import type { PageSpec } from '../page'
import type { Screen, ScreenContext } from './types'

/** Firmware limit for list rows. */
export const MAX_ROWS = 20
/** Task rows per page once paging is needed (leaves room for Prev/Next). */
export const PAGE_SIZE = 18
const FAILED_FLAG_MS = 3_100

export type Row = { k: 'task'; id: string } | { k: 'prev' } | { k: 'next' }

export interface TasksView {
  header: string
  rows: Row[]
  itemNames: string[]
  /** Shown instead of the list when there are no rows (a list needs at least one item). */
  emptyMessage?: string
  page: number
  pageCount: number
}

/** Pure view-model for the task list: open first, completed after, paged beyond 20 rows. */
export function buildTasksView(state: StoreState, showCompleted: boolean, page: number, now: number): TasksView {
  const header = headerLine(state, now)
  const tasks = orderedTasks(state.tasks, showCompleted)

  if (tasks.length === 0) {
    const emptyMessage = state.tasks.length === 0 ? 'No tasks today' : `All done (${state.tasks.length}) ★`
    return { header, rows: [], itemNames: [], emptyMessage, page: 0, pageCount: 1 }
  }

  if (tasks.length <= MAX_ROWS) {
    return { header, rows: tasks.map(t => ({ k: 'task', id: t.id })), itemNames: tasks.map(taskRowLabel), page: 0, pageCount: 1 }
  }

  const pageCount = Math.ceil(tasks.length / PAGE_SIZE)
  const current = Math.min(Math.max(page, 0), pageCount - 1)
  const slice = tasks.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const rows: Row[] = []
  const itemNames: string[] = []
  if (current > 0) {
    rows.push({ k: 'prev' })
    itemNames.push(`${GLYPHS.up} Prev (${current}/${pageCount})`)
  }
  for (const task of slice) {
    rows.push({ k: 'task', id: task.id })
    itemNames.push(taskRowLabel(task))
  }
  if (current < pageCount - 1) {
    rows.push({ k: 'next' })
    itemNames.push(`${GLYPHS.down} Next (${current + 2}/${pageCount})`)
  }
  return { header, rows, itemNames, page: current, pageCount }
}

const HDR = { id: 1, name: 'hdr' }

export class TasksScreen implements Screen {
  readonly name = 'tasks'
  private view: TasksView | null = null
  private pageKey = ''
  private page = 0
  private failedTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ctx: ScreenContext) {}

  enter(): void {
    this.page = 0
    this.pageKey = ''
    this.render()
    this.ctx.sync.refreshIfStale(30_000)
    this.ctx.log(`screen=tasks rows=${this.view?.rows.length ?? 0}`)
  }

  exit(): void {
    if (this.failedTimer) clearTimeout(this.failedTimer)
    this.failedTimer = null
  }

  onState(): void {
    this.render()
    // The "! failed" flag clears itself; nothing else would trigger that redraw.
    const failedAt = this.ctx.store.getState().lastToggleFailedAt
    if (failedAt !== undefined && this.ctx.now().getTime() - failedAt < FAILED_FLAG_MS && !this.failedTimer) {
      this.failedTimer = setTimeout(() => {
        this.failedTimer = null
        this.render()
      }, FAILED_FLAG_MS)
    }
  }

  onTick(): void {
    this.render()
  }

  onInput(input: GlassesInput): void {
    switch (input.t) {
      case 'doubleClick':
        this.ctx.go('face')
        return
      case 'click':
        // Only reachable on the empty page, where the text container captures input.
        void this.ctx.sync.refreshNow()
        return
      case 'listSelect':
        this.select(input.index, input.name)
        return
      default:
        return
    }
  }

  private select(index: number, name?: string): void {
    const view = this.view
    const row = view?.rows[index]
    // The list on the glasses must match what we last sent, or the index points at the wrong task.
    if (!view || !row || (name !== undefined && name !== view.itemNames[index])) {
      this.pageKey = ''
      this.render()
      return
    }
    if (row.k === 'task') {
      void this.ctx.store.toggle(row.id)
    } else {
      this.page = view.page + (row.k === 'next' ? 1 : -1)
      this.render()
    }
  }

  /** Lists cannot change in place: rebuild when rows change, otherwise only touch the header. */
  private render(): void {
    const settings = this.ctx.settings.get()
    const view = buildTasksView(this.ctx.store.getState(), settings.showCompleted, this.page, this.ctx.now().getTime())
    this.page = view.page
    const menu = buildMenu('tasks', settings)
    const pageKey = JSON.stringify([view.itemNames, view.emptyMessage, menu])

    if (pageKey !== this.pageKey) {
      void this.ctx.display.showPage(toPage(view, menu))
    } else if (view.header !== this.view?.header) {
      void this.ctx.display.upgradeText(HDR.id, HDR.name, view.header)
    }
    this.pageKey = pageKey
    this.view = view
  }
}

function toPage(view: TasksView, menu: PageSpec['menu']): PageSpec {
  const header = { ...HDR, x: 0, y: 0, w: SCREEN_W, h: 40, content: view.header }
  if (view.emptyMessage) {
    return {
      texts: [header, { id: 2, name: 'empty', x: 0, y: 100, w: SCREEN_W, h: 80, content: view.emptyMessage, capture: true }],
      menu,
    }
  }
  return {
    texts: [header],
    lists: [{ id: 2, name: 'tasks', x: 0, y: 42, w: SCREEN_W, h: 246, items: view.itemNames, capture: true }],
    menu,
  }
}
