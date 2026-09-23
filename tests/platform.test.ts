import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeStorage } from '../src/platform/bridgeStorage'
import type { StorageBridge } from '../src/platform/bridgeStorage'

/** Minimal window.localStorage shim; Node has no `window` global by default. */
function installFakeWindow(): Storage {
  const data = new Map<string, string>()
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage
  ;(globalThis as any).window = { localStorage: storage }
  return storage
}

describe('BridgeStorage', () => {
  afterEach(() => {
    delete (globalThis as any).window
  })

  it('writes to both localStorage and the bridge', async () => {
    installFakeWindow()
    const bridge: StorageBridge = { setLocalStorage: vi.fn(async () => true), getLocalStorage: vi.fn(async () => '') }
    const store = new BridgeStorage(bridge)
    await store.set('k', 'v')
    expect(window.localStorage.getItem('k')).toBe('v')
    expect(bridge.setLocalStorage).toHaveBeenCalledWith('k', 'v')
  })

  it('prefers localStorage over a differing bridge value', async () => {
    const w = installFakeWindow()
    w.setItem('k', 'fresh')
    const bridge: StorageBridge = { setLocalStorage: vi.fn(async () => true), getLocalStorage: vi.fn(async () => 'stale') }
    const store = new BridgeStorage(bridge)
    expect(await store.get('k')).toBe('fresh')
    expect(bridge.getLocalStorage).not.toHaveBeenCalled() // localStorage answered; no need to ask the bridge at all
  })

  it('falls back to the bridge when localStorage has nothing', async () => {
    installFakeWindow()
    const bridge: StorageBridge = { setLocalStorage: vi.fn(async () => true), getLocalStorage: vi.fn(async () => 'from-bridge') }
    const store = new BridgeStorage(bridge)
    expect(await store.get('k')).toBe('from-bridge')
  })

  it('reflects a write on the very next read within the same session, without awaiting the bridge call', async () => {
    installFakeWindow()
    let resolveBridge!: (ok: boolean) => void
    const bridge: StorageBridge = {
      setLocalStorage: vi.fn(() => new Promise<boolean>(resolve => (resolveBridge = resolve))),
      getLocalStorage: vi.fn(async () => ''),
    }
    const store = new BridgeStorage(bridge)
    void store.set('k', 'v') // fire-and-forget, exactly how SettingsStore.update() calls it
    expect(await store.get('k')).toBe('v') // in-memory cache, doesn't even touch localStorage
    resolveBridge(true)
  })

  it("a write that never finished reaching the bridge is still readable after 'restart' (a fresh instance sharing localStorage)", async () => {
    const w = installFakeWindow()
    w.setItem('k', 'old') // what the bridge would also have, from an earlier session
    const bridge: StorageBridge = {
      // Simulates the app closing before this promise ever resolves — it just never does.
      setLocalStorage: vi.fn(() => new Promise<boolean>(() => {})),
      getLocalStorage: vi.fn(async () => 'old'),
    }
    void new BridgeStorage(bridge).set('k', 'new') // the localStorage write inside set() still completes synchronously

    const nextSession = new BridgeStorage(bridge) // a fresh instance, as a new app launch would create
    expect(await nextSession.get('k')).toBe('new')
  })

  it('remove() clears the cache and both backends read back empty', async () => {
    installFakeWindow()
    const bridge: StorageBridge = { setLocalStorage: vi.fn(async () => true), getLocalStorage: vi.fn(async () => '') }
    const store = new BridgeStorage(bridge)
    await store.set('k', 'v')
    await store.remove('k')
    expect(await store.get('k')).toBeNull()
  })
})
