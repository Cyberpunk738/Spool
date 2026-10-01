import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'

export type ExportStage =
  | 'idle'
  | 'loading-engine'
  | 'preparing'
  | 'encoding'
  | 'finalizing'
  | 'complete'
  | 'cancelled'
  | 'failed'

export interface ExportUpdate {
  stage: ExportStage
  progress?: number
  detail: string
}

export interface ExportOptions {
  source: File
  startSeconds: number
  endSeconds: number
  output: {
    width: number
    height: number
    background: string
  }
  onUpdate: (update: ExportUpdate) => void
}

const CORE_BASE = `${window.location.origin}${import.meta.env.BASE_URL}media-engine`

function safeExtension(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase()
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin'
}

function makeName(prefix: string, extension: string): string {
  return `${prefix}-${crypto.randomUUID()}.${extension}`
}

export class FfmpegEngine {
  private ffmpeg: FFmpeg | null = null
  private loading: Promise<void> | null = null
  private cancelled = false

  async load(onUpdate: ExportOptions['onUpdate']): Promise<void> {
    if (this.ffmpeg?.loaded) return
    if (this.loading) return this.loading

    onUpdate({ stage: 'loading-engine', detail: 'Loading the local media engine (about 32 MB)…' })
    const ffmpeg = new FFmpeg()
    this.ffmpeg = ffmpeg
    this.loading = ffmpeg
      .load({
        coreURL: `${CORE_BASE}/ffmpeg-core.js`,
        wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
      })
      .then(() => undefined)
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  async exportTrimmed(options: ExportOptions): Promise<Blob> {
    const { source, startSeconds, endSeconds, output, onUpdate } = options
    this.cancelled = false
    await this.load(onUpdate)
    if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')

    const ffmpeg = this.ffmpeg
    if (!ffmpeg) throw new Error('The media engine did not initialise.')

    const inputName = makeName('input', safeExtension(source))
    const outputName = makeName('output', 'mp4')
    const duration = endSeconds - startSeconds
    const background = /^#[0-9a-f]{6}$/i.test(output.background)
      ? `0x${output.background.slice(1)}`
      : '0x11110f'

    const progressHandler = ({ progress }: { progress: number }) => {
      if (Number.isFinite(progress) && progress >= 0 && progress <= 1) {
        onUpdate({
          stage: 'encoding',
          progress,
          detail: `Encoding locally · ${Math.round(progress * 100)}%`,
        })
      }
    }

    ffmpeg.on('progress', progressHandler)

    try {
      onUpdate({ stage: 'preparing', detail: 'Copying the selected clip into the local workspace…' })
      await ffmpeg.writeFile(inputName, await fetchFile(source))
      if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')

      onUpdate({ stage: 'encoding', detail: 'Decoding and encoding a precise trim…' })
      const exitCode = await ffmpeg.exec([
        '-i', inputName,
        '-ss', startSeconds.toFixed(6),
        '-t', duration.toFixed(6),
        '-map', '0:v:0',
        '-map', '0:a?',
        '-vf', `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=${background},fps=30`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
        outputName,
      ])

      if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
      if (exitCode !== 0) throw new Error(`The encoder stopped with exit code ${exitCode}.`)

      onUpdate({ stage: 'finalizing', detail: 'Reading and checking the finished MP4…' })
      const data = await ffmpeg.readFile(outputName)
      if (typeof data === 'string' || data.byteLength === 0) {
        throw new Error('The encoder produced an empty or invalid output.')
      }
      return new Blob([data.slice().buffer], { type: 'video/mp4' })
    } finally {
      ffmpeg.off('progress', progressHandler)
      if (ffmpeg.loaded) {
        await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)])
      }
    }
  }

  cancel(): void {
    this.cancelled = true
    this.ffmpeg?.terminate()
    this.ffmpeg = null
    this.loading = null
  }

  dispose(): void {
    this.cancel()
  }
}
