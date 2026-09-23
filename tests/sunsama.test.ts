import { describe, expect, it, vi } from 'vitest'
import { AuthRequiredError } from '../src/core/types'
import type { KeyValueStore } from '../src/core/types'
import { McpClient } from '../src/sunsama/mcpClient'
import { TokenManager, decodeBundle } from '../src/sunsama/oauth'
import { McpToolError, parseCalendarEvents, parseMe, parseTasksResource, sseToMessages, unwrapResourceResult, unwrapToolResult } from '../src/sunsama/parse'
import { SunsamaProvider } from '../src/sunsama/sunsamaProvider'
import meFixture from '../src/sunsama/__fixtures__/me.json'
import tasksFixture from '../src/sunsama/__fixtures__/tasks.json'
import calendarFixture from '../src/sunsama/__fixtures__/calendar-events.json'

class MemoryKv implements KeyValueStore {
  data = new Map<string, string>()
  async get(key: string) {
    return this.data.get(key) || null
  }
  async set(key: string, value: string) {
    this.data.set(key, value)
  }
  async remove(key: string) {
    this.data.delete(key)
  }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
const bundleOf = (value: object) => `es1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`

describe('parse', () => {
  it('keeps only live tasks scheduled for the day and counts subtasks', () => {
    const tasks = parseTasksResource(tasksFixture, '2026-09-20')
    expect(tasks.map(t => t.id)).toEqual(['t-open', 't-subtasks', 't-done'])
    expect(tasks[1]).toMatchObject({ subtasksDone: 1, subtasksTotal: 3, completed: false })
    expect(tasks[1].subtasks).toEqual([
      { id: 's1', title: 'Inbox zero', completed: true },
      { id: 's2', title: 'Review calendar', completed: false },
      { id: 's3', title: 'Review goals', completed: false },
    ])
    expect(tasks[2].completed).toBe(true)
    expect(() => parseTasksResource({ nope: true }, '2026-09-20')).toThrow()
  })

  it('carries priority, notes and time estimate through, defaulting when absent', () => {
    const tasks = parseTasksResource(tasksFixture, '2026-09-20')
    expect(tasks[0]).toMatchObject({ priority: 'urgent', timeEstimate: '1 hours' })
    expect(tasks[0].notes).toContain('Focus')
    expect(tasks[1]).toMatchObject({ priority: null, notes: '', timeEstimate: undefined })
  })

  it('parses calendar events, keeping raw start times and meeting/all-day flags', () => {
    const events = parseCalendarEvents(calendarFixture)
    expect(events).toEqual([
      { id: 'ev-allday', title: 'Out of office', startTime: '12:00 AM', durationMin: 0, isMeeting: false, isAllDay: true },
      { id: 'ev-meeting', title: 'Standup', startTime: '9:00 AM', durationMin: 15, isMeeting: true, isAllDay: false },
      { id: 'ev-focus', title: 'Focus block', startTime: '10:00 AM', durationMin: 60, isMeeting: false, isAllDay: false },
    ])
    expect(() => parseCalendarEvents({ nope: true })).toThrow()
  })

  it('reads the timezone from the profile', () => {
    expect(parseMe(meFixture)).toEqual({ timezone: 'America/New_York' })
    expect(() => parseMe({ user: {} })).toThrow()
  })

  it('unwraps tool and resource results, including nested envelopes and tool errors', () => {
    expect(unwrapResourceResult({ contents: [{ uri: 'x', text: '{"a":1}' }] })).toEqual({ a: 1 })
    expect(unwrapToolResult({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 })
    const nested = JSON.stringify({ contents: [{ text: '{"tasks":[]}' }] })
    expect(unwrapToolResult({ content: [{ type: 'text', text: nested }] })).toEqual({ tasks: [] })
    expect(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'Task not found' }] })).toThrow(McpToolError)
  })

  it('parses SSE bodies and skips non-JSON frames', () => {
    const body = ': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\ndata: not json\n\n'
    expect(sseToMessages(body)).toEqual([{ jsonrpc: '2.0', id: 2, result: { ok: true } }])
  })
})

