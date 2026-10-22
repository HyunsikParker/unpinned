// Builds small EXIF (TIFF) blocks for the bundled sample photo and for tests. Big-endian ("MM") layout:
// header, IFD0, Exif IFD, GPS IFD, IFD1 (thumbnail pointer), then the value data and the thumbnail bytes.
import { concat } from './metadata'

export interface ExifSpec {
  make?: string
  model?: string
  software?: string
  artist?: string
  orientation?: number
  dateTimeOriginal?: string
  bodySerial?: string
  gps?: { lat: number; lon: number; altitude?: number }
  thumbnail?: Uint8Array
}

type Value = { type: number; count: number; data: Uint8Array }

const enc = new TextEncoder()

function asciiValue(s: string): Value {
  const data = concat([enc.encode(s), new Uint8Array([0])])
  return { type: 2, count: data.length, data }
}

function shortValue(n: number): Value {
  return { type: 3, count: 1, data: new Uint8Array([(n >> 8) & 0xff, n & 0xff]) }
}

function longValue(n: number): Value {
  const d = new Uint8Array(4)
  new DataView(d.buffer).setUint32(0, n)
  return { type: 4, count: 1, data: d }
}

function rationalValue(nums: [number, number][]): Value {
  const d = new Uint8Array(nums.length * 8)
  const v = new DataView(d.buffer)
  nums.forEach(([n, den], i) => {
    v.setUint32(i * 8, n)
    v.setUint32(i * 8 + 4, den)
  })
  return { type: 5, count: nums.length, data: d }
}

function byteValue(n: number): Value {
  return { type: 1, count: 1, data: new Uint8Array([n]) }
}

function dmsRationals(deg: number): [number, number][] {
  const a = Math.abs(deg)
  const d = Math.floor(a)
  const mFloat = (a - d) * 60
  const m = Math.floor(mFloat)
  const s = Math.round((mFloat - m) * 60 * 10000)
  return [[d, 1], [m, 1], [s, 10000]]
}

// An IFD whose pointer entries are filled once the layout is known.
interface Ifd {
  entries: Map<number, Value>
  pointers: Map<number, () => number>
}

function ifdSize(ifd: Ifd): { table: number; data: number } {
  const all = [...ifd.entries.values()]
  const n = all.length + ifd.pointers.size
  const data = all.reduce((s, v) => s + (v.data.length > 4 ? v.data.length + (v.data.length % 2) : 0), 0)
  return { table: 2 + n * 12 + 4, data }
}

function writeIfd(out: DataView, bytes: Uint8Array, at: number, ifd: Ifd, next: number): void {
  const tags = [...new Set([...ifd.entries.keys(), ...ifd.pointers.keys()])].sort((a, b) => a - b)
  out.setUint16(at, tags.length)
  let dataAt = at + 2 + tags.length * 12 + 4
  tags.forEach((tag, i) => {
    const e = at + 2 + i * 12
    out.setUint16(e, tag)
    const ptr = ifd.pointers.get(tag)
    if (ptr) {
      out.setUint16(e + 2, 4)
      out.setUint32(e + 4, 1)
      out.setUint32(e + 8, ptr())
      return
    }
    const v = ifd.entries.get(tag)!
    out.setUint16(e + 2, v.type)
    out.setUint32(e + 4, v.count)
    if (v.data.length <= 4) bytes.set(v.data, e + 8)
    else {
      out.setUint32(e + 8, dataAt)
      bytes.set(v.data, dataAt)
      dataAt += v.data.length + (v.data.length % 2)
    }
  })
  out.setUint32(at + 2 + tags.length * 12, next)
}

