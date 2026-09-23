/** Mirrors the SDK's `OsEventTypeList`; kept local so this module stays pure and testable. */
export const Os = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  ABNORMAL_EXIT: 6,
  SYSTEM_EXIT: 7,
  LONG_PRESS: 9,
} as const

export type GlassesInput =
  | { t: 'click' }
  | { t: 'doubleClick' }
  | { t: 'scrollUp' }
  | { t: 'scrollDown' }
  | { t: 'listSelect'; index: number; name?: string }
  | { t: 'menu'; itemID: number }
  | { t: 'fgEnter' }
  | { t: 'fgExit' }
  | { t: 'exit' }
  | { t: 'longPress' }

interface Envelope {
  eventType?: number
  currentSelectItemIndex?: number
  currentSelectItemName?: string
}

export interface RawHubEvent {
  listEvent?: Envelope
  textEvent?: Envelope
  sysEvent?: Envelope
  menuItemClickEvent?: { itemID?: number }
  audioEvent?: unknown
}

// CLICK_EVENT is 0 and protobuf drops zero values on the wire, so a tap arrives
// with no `eventType`. The default must be resolved INSIDE the envelope check:
// defaulting on a missing envelope would turn every audio frame into a tap.
function eventTypeOf(envelope?: Envelope): number | null {
  if (!envelope) return null
  return envelope.eventType ?? Os.CLICK
}

/** One place that turns raw hub events into app inputs. Unknown events become null. */
export function normalizeEvent(event: RawHubEvent): GlassesInput | null {
  const itemID = event.menuItemClickEvent?.itemID
  if (itemID !== undefined) return { t: 'menu', itemID }

  const listType = eventTypeOf(event.listEvent)
  const textType = eventTypeOf(event.textEvent)
  const sysType = eventTypeOf(event.sysEvent)

  // Double-click before click, whichever envelope carries it.
  if (listType === Os.DOUBLE_CLICK || textType === Os.DOUBLE_CLICK || sysType === Os.DOUBLE_CLICK) return { t: 'doubleClick' }

  if (listType === Os.CLICK) {
    // Same zero-value trap: the first row arrives without an index.
    return { t: 'listSelect', index: event.listEvent?.currentSelectItemIndex ?? 0, name: event.listEvent?.currentSelectItemName }
  }

  if (textType === Os.SCROLL_TOP || sysType === Os.SCROLL_TOP) return { t: 'scrollUp' }
  if (textType === Os.SCROLL_BOTTOM || sysType === Os.SCROLL_BOTTOM) return { t: 'scrollDown' }
  if (textType === Os.CLICK || sysType === Os.CLICK) return { t: 'click' }

  switch (sysType) {
    case Os.FOREGROUND_ENTER:
      return { t: 'fgEnter' }
    case Os.FOREGROUND_EXIT:
      return { t: 'fgExit' }
    case Os.ABNORMAL_EXIT:
    case Os.SYSTEM_EXIT:
      return { t: 'exit' }
    case Os.LONG_PRESS:
      return { t: 'longPress' }
    default:
      return null
  }
}
