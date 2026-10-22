// Records the narrated walkthrough: node scripts/demo.mjs https://hyunsikparker.github.io/unpinned/ OUT_DIR
// then, from the Bounty tools: calibrate.py OUT_DIR/timeline.json --visual 2,3,4 and compose.py OUT_DIR/timeline.json OUT.mp4
// The findings the narration names are checked against the page as it records; the run stops if one is missing.
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [url, out] = process.argv.slice(2)
const TTS = '/Volumes/Crucial X9/workstation/Bounty/tts-narration/bin/bounty-tts'
mkdirSync(join(out, 'rec'), { recursive: true })

const expectText = async (page, sel, want) => {
  const got = (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ')
  if (!got.includes(want)) throw new Error(`narration check failed: ${sel} lacks "${want}"`)
}
const center = (page, loc) => loc.first().evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
const card = (page) => page.getByRole('listitem').filter({ hasText: 'sofa-for-sale.jpg' })

const scenes = [
  {
    text: 'Unpinned shows what a photo gives away before you share it, and makes a clean copy, all inside your browser. Nothing is uploaded, and it works offline.',
    run: async (page) => { await page.waitForTimeout(500) },
  },
  {
    text: 'This made-up sample is a photo for a sofa sale. Unpinned finds the exact spot where it was taken, the owner\'s name, the phone\'s serial number, the time, the altitude, and a hidden preview image.',
    run: async (page) => {
      await page.getByRole('button', { name: 'Try a sample photo' }).click()
      await card(page).getByRole('heading', { level: 3 }).waitFor()
      for (const want of ['Exact location (GPS): 48.85837° N, 2.29448° E', 'Name of the owner or author: Sam Sample', 'Device serial number: SN-0000-DEMO',
        'Date and time taken', 'Altitude: 35.0 m', 'Hidden preview image: 2 KB']) await expectText(page, '.results', want)
    },
  },
  {
    text: 'Each finding says what it reveals. The coordinates often point to a home, a school or a workplace, and a serial number links every photo taken with the same device.',
    run: async (page) => {
      await center(page, card(page).getByText('Device serial number:'))
    },
  },
  {
    text: 'Make a clean copy keeps the picture data byte for byte and leaves the metadata out, so the quality does not change. Then the copy is checked again: no location, names, serial numbers or hidden previews remain.',
    run: async (page) => {
      await center(page, card(page).getByRole('heading', { level: 3 }))
      await page.waitForTimeout(1500)
      await card(page).getByRole('button', { name: 'Make a clean copy' }).click()
      await expectText(page, '.results', 'Clean copy checked: no location, names, serial numbers or hidden previews remain.')
      await expectText(page, '.results', '8 KB → 5 KB')
    },
  },
  {
    text: 'Save the copy, and share that one instead. Unpinned cannot see clues in the picture itself, such as a street sign or a reflection, and the page says so.',
    run: async (page) => {
      await card(page).getByRole('link', { name: 'Save sofa-for-sale-unpinned.jpg' }).click()
      await page.waitForTimeout(3500)
      const limits = page.getByText('It cannot see clues in the picture itself, such as a street sign, a window view or a reflection.')
      await center(page, limits)
    },
  },
]

// 1. Narration, one WAV per scene, reused while the scene text is unchanged.
scenes.forEach((s, k) => {
  s.wav = `s${k + 1}.wav`
  const receiptPath = join(out, `s${k + 1}.json`)
  const textPath = join(out, `s${k + 1}.txt`)
  const cached = existsSync(receiptPath) && existsSync(textPath) && readFileSync(textPath, 'utf8') === s.text
  if (!cached) {
    // The runtime logs model loading before the receipt; the receipt is the last top-level JSON object.
    const stdout = execFileSync(TTS, ['--text', s.text, '--output', join(out, s.wav)], { encoding: 'utf8' })
    writeFileSync(receiptPath, stdout.slice(stdout.startsWith('{') ? 0 : stdout.lastIndexOf('\n{') + 1))
    writeFileSync(textPath, s.text)
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  s.duration = receipt.duration_seconds
  if (!(s.duration > 0)) throw new Error(`scene ${k + 1}: no duration in the TTS receipt`)
  console.log(`scene ${k + 1}: ${s.duration}s`)
})

// 2. Record a clean run paced by the narration.
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  bypassCSP: true,
  acceptDownloads: true,
  recordVideo: { dir: join(out, 'rec'), size: { width: 1280, height: 800 } },
})
await context.addInitScript(() => {
  // Repaint a 2-pixel element every frame so the screencast keeps emitting frames on static scenes.
  const tick = () => {
    let el = document.getElementById('__keep_paint')
    if (!el && document.body) {
      el = document.createElement('div')
      el.id = '__keep_paint'
      Object.assign(el.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', pointerEvents: 'none', zIndex: '2147483647' })
      document.body.appendChild(el)
    }
    if (el) el.style.opacity = el.style.opacity === '0.01' ? '0.02' : '0.01'
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const page = await context.newPage()
const v0 = Date.now()
await page.goto(url)
await page.evaluate(() => localStorage.clear())
await page.goto(url)
await page.getByRole('button', { name: 'Try a sample photo' }).waitFor()
await page.addStyleTag({ content: 'html { scroll-behavior: smooth; }' })
await page.waitForTimeout(400)
const t0 = Date.now()
const timeline = { video: 'rec.webm', trim_start_ms: t0 - v0, scenes: [] }
for (const s of scenes) {
  const start = Date.now() - t0
  timeline.scenes.push({ start_ms: start + 400, wav: s.wav, text: s.text, caption: s.caption, duration_s: s.duration })
  await page.waitForTimeout(400)
  await s.run(page)
  const left = start + 400 + s.duration * 1000 + 600 - (Date.now() - t0)
  if (left > 0) await page.waitForTimeout(left)
}
await page.waitForTimeout(900)
await context.close()
await browser.close()
const webm = readdirSync(join(out, 'rec')).find((f) => f.endsWith('.webm'))
renameSync(join(out, 'rec', webm), join(out, 'rec.webm'))
writeFileSync(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1))
console.log('recorded', ((Date.now() - t0) / 1000).toFixed(1), 's after a', timeline.trim_start_ms, 'ms load', existsSync(join(out, 'rec.webm')) ? '' : '(no video!)')
