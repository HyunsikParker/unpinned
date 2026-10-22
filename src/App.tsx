import { useCallback, useEffect, useRef, useState } from 'react'
import { analyze, cleanCopy, type Finding, type Report, type Severity, verdict } from './metadata'
import { makeSamplePhoto } from './sample'

interface Cleaned {
  url: string
  name: string
  size: number
  removed: string[]
  kept: string[]
  remaining: Finding[]
}

interface Item {
  id: number
  name: string
  size: number
  bytes: Uint8Array
  report: Report
  previewUrl: string
  thumbUrl?: string
  cleaned?: Cleaned
  error?: string
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif'

const RISK: Record<Severity | 'none', string> = { high: 'High risk', medium: 'Some risk', low: 'Low risk', none: 'Nothing to remove' }

const HEADLINE: Record<Severity | 'none', string> = {
  high: 'This photo gives away more than you can see',
  medium: 'This photo carries some hidden details',
  low: 'Only minor hidden details found',
  none: 'No hidden details found',
}

function summary(r: Report): string {
  if (r.gps) return 'Anyone who gets this file can see the exact spot where it was taken.'
  const v = verdict(r)
  if (v === 'high') return 'It contains names or device identifiers that can point back to you.'
  if (v === 'medium') return 'It contains dates, captions or hidden copies that you may not want to share.'
  if (v === 'low') return 'It names the camera or app that made it. Usually harmless, but it can be removed.'
  return 'The file has no location, names or hidden previews. You can share it as it is.'
}

function kb(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

function cleanName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}-unpinned${name.slice(dot)}` : `${name}-unpinned`
}

function blobUrl(bytes: Uint8Array, type: string): string {
  return URL.createObjectURL(new Blob([bytes.slice()], { type }))
}

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', unknown: 'application/octet-stream' } as const

export default function App() {
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [announce, setAnnounce] = useState('')
  const nextId = useRef(1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    items.forEach((it) => {
      URL.revokeObjectURL(it.previewUrl)
      if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl)
      if (it.cleaned) URL.revokeObjectURL(it.cleaned.url)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    const added: Item[] = []
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const report = analyze(bytes)
      added.push({
        id: nextId.current++,
        name: file.name,
        size: file.size,
        bytes,
        report,
        previewUrl: blobUrl(bytes, file.type || MIME[report.format]),
        thumbUrl: report.thumbnail ? blobUrl(report.thumbnail, 'image/jpeg') : undefined,
      })
    }
    setItems((prev) => [...added, ...prev])
    setBusy(false)
    const flagged = added.filter((it) => it.report.gps).length
    setAnnounce(`${added.length} photo${added.length > 1 ? 's' : ''} checked. ${flagged ? `${flagged} with an exact location.` : 'No exact location found.'}`)
  }, [])

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void addFiles(Array.from(e.dataTransfer.files))
  }

  const trySample = async () => {
    setBusy(true)
    try {
      await addFiles([await makeSamplePhoto()])
    } finally {
      setBusy(false)
    }
  }

  const clean = (id: number) => {
    setItems((prev) => prev.map((it) => {
      if (it.id !== id) return it
      try {
        const c = cleanCopy(it.bytes)
        const remaining = analyze(c.bytes).findings
        const cleaned: Cleaned = {
          url: blobUrl(c.bytes, MIME[it.report.format]),
          name: cleanName(it.name),
          size: c.bytes.length,
          removed: c.removed,
          kept: c.kept,
          remaining,
        }
        setAnnounce(remaining.length ? 'Clean copy made, but some details remain.' : 'Clean copy made and checked: nothing hidden remains.')
        return { ...it, cleaned }
      } catch {
        return { ...it, error: 'This file could not be cleaned safely. Nothing was changed.' }
      }
    }))
  }

  const remove = (id: number) => setItems((prev) => prev.filter((it) => it.id !== id))

  return (
    <div className="page">
      <header className="masthead">
        <p className="brand" aria-hidden="true"><span className="pin" />Unpinned</p>
        <h1>See what a photo reveals before you share it</h1>
        <p className="lede">
          Photos often carry an exact location, a name, a device serial number or an uncropped preview. Unpinned shows
          you what is inside and saves a copy without it. <strong>Your photos never leave this device.</strong>
        </p>
      </header>

      <main>
        <section
          className={`dropzone${dragging ? ' is-dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          aria-labelledby="drop-title"
        >
          <h2 id="drop-title">Check a photo</h2>
          <p>Drop JPEG, PNG or WebP photos here, or choose them from your device.</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => inputRef.current?.click()} disabled={busy}>
              Choose photos
            </button>
            <button type="button" className="secondary" onClick={() => void trySample()} disabled={busy}>
              Try a sample photo
            </button>
          </div>
          <input ref={inputRef} id="file-input" type="file" accept={ACCEPT} multiple onChange={onPick} hidden />
          <p className="fine">Works offline. No uploads, no accounts, no tracking.</p>
        </section>

