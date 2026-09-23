import type { SettingsStore } from '../../core/settings'
import type { SyncController } from '../../core/sync'
import type { TaskStore } from '../../core/taskStore'
import type { ScreenName } from '../../core/types'
import type { GlassesInput } from '../events'
import type { Display } from '../page'

/** Every screen GlassesApp can navigate to. Settings.startScreen stays restricted to `ScreenName` — Focus is never a boot target. */
export type Route = ScreenName | 'focus'

export interface ScreenContext {
  display: Display
  store: TaskStore
  settings: SettingsStore
  sync: SyncController
  now: () => Date
  log: (message: string) => void
  go(screen: Route): void
  /** Opens Task View for one task, in full mode. */
  openFocus(taskId: string): void
  /** The task Task View is (or was last) showing; null before it's ever been opened. */
  getFocusTaskId(): string | null
  /** Opens the system exit dialog. */
  exitApp(): void
  /** PNG bytes for large text; injected so screens stay testable without a canvas. */
  renderBigText(text: string, width: number, height: number, align?: 'left' | 'center'): Promise<Uint8Array>
}

export interface Screen {
  readonly name: Route | 'message'
  /** Draw the full page. */
  enter(): void
  exit(): void
  onInput(input: GlassesInput): void
  /** Store or settings changed. */
  onState(): void
  /** Once per minute while in the foreground. */
  onTick(): void
}
