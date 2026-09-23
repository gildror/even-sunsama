import type { ScreenName, Settings } from '../core/types'
import type { MenuItemSpec } from './page'

/** Contextual-menu item ids for Face and Tasks (non-zero, unique per page). The OS adds its own "Close" entry. */
export const MENU = { SWITCH: 1, REFRESH: 2, TOGGLE_COMPLETED: 3, OPEN: 4 } as const

/** Menu labels are static once sent, so every page carries labels for the current state. */
export function buildMenu(screen: ScreenName | 'message', settings: Settings): MenuItemSpec[] {
  const items: MenuItemSpec[] = [
    { id: MENU.SWITCH, label: screen === 'tasks' ? 'Face' : 'Tasks' },
    { id: MENU.REFRESH, label: 'Refresh' },
    { id: MENU.TOGGLE_COMPLETED, label: settings.showCompleted ? 'Hide completed' : 'Show completed' },
  ]
  if (screen === 'tasks') items.push({ id: MENU.OPEN, label: 'Open' })
  return items
}

/** Contextual-menu item ids for Task View's full mode. */
export const FOCUS_FULL_MENU = { FOCUS: 1, TASKS: 2, REFRESH: 3 } as const

export function buildFocusFullMenu(): MenuItemSpec[] {
  return [
    { id: FOCUS_FULL_MENU.FOCUS, label: 'Focus' },
    { id: FOCUS_FULL_MENU.TASKS, label: 'Tasks' },
    { id: FOCUS_FULL_MENU.REFRESH, label: 'Refresh' },
  ]
}

/** Contextual-menu item ids for Task View's minimal focus mode. */
export const FOCUS_MIN_MENU = { FULL: 1, TASKS: 2 } as const

export function buildFocusMinMenu(): MenuItemSpec[] {
  return [
    { id: FOCUS_MIN_MENU.FULL, label: 'Full view' },
    { id: FOCUS_MIN_MENU.TASKS, label: 'Tasks' },
  ]
}
