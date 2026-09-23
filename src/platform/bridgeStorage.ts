import type { KeyValueStore } from '../core/types'

/** The two storage calls we need from the Even bridge (absent when running in a plain browser). */
export interface StorageBridge {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

/**
 * window.localStorage first, bridge storage as a fallback/second copy. Both are
 * written on every set, but callers routinely fire `set()` without awaiting it
 * (e.g. a settings toggle right before the user exits the app) — the bridge
 * write is an async round trip that a fast app close can cut off before it
 * lands, while the localStorage write is synchronous and has always completed
 * by the time `set()` is even called, let alone awaited. Reading localStorage
 * first means a truncated bridge write can never shadow the value that did
 * make it to disk; the bridge copy only matters when localStorage itself is
 * empty or unavailable (blocked/private-mode storage).
 */
export class BridgeStorage implements KeyValueStore {
  private cache = new Map<string, string>()

  constructor(private readonly bridge: StorageBridge | null) {}

  async get(key: string): Promise<string | null> {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached || null
    let value = ''
    try {
      value = window.localStorage.getItem(key) ?? ''
    } catch {
      value = ''
    }
    if (!value) {
      try {
        value = (await this.bridge?.getLocalStorage(key)) ?? ''
      } catch {
        value = ''
      }
    }
    this.cache.set(key, value)
    return value || null
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value)
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Private mode / blocked storage: the bridge copy is enough.
    }
    try {
      await this.bridge?.setLocalStorage(key, value)
    } catch {
      // Plain browser or bridge hiccup: the localStorage copy is enough.
    }
  }

  /** The bridge has no delete; an empty string reads back as "missing". */
  remove(key: string): Promise<void> {
    return this.set(key, '')
  }
}
