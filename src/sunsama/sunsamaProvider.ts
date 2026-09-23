import type { CalendarEvent, Profile, Task, TaskProvider, WeeklyObjective } from '../core/types'
import { McpRpcError } from './mcpClient'
import type { McpClient } from './mcpClient'
import { parseCalendarEvents, parseMe, parseTasksResource, parseWeeklyObjectives } from './parse'

/** Sunsama through its official MCP server. */
export class SunsamaProvider implements TaskProvider {
  /** Day lists are an MCP resource; `read_resource` is the server's tool fallback for it. */
  private readVia: 'resource' | 'tool' = 'resource'

  constructor(private readonly client: McpClient) {}

  async getProfile(): Promise<Profile> {
    return parseMe(await this.read('sunsama://me'))
  }

  async listTasks(day: string): Promise<Task[]> {
    return parseTasksResource(await this.read(`sunsama://tasks/${day}`), day)
  }

  async getEventsForDay(day: string): Promise<CalendarEvent[]> {
    return parseCalendarEvents(await this.read(`sunsama://calendar/events/${day}`))
  }

  async getWeeklyObjectives(day: string): Promise<WeeklyObjective[]> {
    return parseWeeklyObjectives(await this.read(`sunsama://objectives/${day}`))
  }

  async setCompleted(id: string, completed: boolean, day: string): Promise<void> {
    if (completed) {
      await this.client.callTool('mark_task_as_completed', { taskId: id, finishedDay: day })
    } else {
      await this.client.callTool('mark_task_as_incomplete', { taskId: id })
    }
  }

  async setSubtaskCompleted(taskId: string, subtaskId: string, completed: boolean): Promise<void> {
    const tool = completed ? 'mark_subtask_as_completed' : 'mark_subtask_as_incomplete'
    await this.client.callTool(tool, { taskId, subtaskId })
  }

  private async read(uri: string): Promise<unknown> {
    if (this.readVia === 'resource') {
      try {
        return await this.client.readResource(uri)
      } catch (err) {
        if (!(err instanceof McpRpcError)) throw err
        this.readVia = 'tool'
      }
    }
    return this.client.callTool('read_resource', { uri })
  }
}
