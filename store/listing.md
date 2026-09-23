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

- Glance screen: a small open-task count and clock, and the main screen given over to this week's Sunsama objectives and how many of today's meetings you're actually attending.
- Task list: today's tasks with open ones first, grouped by priority, and subtask progress. Tap a task to complete it; tap again to reopen it. Changes sync to Sunsama right away.
- Task View: tapping a task with subtasks opens its full description and checkable subtasks instead of completing it — the task finishes on its own once every subtask is checked off.
- Focus mode: the task and its subtasks in a tight, heads-down layout, with a banner when a meeting is starting soon (on/off and lead time are both adjustable). Goes blank after 10 seconds idle; any tap wakes it.
- Channel filter: show every Sunsama channel on the glasses, or just the ones you pick.
- Contextual menu on every screen: switch screens, refresh, hide completed tasks, open a task.
- Works offline from the last sync and never shows a blank screen.

Setup takes a minute: sign in to Sunsama on the phone at gildror.github.io/even-sunsama, paste the code into the plugin, done. Your tasks go directly between your phone and Sunsama; there is no third-party server.

Requires a Sunsama account on the Pro plan (Sunsama's app access is a Pro feature). Not affiliated with Sunsama.

## Changelog 1.0.0
First release: glance screen with weekly objectives and meeting count, priority-grouped task list with tap-to-complete, Task View with subtasks, Focus mode with meeting reminders, channel filter, contextual menu, offline cache.

## Assets
- **Icon / "foreground"**: `store/icon-store-24x24.png` (identical to `public/icon.png`, the one packed
  into the .ehpk). 24×24, 1-bit black/white, built entirely from 2×2 pixel blocks — meets the portal's
  stricter store-icon rule (no single-pixel lines, no anti-aliasing). Upload this into the Developer
  Portal's 24×24 pixel editor for the store listing's foreground/icon field.
- **Background**: `store/background.png`, greyscale. Portal upload form states the exact required
  pixel size on the page — resize this to match if it differs from the placeholder's 1200×600.
- **Screenshots**: `store/screenshots/` (captured with the simulator's screenshot API, not mocked up).
