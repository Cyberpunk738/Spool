import { spawn, spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const demo = resolve(root, 'demo')
const fixture = resolve(demo, 'spool-fixture.mp4')
const screenshot = resolve(demo, 'spool-editor.png')
const output = resolve(demo, 'spool-demo.mp4')
const titlePng = resolve(demo, 'title.png')
const outroPng = resolve(demo, 'outro.png')
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

await mkdir(demo, { recursive: true })

function ffmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-y', ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`FFmpeg stopped with exit code ${result.status}`)
}

ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', fixture,
])

const vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
  cwd: root,
  stdio: 'ignore',
})

for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:5173/')
    if (response.ok) break
  } catch {
    if (attempt === 29) throw new Error('The local Spool server did not start.')
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
}

const browser = await chromium.launch({ executablePath: chrome, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 })
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
  await page.locator('input[type="file"]').setInputFiles(fixture)
  await page.locator('.precision-trimmer').waitFor({ state: 'visible' })
  await page.getByText('Add selection to timeline').click()
  await page.getByRole('button', { name: 'Add text overlay' }).click()
  await page.getByLabel('Overlay text').fill('Made locally with Spool')
  await page.waitForTimeout(4500)
  await page.screenshot({ path: screenshot, fullPage: true })

  const card = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  await card.goto(pathToFileURL(resolve(demo, 'title.svg')).href)
  await card.screenshot({ path: titlePng })
  await card.goto(pathToFileURL(resolve(demo, 'outro.svg')).href)
  await card.screenshot({ path: outroPng })
} finally {
  await browser.close()
  vite.kill()
}

ffmpeg([
  '-loop', '1', '-t', '3.2', '-i', titlePng,
  '-loop', '1', '-t', '7.4', '-i', screenshot,
  '-loop', '1', '-t', '3.4', '-i', outroPng,
  '-f', 'lavfi', '-t', '14', '-i', 'sine=frequency=110:sample_rate=48000',
  '-filter_complex', [
    '[0:v]scale=1920:1080,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=2.7:d=0.5[v0]',
    '[1:v]scale=1920:-1,crop=1920:1080:0:\'min((ih-1080),t*115)\',format=yuv420p,fade=t=in:st=0:d=0.45,fade=t=out:st=6.9:d=0.5[v1]',
    '[2:v]scale=1920:1080,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=2.9:d=0.5[v2]',
    '[v0][v1][v2]concat=n=3:v=1:a=0[v]',
    '[3:a]volume=0.035,afade=t=in:st=0:d=1,afade=t=out:st=12.7:d=1.3[a]',
  ].join(';'),
  '-map', '[v]', '-map', '[a]', '-t', '14', '-r', '30',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
])

console.log(`Created ${output}`)
