// Reads and removes the metadata that photos carry besides their pixels. Everything runs on the bytes in memory;
// nothing is sent anywhere. Supported containers: JPEG (EXIF, XMP, IPTC, comments, data after the end of the image),
// PNG (eXIf and text chunks) and WebP (EXIF and XMP chunks). Pixel data is copied byte for byte, never re-encoded.

export type Severity = 'high' | 'medium' | 'low'
export type Format = 'jpeg' | 'png' | 'webp' | 'unknown'

export interface Finding {
  id: string
  label: string
  value: string
  severity: Severity
  why: string
}

export interface Gps {
  lat: number
  lon: number
  altitude?: number
}

export interface Report {
  format: Format
  findings: Finding[]
  gps?: Gps
  orientation?: number
  thumbnail?: Uint8Array
  supported: boolean
}

export interface CleanResult {
  bytes: Uint8Array
  removed: string[]
  kept: string[]
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
// Within a severity, show where the photo was taken first, then who took it, then what links it to a device.
const FIRST = ['gps', 'xmp-gps', 'iptc-place', 'iptc-city', 'xmp-place', 'artist', 'owner', 'iptc-author', 'xmp-creator', 'copyright', 'serial']
const rank = (id: string) => (FIRST.includes(id) ? FIRST.indexOf(id) : FIRST.length)

export function detectFormat(b: Uint8Array): Format {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  return 'unknown'
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = ''
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

function startsWith(b: Uint8Array, start: number, text: string): boolean {
  if (start + text.length > b.length) return false
  for (let i = 0; i < text.length; i++) if (b[start + i] !== text.charCodeAt(i)) return false
  return true
}

// ---------------------------------------------------------------- TIFF / EXIF ----

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

interface Entry {
  tag: number
  type: number
  count: number
  offset: number // absolute offset of the value inside the TIFF block
}

class TiffReader {
  readonly view: DataView
  readonly le: boolean
  constructor(readonly b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const order = ascii(b, 0, 2)
    if (order !== 'II' && order !== 'MM') throw new Error('not TIFF')
    this.le = order === 'II'
    if (this.u16(2) !== 42) throw new Error('bad TIFF magic')
  }
  ok(off: number, n: number): boolean {
    return off >= 0 && n >= 0 && off + n <= this.b.length
  }
  u16(off: number): number {
    return this.view.getUint16(off, this.le)
  }
  u32(off: number): number {
    return this.view.getUint32(off, this.le)
  }
  ifd(off: number): { entries: Map<number, Entry>; next: number } | null {
    if (!this.ok(off, 2)) return null
    const n = this.u16(off)
    if (n > 1000 || !this.ok(off + 2, n * 12 + 4)) return null
    const entries = new Map<number, Entry>()
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12
      const tag = this.u16(e)
      const type = this.u16(e + 2)
      const count = this.u32(e + 4)
      const size = (TYPE_SIZE[type] ?? 1) * count
      const offset = size <= 4 ? e + 8 : this.u32(e + 8)
      if (size > 4 && !this.ok(offset, size)) continue
      entries.set(tag, { tag, type, count, offset })
    }
    return { entries, next: this.u32(off + 2 + n * 12) }
  }
  text(e: Entry | undefined): string | undefined {
    if (!e) return undefined
    const bytes = this.b.subarray(e.offset, e.offset + e.count)
    if (e.type === 1 && e.count % 2 === 0) {
      // Windows XP* tags store UTF-16LE in a BYTE array.
      let s = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      return clean(s)
    }
    if (e.type === 7 && startsWith(bytes, 0, 'ASCII\0\0\0')) return clean(ascii(bytes, 8, bytes.length - 8))
    return clean(ascii(bytes, 0, bytes.length))
  }
  short(e: Entry | undefined): number | undefined {
    if (!e) return undefined
    return e.type === 4 ? this.u32(e.offset) : this.u16(e.offset)
  }
  long(e: Entry | undefined): number | undefined {
    if (!e) return undefined
    return e.type === 3 ? this.u16(e.offset) : this.u32(e.offset)
  }
  rationals(e: Entry | undefined): number[] | undefined {
    if (!e || (e.type !== 5 && e.type !== 10)) return undefined
    const out: number[] = []
    for (let i = 0; i < e.count; i++) {
      const o = e.offset + i * 8
      const num = e.type === 10 ? this.view.getInt32(o, this.le) : this.u32(o)
      const den = e.type === 10 ? this.view.getInt32(o + 4, this.le) : this.u32(o + 4)
      out.push(den === 0 ? 0 : num / den)
    }
    return out
  }
}

function clean(s: string): string | undefined {
  const t = s.replace(/\0+$/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim()
  return t.length ? t : undefined
}

function dms(v: number[] | undefined, ref: string | undefined, negative: string): number | undefined {
  if (!v || v.length < 1) return undefined
  const deg = v[0] + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600
  if (!Number.isFinite(deg)) return undefined
  return ref && ref.toUpperCase().startsWith(negative) ? -deg : deg
}

export function formatCoordinate(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lon).toFixed(5)}° ${ew}`
}

interface ExifInfo {
  findings: Finding[]
  gps?: Gps
  orientation?: number
  thumbnail?: Uint8Array
}

export function readExif(tiffBytes: Uint8Array, where: string): ExifInfo {
  const out: ExifInfo = { findings: [] }
  let t: TiffReader
  try {
    t = new TiffReader(tiffBytes)
  } catch {
    out.findings.push(f('exif-unreadable', 'Unreadable camera data', where, 'medium',
      'The file has a camera-data block this tool cannot read. The clean copy removes it anyway.'))
    return out
  }
  const ifd0 = t.ifd(t.u32(4))
  if (!ifd0) return out
  const e0 = ifd0.entries
  const add = (id: string, label: string, value: string | undefined, severity: Severity, why: string) => {
    if (value) out.findings.push(f(id, label, value, severity, why))
  }
  out.orientation = t.short(e0.get(0x0112))
  add('make-model', 'Camera or phone model', [t.text(e0.get(0x010f)), t.text(e0.get(0x0110))].filter(Boolean).join(' ') || undefined,
    'low', 'Narrows down who took the photo when combined with other posts.')
  add('software', 'Editing software', t.text(e0.get(0x0131)), 'low', 'Shows which app or device version produced the file.')
  add('artist', 'Name of the owner or author', t.text(e0.get(0x013b)) ?? t.text(e0.get(0x9c9d)), 'high',
    'A name stored inside the file identifies you even when the post is anonymous.')
  add('copyright', 'Copyright holder', t.text(e0.get(0x8298)), 'high', 'Often contains a real name or company.')
  add('description', 'Caption or comment', t.text(e0.get(0x010e)) ?? t.text(e0.get(0x9c9c)), 'medium',
    'Captions can contain names, addresses or notes you did not mean to share.')
  const modified = t.text(e0.get(0x0132))

  const exifPtr = t.long(e0.get(0x8769))
  if (exifPtr !== undefined) {
    const ex = t.ifd(exifPtr)?.entries
    if (ex) {
      const taken = t.text(ex.get(0x9003)) ?? t.text(ex.get(0x9004)) ?? modified
      add('taken', 'Date and time taken', taken, 'medium', 'Reveals when you were at the place shown in the photo.')
      add('owner', 'Camera owner name', t.text(ex.get(0xa430)), 'high', 'Some cameras store the owner’s name in every photo.')
      add('serial', 'Device serial number', t.text(ex.get(0xa431)) ?? t.text(ex.get(0xa435)), 'high',
        'A serial number links every photo from the same device, across accounts and sites.')
      add('unique-id', 'Unique photo ID', t.text(ex.get(0xa420)), 'medium', 'Lets the same picture be matched across platforms.')
      add('user-comment', 'Hidden comment', t.text(ex.get(0x9286)), 'medium', 'Free text that may contain personal notes.')
      if (ex.has(0x927c)) {
        out.findings.push(f('makernote', 'Manufacturer data block', 'present', 'low',
          'Vendor-specific data that can include serial numbers or settings.'))
      }
    }
  } else if (modified) {
    add('taken', 'Date and time', modified, 'medium', 'Reveals when the photo was made or edited.')
  }

  const gpsPtr = t.long(e0.get(0x8825))
  if (gpsPtr !== undefined) {
    const g = t.ifd(gpsPtr)?.entries
    if (g) {
      const lat = dms(t.rationals(g.get(0x0002)), t.text(g.get(0x0001)), 'S')
      const lon = dms(t.rationals(g.get(0x0004)), t.text(g.get(0x0003)), 'W')
      if (lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0)) {
        const altRaw = t.rationals(g.get(0x0006))?.[0]
        const altRef = g.get(0x0005) ? t.b[g.get(0x0005)!.offset] : 0
        const altitude = altRaw === undefined ? undefined : altRef === 1 ? -altRaw : altRaw
        out.gps = { lat, lon, altitude }
        out.findings.push(f('gps', 'Exact location (GPS)', formatCoordinate(lat, lon), 'high',
          'Anyone who downloads the photo can open these coordinates on a map: often your home, school or workplace.'))
        if (altitude !== undefined) {
          out.findings.push(f('altitude', 'Altitude', `${altitude.toFixed(1)} m`, 'medium',
            'Can reveal which floor of a building you were on.'))
        }
      } else if (g.size > 1) {
        out.findings.push(f('gps-partial', 'Location fields (incomplete)', `${g.size} fields`, 'medium',
          'The file has GPS fields even though no full position could be read.'))
      }
      const date = t.text(g.get(0x001d))
      if (date) out.findings.push(f('gps-time', 'Satellite time stamp', date, 'low', 'An exact timestamp from the GPS receiver.'))
    }
  }

  if (ifd0.next) {
    const ifd1 = t.ifd(ifd0.next)?.entries
    const start = t.long(ifd1?.get(0x0201))
    const length = t.long(ifd1?.get(0x0202))
    if (start !== undefined && length !== undefined && length > 0 && t.ok(start, length)) {
      out.thumbnail = tiffBytes.slice(start, start + length)
      out.findings.push(f('thumbnail', 'Hidden preview image', `${Math.round(length / 1024) || 1} KB`, 'medium',
        'A small copy of the photo is stored inside the file. Some apps leave the uncropped original here after you crop.'))
    }
  }
  return out
}

function f(id: string, label: string, value: string, severity: Severity, why: string): Finding {
  return { id, label, value, severity, why }
}

// ---------------------------------------------------------------- XMP / IPTC ----

const XMP_FIELDS: [RegExp, string, string, Severity, string][] = [
  [/(?:exif:)?GPSLatitude[=>"\s]+["']?([0-9.,]+\s*[NSns]?)/, 'xmp-gps', 'Location in XMP data', 'high',
    'A second copy of the GPS position, stored in the Adobe XMP block.'],
  [/(?:photoshop:City|Iptc4xmpCore:Location|photoshop:State)[=>"\s]+["']?([^"'<]{2,80})/, 'xmp-place', 'Place name', 'high',
    'City or place names point to where the photo was taken.'],
  [/dc:creator[\s\S]{0,200}?<rdf:li[^>]*>([^<]{1,80})</, 'xmp-creator', 'Author name (XMP)', 'high',
    'An author name stored by the editing app.'],
  [/xmp:CreatorTool[=>"\s]+["']?([^"'<]{2,80})/, 'xmp-tool', 'Editing app (XMP)', 'low',
    'Names the app that last saved the photo.'],
  [/(?:xmpMM:History|stEvt:)/, 'xmp-history', 'Edit history', 'low', 'A log of edits, sometimes with original file names.'],
]

export function readXmp(text: string): Finding[] {
  const out: Finding[] = []
  for (const [re, id, label, sev, why] of XMP_FIELDS) {
    const m = re.exec(text)
    if (m) out.push(f(id, label, (m[1] ?? 'present').trim(), sev, why))
  }
  if (!out.length) out.push(f('xmp', 'Adobe XMP data', 'present', 'low', 'Editing metadata that can include names or places.'))
  return out
}

function readIptc(b: Uint8Array): Finding[] {
  // Photoshop "8BIM" resources; IPTC dataset 2:80 by-line, 2:90 city, 2:92 sublocation, 2:101 country, 2:120 caption.
  const out: Finding[] = []
  const wanted: Record<number, [string, string, Severity, string]> = {
    80: ['iptc-author', 'Author name (IPTC)', 'high', 'A photographer or owner name.'],
    90: ['iptc-city', 'City (IPTC)', 'high', 'Where the photo was taken.'],
    92: ['iptc-place', 'Sublocation (IPTC)', 'high', 'A street, venue or neighbourhood.'],
    101: ['iptc-country', 'Country (IPTC)', 'medium', 'The country where the photo was taken.'],
    120: ['iptc-caption', 'Caption (IPTC)', 'medium', 'Captions can contain names or addresses.'],
  }
  for (let i = 0; i + 5 < b.length; i++) {
    if (b[i] === 0x1c && b[i + 1] === 2) {
      const ds = b[i + 2]
      const len = (b[i + 3] << 8) | b[i + 4]
      if (wanted[ds] && i + 5 + len <= b.length) {
        const [id, label, sev, why] = wanted[ds]
        const v = clean(new TextDecoder().decode(b.subarray(i + 5, i + 5 + len)))
        if (v && !out.some((x) => x.id === id)) out.push(f(id, label, v, sev, why))
        i += 4 + len
      }
    }
  }
  if (!out.length) out.push(f('iptc', 'Photoshop/IPTC data', 'present', 'low', 'Publishing metadata that can include names or places.'))
  return out
}

// ---------------------------------------------------------------- JPEG ----

interface Segment {
  marker: number
  start: number // index of the 0xFF
  end: number // index after the segment (for SOS: after the entropy-coded data)
}

function jpegSegments(b: Uint8Array): { segments: Segment[]; eoi: number } {
  const segments: Segment[] = []
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`)
    let marker = b[i + 1]
    while (marker === 0xff && i + 2 < b.length) {
      i++ // fill bytes
      marker = b[i + 1]
    }
    if (marker === 0xd9) return { segments, eoi: i + 2 }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segments.push({ marker, start: i, end: i + 2 })
      i += 2
      continue
    }
    if (i + 3 >= b.length) break
    const len = (b[i + 2] << 8) | b[i + 3]
    let end = i + 2 + len
    if (marker === 0xda) {
      // entropy-coded data runs until the next marker that is not a stuffed 0x00 or a restart marker
      let j = end
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++
      end = j
    }
    segments.push({ marker, start: i, end: Math.min(end, b.length) })
    i = end
  }
  return { segments, eoi: b.length }
}

