#!/usr/bin/env node
// Answers the open questions about Sunsama's MCP server from a browser-like client.
// Prints shapes and headers only: no tokens and no task contents.
//   pnpm auth --label probe && pnpm probe
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : 'probe'
const authPath = join(ROOT, '.secrets', `auth.${label}.json`)
if (!existsSync(authPath)) {
  console.error(`No grant for label "${label}". Run: pnpm auth --label ${label}`)
  process.exit(1)
}
const auth = JSON.parse(readFileSync(authPath, 'utf8'))
const MCP = 'https://api.sunsama.com/mcp'
const ORIGIN = 'http://localhost:5183' // pretend to be the dev WebView so CORS headers show up

async function refresh() {
  const res = await fetch('https://api.sunsama.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: auth.clientId }).toString(),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${body.error}`)
  const rotated = Boolean(body.refresh_token) && body.refresh_token !== auth.refreshToken
  if (rotated) {
    // Keep the grant usable: a rotated token must be written back immediately.
    auth.refreshToken = body.refresh_token
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
    chmodSync(authPath, 0o600)
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in, rotated, cors: res.headers.get('access-control-allow-origin') }
}

let nextId = 1
async function rpc(token, method, params, session, notification = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, origin: ORIGIN }
  if (session) headers['mcp-session-id'] = session
  if (method !== 'initialize') headers['mcp-protocol-version'] = '2025-06-18'
  const id = notification ? undefined : nextId++
  const res = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  const type = res.headers.get('content-type') ?? ''
  const text = await res.text()
  let message = null
  if (type.includes('event-stream')) {
    for (const line of text.split('\n')) if (line.startsWith('data:')) try { const m = JSON.parse(line.slice(5)); if (m.id === id) message = m } catch {}
  } else if (text) {
    try { message = JSON.parse(text) } catch { message = { raw: text.slice(0, 200) } }
  }
  return { status: res.status, type, message, res }
}

const shape = value => (Array.isArray(value) ? [`${value.length} items`, value[0] && shape(value[0])] : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'object' && v ? (Array.isArray(v) ? `array(${v.length})` : 'object') : typeof v])) : typeof value)
const parseText = text => { try { return JSON.parse(text) } catch { return text } }

const first = await refresh()
console.log('token refresh     :', { expiresIn: first.expiresIn, refreshTokenRotated: first.rotated, corsAllowOrigin: first.cors })
const second = await refresh()
console.log('second refresh    :', { refreshTokenRotated: second.rotated })
const token = second.accessToken

const bare = await rpc(token, 'tools/list', {})
console.log('no initialize     :', { status: bare.status, ok: Boolean(bare.message?.result), error: bare.message?.error?.message ?? bare.message?.raw })

const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'even-sunsama-probe', version: '0.1.0' } })
const session = init.res.headers.get('mcp-session-id')
console.log('initialize        :', {
  status: init.status,
  contentType: init.type,
  protocolVersion: init.message?.result?.protocolVersion,
  sessionIdSent: Boolean(session),
  exposeHeaders: init.res.headers.get('access-control-expose-headers'),
  allowOrigin: init.res.headers.get('access-control-allow-origin'),
  capabilities: Object.keys(init.message?.result?.capabilities ?? {}),
})
const ack = await rpc(token, 'notifications/initialized', undefined, session, true)
console.log('initialized ack   :', { status: ack.status })

if (session) {
  const noSession = await rpc(token, 'tools/list', {})
  console.log('after init, no session header:', { status: noSession.status, ok: Boolean(noSession.message?.result), error: noSession.message?.error?.message ?? noSession.message?.raw })
}

const tools = await rpc(token, 'tools/list', {}, session)
const names = (tools.message?.result?.tools ?? []).map(t => t.name)
console.log('tools/list        :', { status: tools.status, contentType: tools.type, count: names.length, hasComplete: names.includes('mark_task_as_completed'), hasIncomplete: names.includes('mark_task_as_incomplete'), hasReadResource: names.includes('read_resource') })

const me = await rpc(token, 'resources/read', { uri: 'sunsama://me' }, session)
const mePayload = parseText(me.message?.result?.contents?.[0]?.text ?? '')
console.log('resources/read me :', { status: me.status, error: me.message?.error?.message, timezone: mePayload?.user?.timezone, day: mePayload?.user?.currentDayForUser })

const day = mePayload?.user?.currentDayForUser ?? new Date().toISOString().slice(0, 10)
const tasks = await rpc(token, 'resources/read', { uri: `sunsama://tasks/${day}` }, session)
const tasksPayload = parseText(tasks.message?.result?.contents?.[0]?.text ?? '')
console.log('resources/read day:', { status: tasks.status, error: tasks.message?.error?.message, taskCount: tasksPayload?.tasks?.length, taskShape: shape(tasksPayload?.tasks?.[0]) })

const viaTool = await rpc(token, 'tools/call', { name: 'read_resource', arguments: { uri: `sunsama://tasks/${day}` } }, session)
const toolText = parseText(viaTool.message?.result?.content?.[0]?.text ?? '')
console.log('read_resource tool:', { status: viaTool.status, isError: viaTool.message?.result?.isError, topLevelKeys: toolText && typeof toolText === 'object' ? Object.keys(toolText) : typeof toolText })
