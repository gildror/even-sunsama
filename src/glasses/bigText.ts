/**
 * The SDK has no font sizes, so large digits are drawn on a canvas and sent as
 * an image. White on black: black is "off" (transparent) on the glasses.
 */
export async function renderBigText(text: string, width: number, height: number, align: 'left' | 'center' = 'center'): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'

  // Largest size that fits the box.
  const font = (px: number) => `700 ${px}px -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif`
  let size = height
  ctx.font = font(size)
  while (size > 12 && ctx.measureText(text).width > width - 4) {
    size -= 4
    ctx.font = font(size)
  }

  ctx.textAlign = align
  ctx.fillText(text, align === 'center' ? width / 2 : 2, height / 2 + size * 0.04)

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob returned nothing')
  return new Uint8Array(await blob.arrayBuffer())
}
