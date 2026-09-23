/** Plain-data description of a glasses page. Screens build these; a Display sends them. */
export const SCREEN_W = 576
export const SCREEN_H = 288

interface Box {
  id: number
  /** Unique per page, max 16 chars. */
  name: string
  x: number
  y: number
  w: number
  h: number
}

export interface TextSpec extends Box {
  content: string
  capture?: boolean
  padding?: number
}

export interface ListSpec extends Box {
  items: string[]
  capture?: boolean
}

/** Width 20-288, height 20-144. Pixels arrive later through Display.setImage. */
export type ImageSpec = Box

export interface MenuItemSpec {
  id: number
  label: string
}

/** Exactly one text or list container must have `capture: true`. Declaration order is z-order. */
export interface PageSpec {
  texts?: TextSpec[]
  lists?: ListSpec[]
  images?: ImageSpec[]
  /** Sent with every page: omitting it would clear the contextual menu. */
  menu: MenuItemSpec[]
}

export interface Display {
  showPage(page: PageSpec): Promise<boolean>
  /** Flicker-free text change on the current page. */
  upgradeText(id: number, name: string, content: string): Promise<boolean>
  /** PNG bytes for an image container on the current page. */
  setImage(id: number, name: string, png: Uint8Array): Promise<boolean>
  /** 1 = system exit dialog (required on root screens), 0 = immediate. */
  shutDown(mode: 0 | 1): Promise<void>
}