export function buildExif(spec: ExifSpec): Uint8Array {
  const ifd0: Ifd = { entries: new Map(), pointers: new Map() }
  const exif: Ifd = { entries: new Map(), pointers: new Map() }
  const gps: Ifd = { entries: new Map(), pointers: new Map() }
  const ifd1: Ifd = { entries: new Map(), pointers: new Map() }
  if (spec.make) ifd0.entries.set(0x010f, asciiValue(spec.make))
  if (spec.model) ifd0.entries.set(0x0110, asciiValue(spec.model))
  if (spec.orientation) ifd0.entries.set(0x0112, shortValue(spec.orientation))
  if (spec.software) ifd0.entries.set(0x0131, asciiValue(spec.software))
  if (spec.artist) ifd0.entries.set(0x013b, asciiValue(spec.artist))
  if (spec.dateTimeOriginal) exif.entries.set(0x9003, asciiValue(spec.dateTimeOriginal))
  if (spec.bodySerial) exif.entries.set(0xa431, asciiValue(spec.bodySerial))
  if (spec.gps) {
    gps.entries.set(0x0000, { type: 1, count: 4, data: new Uint8Array([2, 3, 0, 0]) })
    gps.entries.set(0x0001, asciiValue(spec.gps.lat >= 0 ? 'N' : 'S'))
    gps.entries.set(0x0002, rationalValue(dmsRationals(spec.gps.lat)))
    gps.entries.set(0x0003, asciiValue(spec.gps.lon >= 0 ? 'E' : 'W'))
    gps.entries.set(0x0004, rationalValue(dmsRationals(spec.gps.lon)))
    if (spec.gps.altitude !== undefined) {
      gps.entries.set(0x0005, byteValue(spec.gps.altitude < 0 ? 1 : 0))
      gps.entries.set(0x0006, rationalValue([[Math.round(Math.abs(spec.gps.altitude) * 10), 10]]))
    }
  }
  const hasExif = exif.entries.size > 0
  const hasGps = gps.entries.size > 0
  const hasThumb = !!spec.thumbnail?.length

  // layout
  const order: Ifd[] = [ifd0]
  if (hasExif) order.push(exif)
  if (hasGps) order.push(gps)
  if (hasThumb) {
    ifd1.entries.set(0x0103, shortValue(6)) // JPEG compression
    ifd1.entries.set(0x0202, longValue(spec.thumbnail!.length))
    order.push(ifd1)
  }
  // pointer placeholders count as entries when sizing
  if (hasExif) ifd0.pointers.set(0x8769, () => offsets.get(exif)!)
  if (hasGps) ifd0.pointers.set(0x8825, () => offsets.get(gps)!)
  if (hasThumb) ifd1.pointers.set(0x0201, () => thumbAt)
  const offsets = new Map<Ifd, number>()
  let at = 8
  for (const ifd of order) {
    offsets.set(ifd, at)
    const s = ifdSize(ifd)
    at += s.table + s.data
  }
  const thumbAt = at
  const total = at + (spec.thumbnail?.length ?? 0)
  const bytes = new Uint8Array(total)
  const out = new DataView(bytes.buffer)
  bytes.set([0x4d, 0x4d, 0x00, 0x2a])
  out.setUint32(4, 8)
  writeIfd(out, bytes, offsets.get(ifd0)!, ifd0, hasThumb ? offsets.get(ifd1)! : 0)
  if (hasExif) writeIfd(out, bytes, offsets.get(exif)!, exif, 0)
  if (hasGps) writeIfd(out, bytes, offsets.get(gps)!, gps, 0)
  if (hasThumb) {
    writeIfd(out, bytes, offsets.get(ifd1)!, ifd1, 0)
    bytes.set(spec.thumbnail!, thumbAt)
  }
  return bytes
}

/** Insert an EXIF APP1 segment into a JPEG right after SOI (and after a JFIF APP0 when present). */
export function withExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array {
  const body = concat([enc.encode('Exif\0\0'), tiff])
  const len = body.length + 2
  if (len > 0xffff) throw new Error('EXIF block too large for one APP1 segment')
  const seg = concat([new Uint8Array([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]), body])
  let at = 2
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5])
  return concat([jpeg.subarray(0, at), seg, jpeg.subarray(at)])
}
