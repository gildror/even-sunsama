import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Display, PageSpec } from './page'

/**
 * Sends pages to the glasses over the Even bridge. Everything goes through one
 * serial queue (image updates must never overlap), and work queued for a page
 * that has since been replaced is dropped.
 */
export class BridgeDisplay implements Display {
  private queue: Promise<unknown> = Promise.resolve()
  private created = false
  private generation = 0

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly log: (message: string) => void = () => {},
  ) {}

  showPage(page: PageSpec): Promise<boolean> {
    const generation = ++this.generation
    return this.enqueue(async () => {
      if (generation !== this.generation) return false // a newer page is already queued
      const payload = toContainers(page)
      if (!this.created) {
        const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
        this.created = Number(result) === 0
        if (this.created) return true
        // The host allows one startup page per session. After a WebView reload (hot reload,
        // restore) ours already exists, so creation is refused and a rebuild is the way in.
        this.created = await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload))
        if (!this.created) this.log(`createStartUpPageContainer failed (${result}) and rebuild was refused`)
        return this.created
      }
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload))
      if (!ok) this.log('rebuildPageContainer failed')
      return ok
    })
  }

  upgradeText(id: number, name: string, content: string): Promise<boolean> {
    const generation = this.generation
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.created) return false
      return this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content }))
    })
  }

  setImage(id: number, name: string, png: Uint8Array): Promise<boolean> {
    const generation = this.generation
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.created) return false
      const result = await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: Array.from(png) }),
      )
      const ok = ImageRawDataUpdateResult.isSuccess(result)
      if (!ok) this.log(`updateImageRawData ${name} failed (${result})`)
      return ok
    })
  }

  async shutDown(mode: 0 | 1): Promise<void> {
    await this.enqueue(() => this.bridge.shutDownPageContainer(mode))
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job)
    this.queue = run.catch(err => this.log(`display error: ${err instanceof Error ? err.message : String(err)}`))
    return run
  }
}

function toContainers(page: PageSpec) {
  const texts = page.texts ?? []
  const lists = page.lists ?? []
  const images = page.images ?? []
  return {
    containerTotalNum: texts.length + lists.length + images.length,
    textObject: texts.map(
      t =>
        new TextContainerProperty({
          xPosition: t.x,
          yPosition: t.y,
          width: t.w,
          height: t.h,
          borderWidth: 0,
          paddingLength: t.padding ?? 4,
          containerID: t.id,
          containerName: t.name,
          content: t.content,
          isEventCapture: t.capture ? 1 : 0,
        }),
    ),
    listObject: lists.map(
      l =>
        new ListContainerProperty({
          xPosition: l.x,
          yPosition: l.y,
          width: l.w,
          height: l.h,
          borderWidth: 0,
          paddingLength: 4,
          containerID: l.id,
          containerName: l.name,
          isEventCapture: l.capture ? 1 : 0,
          itemContainer: new ListItemContainerProperty({
            itemCount: l.items.length,
            itemWidth: 0,
            isItemSelectBorderEn: 1,
            itemName: l.items,
          }),
        }),
    ),
    imageObject: images.map(
      i =>
        new ImageContainerProperty({
          xPosition: i.x,
          yPosition: i.y,
          width: i.w,
          height: i.h,
          containerID: i.id,
          containerName: i.name,
        }),
    ),
    menuObject: new MenuContainerProperty({
      menuItems: page.menu.map(m => new MenuItemProperty({ itemName: m.label, itemID: m.id })),
    }),
  }
}
