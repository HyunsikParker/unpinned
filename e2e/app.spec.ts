import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('sample photo: finds the location first, makes a verified clean copy', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const requests: string[] = []
  page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1:4173') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) requests.push(r.url()) })

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('See what a photo reveals before you share it')
  await page.getByRole('button', { name: 'Try a sample photo' }).click()

  const card = page.getByRole('listitem').filter({ hasText: 'sofa-for-sale.jpg' })
  await expect(card.getByRole('heading', { level: 3 })).toHaveText('This photo gives away more than you can see')
  await expect(card.locator('.finding').first()).toContainText('Exact location (GPS): 48.85837° N, 2.29448° E')
  await expect(card.getByText('Name of the owner or author:')).toBeVisible()
  await expect(card.getByText('Device serial number:')).toBeVisible()
  await expect(card.getByRole('img', { name: 'Hidden preview image stored inside the file' })).toBeVisible()

  await card.getByRole('button', { name: 'Make a clean copy' }).click()
  await expect(card.getByRole('status')).toContainText('Clean copy checked: no location, names, serial numbers or hidden previews remain.')
  const link = card.getByRole('link', { name: 'Save sofa-for-sale-unpinned.jpg' })
  await expect(link).toHaveAttribute('download', 'sofa-for-sale-unpinned.jpg')
  const download = await Promise.all([page.waitForEvent('download'), link.click()]).then(([d]) => d)
  expect(download.suggestedFilename()).toBe('sofa-for-sale-unpinned.jpg')

  const a11y = await new AxeBuilder({ page }).analyze()
  if (a11y.violations.length) console.log(JSON.stringify(a11y.violations.flatMap((v) => v.nodes.map((n) => ({ t: n.target, d: n.any[0]?.data })))).slice(0, 3000))
  expect(a11y.violations.map((v) => v.id)).toEqual([])
  expect(errors).toEqual([])
  expect(requests).toEqual([])
})

test('phone width: no horizontal scroll and the main action is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Try a sample photo' }).click()
  await expect(page.getByRole('button', { name: 'Make a clean copy' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