        <p className="sr-only" aria-live="polite">{announce}</p>

        <ul className="results" aria-label="Checked photos">
          {items.map((it) => <Result key={it.id} item={it} onClean={clean} onRemove={remove} />)}
        </ul>

        <section className="explain" aria-labelledby="how-title">
          <h2 id="how-title">How it works, and what it cannot do</h2>
          <div className="cols">
            <div>
              <h3>What it checks</h3>
              <p>GPS position and altitude, owner and author names, device serial numbers, dates, captions, hidden preview
                images, Adobe XMP and IPTC fields, and data attached after the picture (such as motion-photo clips).</p>
            </div>
            <div>
              <h3>How the copy is made</h3>
              <p>The picture data is copied byte for byte; only the metadata blocks are left out, so quality does not change.
                The rotation flag and colour profile are kept. The copy is checked again before you save it.</p>
            </div>
            <div>
              <h3>Limits</h3>
              <p>It cannot see clues in the picture itself, such as a street sign, a window view or a reflection. HEIC files
                from iPhones are not supported yet: share them as JPEG ("Most Compatible") or turn off Location in the share sheet.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <p>Open source. Built for SafeSpace Hacks 2026. Runs entirely in your browser.</p>
      </footer>
    </div>
  )
}

function Result({ item, onClean, onRemove }: { item: Item; onClean: (id: number) => void; onRemove: (id: number) => void }) {
  const r = item.report
  const level = r.supported ? verdict(r) : 'unsupported'
  const titleId = `result-${item.id}`
  return (
    <li className={`result level-${level}`} aria-labelledby={titleId}>
      <div className="result-media">
        {r.supported ? <img src={item.previewUrl} alt={`Preview of ${item.name}`} /> : <div className="no-preview">No preview</div>}
        {item.thumbUrl && (
          <figure className="hidden-thumb">
            <img src={item.thumbUrl} alt="Hidden preview image stored inside the file" />
            <figcaption>Hidden preview inside the file</figcaption>
          </figure>
        )}
      </div>
      <div className="result-body">
        <p className="file-line">{item.name} · {kb(item.size)}</p>
        {r.supported ? (
          <>
            <p className="risk">{RISK[verdict(r)]}</p>
            <h3 id={titleId}>{HEADLINE[verdict(r)]}</h3>
            <p className="summary">{summary(r)}</p>
            {item.error && <p className="error" role="alert">{item.error}</p>}
            {!item.cleaned ? (
              r.findings.length > 0 && (
                <button type="button" className="primary" onClick={() => onClean(item.id)}>Make a clean copy</button>
              )
            ) : (
              <div className="cleaned" role="status">
                <p className="check">
                  {item.cleaned.remaining.length === 0
                    ? 'Clean copy checked: no location, names, serial numbers or hidden previews remain.'
                    : `Clean copy checked: ${item.cleaned.remaining.length} detail(s) remain.`}
                </p>
                <p className="fine">
                  Removed: {item.cleaned.removed.join(', ') || 'nothing'}.
                  {item.cleaned.kept.length > 0 && <> Kept: {item.cleaned.kept.join(', ')}.</>}
                  {' '}{kb(item.size)} → {kb(item.cleaned.size)}.
                </p>
                <a className="primary button-link" href={item.cleaned.url} download={item.cleaned.name}>
                  Save {item.cleaned.name}
                </a>
              </div>
            )}
            {r.findings.length > 0 && (
              <>
                <h4 className="list-title">
                  {item.cleaned ? 'What the original file contained (left out of the copy)' : 'What the file contains'}
                </h4>
                <ul className={`findings${item.cleaned ? ' is-removed' : ''}`}>
                  {r.findings.map((f) => (
                    <li key={f.id} className={`finding sev-${f.severity}`}>
                      <span className="sev" aria-label={`${f.severity} risk`}>{f.severity}</span>
                      <div>
                        <p className="f-label">{f.label}: <span className="f-value">{f.value}</span></p>
                        <p className="f-why">{f.why}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            <h3 id={titleId}>This file type can't be checked here</h3>
            <p className="summary">
              Unpinned reads JPEG, PNG and WebP. For iPhone HEIC photos, set Camera → Formats → Most Compatible, or tap
              Options in the share sheet and turn off Location before sending.
            </p>
          </>
        )}
        <button type="button" className="link" onClick={() => onRemove(item.id)}>Remove from list</button>
      </div>
    </li>
  )
}