function payload(b: Uint8Array, s: Segment): Uint8Array {
  return b.subarray(s.start + 4, s.end)
}

function readJpeg(b: Uint8Array): Report {
  const r: Report = { format: 'jpeg', findings: [], supported: true }
  const { segments, eoi } = jpegSegments(b)
  for (const s of segments) {
    const p = payload(b, s)
    if (s.marker === 0xe1 && startsWith(p, 0, 'Exif\0\0')) {
      const info = readExif(p.subarray(6), 'EXIF')
      r.findings.push(...info.findings)
      r.gps ??= info.gps
      r.orientation ??= info.orientation
      r.thumbnail ??= info.thumbnail
    } else if (s.marker === 0xe1 && startsWith(p, 0, 'http://ns.adobe.com/')) {
      r.findings.push(...readXmp(new TextDecoder().decode(p)))
    } else if (s.marker === 0xed) {
      r.findings.push(...readIptc(p))
    } else if (s.marker === 0xfe) {
      const v = clean(new TextDecoder().decode(p))
      if (v) r.findings.push(f('comment', 'File comment', v.slice(0, 120), 'medium', 'Free text stored in the file.'))
    } else if (s.marker === 0xe0 && startsWith(p, 0, 'JFXX')) {
      r.findings.push(f('jfxx-thumb', 'Hidden preview image (JFIF)', 'present', 'medium', 'A second small copy of the photo.'))
    } else if (s.marker === 0xe2 && startsWith(p, 0, 'MPF\0')) {
      r.findings.push(f('mpf', 'Extra images (multi-picture)', 'present', 'medium',
        'Additional pictures packed in the same file, each with its own metadata.'))
    } else if (s.marker >= 0xe3 && s.marker <= 0xef && s.marker !== 0xed && s.marker !== 0xee) {
      r.findings.push(f(`app${s.marker - 0xe0}`, `Vendor data block (APP${s.marker - 0xe0})`, 'present', 'low',
        'Manufacturer-specific data with unknown contents.'))
    }
  }
  if (eoi < b.length - 2) {
    r.findings.push(f('trailer', 'Hidden data after the image', `${Math.round((b.length - eoi) / 1024)} KB`, 'medium',
      'Some phones attach a short video (motion photo) or extra data after the picture. It can carry its own location.'))
  }
  return r
}

