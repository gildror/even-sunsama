import { getGlanceSummary } from '../../core/summary'
import { formatClock, formatDateShort } from '../../core/time'
import type { Settings, StoreState } from '../../core/types'
import type { GlassesInput } from '../events'
import { GLYPHS, cleanTitle, statusMarker, truncateUtf8 } from '../format'
import { MENU, buildMenu } from '../menu'
import { SCREEN_H, SCREEN_W } from '../page'
import type { PageSpec } from '../page'
import type { Screen, ScreenContext } from './types'

export interface FaceView {
  count: string
  caption: string
  clock: string
  date: string
  next: string
  status: string
}

/** Pure view-model for the glance face: open count on the left, clock on the right. */
export function buildFaceView(state: StoreState, settings: Settings, now: Date): FaceView {
  const summary = getGlanceSummary(state, now.getTime())
  const allDone = summary.openCount === 0 && summary.doneCount > 0
  return {
    count: String(summary.openCount),
    caption: allDone ? `all done · ${summary.doneCount}` : `open · ${summary.doneCount} done`,
    clock: formatClock(now, settings.clock24h),
    date: formatDateShort(now),
    next: summary.nextTitle ? `${GLYPHS.next} ${truncateUtf8(cleanTitle(summary.nextTitle), 44)}` : '',
    status: statusMarker(state, now.getTime()),
  }
}

// Declaration order is z-order: the invisible event layer goes first.
const EVT = { id: 1, name: 'evt', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
const COUNT = { id: 2, name: 'count', x: 8, y: 48, w: 200, h: 144 }
const CAPTION = { id: 3, name: 'countCap', x: 8, y: 196, w: 260, h: 40 }
const CLOCK = { id: 4, name: 'clock', x: 280, y: 48, w: 288, h: 144 }
const DATE = { id: 5, name: 'dateTxt', x: 280, y: 4, w: 288, h: 40 }
const NEXT = { id: 6, name: 'nextTxt', x: 8, y: 244, w: 560, h: 40 }
const STATUS = { id: 7, name: 'statTxt', x: 8, y: 4, w: 260, h: 40 }

const MAX_IMAGE_FAILURES = 3

export class FaceScreen implements Screen {
  readonly name = 'face'
  private view: FaceView | null = null
  /** Bumped on every full draw so late image renders for an old page are ignored. */
  private epoch = 0
  private active = false
  private imageFailures = 0
  private forceText = false

  constructor(private readonly ctx: ScreenContext) {}

  enter(): void {
    this.active = true
    this.draw()
    this.ctx.log(`screen=face open=${this.view?.count}`)
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

  private get imageMode(): boolean {
    return !this.forceText && this.ctx.settings.get().faceClockMode === 'image'
  }

  private draw(): void {
    const settings = this.ctx.settings.get()
    const view = buildFaceView(this.ctx.store.getState(), settings, this.ctx.now())
    const epoch = ++this.epoch
    const text = (box: typeof CAPTION, content: string) => ({ ...box, content: content || ' ' })
    const page: PageSpec = {
      texts: [
        { ...EVT, content: ' ', capture: true, padding: 0 },
        text(CAPTION, view.caption),
        text(DATE, view.date),
        text(NEXT, view.next),
        text(STATUS, view.status),
      ],
      menu: buildMenu('face', settings),
    }
    if (this.imageMode) {
      page.images = [COUNT, CLOCK]
    } else {
      page.texts?.push(text(COUNT, `${view.count} open`), text(CLOCK, view.clock))
    }
    void this.ctx.display.showPage(page)
    this.view = view
    if (this.imageMode) {
      void this.pushImage(COUNT, view.count, epoch)
      void this.pushImage(CLOCK, view.clock, epoch)
    }
  }

  /** Only what changed is sent: text upgrades are cheap, images cost up to ~2 s over BLE. */
  private update(): void {
    const prev = this.view
    if (!this.active || !prev) return
    const view = buildFaceView(this.ctx.store.getState(), this.ctx.settings.get(), this.ctx.now())
    const { display } = this.ctx
    if (view.caption !== prev.caption) void display.upgradeText(CAPTION.id, CAPTION.name, view.caption || ' ')
    if (view.date !== prev.date) void display.upgradeText(DATE.id, DATE.name, view.date || ' ')
    if (view.next !== prev.next) void display.upgradeText(NEXT.id, NEXT.name, view.next || ' ')
    if (view.status !== prev.status) void display.upgradeText(STATUS.id, STATUS.name, view.status || ' ')
    if (view.count !== prev.count) {
      if (this.imageMode) void this.pushImage(COUNT, view.count, this.epoch)
      else void display.upgradeText(COUNT.id, COUNT.name, `${view.count} open`)
    }
    if (view.clock !== prev.clock) {
      if (this.imageMode) void this.pushImage(CLOCK, view.clock, this.epoch)
      else void display.upgradeText(CLOCK.id, CLOCK.name, view.clock)
    }
    this.view = view
  }

  private async pushImage(box: typeof COUNT, text: string, epoch: number): Promise<void> {
    let ok = false
    try {
      const png = await this.ctx.renderBigText(text, box.w, box.h, 'center')
      if (!this.active || epoch !== this.epoch) return
      ok = await this.ctx.display.setImage(box.id, box.name, png)
    } catch (err) {
      this.ctx.log(`face image error: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!this.active || epoch !== this.epoch) return
    if (ok) {
      this.imageFailures = 0
      return
    }
    // Images keep failing (link too slow, host refuses them): fall back to plain text for this session.
    if (++this.imageFailures >= MAX_IMAGE_FAILURES) {
      this.ctx.log('face: switching to text mode after repeated image failures')
      this.forceText = true
      this.draw()
    }
  }
}
