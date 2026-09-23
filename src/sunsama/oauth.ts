import { AuthRequiredError } from '../core/types'
import type { KeyValueStore } from '../core/types'

export const SUNSAMA_ORIGIN = 'https://api.sunsama.com'
const TOKEN_URL = `${SUNSAMA_ORIGIN}/oauth/token`
const REVOKE_URL = `${SUNSAMA_ORIGIN}/oauth/revoke`
const AUTH_KEY = 'sunsama.auth.v1'
const BUNDLE_PREFIX = 'es1.'
const EXPIRY_MARGIN_MS = 60_000

interface StoredAuth {
  clientId: string
  refreshToken: string
  accessToken?: string
  expiresAt?: number
}

export interface TokenManagerDeps {
  kv: KeyValueStore
  fetch?: typeof fetch
  now?: () => number
  log?: (message: string) => void
}

/** Decodes the `es1.<base64url json>` string printed by `pnpm auth`. */
export function decodeBundle(bundle: string): { clientId: string; refreshToken: string } {
  const text = bundle.trim()
  if (!text.startsWith(BUNDLE_PREFIX)) throw new Error('Not a sign-in bundle (it should start with "es1.")')
  try {
    const b64 = text.slice(BUNDLE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')))
    if (typeof json.clientId !== 'string' || typeof json.refreshToken !== 'string') throw new Error('missing fields')
    return { clientId: json.clientId, refreshToken: json.refreshToken }
  } catch {
    throw new Error('Sign-in bundle is damaged; run `pnpm auth` again')
  }
}

/**
 * Holds the Sunsama OAuth grant for this surface. Refresh tokens may rotate,
 * so refreshes are single-flight and the new token is persisted before use.
 */
export class TokenManager {
  private auth: StoredAuth | null = null
  private refreshing: Promise<string> | null = null
  private readonly kv: KeyValueStore
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(deps: TokenManagerDeps) {
    this.kv = deps.kv
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? (() => {})
  }

  async load(): Promise<boolean> {
    try {
      const raw = await this.kv.get(AUTH_KEY)
      this.auth = raw ? (JSON.parse(raw) as StoredAuth) : null
    } catch {
      this.auth = null
    }
    return this.hasAuth()
  }

  hasAuth(): boolean {
    return Boolean(this.auth?.refreshToken)
  }

  /** Validates the bundle by refreshing right away; nothing is stored if that fails. */
  async importBundle(bundle: string): Promise<void> {
    const previous = this.auth
    this.auth = { ...decodeBundle(bundle) }
    try {
      await this.forceRefresh()
    } catch (err) {
      this.auth = previous
      throw err
    }
  }

  async getAccessToken(): Promise<string> {
    if (!this.auth) throw new AuthRequiredError('signedOut')
    const { accessToken, expiresAt } = this.auth
    if (accessToken && expiresAt && this.now() < expiresAt - EXPIRY_MARGIN_MS) return accessToken
    return this.forceRefresh()
  }

  forceRefresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<string> {
    const auth = this.auth
    if (!auth) throw new AuthRequiredError('signedOut')
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
        client_id: auth.clientId,
      }).toString(),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
        await this.clear()
        throw new AuthRequiredError('expired')
      }
      throw new Error(`Token refresh failed (${res.status})`)
    }
    if (typeof body.access_token !== 'string') throw new Error('Token refresh returned no access token')
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
    const next: StoredAuth = {
      clientId: auth.clientId,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : auth.refreshToken,
      accessToken: body.access_token,
      expiresAt: this.now() + expiresIn * 1000,
    }
    // Persist before anyone uses the new access token: a rotated refresh token must not be lost.
    await this.kv.set(AUTH_KEY, JSON.stringify(next))
    this.auth = next
    this.log(`token refreshed, valid ${expiresIn}s${next.refreshToken !== auth.refreshToken ? ', refresh token rotated' : ''}`)
    return next.accessToken as string
  }

  /** Best-effort revoke, then forget the grant. */
  async signOut(): Promise<void> {
    const auth = this.auth
    await this.clear()
    if (!auth) return
    try {
      await this.fetchFn(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: auth.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: auth.clientId,
        }).toString(),
      })
    } catch {
      // Offline: the local grant is gone either way.
    }
  }

  private async clear(): Promise<void> {
    this.auth = null
    await this.kv.remove(AUTH_KEY)
  }
}
