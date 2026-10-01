import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = resolve(root, 'test-results')
const fixture = resolve(outputDir, 'timeline-fixture.mp4')
const exported = resolve(outputDir, 'timeline-export.mp4')
await mkdir(outputDir, { recursive: true })

function runFfmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-y', ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`FFmpeg stopped with exit code ${result.status}`)
}

runFfmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000',
  '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', fixture,
])

const vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' })
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    if ((await fetch('http://127.0.0.1:5173/')).ok) break
  } catch {
    if (attempt === 29) throw new Error('The local Spool server did not start.')
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
}

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`))
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
  await page.locator('input[type="file"]').first().setInputFiles(fixture)
  await page.getByText('Add selection to timeline').waitFor()

  await page.getByRole('spinbutton', { name: 'Start' }).fill('0')
  await page.getByRole('spinbutton', { name: 'End' }).fill('1.5')
  await page.getByText('Add selection to timeline').click()
  await page.getByRole('spinbutton', { name: 'End' }).fill('3.5')
  await page.getByRole('spinbutton', { name: 'Start' }).fill('2')
  await page.getByText('Add selection to timeline').click()
  await page.getByRole('button', { name: 'Add text overlay' }).click()
  await page.getByLabel('Overlay text').fill('Spool integration test')
  await page.locator('label.tool-add input[type="file"]').setInputFiles(fixture)
  await page.getByRole('button', { name: 'Export 2 clips' }).click()
  try {
    await page.locator('.result-card video').waitFor({ state: 'visible', timeout: 180_000 })
  } catch (error) {
    console.error('Spool status:', await page.locator('.status-copy').innerText())
    const visibleError = page.locator('.error-banner')
    if (await visibleError.count()) console.error('Spool error:', await visibleError.innerText())
    await page.screenshot({ path: resolve(outputDir, 'timeline-export-failure.png'), fullPage: true })
    throw error
  }

  const duration = await page.locator('.result-card video').evaluate((video) => video.duration)
  if (!Number.isFinite(duration) || Math.abs(duration - 3) > 0.15) {
    throw new Error(`Expected a 3 second timeline export, received ${duration.toFixed(3)} seconds.`)
  }

  const bytes = await page.locator('.result-card video').evaluate(async (video) => {
    const response = await fetch(video.src)
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  })
  await writeFile(exported, Buffer.from(bytes))
} finally {
  await browser.close()
  vite.kill()
}

runFfmpeg(['-i', exported, '-f', 'null', 'NUL'])
console.log(`Verified real timeline export: ${exported}`)
