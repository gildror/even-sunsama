import { doneTasks, filterByChannel, hasMixedPriorities, nextTask, orderedTasks } from '../../core/selectors'
import type { Priority, StoreState, Task } from '../../core/types'
import type { GlassesInput } from '../events'
import { GLYPHS, headerLine, priorityLabel, taskRowLabel } from '../format'
import { MENU, buildMenu } from '../menu'
import { SCREEN_W } from '../page'
import type { PageSpec } from '../page'
import type { Screen, ScreenContext } from './types'

/** Firmware limit for list rows. */
export const MAX_ROWS = 20
/** Task rows per page once paging is needed (leaves room for Prev/Next). */
export const PAGE_SIZE = 18
const FAILED_FLAG_MS = 3_100

export type Row = { k: 'task'; id: string } | { k: 'prev' } | { k: 'next' } | { k: 'group'; priority: Priority }

export interface TasksView {
  header: string
  rows: Row[]
  itemNames: string[]
  /** Shown instead of the list when there are no rows (a list needs at least one item). */
  emptyMessage?: string
  page: number
  pageCount: number
}

function buildOpenRows(tasks: Task[], grouped: boolean): { rows: Row[]; itemNames: string[] } {
  const rows: Row[] = []
  const itemNames: string[] = []
  let currentKey: string | null = null
  for (const task of tasks) {
    if (grouped) {
      const key = task.priority ?? 'normal'
      if (key !== currentKey) {
        currentKey = key
        rows.push({ k: 'group', priority: task.priority })
        itemNames.push(`— ${priorityLabel(task.priority)} —`)
      }
    }
    rows.push({ k: 'task', id: task.id })
    itemNames.push(taskRowLabel(task))
  }
  return { rows, itemNames }
}

/**
 * Pure view-model for the task list: open first (grouped by priority when
 * more than one is in play and it still fits on one page), completed after,
 * paged beyond 20 rows. Pagination falls back to a flat list — see buildTasksView.
 */
export function buildTasksView(state: StoreState, showCompleted: boolean, channelFilter: string[], page: number, now: number): TasksView {
  const header = headerLine(state, channelFilter, now)
  const tasks = filterByChannel(state.tasks, channelFilter)
  const openSorted = orderedTasks(tasks, false)
  const done = showCompleted ? doneTasks(tasks) : []
  const doneRows: Row[] = done.map(t => ({ k: 'task', id: t.id }))
  const doneNames = done.map(taskRowLabel)

  if (openSorted.length + done.length === 0) {
    const emptyMessage = tasks.length === 0 ? 'No tasks today' : `All done (${tasks.length}) ★`
    return { header, rows: [], itemNames: [], emptyMessage, page: 0, pageCount: 1 }
  }

  if (hasMixedPriorities(tasks)) {
    const grouped = buildOpenRows(openSorted, true)
    const rows = [...grouped.rows, ...doneRows]
    const itemNames = [...grouped.itemNames, ...doneNames]
    if (rows.length <= MAX_ROWS) return { header, rows, itemNames, page: 0, pageCount: 1 }
    // Headers would push this past the row budget: fall through to the flat, paginated list below.
  }

  const flat = buildOpenRows(openSorted, false)
  const rows = [...flat.rows, ...doneRows]
  const itemNames = [...flat.itemNames, ...doneNames]
  if (rows.length <= MAX_ROWS) return { header, rows, itemNames, page: 0, pageCount: 1 }

  const pageCount = Math.ceil(rows.length / PAGE_SIZE)
  const current = Math.min(Math.max(page, 0), pageCount - 1)
  const sliceRows = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const sliceNames = itemNames.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const pagedRows: Row[] = []
  const pagedNames: string[] = []
  if (current > 0) {
    pagedRows.push({ k: 'prev' })
    pagedNames.push(`${GLYPHS.up} Prev (${current}/${pageCount})`)
  }
  pagedRows.push(...sliceRows)
  pagedNames.push(...sliceNames)
  if (current < pageCount - 1) {
    pagedRows.push({ k: 'next' })
    pagedNames.push(`${GLYPHS.down} Next (${current + 2}/${pageCount})`)
  }
  return { header, rows: pagedRows, itemNames: pagedNames, page: current, pageCount }
}

const HDR = { id: 1, name: 'hdr' }

export class TasksScreen implements Screen {
  readonly name = 'tasks'
  private view: TasksView | null = null
  private pageKey = ''
  private page = 0
  private failedTimer: ReturnType<typeof setTimeout> | null = null
  /** The task the "Open" menu item targets — the only row-targeting signal the platform gives us (see README). */
  private lastSelectedTaskId: string | null = null

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
      case 'menu':
        this.onMenu(input.itemID)
        return
      default:
        return
    }
  }

  private onMenu(itemID: number): void {
    switch (itemID) {
      case MENU.SWITCH:
        this.ctx.go('face')
        return
      case MENU.REFRESH:
        void this.ctx.sync.refreshNow()
        return
      case MENU.TOGGLE_COMPLETED:
        this.ctx.settings.update({ showCompleted: !this.ctx.settings.get().showCompleted })
        return
      case MENU.OPEN: {
        // No prior tap this session: fall back to the top visible open task instead of doing nothing.
        const settings = this.ctx.settings.get()
        const visible = filterByChannel(this.ctx.store.getState().tasks, settings.channelFilter)
        const id = this.lastSelectedTaskId ?? nextTask(orderedTasks(visible, false))?.id
        if (id) this.ctx.openFocus(id)
        return
      }
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
      this.lastSelectedTaskId = row.id
      const task = this.ctx.store.getState().tasks.find(t => t.id === row.id)
      // A task with subtasks can only be completed by finishing all of them — open Task View
      // for that instead of toggling here. A task with none still completes with one tap.
      if (task && task.subtasksTotal > 0) this.ctx.openFocus(row.id)
      else void this.ctx.store.toggle(row.id)
    } else if (row.k === 'prev' || row.k === 'next') {
      this.page = view.page + (row.k === 'next' ? 1 : -1)
      this.render()
    }
    // 'group' header rows are informational only.
  }

  /** Lists cannot change in place: rebuild when rows change, otherwise only touch the header. */
  private render(): void {
    const settings = this.ctx.settings.get()
    const view = buildTasksView(this.ctx.store.getState(), settings.showCompleted, settings.channelFilter, this.page, this.ctx.now().getTime())
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
