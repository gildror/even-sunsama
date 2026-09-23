const REDACTIONS: Array<[RegExp, string]> = [
  [/es1\.[A-Za-z0-9_-]+/g, 'es1.<redacted>'],
  [/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>'],
  [/("?(?:access_token|refresh_token|code|code_verifier)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1<redacted>'],
]

export function redact(text: string): string {
  return REDACTIONS.reduce((out, [re, to]) => out.replace(re, to), text)
}

/** Console logger that also keeps the last lines for the phone debug panel. Never pass tokens in. */
export class Logger {
  private lines: string[] = []
  private listeners = new Set<() => void>()

  constructor(private readonly max = 50) {}

  log(tag: string, message: string): void {
    const line = redact(`[${tag}] ${message}`)
    console.log(line)
    this.lines.push(`${new Date().toLocaleTimeString()} ${line}`)
    if (this.lines.length > this.max) this.lines.shift()
    this.listeners.forEach(fn => fn())
  }

  getLines(): readonly string[] {
    return this.lines
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}
