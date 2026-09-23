# Even Hub listing – Tasks for Sunsama

**Name:** Tasks for Sunsama (matches `app.json`)
**Package id:** com.gildror.sunsamatasks
**Category:** Productivity
**Privacy policy:** https://gildror.github.io/even-sunsama/privacy
**Support / source:** https://github.com/gildror/even-sunsama

## Tagline (short)
Today's Sunsama tasks on your glasses. Tap to check them off.

## Description
See today's Sunsama task list on your Even G2 and tick tasks off with a tap, phone in your pocket.

- Glance screen: how many tasks are still open, the time, and the next task up.
- Task list: today's tasks with open ones first, grouped by priority, and subtask progress. Tap a task to complete it; tap again to reopen it. Changes sync to Sunsama right away.
- Task View: tapping a task with subtasks opens its full description and checkable subtasks instead of completing it — the task finishes on its own once every subtask is checked off.
- Focus mode: a distraction-free view showing just the clock and task name, with a heads-up banner when a meeting is starting soon. Tap to peek at the full view, double-tap to come back.
- Contextual menu on every screen: switch screens, refresh, hide completed tasks, open a task.
- Works offline from the last sync and never shows a blank screen.

Setup takes a minute: sign in to Sunsama on the phone at gildror.github.io/even-sunsama, paste the code into the plugin, done. Your tasks go directly between your phone and Sunsama; there is no third-party server.

Requires a Sunsama account on the Pro plan (Sunsama's app access is a Pro feature). Not affiliated with Sunsama.

## Changelog 1.0.0
First release: glance screen, priority-grouped task list with tap-to-complete, Task View with subtasks, Focus mode with meeting reminders, contextual menu, offline cache.

## Assets
- **Icon / "foreground"**: `store/icon-store-24x24.png` (identical to `public/icon.png`, the one packed
  into the .ehpk). 24×24, 1-bit black/white, built entirely from 2×2 pixel blocks — meets the portal's
  stricter store-icon rule (no single-pixel lines, no anti-aliasing). Upload this into the Developer
  Portal's 24×24 pixel editor for the store listing's foreground/icon field.
- **Background**: `store/background.png`, greyscale. Portal upload form states the exact required
  pixel size on the page — resize this to match if it differs from the placeholder's 1200×600.
- **Screenshots**: `store/screenshots/`, captured with the simulator's screenshot API (real renders,
  not mockups) against the built-in mock task data — every task name shown is fictional, not from any
  real Sunsama account:
  1. `1-face.png` — glance screen (open count, clock, next task)
  2. `2-tasks-grouped.png` — task list grouped by priority
  3. `3-task-view-full.png` — Task View: description + checkable subtasks
  4. `4-focus-minimal.png` — Focus mode (distraction-free)
  5. `5-focus-meeting-banner.png` — Focus mode with the upcoming-meeting banner
  6. `6-tasks-checked-off.png` — a task just checked off from the list