describe('TokenManager', () => {
  it('rejects damaged bundles', () => {
    expect(() => decodeBundle('hello')).toThrow(/es1/)
    expect(() => decodeBundle('es1.%%%')).toThrow(/damaged/)
    expect(decodeBundle(bundleOf({ v: 1, clientId: 'c', refreshToken: 'r' }))).toEqual({ clientId: 'c', refreshToken: 'r' })
  })

  it('persists a rotated refresh token and shares one refresh between callers', async () => {
    const kv = new MemoryKv()
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => json({ access_token: 'a1', refresh_token: 'r2', expires_in: 3600 }))
    const tokens = new TokenManager({ kv, fetch: fetchFn as unknown as typeof fetch, now: () => 0 })
    await tokens.importBundle(bundleOf({ clientId: 'c', refreshToken: 'r1' }))
    expect(JSON.parse(kv.data.get('sunsama.auth.v1') as string)).toMatchObject({ clientId: 'c', refreshToken: 'r2', accessToken: 'a1' })

    const [x, y] = await Promise.all([tokens.forceRefresh(), tokens.forceRefresh()])
    expect([x, y]).toEqual(['a1', 'a1'])
    expect(fetchFn).toHaveBeenCalledTimes(2) // import + one shared refresh
    expect(String(fetchFn.mock.calls[1][1]?.body)).toContain('refresh_token=r2')
  })

  it('reuses a valid access token and refreshes shortly before expiry', async () => {
    let now = 0
    const fetchFn = vi.fn(async () => json({ access_token: `a${fetchFn.mock.calls.length}`, expires_in: 600 }))
    const tokens = new TokenManager({ kv: new MemoryKv(), fetch: fetchFn as unknown as typeof fetch, now: () => now })
    await tokens.importBundle(bundleOf({ clientId: 'c', refreshToken: 'r' }))
    expect(await tokens.getAccessToken()).toBe('a1')
    now = 545_000 // inside the 60 s margin
    expect(await tokens.getAccessToken()).toBe('a2')
  })

  it('forgets the grant on invalid_grant and keeps it on a plain outage', async () => {
    const kv = new MemoryKv()
    const fetchFn = vi.fn(async () => json({ access_token: 'a', expires_in: 1 }))
    const tokens = new TokenManager({ kv, fetch: fetchFn as unknown as typeof fetch, now: () => 0 })
    await tokens.importBundle(bundleOf({ clientId: 'c', refreshToken: 'r' }))

    fetchFn.mockResolvedValueOnce(json({ error: 'server_error' }, { status: 503 }))
    await expect(tokens.forceRefresh()).rejects.toThrow(/503/)
    expect(tokens.hasAuth()).toBe(true)

    fetchFn.mockResolvedValueOnce(json({ error: 'invalid_grant' }, { status: 400 }))
    await expect(tokens.forceRefresh()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(tokens.hasAuth()).toBe(false)
    await expect(tokens.getAccessToken()).rejects.toMatchObject({ reason: 'signedOut' })
  })

  it('does not store a bundle that fails validation', async () => {
    const kv = new MemoryKv()
    const fetchFn = vi.fn(async () => json({ error: 'invalid_grant' }, { status: 400 }))
    const tokens = new TokenManager({ kv, fetch: fetchFn as unknown as typeof fetch })
    await expect(tokens.importBundle(bundleOf({ clientId: 'c', refreshToken: 'bad' }))).rejects.toBeInstanceOf(AuthRequiredError)
    expect(tokens.hasAuth()).toBe(false)
  })
})

/** Minimal fake of the Sunsama MCP endpoint. */
function fakeServer(options: { sse?: boolean; resources?: boolean } = {}) {
  const state = { calls: [] as any[], session: 's1', validTokens: new Set(['good']), resources: options.resources ?? true }
  const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>
    const body = JSON.parse(String(init?.body))
    state.calls.push({ method: body.method, headers })
    if (!state.validTokens.has(headers.authorization.replace('Bearer ', ''))) return new Response('Invalid authorization!', { status: 401 })
    if (body.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } }, { headers: { 'content-type': 'application/json', 'mcp-session-id': state.session } })
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (headers['mcp-session-id'] !== state.session) return new Response('Session not found', { status: 404 })

    const fixtureFor = (uri: string) => (uri.endsWith('/me') ? meFixture : uri.includes('/calendar/') ? calendarFixture : tasksFixture)
    let result: unknown
    if (body.method === 'resources/read') {
      if (!state.resources) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } })
      result = { contents: [{ uri: body.params.uri, text: JSON.stringify(fixtureFor(body.params.uri)) }] }
    } else if (body.params.name === 'read_resource') {
      result = { content: [{ type: 'text', text: JSON.stringify(fixtureFor(body.params.arguments.uri)) }] }
    } else {
      result = { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] }
    }
    const message = { jsonrpc: '2.0', id: body.id, result }
    if (options.sse) {
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return json(message)
  })
  return { state, fetchFn }
}

