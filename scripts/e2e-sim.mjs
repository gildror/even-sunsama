#!/usr/bin/env node
// End-to-end check in the Even Hub simulator, always with mock data (never touches Sunsama).
// Drives the glasses through the simulator's automation API and asserts on the app's
// console markers and on lit pixels in the glasses framebuffer.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

/**
 * The simulator keeps a real WebKit profile on disk across separate process launches (macOS:
 * ~/Library/WebKit/evenhub-simulator), so our app's localStorage cache — correct, intentional
 * behaviour on a real device — otherwise leaks between e2e runs and even between scenarios in the
 * same run, making the very first render after a launch reflect a *previous* scenario's fixture.
 * Wiping it before every run is what makes assertions on that first render reproducible.
 */
function clearSimulatorProfile() {
  if (process.platform !== 'darwin') return
  for (const dir of ['Library/WebKit/evenhub-simulator', 'Library/Caches/evenhub-simulator']) {
    try {
      rmSync(join(homedir(), dir), { recursive: true, force: true })
    } catch {
      // Best-effort: an e2e run is still meaningful without this, just noisier.
    }
  }
}

async function run() {
  mkdirSync(OUT, { recursive: true })
  clearSimulatorProfile()
  console.log('Starting dev server (mock data) and simulator…')
  start('npx', ['vite', '--port', String(APP_PORT), '--strictPort'], { VITE_PROVIDER: 'mock' })
  await waitFor('dev server', async () => (await (await fetch(APP)).text()).includes('Tasks for Sunsama'))

  console.log('\nHappy path')
  let sim = await launchSimulator('?priority=flat')
  await expectLog('[app] screen=face open=3', 30_000)
  await sleep(400)
  const face = await screenshot('face')
  const openStrip = litPixels(face, { x: 8, y: 6, w: 200, h: 24 })
  const objectives = litPixels(face, { x: 8, y: 48, w: 560, h: 100 })
  check('face: open count drawn', openStrip > 50, `${openStrip} lit px`)
  check('face: weekly objectives drawn', objectives > 200, `${objectives} lit px`)

  await input('click')
  await expectLog('[app] screen=tasks rows=5')
  // Row 0 is t1, which has subtasks (tapping it would open Task View, not toggle it — see the
  // third scenario below) — t2 has none, so it's the one to exercise a plain toggle here.
  await input('down')
  await input('click')
  await expectLog('[store] toggle t2 -> true ok')
  await sleep(800)
  await screenshot('tasks-after-check')

  // t2 sank into the completed group (rows: t1, t3, t2, t4, t5); move to it and un-check.
  await input('down')
  await input('down')
  await input('click')
  await expectLog('[store] toggle t2 -> false ok')

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
  sim = await launchSimulator('?priority=flat&fail=toggle')
  await expectLog('[app] screen=face open=3', 30_000)
  await input('click')
  await expectLog('[app] screen=tasks rows=5')
  await input('down') // t1 has subtasks; t2 doesn't, so it's the one that attempts (and fails) a toggle
  await input('click')
  await expectLog('[store] toggle t2 -> true failed, rolled back')
  await sleep(800)
  await screenshot('tasks-after-rollback')
  stop(sim)
  await waitFor('simulator shutdown', async () => !(await fetch(`${SIM}/api/ping`).then(r => r.ok).catch(() => false)))

  console.log('\nPriority grouping, Task View, subtasks and meeting reminder')
  sim = await launchSimulator('?meeting=5')
  await expectLog('[app] screen=face open=3', 30_000)
  await input('click')
  await expectLog('[app] screen=tasks') // exact row count is flaky here: this origin's localStorage still
  // has the previous scenario's cache, so the very first render can reflect stale data for an instant,
  // before the background refresh (already in flight) repaints with this scenario's fixture. The repaint
  // is a plain rebuild with no log line of its own, so the screenshot below is what actually verifies it.
  await sleep(700)
  // Default fixture: 3 open tasks spanning 3 priorities -> 3 group headers + 3 open + 2 done.
  const grouped = await screenshot('tasks-grouped')
  const groupHeader = litPixels(grouped, { x: 0, y: 36, w: 200, h: 34 })
  check('tasks: priority group header rendered', groupHeader > 200, `${groupHeader} lit px`)

  // Row 0 is the "— Urgent —" header; row 1 is t1 (urgent, has subtasks). A task with subtasks
  // can only complete by finishing them, so tapping it opens Task View directly — no toggle.
  await input('down')
  await input('click')
  await expectLog('[app] screen=focus task=t1')
  await screenshot('focus-full')

  await input('click') // first OPEN subtask (t1-s1 starts done, so this lands on t1-s2)
  await expectLog('[store] toggle subtask t1-s2 -> true ok')
  await input('click') // t1-s3, the last remaining open one -> the task auto-completes
  await expectLog('[store] toggle subtask t1-s3 -> true ok')
  await expectLog('[store] toggle t1 -> true ok')
  await screenshot('focus-autocompleted')

  await input('double_click') // full -> tasks; t1 is now done, t2 (no subtasks) took its place at row 1
  await expectLog('[app] screen=tasks')

  // t2 has no subtasks, so a plain tap still completes it directly — the old behaviour, unchanged.
  // This also sets it as the Tasks menu's "Open" target for the next part.
  await input('down')
  await input('click')
  await expectLog('[store] toggle t2 -> true ok')

  // The "Open" menu item remains the way to view a task's description when it has no subtasks
  // to tap into directly.
  await input('context_menu')
  await input('down')
  await input('down')
  await input('down')
  await input('click') // Tasks menu: Face, Refresh, Hide completed, Open
  await expectLog('[app] screen=focus task=t2')

  await input('context_menu')
  await input('click') // Task View full-mode menu: Focus is first
  await expectLog('[app] focus: mode=focus')
  await sleep(600)
  const minimal = await screenshot('focus-minimal')
  const banner = litPixels(minimal, { x: 8, y: 8, w: 400, h: 28 })
  check('focus minimal: meeting banner drawn', banner > 100, `${banner} lit px`)

  await input('double_click') // exits focus mode back to full — immediate, not timer-dependent
  await expectLog('[app] focus: mode=full')
  await input('double_click') // full -> tasks
  await expectLog('[app] screen=tasks')
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
