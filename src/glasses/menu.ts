import type { ScreenName, Settings } from '../core/types'
import type { MenuItemSpec } from './page'

/** Contextual-menu item ids (non-zero, unique). The OS adds its own "Close" entry. */
export const MENU = { SWITCH: 1, REFRESH: 2, TOGGLE_COMPLETED: 3 } as const

/** Menu labels are static once sent, so every page carries labels for the current state. */
export function buildMenu(screen: ScreenName | 'message', settings: Settings): MenuItemSpec[] {
  return [
    { id: MENU.SWITCH, label: screen === 'tasks' ? 'Face' : 'Tasks' },
    { id: MENU.REFRESH, label: 'Refresh' },
    { id: MENU.TOGGLE_COMPLETED, label: settings.showCompleted ? 'Hide completed' : 'Show completed' },
  ]
}
