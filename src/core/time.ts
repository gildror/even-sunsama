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

/** Parses Sunsama's "9:00 AM" / "12:30 PM" event time strings to 24h {h, m}. Returns null if unparseable. */
export function parseTimeOfDay12h(text: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text.trim())
  if (!match) return null
  let h = Number(match[1])
  const m = Number(match[2])
  if (h < 1 || h > 12 || m > 59) return null
  const isPM = match[3].toUpperCase() === 'PM'
  if (h === 12) h = 0 // 12:xx AM is midnight, 12:xx PM is noon
  return { h: h + (isPM ? 12 : 0), m }
}

/**
 * Converts a wall-clock time (a day, an hour/minute, an IANA zone) to the
 * absolute instant it refers to — the inverse of `Intl.DateTimeFormat`, which
 * only goes instant -> wall time. Needed because Sunsama's calendar events
 * carry a time string ("9:00 AM") with no date or offset attached.
 *
 * Works by guessing an instant, reading back what wall time that instant has
 * in `tz`, and correcting for the difference. One correction is enough except
 * exactly at a DST transition, where a second pass removes the residual error.
 */
export function zonedTimeToUtc(day: string, hm: { h: number; m: number }, tz: string): Date {
  const [y, mo, d] = day.split('-').map(Number)
  let guess = Date.UTC(y, (mo || 1) - 1, d || 1, hm.h, hm.m)
  for (let i = 0; i < 2; i++) {
    const seen = wallTimeInTz(new Date(guess), tz)
    const deltaMin = (hm.h * 60 + hm.m - (seen.h * 60 + seen.m)) + (dayDelta(y, mo, d, seen) * 1440)
    if (deltaMin === 0) break
    guess += deltaMin * 60_000
  }
  return new Date(guess)
}

function wallTimeInTz(instant: Date, tz: string): { y: number; mo: number; d: number; h: number; m: number } {
  let parts: Intl.DateTimeFormatPart[]
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const
  try {
    parts = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz || undefined }).formatToParts(instant)
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(instant)
  }
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), m: get('minute') }
}

/** Whole-day difference between the target calendar day and the day a guess landed on. */
function dayDelta(y: number, mo: number, d: number, seen: { y: number; mo: number; d: number }): number {
  const target = Date.UTC(y, (mo || 1) - 1, d || 1)
  const actual = Date.UTC(seen.y, seen.mo - 1, seen.d)
  return Math.round((target - actual) / 86_400_000)
}
