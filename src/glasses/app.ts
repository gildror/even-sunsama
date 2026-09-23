import { msToNextMinute } from '../core/time'
import { normalizeEvent } from './events'
import type { GlassesInput, RawHubEvent } from './events'
import { FaceScreen } from './screens/face'
import { FocusScreen } from './screens/focus'
import { MessageScreen, messageFor } from './screens/message'
import { TasksScreen } from './screens/tasks'
import type { Route, Screen, ScreenContext } from './screens/types'

export type GlassesAppDeps = Omit<ScreenContext, 'go' | 'exitApp' | 'openFocus' | 'getFocusTaskId'>

/**
 * Screen state machine for the glasses. Face is the root, Tasks its child,
 * Task View (Focus) a child of Tasks; a message screen takes over while
 * there is nothing to show (signed out, first load). Each screen owns its
 * own contextual-menu handling via onInput({t:'menu',...}) — there is no
 * central menu dispatch, since different screens have different menus.
 */
export class GlassesApp {
  private readonly ctx: ScreenContext
  private readonly screens: Record<Route | 'message', Screen>
  private current: Screen | null = null
  private wanted: Route
  private focusTaskId: string | null = null
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
      openFocus: taskId => {
        this.focusTaskId = taskId
        this.wanted = 'focus'
        this.reconcile()
      },
      getFocusTaskId: () => this.focusTaskId,
      exitApp: () => {
        deps.log('exit dialog requested')
        void deps.display.shutDown(1)
      },
    }
    this.screens = {
      face: new FaceScreen(this.ctx),
      tasks: new TasksScreen(this.ctx),
      focus: new FocusScreen(this.ctx),
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
