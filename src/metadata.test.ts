import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildExif, withExif } from './exifWriter'
import { bytes, jpegWithEverything, plainJpeg, pngWithExif, webpWithExif } from './fixtures'
import { analyze, cleanCopy, detectFormat, verdict } from './metadata'

const ids = (b: Uint8Array) => analyze(b).findings.map((f) => f.id)

function scanData(b: Uint8Array): Uint8Array {
  // bytes from the main image's first SOS marker onwards: the compressed pixels, which cleaning must not touch.
  // Walk segment lengths so that an SOS inside an embedded EXIF thumbnail is skipped.
  let i = 2
  while (i + 3 < b.length && b[i] === 0xff) {
    if (b[i + 1] === 0xda) return b.subarray(i)
    i += 2 + ((b[i + 2] << 8) | b[i + 3])
  }
  throw new Error('no SOS')
}

function exiftoolJson(b: Uint8Array, ext: string): Record<string, unknown> | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'unpinned-'))
    const p = join(dir, `x.${ext}`)
    writeFileSync(p, b)
    return JSON.parse(execFileSync('exiftool', ['-json', '-a', '-G1', p]).toString())[0]
  } catch {
    return null // exiftool not installed: the cross-check is skipped
  }
}

describe('JPEG with every kind of hidden data (written by exiftool)', () => {
  const jpg = bytes(jpegWithEverything)

  it('finds the location, names, serial, preview, XMP/IPTC places and the trailer', () => {
    const r = analyze(jpg)
    expect(r.format).toBe('jpeg')
    expect(r.gps?.lat).toBeCloseTo(48.85837, 4)
    expect(r.gps?.lon).toBeCloseTo(2.29448, 4)
    expect(r.gps?.altitude).toBeCloseTo(35, 1)
    expect(r.orientation).toBe(6)
    expect(r.thumbnail?.length).toBeGreaterThan(100)
    const found = ids(jpg)
    for (const id of ['gps', 'artist', 'serial', 'taken', 'make-model', 'thumbnail', 'xmp-place', 'iptc-author', 'comment', 'trailer']) {
      expect(found).toContain(id)
    }
    expect(verdict(r)).toBe('high')
    expect(r.findings[0].severity).toBe('high')
  })

  it('cleans losslessly: no findings left, pixels untouched, orientation kept', () => {
    const c = cleanCopy(jpg)
    const after = analyze(c.bytes)
    expect(after.findings).toEqual([])
    expect(after.orientation).toBe(6)
    expect(detectFormat(c.bytes)).toBe('jpeg')
    const before = scanData(jpg)
    const kept = scanData(c.bytes)
    // the original has 22 trailer bytes after EOI; everything up to and including EOI must be identical
    expect(kept).toEqual(before.subarray(0, kept.length))
    expect(c.removed).toEqual(expect.arrayContaining(['EXIF camera data', 'XMP data', 'Photoshop/IPTC data', 'file comment', 'data after the image']))
    expect(c.kept).toContain('image orientation')
    expect(c.bytes.length).toBeLessThan(jpg.length)
  })

  it('exiftool agrees that the clean copy has no location, names or serials', () => {
    const tags = exiftoolJson(cleanCopy(jpg).bytes, 'jpg')
    if (!tags) return
    const keys = Object.keys(tags).join(' ')
    expect(keys).not.toMatch(/GPS|Artist|SerialNumber|By-line|City|Comment|ThumbnailImage|DateTimeOriginal/)
    expect(tags['IFD0:Orientation']).toMatch(/Rotate 90/)
    const original = exiftoolJson(jpg, 'jpg')!
    expect(Object.keys(original).join(' ')).toMatch(/GPSLatitude/)
  })
})

describe('PNG and WebP', () => {
  it('reads and removes PNG eXIf and text chunks', () => {
    const png = bytes(pngWithExif)
    const r = analyze(png)
    expect(r.format).toBe('png')
    expect(r.gps?.lat).toBeCloseTo(48.85837, 4)
    expect(ids(png).some((id) => id.startsWith('png-text'))).toBe(true)
    const c = cleanCopy(png)
    expect(analyze(c.bytes).findings).toEqual([])
    const tags = exiftoolJson(c.bytes, 'png')
    if (tags) expect(Object.keys(tags).join(' ')).not.toMatch(/GPS|Author/)
  })

  it('reads and removes WebP EXIF and XMP chunks and fixes the RIFF size', () => {
    const webp = bytes(webpWithExif)
    const r = analyze(webp)
    expect(r.format).toBe('webp')
    expect(r.gps?.lon).toBeCloseTo(2.29448, 4)
    expect(ids(webp)).toContain('xmp-creator')
    const c = cleanCopy(webp)
    expect(analyze(c.bytes).findings).toEqual([])
    const riffSize = new DataView(c.bytes.buffer, c.bytes.byteOffset).getUint32(4, true)
    expect(riffSize).toBe(c.bytes.length - 8)
    const tags = exiftoolJson(c.bytes, 'webp')
    if (tags) expect(Object.keys(tags).join(' ')).not.toMatch(/GPS|Creator/)
  })
})

describe('edge cases', () => {
  it('reports nothing for a plain photo and leaves its bytes intact apart from metadata', () => {
    const plain = bytes(plainJpeg)
    expect(analyze(plain).findings).toEqual([])
    expect(verdict(analyze(plain))).toBe('none')
    expect(scanData(cleanCopy(plain).bytes)).toEqual(scanData(plain))
  })

  it('round-trips EXIF written by our own writer, including a hidden preview', () => {
    const tiff = buildExif({ make: 'Example', model: 'X', orientation: 3, gps: { lat: -33.8568, lon: 151.2153, altitude: 12 },
      artist: 'Someone', bodySerial: 'ABC123', dateTimeOriginal: '2026:01:02 03:04:05', thumbnail: bytes(plainJpeg) })
    const jpg = withExif(bytes(plainJpeg), tiff)
    const r = analyze(jpg)
    expect(r.gps?.lat).toBeCloseTo(-33.8568, 4)
    expect(r.gps?.lon).toBeCloseTo(151.2153, 4)
    expect(r.orientation).toBe(3)
    expect(r.thumbnail).toEqual(bytes(plainJpeg))
    expect(ids(jpg)).toEqual(expect.arrayContaining(['gps', 'artist', 'serial', 'taken', 'thumbnail']))
    expect(analyze(cleanCopy(jpg).bytes).orientation).toBe(3)
  })

  it('does not crash on truncated or unknown files', () => {
    const jpg = bytes(jpegWithEverything)
    expect(() => analyze(jpg.subarray(0, 300))).not.toThrow()
    expect(analyze(new Uint8Array([1, 2, 3])).supported).toBe(false)
    expect(analyze(new TextEncoder().encode('ftypheic not supported')).format).toBe('unknown')
  })
})
