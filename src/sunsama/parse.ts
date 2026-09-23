import type { Profile, Task } from '../core/types'

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}

/** Pulls the JSON-RPC messages out of a `text/event-stream` body. */
export function sseToMessages(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = []
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // Keep-alives and partial frames are not JSON.
    }
  }
  return messages
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** `tools/call` result -> the JSON the tool returned (Sunsama puts it in `content[0].text`). */
export function unwrapToolResult(result: any): unknown {
  const text = (result?.content ?? []).find((c: any) => c?.type === 'text')?.text
  if (result?.isError) throw new McpToolError(typeof text === 'string' ? text : 'Sunsama tool call failed')
  if (typeof text !== 'string') return result?.structuredContent ?? null
  const value = parseMaybeJson(text)
  // read_resource may hand back a resources/read envelope instead of the bare payload.
  return isResourceEnvelope(value) ? unwrapResourceResult(value) : value
}

function isResourceEnvelope(value: unknown): value is { contents: Array<{ text?: string }> } {
  return typeof value === 'object' && value !== null && Array.isArray((value as any).contents)
}

/** `resources/read` result -> parsed JSON of the first text content. */
export function unwrapResourceResult(result: any): unknown {
  const text = (result?.contents ?? []).find((c: any) => typeof c?.text === 'string')?.text
  return typeof text === 'string' ? parseMaybeJson(text) : null
}

/** Payload of `sunsama://tasks/{day}` -> tasks the glasses should show for that day. */
export function parseTasksResource(payload: unknown, day: string): Task[] {
  const list = Array.isArray(payload) ? payload : (payload as any)?.tasks
  if (!Array.isArray(list)) throw new Error('Unexpected Sunsama tasks response')
  return list
    .filter(t => t && typeof t._id === 'string' && !t.deleted && !t.isArchived && !t.isBacklogged)
    .filter(t => !t.scheduledDate || t.scheduledDate === day)
    .map(t => {
      const subtasks: any[] = Array.isArray(t.subtasks) ? t.subtasks : []
      return {
        id: t._id,
        title: String(t.title ?? '').trim() || '(untitled)',
        completed: Boolean(t.completed),
        subtasksDone: subtasks.filter(s => s?.completed).length,
        subtasksTotal: subtasks.length,
      }
    })
}

/** Payload of `sunsama://me` -> profile. */
export function parseMe(payload: unknown): Profile {
  const timezone = (payload as any)?.user?.timezone ?? (payload as any)?.timezone
  if (typeof timezone !== 'string' || !timezone) throw new Error('Sunsama profile has no timezone')
  return { timezone }
}