function minimalOrientationApp1(orientation: number): Uint8Array {
  // "Exif\0\0" + big-endian TIFF header + IFD0 with a single Orientation entry and no next IFD.
  const tiff = new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, (orientation >> 8) & 0xff, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ])
  const body = concat([new TextEncoder().encode('Exif\0\0'), tiff])
  const len = body.length + 2
  return concat([new Uint8Array([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]), body])
}

function cleanJpeg(b: Uint8Array, orientation: number | undefined): CleanResult {
  const { segments, eoi } = jpegSegments(b)
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  const removed = new Set<string>()
  const kept = new Set<string>()
  let insertedOrientation = false
  const insertOrientation = () => {
    if (!insertedOrientation && orientation && orientation !== 1) {
      parts.push(minimalOrientationApp1(orientation))
      kept.add('image orientation')
    }
    insertedOrientation = true
  }
  segments.forEach((s, idx) => {
    const p = payload(b, s)
    const m = s.marker
    let keep = true
    let what = ''
    if (m === 0xe0) {
      keep = startsWith(p, 0, 'JFIF\0')
      what = 'JFIF preview image'
    } else if (m === 0xe1) {
      keep = false
      what = startsWith(p, 0, 'Exif') ? 'EXIF camera data' : 'XMP data'
    } else if (m === 0xe2) {
      keep = startsWith(p, 0, 'ICC_PROFILE\0')
      what = startsWith(p, 0, 'MPF') ? 'extra pictures (MPF)' : 'APP2 data'
      if (keep) kept.add('colour profile')
    } else if (m === 0xee) {
      keep = true // Adobe colour-transform flag, needed to decode some files correctly
    } else if (m >= 0xe3 && m <= 0xef) {
      keep = false
      what = m === 0xed ? 'Photoshop/IPTC data' : `vendor block APP${m - 0xe0}`
    } else if (m === 0xfe) {
      keep = false
      what = 'file comment'
    }
    if (m === 0xe0 && keep) {
      parts.push(b.subarray(s.start, s.end))
      return
    }
    // put the orientation record right after SOI/JFIF, before any other segment
    insertOrientation()
    if (keep) parts.push(b.subarray(s.start, s.end))
    else removed.add(what)
    void idx
  })
  insertOrientation()
  parts.push(new Uint8Array([0xff, 0xd9]))
  if (eoi < b.length - 2) removed.add('data after the image')
  return { bytes: concat(parts), removed: [...removed].filter(Boolean), kept: [...kept] }
}

