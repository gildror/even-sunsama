/** Today's date (YYYY-MM-DD) in an IANA timezone. Falls back to the device zone if `tz` is unknown. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  let parts: Intl.DateTimeFormatPart[]
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  try {
    parts = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz || undefined }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(now)
  }
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Device-local clock, `14:05` or `2:05`. */
export function formatClock(now: Date, h24: boolean): string {
  const m = String(now.getMinutes()).padStart(2, '0')
  if (h24) return `${String(now.getHours()).padStart(2, '0')}:${m}`
  const h = now.getHours() % 12 || 12
  return `${h}:${m}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Device-local `Sun 20 Sep`. */
export function formatDateShort(now: Date): string {
  return `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`
}

/** `Sun 20 Sep` for a YYYY-MM-DD string, without any timezone shifting. */
export function formatDayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  return formatDateShort(new Date(y, m - 1, d))
}

export function msToNextMinute(now: Date = new Date()): number {
  return 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds())
}
