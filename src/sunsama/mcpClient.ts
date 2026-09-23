import { AuthRequiredError } from '../core/types'
import { sseToMessages, unwrapResourceResult, unwrapToolResult } from './parse'
import type { JsonRpcMessage } from './parse'

const PROTOCOL_VERSION = '2025-06-18'
const SESSION_HEADER = 'mcp-session-id'

export class McpRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message)
    this.name = 'McpRpcError'
  }
}

export class McpHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'McpHttpError'
  }
}

export interface McpClientDeps {
  url: string
  getToken: () => Promise<string>
  /** Called once after a 401; must return a fresh access token. */
  refreshToken: () => Promise<string>
  fetch?: typeof fetch
  log?: (message: string) => void
}

/**
 * The slice of MCP streamable-HTTP we need: initialize, tools/call and
 * resources/read, with JSON or SSE responses. Small on purpose so it runs in
 * the Even WebView and is testable with a fake fetch.
 */
export class McpClient {
  private nextId = 1
  private sessionId: string | null = null
  private protocolVersion = PROTOCOL_VERSION
  private initializing: Promise<void> | null = null
  private initialized = false
  private readonly deps: McpClientDeps
  private readonly fetchFn: typeof fetch

  constructor(deps: McpClientDeps) {
    this.deps = deps
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return unwrapToolResult(await this.request('tools/call', { name, arguments: args }))
  }

  async readResource(uri: string): Promise<unknown> {
    return unwrapResourceResult(await this.request('resources/read', { uri }))
  }

  private async request(method: string, params: unknown): Promise<any> {
    await this.ensureInitialized()
    try {
      return await this.rpc(method, params)
    } catch (err) {
      // The server forgot our session (restart/expiry): start a new one, once.
      const sessionLost = err instanceof McpHttpError && (err.status === 404 || (err.status === 400 && /session/i.test(err.message)))
      if (!sessionLost) throw err
      this.initialized = false
      this.sessionId = null
      await this.ensureInitialized()
      return this.rpc(method, params)
    }
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializing ??= this.initialize().finally(() => {
      this.initializing = null
    })
    return this.initializing
  }

  private async initialize(): Promise<void> {
    const result = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'even-sunsama', version: '0.1.0' },
    })
    if (typeof result?.protocolVersion === 'string') this.protocolVersion = result.protocolVersion
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
    this.initialized = true
    this.deps.log?.(`mcp initialized, session ${this.sessionId ? 'id captured' : 'not exposed'}`)
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    const message = await this.post({ jsonrpc: '2.0', id, method, params }, true)
    if (!message) throw new Error(`No response to ${method}`)
    if (message.error) throw new McpRpcError(message.error.code, message.error.message)
    return message.result
  }

  private async post(payload: { id?: number; method: string } & Record<string, unknown>, expectReply: boolean): Promise<JsonRpcMessage | null> {
    let res = await this.send(payload, await this.deps.getToken())
    if (res.status === 401) res = await this.send(payload, await this.deps.refreshToken())
    if (res.status === 401) throw new AuthRequiredError('expired')
    if (!res.ok) throw new McpHttpError(res.status, `Sunsama responded ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)

    // Unreadable unless the server exposes the header to browsers; fine if the server is stateless.
    const session = res.headers.get(SESSION_HEADER)
    if (session) this.sessionId = session
    if (!expectReply) return null

    const text = await res.text()
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return sseToMessages(text).find(m => m.id === payload.id) ?? null
    }
    return text ? (JSON.parse(text) as JsonRpcMessage) : null
  }

  private send(payload: unknown, token: string): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (this.initialized || this.sessionId) headers['mcp-protocol-version'] = this.protocolVersion
    if (this.sessionId) headers[SESSION_HEADER] = this.sessionId
    return this.fetchFn(this.deps.url, { method: 'POST', headers, body: JSON.stringify(payload) })
  }
}
