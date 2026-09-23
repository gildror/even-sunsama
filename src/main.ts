import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Logger } from './core/logger'
import { SettingsStore } from './core/settings'
import { SyncController } from './core/sync'
import { TaskStore } from './core/taskStore'
import type { TaskProvider } from './core/types'
import { GlassesApp } from './glasses/app'
import { renderBigText } from './glasses/bigText'
import { BridgeDisplay } from './glasses/display'
import { mountPhoneUi } from './phone/ui'
import './phone/styles.css'
import { BridgeStorage } from './platform/bridgeStorage'
import { McpClient } from './sunsama/mcpClient'
import { MockProvider, mockOptionsFromUrl } from './sunsama/mockProvider'
import { SUNSAMA_ORIGIN, TokenManager } from './sunsama/oauth'
import { SunsamaProvider } from './sunsama/sunsamaProvider'

const NO_HOST_TIMEOUT_MS = 6_000

/** Null when opened in a plain browser: the phone page still works, there are just no glasses. */
async function getBridge(): Promise<EvenAppBridge | null> {
  const timeout = new Promise<null>(resolve =>
    setTimeout(() => {
      // Inside the Even app (or simulator) the host object exists; keep waiting for it there.
      if (!('flutter_inappwebview' in window)) resolve(null)
    }, NO_HOST_TIMEOUT_MS),
  )
  return Promise.race([waitForEvenAppBridge(), timeout])
}

const logger = new Logger()
const bridge = await getBridge()

// Fires exactly once, right after load: subscribe before anything slow.
let launchSource = 'unknown'
bridge?.onLaunchSource(source => {
  launchSource = source
  logger.log('app', `launch source=${source}`)
})

const kv = new BridgeStorage(bridge)
const settings = new SettingsStore(kv)
const providerName = import.meta.env.VITE_PROVIDER === 'mock' ? 'mock' : 'sunsama'

let tokens: TokenManager | null = null
let provider: TaskProvider
if (providerName === 'mock') {
  provider = new MockProvider(mockOptionsFromUrl(window.location.search))
} else {
  const manager = new TokenManager({ kv, log: m => logger.log('auth', m) })
  tokens = manager
  provider = new SunsamaProvider(
    new McpClient({
      url: `${SUNSAMA_ORIGIN}/mcp`,
      getToken: () => manager.getAccessToken(),
      refreshToken: () => manager.forceRefresh(),
      log: m => logger.log('mcp', m),
    }),
  )
}

const store = new TaskStore({ provider, kv, log: m => logger.log('store', m) })
const sync = new SyncController({ store, pollMs: () => settings.get().pollSeconds * 1000 })

// Everything needed for the first frame comes from storage, so the glasses never show a spinner.
await Promise.all([settings.load(), store.hydrate(), tokens?.load()])

// Dev server only: seed the sign-in from .env.development.local when storage has none.
if (tokens && !tokens.hasAuth() && import.meta.env.DEV && import.meta.env.VITE_SUNSAMA_SEED_BUNDLE) {
  try {
    await tokens.importBundle(import.meta.env.VITE_SUNSAMA_SEED_BUNDLE)
    logger.log('auth', 'signed in from dev seed bundle')
  } catch (err) {
    logger.log('auth', `dev seed bundle rejected: ${err instanceof Error ? err.message : String(err)}`)
  }
}
if (tokens) store.setAuth(tokens.hasAuth() ? 'signedIn' : 'signedOut')

if (bridge) {
  const app = new GlassesApp({
    display: new BridgeDisplay(bridge, m => logger.log('display', m)),
    store,
    settings,
    sync,
    now: () => new Date(),
    log: m => logger.log('app', m),
    renderBigText,
  })
  app.start()
  bridge.onEvenHubEvent(event => app.handleEvent(event))
} else {
  logger.log('app', 'no Even bridge found: phone page only')
}

const ui = mountPhoneUi({
  root: document.getElementById('app') as HTMLElement,
  store,
  settings,
  sync,
  logger,
  providerName,
  hasBridge: Boolean(bridge),
  auth: tokens && {
    connect: async bundle => {
      await tokens.importBundle(bundle)
      store.setAuth('signedIn')
      sync.start()
    },
    disconnect: async () => {
      sync.pause()
      await tokens.signOut()
      store.setAuth('signedOut')
    },
  },
})

if (tokens && !tokens.hasAuth() && launchSource !== 'glassesMenu') ui.focusConnect()
sync.start()