function clientFor(server: ReturnType<typeof fakeServer>, token = { value: 'good' }) {
  return new McpClient({
    url: 'https://api.sunsama.com/mcp',
    fetch: server.fetchFn as unknown as typeof fetch,
    getToken: async () => token.value,
    refreshToken: async () => (token.value = 'good'),
  })
}

describe('McpClient + SunsamaProvider', () => {
  it('initializes once, carries the session, and reads JSON or SSE replies', async () => {
    for (const sse of [false, true]) {
      const server = fakeServer({ sse })
      const provider = new SunsamaProvider(clientFor(server))
      expect(await provider.getProfile()).toEqual({ timezone: 'America/New_York' })
      expect((await provider.listTasks('2026-09-20')).length).toBe(3)
      expect(server.state.calls.map(c => c.method)).toEqual(['initialize', 'notifications/initialized', 'resources/read', 'resources/read'])
      expect(server.state.calls[2].headers).toMatchObject({ 'mcp-session-id': 's1', 'mcp-protocol-version': '2025-03-26' })
    }
  })

  it('sends the completion day when checking off and none when un-checking', async () => {
    const server = fakeServer()
    const provider = new SunsamaProvider(clientFor(server))
    await provider.setCompleted('t1', true, '2026-09-20')
    await provider.setCompleted('t1', false, '2026-09-20')
    const bodies = server.fetchFn.mock.calls.map(c => JSON.parse(String(c[1]?.body))).filter(b => b.method === 'tools/call')
    expect(bodies[0].params).toEqual({ name: 'mark_task_as_completed', arguments: { taskId: 't1', finishedDay: '2026-09-20' } })
    expect(bodies[1].params).toEqual({ name: 'mark_task_as_incomplete', arguments: { taskId: 't1' } })
  })

  it('marks a subtask complete or incomplete with both ids', async () => {
    const server = fakeServer()
    const provider = new SunsamaProvider(clientFor(server))
    await provider.setSubtaskCompleted('t1', 's1', true)
    await provider.setSubtaskCompleted('t1', 's1', false)
    const bodies = server.fetchFn.mock.calls.map(c => JSON.parse(String(c[1]?.body))).filter(b => b.method === 'tools/call')
    expect(bodies[0].params).toEqual({ name: 'mark_subtask_as_completed', arguments: { taskId: 't1', subtaskId: 's1' } })
    expect(bodies[1].params).toEqual({ name: 'mark_subtask_as_incomplete', arguments: { taskId: 't1', subtaskId: 's1' } })
  })

  it('fetches and parses calendar events for a day', async () => {
    const server = fakeServer()
    const provider = new SunsamaProvider(clientFor(server))
    const events = await provider.getEventsForDay('2026-09-20')
    expect(events).toHaveLength(3)
    expect(events.find(e => e.id === 'ev-meeting')).toMatchObject({ isMeeting: true, startTime: '9:00 AM' })
  })

  it('falls back to the read_resource tool when resources/read is unsupported, and remembers it', async () => {
    const server = fakeServer({ resources: false })
    const provider = new SunsamaProvider(clientFor(server))
    expect((await provider.listTasks('2026-09-20')).length).toBe(3)
    await provider.listTasks('2026-09-20')
    expect(server.state.calls.filter(c => c.method === 'resources/read')).toHaveLength(1)
  })

  it('refreshes the token once on 401 and gives up with an auth error if that fails too', async () => {
    const server = fakeServer()
    const token = { value: 'stale' }
    const provider = new SunsamaProvider(clientFor(server, token))
    expect((await provider.listTasks('2026-09-20')).length).toBe(3)
    expect(token.value).toBe('good')

    server.state.validTokens.clear()
    await expect(provider.listTasks('2026-09-20')).rejects.toBeInstanceOf(AuthRequiredError)
  })

  it('starts a new session once when the server forgets ours', async () => {
    const server = fakeServer()
    const provider = new SunsamaProvider(clientFor(server))
    await provider.listTasks('2026-09-20')
    server.state.session = 's2'
    expect((await provider.listTasks('2026-09-20')).length).toBe(3)
    expect(server.state.calls.filter(c => c.method === 'initialize')).toHaveLength(2)
  })
})