// ---------------------------------------------------------------- PNG ----

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'])

function pngChunks(b: Uint8Array): { type: string; start: number; end: number; data: Uint8Array }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = []
  let i = 8
  while (i + 12 <= b.length) {
    const len = v.getUint32(i)
    const type = ascii(b, i + 4, 4)
    const end = i + 12 + len
    if (end > b.length) break
    out.push({ type, start: i, end, data: b.subarray(i + 8, i + 8 + len) })
    i = end
    if (type === 'IEND') break
  }
  return out
}

function readPng(b: Uint8Array): Report {
  const r: Report = { format: 'png', findings: [], supported: true }
  for (const c of pngChunks(b)) {
    if (c.type === 'eXIf') {
      const info = readExif(c.data, 'eXIf')
      r.findings.push(...info.findings)
      r.gps ??= info.gps
      r.orientation ??= info.orientation
    } else if (c.type === 'iTXt' && startsWith(c.data, 0, 'XML:com.adobe.xmp')) {
      r.findings.push(...readXmp(new TextDecoder().decode(c.data)))
    } else if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
      const key = clean(ascii(c.data, 0, Math.min(79, c.data.indexOf(0) >= 0 ? c.data.indexOf(0) : 79))) ?? 'text'
      const value = c.type === 'tEXt' ? clean(ascii(c.data, key.length + 1, c.data.length - key.length - 1)) : 'compressed or international text'
      r.findings.push(f(`png-text-${key}`, `Text field “${key}”`, (value ?? '').slice(0, 120) || 'present', 'medium',
        'Text chunks can hold names, software or locations.'))
    } else if (c.type === 'tIME') {
      r.findings.push(f('png-time', 'Last-modified time', 'present', 'low', 'When the image was last saved.'))
    }
  }
  return r
}

