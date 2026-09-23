#!/usr/bin/env node
// End-to-end check in the Even Hub simulator, always with mock data (never touches Sunsama).
// Drives the glasses through the simulator's automation API and asserts on the app's
// console markers and on lit pixels in the glasses framebuffer.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'e2e-out')
// Own ports, so a running `pnpm dev` / `pnpm sim` session is left alone.
const APP_PORT = 5198
const SIM_PORT = 9899
const APP = `http://localhost:${APP_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const children = []
let failures = 0

function start(command, args, env = {}) {
  // Own process group: both npx and the simulator launcher start a child that would
  // otherwise outlive them (and keep the ports busy for the next scenario).
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
  children.push(child)
  return child
}

function stop(child) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

async function waitFor(label, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${label}`)
}

let lastConsoleId = -1
const seen = []
async function pollConsole() {
  const res = await fetch(`${SIM}/api/console${lastConsoleId >= 0 ? `?since_id=${lastConsoleId}` : ''}`)
  for (const entry of (await res.json()).entries) {
    if (entry.id <= lastConsoleId) continue
    lastConsoleId = entry.id
    seen.push(entry.message)
  }
}

/** Waits for a console line containing `text` that appeared after the previous match. */
let cursor = 0
async function expectLog(text, timeoutMs = 15_000) {
  try {
    await waitFor(`console "${text}"`, async () => {
      await pollConsole()
      const at = seen.findIndex((line, i) => i >= cursor && line.includes(text))
      if (at < 0) return false
      cursor = at + 1
      return true
    }, timeoutMs)
    console.log(`  ✓ ${text}`)
  } catch (err) {
    failures++
    console.log(`  ✗ ${text}  (${err.message})`)
  }
}

async function input(action, settleMs = 700) {
  await fetch(`${SIM}/api/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
  await sleep(settleMs)
}

async function screenshot(name) {
  const buffer = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`)).arrayBuffer())
  writeFileSync(join(OUT, `${name}.png`), buffer)
  return PNG.sync.read(buffer)
}

/** Lit pixels in a box. The framebuffer is RGBA and unlit pixels are transparent. */
function litPixels(png, { x, y, w, h }) {
  let lit = 0
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) if (png.data[(row * png.width + col) * 4 + 3] > 0) lit++
  return lit
}

function check(label, ok, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`)
}

async function launchSimulator(query = '') {
  lastConsoleId = -1
  seen.length = 0
  cursor = 0
  const sim = start('evenhub-simulator', [`${APP}/${query}`, '--automation-port', String(SIM_PORT)])
  await waitFor('simulator automation API', async () => (await fetch(`${SIM}/api/ping`)).ok)
  return sim
}

async function run() {
  mkdirSync(OUT, { recursive: true })
  console.log('Starting dev server (mock data) and simulator…')
  start('npx', ['vite', '--port', String(APP_PORT), '--strictPort'], { VITE_PROVIDER: 'mock' })
  await waitFor('dev server', async () => (await (await fetch(APP)).text()).includes('Sunsama Tasks'))

  console.log('\nHappy path')
  let sim = await launchSimulator()
  await expectLog('[app] screen=face open=3', 30_000)
  await sleep(1500) // images are pushed after the page
  const face = await screenshot('face')
  const count = litPixels(face, { x: 8, y: 48, w: 200, h: 144 })
  const clock = litPixels(face, { x: 280, y: 48, w: 288, h: 144 })
  check('face: open count drawn on the left', count > 800, `${count} lit px`)
  check('face: clock drawn on the right', clock > 2000, `${clock} lit px`)

  await input('click')
  await expectLog('[app] screen=tasks rows=5')
  await input('click')
  await expectLog('[store] toggle t1 -> true ok')
  await sleep(800)
  await screenshot('tasks-after-check')

  // t1 sank into the completed group (rows: t2, t3, t1, t4, t5); move to it and un-check.
  await input('down')
  await input('down')
  await input('click')
  await expectLog('[store] toggle t1 -> false ok')

  await input('double_click')
  await expectLog('[app] screen=face open=3')
  await input('double_click')
  await expectLog('[app] exit dialog requested')

  await pollConsole()
  const errors = seen.filter(line => /\[uncaught\]|\[unhandledrejection\]|\[fetch\]/.test(line))
  check('no uncaught errors or failed requests', errors.length === 0, errors.slice(0, 3).join(' | '))
  stop(sim)
  await waitFor('simulator shutdown', async () => !(await fetch(`${SIM}/api/ping`).then(r => r.ok).catch(() => false)))

  console.log('\nFailed check-off rolls back')
  sim = await launchSimulator('?fail=toggle')
  await expectLog('[app] screen=face open=3', 30_000)
  await input('click')
  await expectLog('[app] screen=tasks rows=5')
  await input('click')
  await expectLog('[store] toggle t1 -> true failed, rolled back')
  await sleep(800)
  await screenshot('tasks-after-rollback')
  stop(sim)
}

try {
  await run()
} catch (err) {
  failures++
  console.error(`\n✗ ${err.message}`)
} finally {
  children.forEach(stop)
}
console.log(failures ? `\n✗ ${failures} check(s) failed. Screenshots in e2e-out/` : '\n✓ All end-to-end checks passed. Screenshots in e2e-out/')
process.exit(failures ? 1 : 0)
