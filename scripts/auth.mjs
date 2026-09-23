#!/usr/bin/env node
// Signs this Mac in to Sunsama's official MCP server and produces a "sign-in bundle"
// for one surface of the app.
//
//   pnpm auth --label sim     -> also writes .env.development.local for the dev server/simulator
//   pnpm auth --label phone   -> paste the copied bundle into the plugin's phone page
//   pnpm auth --label probe   -> used by `pnpm probe`
//
// One grant per label: refresh tokens may rotate, and two surfaces sharing a grant
// would sign each other out. Everything sensitive stays in .secrets/ (git-ignored).
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECRETS = join(ROOT, '.secrets')
const ISSUER = 'https://api.sunsama.com'
const RESOURCE = `${ISSUER}/mcp`
const PORT = 53682
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`
const SCOPE = 'read execute offline_access'

const args = process.argv.slice(2)
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'sim'
if (!/^[a-z0-9-]+$/.test(label ?? '')) fail('Use --label with lowercase letters, digits or dashes (e.g. sim, phone, probe).')

const b64url = buf => Buffer.from(buf).toString('base64url')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function writeSecret(path, value) {
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) fail(`${url} -> ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`)
  return body
}

/** Dynamic client registration, done once and reused for every label. */
async function getClient(meta) {
  const path = join(SECRETS, 'client.json')
  if (existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    if (cached.redirect_uri === REDIRECT_URI && cached.client_id) return cached
  }
  if (!meta.registration_endpoint) fail('Sunsama no longer advertises dynamic client registration.')
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Tasks for Sunsama (Even G2, personal)',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.client_id) fail(`Client registration failed (${res.status}): ${JSON.stringify(body)}`)
  const client = { client_id: body.client_id, redirect_uri: REDIRECT_URI, registered_at: new Date().toISOString() }
  writeSecret(path, client)
  console.log('• Registered this app with Sunsama (saved in .secrets/client.json)')
  return client
}

/** Waits for the browser to come back to the loopback address with ?code=. */
function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const ok = !error && url.searchParams.get('state') === expectedState && url.searchParams.get('code')
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<body style="font:16px system-ui;padding:40px">${ok ? 'Signed in. You can close this tab and go back to the terminal.' : 'Sign-in failed. Check the terminal.'}</body>`)
      server.close()
      if (ok) resolve(url.searchParams.get('code'))
      else reject(new Error(error ? `Sunsama returned "${error}": ${url.searchParams.get('error_description') ?? ''}` : 'State mismatch in callback'))
    })
    server.on('error', err => reject(new Error(`Cannot listen on 127.0.0.1:${PORT} (${err.message})`)))
    server.listen(PORT, '127.0.0.1')
    setTimeout(() => {
      server.close()
      reject(new Error('Timed out after 5 minutes waiting for the browser sign-in'))
    }, 300_000).unref()
  })
}

function upsertEnv(path, values) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex(line => line.startsWith(`${key}=`))
    if (at >= 0) lines[at] = `${key}=${value}`
    else lines.push(`${key}=${value}`)
  }
  writeFileSync(path, lines.filter((line, i) => line || i < lines.length - 1).join('\n') + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}

const meta = await (await fetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json()
const client = await getClient(meta)

const verifier = b64url(randomBytes(48))
const state = b64url(randomBytes(16))
const authorizeUrl = new URL(meta.authorization_endpoint)
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: REDIRECT_URI,
  scope: SCOPE,
  state,
  code_challenge: b64url(createHash('sha256').update(verifier).digest()),
  code_challenge_method: 'S256',
  resource: RESOURCE,
}).toString()

const pendingCode = waitForCode(state)
console.log(`• Opening your browser to sign in to Sunsama (label "${label}")…`)
console.log(`  If it does not open, visit:\n  ${authorizeUrl}\n`)
spawn('open', [authorizeUrl.toString()], { stdio: 'ignore', detached: true }).unref()

const code = await pendingCode.catch(err => fail(err.message))
const token = await postForm(meta.token_endpoint, {
  grant_type: 'authorization_code',
  code,
  redirect_uri: REDIRECT_URI,
  client_id: client.client_id,
  code_verifier: verifier,
  resource: RESOURCE,
})
if (!token.refresh_token) fail('Sunsama returned no refresh token (offline_access was not granted).')

writeSecret(join(SECRETS, `auth.${label}.json`), {
  label,
  clientId: client.client_id,
  refreshToken: token.refresh_token,
  scope: token.scope,
  accessTokenLifetimeSeconds: token.expires_in,
  createdAt: new Date().toISOString(),
})

const bundle = `es1.${b64url(JSON.stringify({ v: 1, clientId: client.client_id, refreshToken: token.refresh_token }))}`
console.log(`✓ Signed in. Grant saved to .secrets/auth.${label}.json (access tokens last ${token.expires_in ?? '?'}s).`)

if (label === 'sim') {
  upsertEnv(join(ROOT, '.env.development.local'), { VITE_PROVIDER: 'sunsama', VITE_SUNSAMA_SEED_BUNDLE: bundle })
  console.log('✓ Wrote .env.development.local: `pnpm dev` + `pnpm sim` now use your real Sunsama tasks.')
} else if (label !== 'probe') {
  const copy = spawn('pbcopy')
  copy.stdin.end(bundle)
  await new Promise(resolve => copy.on('close', resolve))
  console.log('✓ Sign-in bundle copied to the clipboard. Paste it into the plugin page in the Even app (Connect → Save).')
  console.log('  With Universal Clipboard you can paste straight on the phone. Treat it like a password.')
}
