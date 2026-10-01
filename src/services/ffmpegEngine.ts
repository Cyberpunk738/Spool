import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import type { TimelineClip } from '../domain/timeline'

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

export interface TimelineExportOptions {
  assets: Array<{ id: string; file: File }>
  clips: TimelineClip[]
  output: ExportOptions['output']
  onUpdate: ExportOptions['onUpdate']
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
        classWorkerURL: `${CORE_BASE}/ffmpeg-worker.js`,
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

  async exportTimeline(options: TimelineExportOptions): Promise<Blob> {
    const { assets, clips, output, onUpdate } = options
    this.cancelled = false
    await this.load(onUpdate)
    if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
    const ffmpeg = this.ffmpeg
    if (!ffmpeg) throw new Error('The media engine did not initialise.')
    if (!clips.length) throw new Error('Add at least one clip to the timeline before exporting.')

    const background = /^#[0-9a-f]{6}$/i.test(output.background)
      ? `0x${output.background.slice(1)}`
      : '0x11110f'
    const job = crypto.randomUUID().replaceAll('-', '')
    const temporaryFiles: string[] = []
    const inputNames = new Map<string, string>()

    try {
      onUpdate({ stage: 'preparing', detail: `Preparing ${clips.length} timeline clip${clips.length === 1 ? '' : 's'}…` })
      for (const asset of assets) {
        if (!clips.some((clip) => clip.assetId === asset.id)) continue
        const name = `${job}-asset-${inputNames.size}.${safeExtension(asset.file)}`
        inputNames.set(asset.id, name)
        temporaryFiles.push(name)
        await ffmpeg.writeFile(name, await fetchFile(asset.file))
      }

      const videoSegments: string[] = []
      const audioSegments: string[] = []
      for (let index = 0; index < clips.length; index += 1) {
        if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
        const clip = clips[index]
        const inputName = inputNames.get(clip.assetId)
        if (!inputName) throw new Error(`Timeline clip ${index + 1} references missing media.`)
        const duration = clip.sourceOut - clip.sourceIn
        if (duration <= 0) throw new Error(`Timeline clip ${index + 1} has no duration.`)
        const videoName = `${job}-video-${index}.mp4`
        const audioName = `${job}-audio-${index}.m4a`
        videoSegments.push(videoName)
        audioSegments.push(audioName)
        temporaryFiles.push(videoName, audioName)
        onUpdate({
          stage: 'encoding',
          progress: index / clips.length,
          detail: `Normalizing clip ${index + 1} of ${clips.length}…`,
        })

        const videoExit = await ffmpeg.exec([
          '-i', inputName,
          '-ss', clip.sourceIn.toFixed(6),
          '-t', duration.toFixed(6),
          '-an',
          '-vf', `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=${background},fps=30,setpts=PTS-STARTPTS`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          videoName,
        ])
        if (videoExit !== 0) throw new Error(`Video processing failed for timeline clip ${index + 1}.`)

        const audioExit = await ffmpeg.exec([
          '-i', inputName,
          '-ss', clip.sourceIn.toFixed(6),
          '-t', duration.toFixed(6),
          '-map', '0:a:0', '-vn',
          '-af', 'asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo',
          '-c:a', 'aac', '-ar', '48000', '-ac', '2', audioName,
        ])
        if (audioExit !== 0) {
          await ffmpeg.deleteFile(audioName).catch(() => undefined)
          const silenceExit = await ffmpeg.exec([
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            '-t', duration.toFixed(6), '-c:a', 'aac', '-ar', '48000', '-ac', '2', audioName,
          ])
          if (silenceExit !== 0) throw new Error(`Could not create silence for timeline clip ${index + 1}.`)
        }
      }

      const videoList = `${job}-videos.txt`
      const audioList = `${job}-audio.txt`
      const joinedVideo = `${job}-joined-video.mp4`
      const joinedAudio = `${job}-joined-audio.m4a`
      const outputName = `${job}-timeline.mp4`
      temporaryFiles.push(videoList, audioList, joinedVideo, joinedAudio, outputName)
      await ffmpeg.writeFile(videoList, videoSegments.map((name) => `file '${name}'`).join('\n'))
      await ffmpeg.writeFile(audioList, audioSegments.map((name) => `file '${name}'`).join('\n'))

      onUpdate({ stage: 'finalizing', detail: 'Joining timeline clips and finalizing MP4…' })
      const videoJoinExit = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', videoList, '-c', 'copy', joinedVideo])
      if (videoJoinExit !== 0) throw new Error('The normalized video segments could not be joined.')
      const audioJoinExit = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', audioList, '-c', 'copy', joinedAudio])
      if (audioJoinExit !== 0) throw new Error('The normalized audio segments could not be joined.')
      const muxExit = await ffmpeg.exec([
        '-i', joinedVideo, '-i', joinedAudio,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', '-movflags', '+faststart', outputName,
      ])
      if (muxExit !== 0) throw new Error('The final timeline MP4 could not be created.')
      const data = await ffmpeg.readFile(outputName)
      if (typeof data === 'string' || data.byteLength === 0) throw new Error('The timeline export was empty.')
      onUpdate({ stage: 'complete', progress: 1, detail: 'Timeline export complete.' })
      return new Blob([data.slice().buffer], { type: 'video/mp4' })
    } finally {
      if (ffmpeg.loaded) await Promise.allSettled(temporaryFiles.map((name) => ffmpeg.deleteFile(name)))
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
