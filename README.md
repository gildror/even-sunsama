# Tasks for Sunsama (Even G2)

An [Even Hub](https://hub.evenrealities.com/docs/get-started/overview) plugin that shows today's
[Sunsama](https://www.sunsama.com) tasks on Even Realities G2 glasses and lets you check them off.

- **Face screen** (opens first): open-task count on the left, clock on the right, next task below.
- **Tasks screen**: today's tasks, open ones first. Tap to check off or un-check.
- **Phone page** (inside the Even app): connect to Sunsama, mirror of today's tasks, settings, log.

Even Hub only offers *plugins* to third parties today. Dashboard widgets and dashboard layouts
(watch faces) are announced but not available, so the "face" is a screen inside this plugin and only
shows while the plugin is open. `src/core/summary.ts` is the piece a real widget would reuse.

## Controls on the glasses

| Screen | Tap | Double-tap | Tap, then long-press |
|---|---|---|---|
| Face | Open tasks | Exit dialog | Menu: Tasks · Refresh · Hide/Show completed |
| Tasks | Check off / un-check the selected task (swipe to move) | Back to face | Menu: Face · Refresh · Hide/Show completed |

Header markers: `~` syncing, `! failed` a check-off was rolled back, `! offline` / `! stale` data may be old.

## Develop

```bash
pnpm install
pnpm dev:mock        # dev server on :5183 with built-in fake tasks
pnpm sim             # Even Hub simulator pointed at the dev server
```

`pnpm test` runs the unit tests, `pnpm e2e` drives the simulator end to end (mock data, own ports).

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
src/glasses/   event normalisation, page/display abstraction, face/tasks/message screens
src/phone/     page shown in the Even phone app
src/platform/  storage over the Even bridge with a localStorage mirror
scripts/       auth, probe, secret check, simulator e2e
```
