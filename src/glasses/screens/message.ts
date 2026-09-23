import { CONNECT_URL_SHORT } from '../../core/config'
import type { StoreState } from '../../core/types'
import type { GlassesInput } from '../events'
import { buildMenu } from '../menu'
import { SCREEN_H, SCREEN_W } from '../page'
import type { Screen, ScreenContext } from './types'

/** States where neither the face nor the list has anything to show. */
export function messageFor(state: StoreState): string | null {
  if (state.auth === 'signedOut') {
    return `Sunsama: not connected.\nOn your phone, open ${CONNECT_URL_SHORT}\nsign in, then paste the code into this plugin's page in the Even app (Home tab).`
  }
  if (state.auth === 'expired') {
    return `Sunsama sign-in expired.\nOn your phone, open ${CONNECT_URL_SHORT}\nsign in again, then paste the new code into this plugin's page in the Even app.`
  }
  if (state.lastSyncAt === undefined) {
    if (state.status === 'error') return "Can't reach Sunsama.\nTap to retry."
    return 'Loading…'
  }
  return null
}

const BOX = { id: 1, name: 'msg', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }

export class MessageScreen implements Screen {
  readonly name = 'message'
  private shown: string | null = null

  constructor(private readonly ctx: ScreenContext) {}

  enter(): void {
    this.shown = messageFor(this.ctx.store.getState()) ?? ''
    void this.ctx.display.showPage({
      texts: [{ ...BOX, content: this.shown || ' ', capture: true, padding: 16 }],
      menu: buildMenu('message', this.ctx.settings.get()),
    })
    this.ctx.log('screen=message')
  }

  exit(): void {}

  onState(): void {
    const message = messageFor(this.ctx.store.getState()) ?? ''
    if (message === this.shown) return
    this.shown = message
    void this.ctx.display.upgradeText(BOX.id, BOX.name, message || ' ')
  }

  onTick(): void {}

  onInput(input: GlassesInput): void {
    if (input.t === 'click') void this.ctx.sync.refreshNow()
    // Root screen: leave through the system exit dialog.
    if (input.t === 'doubleClick') this.ctx.exitApp()
  }
}
