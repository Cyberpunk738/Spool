import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'node_modules/@ffmpeg/core/dist/esm')
const wrapperSource = resolve(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm')
const destination = resolve(root, 'public/media-engine')

await mkdir(destination, { recursive: true })
await Promise.all([
  copyFile(resolve(source, 'ffmpeg-core.js'), resolve(destination, 'ffmpeg-core.js')),
  copyFile(resolve(source, 'ffmpeg-core.wasm'), resolve(destination, 'ffmpeg-core.wasm')),
  copyFile(resolve(wrapperSource, 'worker.js'), resolve(destination, 'ffmpeg-worker.js')),
  copyFile(resolve(wrapperSource, 'const.js'), resolve(destination, 'const.js')),
  copyFile(resolve(wrapperSource, 'errors.js'), resolve(destination, 'errors.js')),
])

console.log('Copied the single-thread FFmpeg core to public/media-engine')
