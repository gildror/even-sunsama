import { acceptedMeetingsToday, filterByChannel, objectivesDone, openCount } from '../../core/selectors'
import { formatClock, formatDateShort } from '../../core/time'
import type { Settings, StoreState } from '../../core/types'
import type { GlassesInput } from '../events'
import { objectiveRowLabel, statusMarker, truncateUtf8 } from '../format'
import { MENU, buildMenu } from '../menu'
import { SCREEN_W } from '../page'
import type { PageSpec } from '../page'
import type { Screen, ScreenContext } from './types'

/** Objective lines that fit under the meetings line without crowding it. */
const MAX_OBJECTIVE_LINES = 4

export interface FaceView {
  openLine: string
  dateTime: string
  objectivesLine: string
  meetingsLine: string
}

/**
 * Pure view-model for the glance face: a small open-count/clock strip up
 * top (the SDK has no font-size control, so "small" just means plain text
 * rather than the big rendered digits this screen used to draw), and the
 * week's objectives plus today's accepted-meeting count filling the rest.
 */
export function buildFaceView(state: StoreState, settings: Settings, now: Date): FaceView {
  const tasks = filterByChannel(state.tasks, settings.channelFilter)
  const marker = statusMarker(state, now.getTime())
  const openLine = [`${openCount(tasks)} open`, marker].filter(Boolean).join('  ')
  const dateTime = `${formatDateShort(now)} · ${formatClock(now, settings.clock24h)}`

  const objectives = state.objectives
  const objectivesLine = objectives.length
    ? [
        `This week (${objectivesDone(objectives)}/${objectives.length}):`,
        ...objectives.slice(0, MAX_OBJECTIVE_LINES).map(o => objectiveRowLabel(o)),
      ].join('\n')
    : 'No weekly objectives set'

  const meetings = acceptedMeetingsToday(state.events)
  const meetingsLine = meetings === 0 ? 'No meetings today' : `${meetings} meeting${meetings === 1 ? '' : 's'} today`

  return { openLine, dateTime, objectivesLine, meetingsLine }
}

// Declaration order is z-order: the invisible event layer goes first.
const EVT = { id: 1, name: 'evt', x: 0, y: 0, w: SCREEN_W, h: 288 }
const OPEN = { id: 2, name: 'open', x: 8, y: 6, w: 200, h: 28 }
const DATETIME = { id: 3, name: 'datetime', x: 260, y: 6, w: 308, h: 28 }
const OBJECTIVES = { id: 4, name: 'objectives', x: 8, y: 48, w: 560, h: 168 }
const MEETINGS = { id: 5, name: 'meetings', x: 8, y: 232, w: 560, h: 32 }

export class FaceScreen implements Screen {
  readonly name = 'face'
  private view: FaceView | null = null
  private active = false

  constructor(private readonly ctx: ScreenContext) {}

  enter(): void {
    this.active = true
    this.draw()
    this.ctx.log(`screen=face open=${openCount(filterByChannel(this.ctx.store.getState().tasks, this.ctx.settings.get().channelFilter))}`)
  }

  exit(): void {
    this.active = false
  }

  onState(): void {
    this.update()
  }

  onTick(): void {
    this.update()
  }

  onInput(input: GlassesInput): void {
    switch (input.t) {
      case 'click':
      case 'scrollUp':
      case 'scrollDown':
        this.ctx.go('tasks')
        return
      case 'doubleClick':
        // Root screen: leave through the system exit dialog.
        this.ctx.exitApp()
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
        this.ctx.go('tasks')
        return
      case MENU.REFRESH:
        void this.ctx.sync.refreshNow()
        return
      case MENU.TOGGLE_COMPLETED:
        this.ctx.settings.update({ showCompleted: !this.ctx.settings.get().showCompleted })
        return
      default:
        return
    }
  }

  private draw(): void {
    const settings = this.ctx.settings.get()
    const view = buildFaceView(this.ctx.store.getState(), settings, this.ctx.now())
    const text = (box: typeof OPEN, content: string) => ({ ...box, content: content || ' ' })
    const page: PageSpec = {
      texts: [
        { ...EVT, content: ' ', capture: true, padding: 0 },
        text(OPEN, truncateUtf8(view.openLine, 60)),
        text(DATETIME, truncateUtf8(view.dateTime, 90)),
        text(OBJECTIVES, view.objectivesLine),
        text(MEETINGS, view.meetingsLine),
      ],
      menu: buildMenu('face', settings),
    }
    void this.ctx.display.showPage(page)
    this.view = view
  }

  /** Cheap text-only redraws: only what changed goes over the wire. */
  private update(): void {
    const prev = this.view
    if (!this.active || !prev) return
    const view = buildFaceView(this.ctx.store.getState(), this.ctx.settings.get(), this.ctx.now())
    const { display } = this.ctx
    if (view.openLine !== prev.openLine) void display.upgradeText(OPEN.id, OPEN.name, truncateUtf8(view.openLine, 60) || ' ')
    if (view.dateTime !== prev.dateTime) void display.upgradeText(DATETIME.id, DATETIME.name, truncateUtf8(view.dateTime, 90) || ' ')
    if (view.objectivesLine !== prev.objectivesLine) void display.upgradeText(OBJECTIVES.id, OBJECTIVES.name, view.objectivesLine || ' ')
    if (view.meetingsLine !== prev.meetingsLine) void display.upgradeText(MEETINGS.id, MEETINGS.name, view.meetingsLine || ' ')
    this.view = view
  }
}
