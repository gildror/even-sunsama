import { nextMeetingSoon, orderedSubtasks } from '../../core/selectors'
import { formatClock } from '../../core/time'
import type { Subtask, Task } from '../../core/types'
import type { GlassesInput } from '../events'
import { cleanTitle, formatMeetingBanner, priorityPrefix, stripHtml, subtaskRowLabel, truncateUtf8 } from '../format'
import { FOCUS_FULL_MENU, FOCUS_MIN_MENU, buildFocusFullMenu, buildFocusMinMenu } from '../menu'
import { SCREEN_H, SCREEN_W } from '../page'
import type { PageSpec } from '../page'
import type { Screen, ScreenContext } from './types'

const PEEK_MS = 10_000
/** Room left for notes after the header, before a subtask list (or more notes) takes the rest. */
const NOTES_CHARS_WITH_SUBTASKS = 160
const NOTES_CHARS_ALONE = 420
const MAX_SUBTASK_ROWS = 20

const EVT = { id: 1, name: 'evt', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
const HDR = { id: 2, name: 'hdr', x: 8, y: 4, w: 560, h: 56 }
const NOTES = { id: 3, name: 'notes', x: 8, y: 62, w: 560, h: 70 }
const NOTES_ALONE = { id: 3, name: 'notes', x: 8, y: 62, w: 560, h: 210 }
const LIST = { id: 4, name: 'subtasks', x: 0, y: 134, w: SCREEN_W, h: 152 }

// Numbered from 2 so these never collide with EVT (id 1) on the same page.
const MIN_BANNER = { id: 2, name: 'banner', x: 8, y: 8, w: 560, h: 32 }
const MIN_CLOCK = { id: 3, name: 'clock', x: 8, y: 48, w: 200, h: 48 }
const MIN_TITLE = { id: 4, name: 'title', x: 8, y: 100, w: 560, h: 48 }

/** header line for Task View: priority marker + title, truncated to the header box. */
function headerText(task: Task): string {
  return truncateUtf8(`${priorityPrefix(task.priority)}${cleanTitle(task.title)}`, 240)
}

/**
 * Task detail / Focus screen. Full mode shows description and checkable
 * subtasks; Focus mode is a two-line minimal display (clock + task name),
 * with a brief tap-triggered peek back to the full content, and a meeting
 * banner when one is starting soon. See README for the gesture model.
 */
export class FocusScreen implements Screen {
  readonly name = 'focus'
  private taskId: string | null = null
  private subMode: 'full' | 'focus' = 'full'
  private peeking = false
  private peekTimer: ReturnType<typeof setTimeout> | null = null
  private subtaskIds: string[] = []
  private lastMinimalKey = ''

  constructor(private readonly ctx: ScreenContext) {}

  enter(): void {
    this.taskId = this.ctx.getFocusTaskId()
    this.subMode = 'full'
    this.peeking = false
    this.lastMinimalKey = ''
    this.render()
    this.ctx.log(`screen=focus task=${this.taskId ?? 'none'}`)
  }

  exit(): void {
    this.clearPeekTimer()
  }

  onState(): void {
    if (this.subMode === 'full') this.render()
    // While in Focus mode the display is intentionally static between ticks.
  }

  onTick(): void {
    if (this.subMode === 'focus' && !this.peeking) this.renderMinimal()
  }

  onInput(input: GlassesInput): void {
    if (this.subMode === 'focus') {
      this.onFocusInput(input)
      return
    }
    switch (input.t) {
      case 'doubleClick':
        this.ctx.go('tasks')
        return
      case 'click':
        void this.ctx.sync.refreshNow() // only reachable with no subtasks, where the invisible layer captures taps
        return
      case 'listSelect':
        this.selectSubtask(input.index, input.name)
        return
      case 'menu':
        this.onFullMenu(input.itemID)
        return
      default:
        return
    }
  }

  private onFocusInput(input: GlassesInput): void {
    switch (input.t) {
      case 'click':
        this.startPeek()
        return
      case 'doubleClick':
        // Two taps exit focus mode entirely — back to the persistent full view.
        this.clearPeekTimer()
        this.subMode = 'full'
        this.peeking = false
        this.render()
        this.ctx.log('focus: mode=full')
        return
      case 'menu':
        this.onMinMenu(input.itemID)
        return
      default:
        return
    }
  }

  private startPeek(): void {
    this.peeking = true
    this.clearPeekTimer()
    this.render()
    this.peekTimer = setTimeout(() => {
      this.peeking = false
      // The peek replaced the display with the full page: renderMinimal's dedup guard must not
      // suppress this rebuild just because the minimal content itself hasn't changed since.
      this.lastMinimalKey = ''
      this.renderMinimal()
    }, PEEK_MS)
  }

  private clearPeekTimer(): void {
    if (this.peekTimer) clearTimeout(this.peekTimer)
    this.peekTimer = null
  }

  private onFullMenu(itemID: number): void {
    switch (itemID) {
      case FOCUS_FULL_MENU.FOCUS:
        this.subMode = 'focus'
        this.peeking = false
        this.lastMinimalKey = ''
        this.renderMinimal()
        this.ctx.log('focus: mode=focus')
        return
      case FOCUS_FULL_MENU.TASKS:
        this.ctx.go('tasks')
        return
      case FOCUS_FULL_MENU.REFRESH:
        void this.ctx.sync.refreshNow()
        return
      default:
        return
    }
  }

  private onMinMenu(itemID: number): void {
    switch (itemID) {
      case FOCUS_MIN_MENU.FULL:
        this.clearPeekTimer()
        this.subMode = 'full'
        this.peeking = false
        this.render()
        this.ctx.log('focus: mode=full')
        return
      case FOCUS_MIN_MENU.TASKS:
        this.ctx.go('tasks')
        return
      default:
        return
    }
  }

  private selectSubtask(index: number, name?: string): void {
    const task = this.currentTask()
    const subtaskId = this.subtaskIds[index]
    if (!task || !subtaskId || (name !== undefined && name !== this.subtaskLabelAt(index))) return
    void this.ctx.store.toggleSubtask(task.id, subtaskId)
  }

  private subtaskLabelAt(index: number): string | undefined {
    const task = this.currentTask()
    const subtask = task?.subtasks.find(s => s.id === this.subtaskIds[index])
    return subtask && subtaskRowLabel(subtask)
  }

  private currentTask(): Task | undefined {
    return this.taskId ? this.ctx.store.getState().tasks.find(t => t.id === this.taskId) : undefined
  }

  /** Full mode (and, identically, the 10s peek): header, notes, and checkable subtasks. */
  private render(): void {
    if (this.subMode === 'focus' && this.peeking) {
      void this.ctx.display.showPage(this.buildFullPage(true))
      return
    }
    const task = this.currentTask()
    if (!task) {
      // The task left today's list (completed elsewhere, moved, deleted) — nothing left to show.
      this.ctx.go('tasks')
      return
    }
    void this.ctx.display.showPage(this.buildFullPage(false))
  }

  private buildFullPage(readOnly: boolean): PageSpec {
    const task = this.currentTask()
    const menu = buildFocusFullMenu()
    if (!task) return { texts: [{ ...EVT, content: 'Task no longer available.\nDouble-tap to go back.', capture: true }], menu }

    const hasSubtasks = task.subtasks.length > 0
    const showCompleted = this.ctx.settings.get().showCompleted
    // "Hide completed" applies here too: a completed subtask disappears from the list, same as a
    // completed task disappears from Tasks.
    const visible = orderedSubtasks(showCompleted ? task.subtasks : task.subtasks.filter(s => !s.completed)).slice(0, MAX_SUBTASK_ROWS)
    const header = { ...HDR, content: headerText(task) }

    if (visible.length === 0) {
      this.subtaskIds = []
      // ★ not ✓: the glasses font only documents a specific glyph set, and a checkmark isn't in
      // it — confirmed in the simulator, it silently renders as blank space. ★ is the same glyph
      // the empty Tasks list already uses for "all done", so this stays consistent too.
      const status = hasSubtasks ? `★ All ${task.subtasksTotal} subtasks done` : ''
      const notesText = truncateUtf8([stripHtml(task.notes), status].filter(Boolean).join('\n\n') || ' ', NOTES_CHARS_ALONE)
      return { texts: [{ ...EVT, content: ' ', capture: true, padding: 0 }, header, { ...NOTES_ALONE, content: notesText }], menu }
    }

    const notes = { ...NOTES, content: truncateUtf8(stripHtml(task.notes) || ' ', NOTES_CHARS_WITH_SUBTASKS) }
    this.subtaskIds = visible.map(s => s.id)
    return {
      texts: [header, notes],
      lists: [{ ...LIST, items: visible.map(subtaskRowLabel), capture: !readOnly }],
      // readOnly (peek) still needs exactly one capturing container: the invisible full-bleed layer.
      ...(readOnly ? { texts: [{ ...EVT, content: ' ', capture: true, padding: 0 }, header, notes] } : {}),
      menu,
    }
  }

  /** Focus mode: two lines at the top, plus an upcoming-meeting banner when one applies. */
  private renderMinimal(): void {
    const task = this.currentTask()
    if (!task) {
      this.ctx.go('tasks')
      return
    }
    const state = this.ctx.store.getState()
    const appSettings = this.ctx.settings.get()
    const meeting = appSettings.meetingReminderEnabled
      ? nextMeetingSoon(state.events, state.day, state.tz, this.ctx.now(), appSettings.meetingReminderLeadMin)
      : null
    const banner = meeting ? formatMeetingBanner(meeting) : ''
    const clock = formatClock(this.ctx.now(), appSettings.clock24h)
    const title = truncateUtf8(`${priorityPrefix(task.priority)}${cleanTitle(task.title)}`, 90)
    const key = JSON.stringify([banner, clock, title])
    if (key === this.lastMinimalKey) return
    this.lastMinimalKey = key
    void this.ctx.display.showPage({
      texts: [
        { ...EVT, content: ' ', capture: true, padding: 0 },
        { ...MIN_BANNER, content: banner || ' ' },
        { ...MIN_CLOCK, content: clock },
        { ...MIN_TITLE, content: title },
      ],
      menu: buildFocusMinMenu(),
    })
  }
}

// Re-exported for tests that only need the pure row-label logic.
export type { Subtask }
