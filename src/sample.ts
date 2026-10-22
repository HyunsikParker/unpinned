// Builds the bundled sample photo in the browser: a living room with a sofa for sale. The visible photo is cropped to
// the sofa, but the hidden EXIF preview keeps the uncropped scene, where a street sign shows through the window. The
// EXIF also carries a synthetic GPS point (the Eiffel Tower, not anyone's home), a fake owner name and a serial number.
import { buildExif, withExif } from './exifWriter'

function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#efe6d8' // wall
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#c9b79c' // floor
  ctx.fillRect(0, h * 0.72, w, h * 0.28)
  // window on the left with a street sign outside
  ctx.fillStyle = '#9fc4e0'
  ctx.fillRect(w * 0.05, h * 0.12, w * 0.28, h * 0.38)
  ctx.fillStyle = '#2f6e3f'
  ctx.fillRect(w * 0.07, h * 0.22, w * 0.24, h * 0.11)
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.round(h * 0.042)}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText('14 Sample Lane', w * 0.085, h * 0.275, w * 0.21)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(2, w * 0.006)
  ctx.strokeRect(w * 0.05, h * 0.12, w * 0.28, h * 0.38)
  // sofa on the right
  ctx.fillStyle = '#4b6c8f'
  ctx.fillRect(w * 0.45, h * 0.42, w * 0.48, h * 0.3)
  ctx.fillStyle = '#3d5a78'
  ctx.fillRect(w * 0.45, h * 0.34, w * 0.48, h * 0.12)
  ctx.fillRect(w * 0.42, h * 0.4, w * 0.06, h * 0.3)
  ctx.fillRect(w * 0.9, h * 0.4, w * 0.06, h * 0.3)
  ctx.fillStyle = '#e8b04b'
  ctx.fillRect(w * 0.55, h * 0.46, w * 0.1, h * 0.1)
}

async function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), 'image/jpeg', quality))
  return new Uint8Array(await blob.arrayBuffer())
}

export async function makeSamplePhoto(): Promise<File> {
  const W = 1200
  const H = 800
  const full = document.createElement('canvas')
  full.width = W
  full.height = H
  drawScene(full.getContext('2d')!, W, H)

  // hidden preview: the whole uncropped scene, small
  const thumb = document.createElement('canvas')
  thumb.width = 192
  thumb.height = 128
  thumb.getContext('2d')!.drawImage(full, 0, 0, 192, 128)
  const thumbBytes = await canvasJpeg(thumb, 0.75)

  // visible photo: cropped to the sofa
  const crop = document.createElement('canvas')
  crop.width = 720
  crop.height = 480
  crop.getContext('2d')!.drawImage(full, W * 0.38, H * 0.25, W * 0.6, H * 0.6, 0, 0, 720, 480)
  const main = await canvasJpeg(crop, 0.88)

  const exif = buildExif({
    make: 'Example Phone Co.',
    model: 'Sample X1',
    software: 'Photos 1.0 (crop)',
    artist: 'Sam Sample',
    orientation: 1,
    dateTimeOriginal: '2026:10:18 14:32:05',
    bodySerial: 'SN-0000-DEMO',
    gps: { lat: 48.85837, lon: 2.29448, altitude: 35 },
    thumbnail: thumbBytes,
  })
  const bytes = withExif(main, exif)
  return new File([bytes.slice()], 'sofa-for-sale.jpg', { type: 'image/jpeg' })
}
