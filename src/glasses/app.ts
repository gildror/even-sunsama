import { msToNextMinute } from '../core/time'
import type { ScreenName } from '../core/types'
import { normalizeEvent } from './events'
import type { GlassesInput, RawHubEvent } from './events'
import { MENU } from './menu'
import { FaceScreen } from './screens/face'
import { MessageScreen, messageFor } from './screens/message'
import { TasksScreen } from './screens/tasks'
import type { Screen, ScreenContext } from './screens/types'

export type GlassesAppDeps = Omit<ScreenContext, 'go' | 'exitApp'>

/**
 * Screen state machine for the glasses. Face is the root, Tasks its child; a
 * message screen takes over while there is nothing to show (signed out, first load).
 */
export class GlassesApp {
  private readonly ctx: ScreenContext
  private readonly screens: Record<ScreenName | 'message', Screen>
  private current: Screen | null = null
  private wanted: ScreenName
  private foreground = true
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: Array<() => void> = []

  constructor(deps: GlassesAppDeps) {
    this.ctx = {
      ...deps,
      go: screen => {
        this.wanted = screen
        this.reconcile()
      },
      exitApp: () => {
        deps.log('exit dialog requested')
        void deps.display.shutDown(1)
      },
    }
    this.screens = {
      face: new FaceScreen(this.ctx),
      tasks: new TasksScreen(this.ctx),
      message: new MessageScreen(this.ctx),
    }
    this.wanted = deps.settings.get().startScreen
  }

  start(): void {
    this.unsubscribe.push(
      this.ctx.store.subscribe(() => this.reconcile()),
      // Settings change menu labels and layouts: redraw the whole page.
      this.ctx.settings.subscribe(() => this.current?.enter()),
    )
    this.reconcile()
    this.scheduleTick()
    this.ctx.log(`ready screen=${this.current?.name}`)
  }

  handleEvent(raw: RawHubEvent): void {
    const input = normalizeEvent(raw)
    if (input) this.handleInput(input)
  }

  handleInput(input: GlassesInput): void {
    switch (input.t) {
      case 'menu':
        this.handleMenu(input.itemID)
        return
      // Opening the contextual menu also fires exit/enter, so both must be idempotent.
      case 'fgExit':
        this.foreground = false
        this.clearTick()
        this.ctx.sync.pause()
        return
      case 'fgEnter':
        if (this.foreground) return
        this.foreground = true
        this.ctx.sync.resume()
        this.current?.onTick()
        this.scheduleTick()
        return
      case 'exit':
        this.stop()
        return
      default:
        this.current?.onInput(input)
    }
  }

  stop(): void {
    this.clearTick()
    this.ctx.sync.pause()
    this.unsubscribe.forEach(fn => fn())
    this.unsubscribe = []
    this.current?.exit()
  }

  private handleMenu(itemID: number): void {
    const settings = this.ctx.settings
    switch (itemID) {
      case MENU.SWITCH:
        this.ctx.go(this.wanted === 'tasks' ? 'face' : 'tasks')
        return
      case MENU.REFRESH:
        this.ctx.log('menu refresh')
        void this.ctx.sync.refreshNow()
        return
      case MENU.TOGGLE_COMPLETED:
        settings.update({ showCompleted: !settings.get().showCompleted })
        return
      default:
        return
    }
  }

  /** Shows the screen the current state calls for, or lets the current one update itself. */
  private reconcile(): void {
    const name = messageFor(this.ctx.store.getState()) ? 'message' : this.wanted
    if (this.current?.name === name) {
      this.current.onState()
      return
    }
    this.current?.exit()
    this.current = this.screens[name]
    this.current.enter()
  }

  private scheduleTick(): void {
    this.clearTick()
    this.tickTimer = setTimeout(() => {
      this.ctx.sync.tick()
      this.current?.onTick()
      this.scheduleTick()
    }, msToNextMinute(this.ctx.now()) + 50)
  }

  private clearTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer)
    this.tickTimer = null
  }
}
