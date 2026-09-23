import type { Task } from './types'

export const openTasks = (tasks: Task[]): Task[] => tasks.filter(t => !t.completed)
export const doneTasks = (tasks: Task[]): Task[] => tasks.filter(t => t.completed)
export const openCount = (tasks: Task[]): number => openTasks(tasks).length
export const nextTask = (tasks: Task[]): Task | undefined => tasks.find(t => !t.completed)

/** Open tasks first (provider order kept), then completed ones unless hidden. */
export function orderedTasks(tasks: Task[], showCompleted: boolean): Task[] {
  return showCompleted ? [...openTasks(tasks), ...doneTasks(tasks)] : openTasks(tasks)
}
