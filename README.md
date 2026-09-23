# Tasks for Sunsama (Even G2)

An [Even Hub](https://hub.evenrealities.com/docs/get-started/overview) plugin that shows today's
[Sunsama](https://www.sunsama.com) tasks on Even Realities G2 glasses and lets you check them off.

- **Face screen** (opens first): highest-priority open task's count on the left, clock on the right,
  next task below.
- **Tasks screen**: today's tasks, open ones first, grouped by Sunsama's daily priority (urgent →
  important → normal → low) when more than one is in play and it still fits on one page. Tap to
  check off or un-check.
- **Task View / Focus screen**: tapping a task with subtasks in Tasks opens it directly — a task with
  subtasks can only be completed by finishing all of them, so *Full mode* shows the description and
  checkable subtasks instead of toggling it — the task itself completes automatically once every
  subtask is checked off, and un-completes if you uncheck one afterwards. (The Tasks menu's **Open**
  item also reaches it, for any
  task, including ones without subtasks that you just want to read the notes on.) Its own menu's
  **Focus** item switches to *Focus mode* — just the clock and task name, for working heads-down —
  with an upcoming-meeting banner (`◆ Meeting in N minutes`) when one starts soon (lead time and
  on/off are both settings). A single tap peeks at the full view for 10 seconds and returns; a
  double-tap exits Focus mode for good. "Hide completed" applies to the subtask list here too.
- **Channel filter**: phone setting listing every channel seen in today's tasks; check specific ones
  to show only those on the glasses, or leave all unchecked to show everything (the default, and
  what a brand-new channel falls back to automatically).
- **Phone page** (inside the Even app): connect to Sunsama, mirror of today's tasks (respects "show
  completed"), settings, log.

Even Hub only offers *plugins* to third parties today. Dashboard widgets and dashboard layouts
(watch faces) are announced but not available, so the "face" is a screen inside this plugin and only
shows while the plugin is open. `src/core/summary.ts` is the piece a real widget would reuse.

## Controls on the glasses

| Screen | Tap | Double-tap | Tap, then long-press |
|---|---|---|---|
| Face | Open tasks | Exit dialog | Menu: Tasks · Refresh · Hide/Show completed |
| Tasks | Task with no subtasks: check off / un-check. Task with subtasks: opens Task View | Back to face | Menu: Face · Refresh · Hide/Show completed · **Open** |
| Task View — full mode | Check off / un-check a subtask | Back to tasks | Menu: **Focus** · Tasks · Refresh |
| Task View — Focus mode | Peek at full view for 10 s | Exit Focus mode (back to full) | Menu: Full view · Tasks |

Header markers: `~` syncing, `! failed` a check-off was rolled back, `! offline` / `! stale` data may be old.

**Why "Open" targets the *last-tapped* task, not a selection.** The platform gives the app no way to
learn which list row is under the cursor without also firing that row's tap action — swipes are
handled by firmware with no event sent to the app, so a `click` (which the Tasks screen already uses
to toggle completion) is the only row-targeting signal that exists. Tap a task to interact with it,
then use the menu's Open item to dive into it.

## Develop

```bash
pnpm install
pnpm dev:mock        # dev server on :5183 with built-in fake tasks
pnpm sim             # Even Hub simulator pointed at the dev server
```

`pnpm test` runs the unit tests, `pnpm e2e` drives the simulator end to end (mock data, own ports).

**Simulator quirk (not an app bug):** the headless, automation-only simulator doesn't service JS
`setTimeout`/`setInterval` on real wall-clock time when nothing else is happening — pending timers
only run once a new bridge message (e.g. an `/api/input` call) arrives. This affects the Focus
screen's 10-second peek and the per-minute clock tick under `pnpm e2e` / scripted automation
specifically. An interactively open simulator, and real glasses, don't have this limitation — their
render loop stays live regardless of input. `pnpm e2e` avoids asserting on time-elapsed behaviour for
this reason; verify it by hand (`pnpm sim`, tap to peek, watch it revert after 10 s) when touching that
code.

## Sign-in

Sunsama has no public REST API; the plugin talks to Sunsama's official MCP server
(`https://api.sunsama.com/mcp`) with OAuth (PKCE, public client, no server of ours). Sunsama's app
access requires their Pro plan.

**Users:** open <https://gildror.github.io/even-sunsama/> in the phone browser, sign in, copy the
sign-in code, and paste it into the plugin's page in the Even app (Home tab → *Tasks for Sunsama*
card → Connect → Save). That page is `docs/index.html`, served by GitHub Pages; it registers its own
OAuth client with Sunsama and never sends tokens anywhere but Sunsama.

**Developers:** `pnpm auth --label sim` signs in from the Mac and writes `.env.development.local`,
so `pnpm dev` + `pnpm sim` (or `pnpm qr`) run against your real account without any pasting.
`pnpm auth --label probe && pnpm probe` prints how the Sunsama server behaves. Grants live in the
git-ignored `.secrets/`; the build fails if any token ends up in `dist/` (`scripts/check-no-secrets.mjs`).

## Run on the glasses

```bash
pnpm dev
pnpm qr              # Even app -> Even Hub tab -> developer section (top right) -> Scan QR
```

The page dies when the phone locks or the Even app goes to the background; re-scan the QR.

## Ship to Even Hub

1. `pnpm ehpk` → `tasks-for-sunsama.ehpk` (build, secret check, pack with the SDK floor stamped).
2. Upload it at <https://hub.evenrealities.com> (project → builds). Listing text and assets are in
   `store/`.
3. Move the build to **Test**, add yourself to a Beta group, install from *Me → Beta tester*, and run
   the locked-phone checks (launch from the glasses with the phone locked, 2 minutes idle,
   lock/unlock). QR sideload cannot reproduce these.
4. Move to **Submitted**. Released versions are immutable; ship fixes as a higher version.

## Layout

```
src/core/      tasks store, sync timing, selectors, glance summary (no SDK or DOM imports)
src/sunsama/   OAuth token handling, minimal MCP client, Sunsama + mock providers
src/glasses/   event normalisation, page/display abstraction, face/tasks/focus/message screens
src/phone/     page shown in the Even phone app
src/platform/  storage over the Even bridge with a localStorage mirror
scripts/       auth, probe, secret check, simulator e2e
```