function cleanPng(b: Uint8Array): CleanResult {
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  const removed = new Set<string>()
  for (const c of pngChunks(b)) {
    if (PNG_DROP.has(c.type)) removed.add(c.type === 'eXIf' ? 'EXIF camera data' : c.type === 'tIME' ? 'save time' : 'text fields')
    else parts.push(b.subarray(c.start, c.end))
  }
  return { bytes: concat(parts), removed: [...removed], kept: [] }
}

// ---------------------------------------------------------------- WebP ----

function riffChunks(b: Uint8Array): { type: string; start: number; end: number; data: Uint8Array }[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = []
  let i = 12
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4)
    const len = v.getUint32(i + 4, true)
    const end = i + 8 + len + (len % 2)
    if (i + 8 + len > b.length) break
    out.push({ type, start: i, end: Math.min(end, b.length), data: b.subarray(i + 8, i + 8 + len) })
    i = end
  }
  return out
}

function readWebp(b: Uint8Array): Report {
  const r: Report = { format: 'webp', findings: [], supported: true }
  for (const c of riffChunks(b)) {
    if (c.type === 'EXIF') {
      const tiff = startsWith(c.data, 0, 'Exif\0\0') ? c.data.subarray(6) : c.data
      const info = readExif(tiff, 'EXIF')
      r.findings.push(...info.findings)
      r.gps ??= info.gps
      r.orientation ??= info.orientation
    } else if (c.type === 'XMP ') {
      r.findings.push(...readXmp(new TextDecoder().decode(c.data)))
    }
  }
  return r
}

