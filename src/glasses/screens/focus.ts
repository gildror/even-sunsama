import { nextMeetingSoon, orderedSubtasks } from '../../core/selectors'
import { formatClock } from '../../core/time'
import type { Subtask, Task } from '../../core/types'
import type { GlassesInput } from '../events'
import { cleanTitle, formatMeetingBanner, priorityPrefix, stripHtml, subtaskRowLabel, truncateUtf8 } from '../format'
import { FOCUS_FULL_MENU, FOCUS_MIN_MENU, buildFocusFullMenu, buildFocusMinMenu } from '../menu'
import { SCREEN_H, SCREEN_W } from '../page'
import type { PageSpec } from '../page'
import type { Screen, ScreenContext } from './types'

/** No tap for this long in Focus mode blanks the display; any tap wakes it. */
const IDLE_MS = 10_000
/** Room left for notes after the header, before a subtask list (or more notes) takes the rest. */
const NOTES_CHARS_WITH_SUBTASKS = 160
const NOTES_CHARS_ALONE = 420
const MAX_SUBTASK_ROWS = 20

const EVT = { id: 1, name: 'evt', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
const HDR = { id: 2, name: 'hdr', x: 8, y: 4, w: 560, h: 56 }
const NOTES = { id: 3, name: 'notes', x: 8, y: 62, w: 560, h: 70 }
const NOTES_ALONE = { id: 3, name: 'notes', x: 8, y: 62, w: 560, h: 210 }
const LIST = { id: 4, name: 'subtasks', x: 0, y: 134, w: SCREEN_W, h: 152 }

// Focus mode's own containers — a separate page, so ids/names only need to be unique within it.
const F_EVT = { id: 1, name: 'evt', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
const F_BANNER = { id: 2, name: 'banner', x: 8, y: 4, w: 560, h: 28 }
const F_TITLE = { id: 3, name: 'title', x: 8, y: 36, w: 420, h: 32 }
const F_CLOCK = { id: 4, name: 'clock', x: 436, y: 36, w: 132, h: 32 }
const F_LIST = { id: 5, name: 'fsubtasks', x: 0, y: 74, w: SCREEN_W, h: 206 }

/** header line for Task View: priority marker + title, truncated to the header box. */
function headerText(task: Task): string {
  return truncateUtf8(`${priorityPrefix(task.priority)}${cleanTitle(task.title)}`, 240)
}

/**
 * Task detail / Focus screen. Full mode shows description and checkable
 * subtasks. Focus mode is the compact, heads-down view for working through
 * a checklist: title, the same checkable subtasks (in the glasses' one
 * fixed-size font — there is no size control on this platform), and an
 * upcoming-meeting banner. With no tap for 10s it blanks; any tap wakes it
 * without also acting on that tap. See README for the gesture model.
 */
export class FocusScreen implements Screen {
  readonly name = 'focus'
  private taskId: string | null = null
  private subMode: 'full' | 'focus' = 'full'
  private blanked = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private subtaskIds: string[] = []

  constructor(private readonly ctx: ScreenContext) {}

  enter(): void {
    this.taskId = this.ctx.getFocusTaskId()
    this.subMode = 'full'
    this.blanked = false
    this.clearIdleTimer()
    this.render()
    this.ctx.log(`screen=focus task=${this.taskId ?? 'none'}`)
  }

  exit(): void {
    this.clearIdleTimer()
  }

  onState(): void {
    if (this.subMode === 'full') this.render()
    else if (!this.blanked) this.renderFocusPage() // a blank screen ignores data changes until woken
  }

  onTick(): void {
    // The clock and the meeting countdown are time-based, so Focus mode redraws once a minute too.
    if (this.subMode === 'focus' && !this.blanked) this.renderFocusPage()
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
    if (this.blanked) {
      // The first tap after blanking only wakes the screen — it doesn't also act on whatever
      // would otherwise be under it, so a half-asleep tap can't accidentally toggle a subtask.
      this.blanked = false
      this.resetIdleTimer()
      this.renderFocusPage()
      return
    }
    switch (input.t) {
      case 'listSelect':
        this.resetIdleTimer()
        this.selectSubtask(input.index, input.name)
        return
      case 'click':
        this.resetIdleTimer() // only reachable with no visible subtasks — nothing to toggle
        return
      case 'doubleClick':
        // Two taps exit focus mode entirely — back to the persistent full view.
        this.clearIdleTimer()
        this.subMode = 'full'
        this.blanked = false
        this.render()
        this.ctx.log('focus: mode=full')
        return
      case 'menu':
        this.resetIdleTimer()
        this.onMinMenu(input.itemID)
        return
      default:
        return
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.blanked = true
      this.renderFocusPage()
    }, IDLE_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private onFullMenu(itemID: number): void {
    switch (itemID) {
      case FOCUS_FULL_MENU.FOCUS:
        this.subMode = 'focus'
        this.blanked = false
        this.renderFocusPage()
        this.resetIdleTimer()
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
        this.clearIdleTimer()
        this.subMode = 'full'
        this.blanked = false
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

  /** "Hide completed" applies to subtasks too, same as it does to the top-level Tasks list. */
  private visibleSubtasks(task: Task): Subtask[] {
    const showCompleted = this.ctx.settings.get().showCompleted
    return orderedSubtasks(showCompleted ? task.subtasks : task.subtasks.filter(s => !s.completed)).slice(0, MAX_SUBTASK_ROWS)
  }

  /** Full mode: header, notes, and checkable subtasks. */
  private render(): void {
    const task = this.currentTask()
    if (!task) {
      // The task left today's list (completed elsewhere, moved, deleted) — nothing left to show.
      this.ctx.go('tasks')
      return
    }
    void this.ctx.display.showPage(this.buildFullPage(task))
  }

  private buildFullPage(task: Task): PageSpec {
    const menu = buildFocusFullMenu()
    const visible = this.visibleSubtasks(task)
    const header = { ...HDR, content: headerText(task) }

    if (visible.length === 0) {
      this.subtaskIds = []
      // ★ not ✓: the glasses font only documents a specific glyph set, and a checkmark isn't in
      // it — confirmed in the simulator, it silently renders as blank space. ★ is the same glyph
      // the empty Tasks list already uses for "all done", so this stays consistent too.
      const status = task.subtasks.length > 0 ? `★ All ${task.subtasksTotal} subtasks done` : ''
      const notesText = truncateUtf8([stripHtml(task.notes), status].filter(Boolean).join('\n\n') || ' ', NOTES_CHARS_ALONE)
      return { texts: [{ ...EVT, content: ' ', capture: true, padding: 0 }, header, { ...NOTES_ALONE, content: notesText }], menu }
    }

    const notes = { ...NOTES, content: truncateUtf8(stripHtml(task.notes) || ' ', NOTES_CHARS_WITH_SUBTASKS) }
    this.subtaskIds = visible.map(s => s.id)
    return {
      texts: [header, notes],
      lists: [{ ...LIST, items: visible.map(subtaskRowLabel), capture: true }],
      menu,
    }
  }

  /**
   * Focus mode: title + clock on one tight line, the same checkable subtask
   * list as Full mode below it, and a meeting banner on top when the
   * reminder is due. Always a full rebuild — simpler than diffing, and no
   * hotter a path than a subtask toggle already is.
   */
  private renderFocusPage(): void {
    const task = this.currentTask()
    if (!task) {
      this.ctx.go('tasks')
      return
    }
    const menu = buildFocusMinMenu()
    if (this.blanked) {
      void this.ctx.display.showPage({ texts: [{ ...F_EVT, content: ' ', capture: true, padding: 0 }], menu })
      return
    }

    const state = this.ctx.store.getState()
    const appSettings = this.ctx.settings.get()
    const meeting = appSettings.meetingReminderEnabled
      ? nextMeetingSoon(state.events, state.day, state.tz, this.ctx.now(), appSettings.meetingReminderLeadMin)
      : null
    const banner = { ...F_BANNER, content: meeting ? formatMeetingBanner(meeting) : ' ' }
    const title = { ...F_TITLE, content: truncateUtf8(`${priorityPrefix(task.priority)}${cleanTitle(task.title)}`, 60) }
    const clock = { ...F_CLOCK, content: formatClock(this.ctx.now(), appSettings.clock24h) }

    const visible = this.visibleSubtasks(task)
    if (visible.length === 0) {
      this.subtaskIds = []
      void this.ctx.display.showPage({ texts: [{ ...F_EVT, content: ' ', capture: true, padding: 0 }, banner, title, clock], menu })
      return
    }
    this.subtaskIds = visible.map(s => s.id)
    void this.ctx.display.showPage({
      texts: [banner, title, clock],
      lists: [{ ...F_LIST, items: visible.map(subtaskRowLabel), capture: true }],
      menu,
    })
  }
}

// Re-exported for tests that only need the pure row-label logic.
export type { Subtask }
