import type { KeyValueStore } from '../core/types'

/** The two storage calls we need from the Even bridge (absent when running in a plain browser). */
export interface StorageBridge {
  setLocalStorage(key: string, value: string): Promise<boolean>
  getLocalStorage(key: string): Promise<string>
}

/**
 * Bridge storage first (survives WebView kills and app updates), mirrored to
 * window.localStorage so a plain browser or a non-persisting host still works.
 * Both are written on every set, so whichever answers holds the latest value.
 */
export class BridgeStorage implements KeyValueStore {
  private cache = new Map<string, string>()

  constructor(private readonly bridge: StorageBridge | null) {}

  async get(key: string): Promise<string | null> {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached || null
    let value = ''
    try {
      value = (await this.bridge?.getLocalStorage(key)) ?? ''
    } catch {
      value = ''
    }
    if (!value) {
      try {
        value = window.localStorage.getItem(key) ?? ''
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