function cleanWebp(b: Uint8Array): CleanResult {
  const parts: Uint8Array[] = []
  const removed = new Set<string>()
  for (const c of riffChunks(b)) {
    if (c.type === 'EXIF' || c.type === 'XMP ') {
      removed.add(c.type === 'EXIF' ? 'EXIF camera data' : 'XMP data')
      continue
    }
    if (c.type === 'VP8X') {
      const copy = b.slice(c.start, c.end)
      copy[8] &= ~(0x08 | 0x04) // clear the EXIF and XMP flags
      parts.push(copy)
    } else parts.push(b.subarray(c.start, c.end))
  }
  const body = concat(parts)
  const header = new Uint8Array(12)
  header.set(b.subarray(0, 12))
  new DataView(header.buffer).setUint32(4, body.length + 4, true)
  return { bytes: concat([header, body]), removed: [...removed], kept: [] }
}

// ---------------------------------------------------------------- public API ----

export function analyze(b: Uint8Array): Report {
  const format = detectFormat(b)
  let r: Report
  try {
    if (format === 'jpeg') r = readJpeg(b)
    else if (format === 'png') r = readPng(b)
    else if (format === 'webp') r = readWebp(b)
    else return { format, findings: [], supported: false }
  } catch {
    return { format, findings: [f('damaged', 'File structure could not be read', format, 'medium',
      'The file may be damaged or use a variant this tool does not handle.')], supported: false }
  }
  r.findings = dedupe(r.findings).sort((a, z) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[z.severity] || rank(a.id) - rank(z.id))
  return r
}

function dedupe(list: Finding[]): Finding[] {
  const seen = new Set<string>()
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

export function cleanCopy(b: Uint8Array): CleanResult {
  const format = detectFormat(b)
  if (format === 'jpeg') return cleanJpeg(b, analyze(b).orientation)
  if (format === 'png') return cleanPng(b)
  if (format === 'webp') return cleanWebp(b)
  throw new Error('unsupported format')
}

export function verdict(r: Report): Severity | 'none' {
  if (!r.findings.length) return 'none'
  return r.findings[0].severity
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
