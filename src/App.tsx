import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ArrowUpRight,
  Copy,
  Download,
  Film,
  FolderOpen,
  Gauge,
  HardDrive,
  Info,
  LoaderCircle,
  Play,
  Pause,
  Plus,
  Redo2,
  SkipBack,
  SkipForward,
  Trash2,
  Type,
  Undo2,
  Music2,
  Scissors,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { FfmpegEngine, type ExportStage } from './services/ffmpegEngine'
import {
  clipTimelineStart,
  duplicateClip,
  moveClip,
  removeClip,
  splitClip,
  trimClip,
  timelineDuration,
  type TimelineClip,
} from './domain/timeline'
import { loadProject, saveProject } from './services/projectPersistence'

type MediaDetails = {
  duration: number
  width: number
  height: number
  url: string
}

type MediaAsset = {
  id: string
  file: File
  media: MediaDetails
}

type TextOverlay = {
  id: string
  text: string
  start: number
  end: number
  x: number
  y: number
  fontSize: number
  colour: string
  background: string
}

type MusicAsset = { file: File; url: string; duration: number }

type OutputPreset = 'landscape' | 'portrait' | 'square'

const OUTPUT_PRESETS: Record<OutputPreset, { label: string; width: number; height: number; ratio: string }> = {
  landscape: { label: 'Landscape', width: 1280, height: 720, ratio: '16 / 9' },
  portrait: { label: 'Portrait', width: 720, height: 1280, ratio: '9 / 16' },
  square: { label: 'Square', width: 720, height: 720, ratio: '1 / 1' },
}

const BACKGROUNDS = ['#063f35', '#f2f6f3', '#59e3ac', '#11110f', '#c4d5ed'] as const

const MAX_FILE_BYTES = 250 * 1024 * 1024
const MAX_OUTPUT_SECONDS = 60

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe % 60).toFixed(2).padStart(5, '0')}`
}

function readVideoMetadata(file: File): Promise<MediaDetails> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const timeout = window.setTimeout(() => {
      URL.revokeObjectURL(url)
      reject(new Error('The browser could not read this video within 15 seconds.'))
    }, 15_000)

    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout)
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        URL.revokeObjectURL(url)
        reject(new Error('This file does not contain a readable video duration.'))
        return
      }
      resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        url,
      })
    }
    video.onerror = () => {
      window.clearTimeout(timeout)
      URL.revokeObjectURL(url)
      reject(new Error('This browser cannot decode the selected video. Try MP4 (H.264) or WebM.'))
    }
    video.src = url
  })
}

function readAudioMetadata(file: File): Promise<MusicAsset> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const audio = document.createElement('audio')
    const timeout = window.setTimeout(() => {
      URL.revokeObjectURL(url)
      reject(new Error('Audio metadata timed out.'))
    }, 15_000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      window.clearTimeout(timeout)
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        URL.revokeObjectURL(url)
        reject(new Error('This audio file has no readable duration.'))
        return
      }
      resolve({ file, url, duration: audio.duration })
    }
    audio.onerror = () => {
      window.clearTimeout(timeout)
      URL.revokeObjectURL(url)
      reject(new Error('This browser cannot decode the selected audio file.'))
    }
    audio.src = url
  })
}

async function rasterizeOverlay(overlay: TextOverlay): Promise<{ png: Blob; width: number; height: number }> {
  await document.fonts.load(`600 ${overlay.fontSize}px Manrope`)
  const lines = overlay.text.split('\n').slice(0, 5)
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('Canvas text rendering is unavailable.')
  measure.font = `600 ${overlay.fontSize}px Manrope`
  const padding = Math.round(overlay.fontSize * 0.35)
  const lineHeight = Math.round(overlay.fontSize * 1.22)
  const width = Math.max(
    2,
    Math.ceil(Math.max(...lines.map((line) => measure.measureText(line || ' ').width)) + padding * 2),
  )
  const height = Math.max(2, lineHeight * lines.length + padding * 2)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas text rendering is unavailable.')
  if (overlay.background !== 'transparent') {
    context.fillStyle = overlay.background
    context.fillRect(0, 0, width, height)
  }
  context.font = `600 ${overlay.fontSize}px Manrope`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = overlay.colour
  lines.forEach((line, index) => context.fillText(line, width / 2, padding + lineHeight * (index + 0.5)))
  const png = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Text rasterization failed.'))), 'image/png'),
  )
  return { png, width, height }
}

export default function App() {
  const engineRef = useRef<FfmpegEngine | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const musicPreviewRef = useRef<HTMLAudioElement | null>(null)
  const pendingPreviewRef = useRef<{ time: number; autoplay: boolean } | null>(null)
  const importBusyRef = useRef(false)
  const exportJobRef = useRef(0)
  const previewFrameRef = useRef<HTMLDivElement | null>(null)
  const [previewWidth, setPreviewWidth] = useState(480)
  const [previewMode, setPreviewMode] = useState<'source' | 'sequence'>('source')
  const [isImporting, setIsImporting] = useState(false)
  const [projectName, setProjectName] = useState('Untitled project')
  const assetsRef = useRef<MediaAsset[]>([])
  const resultUrlRef = useRef<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [media, setMedia] = useState<MediaDetails | null>(null)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [stage, setStage] = useState<ExportStage>('idle')
  const [status, setStatus] = useState('Choose a short video to begin.')
  const [progress, setProgress] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [preset, setPreset] = useState<OutputPreset>('landscape')
  const [background, setBackground] = useState<string>('#063f35')
  const [playhead, setPlayhead] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [loopSelection, setLoopSelection] = useState(true)
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [assets, setAssets] = useState<MediaAsset[]>([])
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [undoStack, setUndoStack] = useState<TimelineClip[][]>([])
  const [redoStack, setRedoStack] = useState<TimelineClip[][]>([])
  const [hydrated, setHydrated] = useState(false)
  const [saveState, setSaveState] = useState<'local' | 'saving' | 'saved' | 'failed'>('local')
  const [textOverlay, setTextOverlay] = useState<TextOverlay | null>(null)
  const [music, setMusic] = useState<MusicAsset | null>(null)
  const [musicGain, setMusicGain] = useState(0.35)
  const [sourceGain, setSourceGain] = useState(1)
  const [musicOffset, setMusicOffset] = useState(0)

  const isWorking = ['loading-engine', 'preparing', 'encoding', 'finalizing'].includes(stage)
  const trimDuration = Math.max(0, end - start)
  const sequenceDuration = timelineDuration(clips)
  const output = OUTPUT_PRESETS[preset]
  const canExport = clips.length
    ? sequenceDuration > 0 && sequenceDuration <= MAX_OUTPUT_SECONDS && !isWorking && hydrated && !isImporting
    : Boolean(
        file &&
        media &&
        trimDuration > 0 &&
        trimDuration <= MAX_OUTPUT_SECONDS &&
        !isWorking &&
        hydrated &&
        !isImporting,
      )

  const selectedAsset = assets.find((asset) => asset.file === file)
  const selectedClip = clips.find((clip) => clip.id === selectedClipId)
  const sequencePlayhead = selectedClip
    ? clipTimelineStart(clips, selectedClip.id) + Math.max(0, playhead - selectedClip.sourceIn)
    : 0
  const overlayTime = previewMode === 'sequence' ? sequencePlayhead : -1

  // Keep inspector ranges in sync after undo, redo, split, or ripple deletion.
  useEffect(() => {
    if (!selectedClip) {
      if (previewMode === 'sequence') {
        videoRef.current?.pause()
        setPreviewMode('source')
        setSelectedClipId(null)
      }
      return
    }
    setStart(selectedClip.sourceIn)
    setEnd(selectedClip.sourceOut)
  }, [selectedClip?.id, selectedClip?.sourceIn, selectedClip?.sourceOut])

  useEffect(() => {
    const frame = previewFrameRef.current
    if (!frame) return
    const observer = new ResizeObserver(([entry]) => setPreviewWidth(entry.contentRect.width))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = sourceGain
  }, [sourceGain, media])

  useEffect(() => {
    const audio = musicPreviewRef.current
    if (!audio || !music) return
    const time = sequencePlayhead - musicOffset
    audio.volume = musicGain
    if (previewMode !== 'sequence' || !isPlaying || time < 0 || time >= music.duration) {
      audio.pause()
      return
    }
    if (Math.abs(audio.currentTime - time) > 0.2) audio.currentTime = time
    void audio.play().catch(() => undefined)
  }, [sequencePlayhead, musicOffset, musicGain, music, isPlaying, previewMode])

  useEffect(() => {
    assetsRef.current = assets
  }, [assets])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const saved = await loadProject()
        if (!saved || cancelled) return
        const restored: MediaAsset[] = []
        for (const stored of saved.assets) {
          const restoredFile = new File([stored.blob], stored.name, {
            type: stored.type,
            lastModified: stored.lastModified,
          })
          const restoredMedia = await readVideoMetadata(restoredFile)
          restored.push({
            id: stored.id,
            file: restoredFile,
            media: restoredMedia,
          })
        }
        if (cancelled) {
          for (const asset of restored) URL.revokeObjectURL(asset.media.url)
          return
        }
        setProjectName(saved.name || 'Untitled project')
        setAssets(restored)
        setClips(saved.clips)
        setPreset(saved.preset)
        setBackground(saved.background)
        setTextOverlay(saved.textOverlay ?? null)
        setSourceGain(saved.sourceGain ?? 1)
        if (saved.music) {
          const restoredMusicFile = new File([saved.music.blob], saved.music.name, {
            type: saved.music.type,
            lastModified: saved.music.lastModified,
          })
          setMusic(await readAudioMetadata(restoredMusicFile))
          setMusicGain(saved.music.gain)
          setMusicOffset(saved.music.offset)
        }
        if (restored[0]) {
          setFile(restored[0].file)
          setMedia(restored[0].media)
          setEnd(Math.min(restored[0].media.duration, MAX_OUTPUT_SECONDS))
          setStatus('Local project restored from this browser.')
        }
        setSaveState('saved')
      } catch (caught) {
        if (!cancelled) {
          setSaveState('failed')
          setError(caught instanceof Error ? caught.message : 'The local project could not be restored.')
        }
      } finally {
        if (!cancelled) setHydrated(true)
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated || !assets.length) return
    setSaveState('saving')
    const timeout = window.setTimeout(() => {
      void saveProject({
        schemaVersion: 1,
        name: projectName,
        assets: assets.map((asset) => ({
          id: asset.id,
          name: asset.file.name,
          type: asset.file.type,
          lastModified: asset.file.lastModified,
          blob: asset.file,
        })),
        clips,
        preset,
        background,
        textOverlay: textOverlay ?? undefined,
        music: music
          ? {
              name: music.file.name,
              type: music.file.type,
              lastModified: music.file.lastModified,
              blob: music.file,
              gain: musicGain,
              offset: musicOffset,
            }
          : undefined,
        sourceGain,
        updatedAt: new Date().toISOString(),
      })
        .then(() => setSaveState('saved'))
        .catch((caught: unknown) => {
          setSaveState('failed')
          setError(caught instanceof Error ? caught.message : 'Local autosave failed.')
        })
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [assets, background, clips, hydrated, music, musicGain, musicOffset, preset, projectName, sourceGain, textOverlay])

  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
      for (const asset of assetsRef.current) URL.revokeObjectURL(asset.media.url)
    }
  }, [])

  useEffect(() => {
    if (!media) {
      setThumbnails([])
      return
    }

    let cancelled = false
    const capture = document.createElement('video')
    capture.muted = true
    capture.preload = 'auto'
    capture.src = media.url

    const seekTo = (time: number) =>
      new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Thumbnail seek timed out.')), 4_000)
        capture.onseeked = () => {
          window.clearTimeout(timeout)
          resolve()
        }
        capture.onerror = () => {
          window.clearTimeout(timeout)
          reject(new Error('Thumbnail decode failed.'))
        }
        capture.currentTime = time
      })

    const generate = async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          if (capture.readyState >= 1) {
            resolve()
            return
          }
          capture.onloadedmetadata = () => resolve()
          capture.onerror = () => reject(new Error('Thumbnail metadata failed.'))
        })
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 90
        const context = canvas.getContext('2d')
        if (!context) return
        const frames: string[] = []
        for (let index = 0; index < 8; index += 1) {
          await seekTo(Math.min(media.duration - 0.01, (media.duration * (index + 0.5)) / 8))
          context.fillStyle = '#11110f'
          context.fillRect(0, 0, canvas.width, canvas.height)
          const scale = Math.min(canvas.width / capture.videoWidth, canvas.height / capture.videoHeight)
          const width = capture.videoWidth * scale
          const height = capture.videoHeight * scale
          context.drawImage(capture, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
          frames.push(canvas.toDataURL('image/jpeg', 0.62))
        }
        if (!cancelled) setThumbnails(frames)
      } catch {
        if (!cancelled) setThumbnails([])
      }
    }

    void generate()
    return () => {
      cancelled = true
      capture.removeAttribute('src')
      capture.load()
    }
  }, [media])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (isWorking || !media || target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.code === 'Space' && target?.closest('button, a')) return
      if (event.key.toLowerCase() === 'i') {
        setStart(Math.min(playhead, end - 1 / 30))
      } else if (event.key.toLowerCase() === 'o') {
        setEnd(Math.max(playhead, start + 1 / 30))
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        stepFrame(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (event.code === 'Space') {
        event.preventDefault()
        void togglePlayback()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const resetResult = () => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
    resultUrlRef.current = null
    setResultUrl(null)
    setElapsed(null)
  }

  // A downloaded cut always represents the settings shown when it was encoded.
  useEffect(() => {
    if (!resultUrlRef.current) return
    resetResult()
    setStage('idle')
    setStatus('Your edit changed. Export again to download the latest version.')
  }, [
    clips,
    preset,
    background,
    textOverlay,
    music,
    sourceGain,
    musicGain,
    musicOffset,
    clips.length ? 0 : start,
    clips.length ? 0 : end,
  ])

  const chooseFiles = async (selectedFiles: FileList | File[] | null | undefined) => {
    if (!selectedFiles?.length || importBusyRef.current || isWorking || !hydrated) return
    setError(null)
    resetResult()
    const incoming = Array.from(selectedFiles)
    if (assets.length + incoming.length > 5) {
      setError('Spool supports up to five source videos in this release.')
      return
    }
    if (
      assets.reduce((sum, asset) => sum + asset.file.size, 0) + incoming.reduce((sum, item) => sum + item.size, 0) >
      MAX_FILE_BYTES
    ) {
      setError('Those files exceed Spool’s 250 MB project limit.')
      return
    }

    importBusyRef.current = true
    setIsImporting(true)
    try {
      setStatus(`Reading ${incoming.length} video${incoming.length === 1 ? '' : 's'}…`)
      const results = await Promise.allSettled(
        incoming.map(async (selected) => ({
          id: crypto.randomUUID(),
          file: selected,
          media: await readVideoMetadata(selected),
        })),
      )
      const imported = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        imported.forEach((asset) => URL.revokeObjectURL(asset.media.url))
        throw failed.reason
      }
      const first = imported[0]
      pendingPreviewRef.current = null
      videoRef.current?.pause()
      setPreviewMode('source')
      setSelectedClipId(null)
      setAssets((current) => [...current, ...imported])
      setFile(first.file)
      setMedia(first.media)
      setStart(0)
      setEnd(Math.min(first.media.duration, MAX_OUTPUT_SECONDS))
      setPlayhead(0)
      setStage('idle')
      setStatus('Media imported. Add the clips you want to the timeline.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The selected file could not be opened.')
      setStatus('Choose another video to continue.')
    } finally {
      importBusyRef.current = false
      setIsImporting(false)
    }
  }

  const selectAsset = (asset: MediaAsset) => {
    videoRef.current?.pause()
    pendingPreviewRef.current = null
    setPreviewMode('source')
    setSelectedClipId(null)
    setFile(asset.file)
    setMedia(asset.media)
    setStart(0)
    setEnd(Math.min(asset.media.duration, MAX_OUTPUT_SECONDS))
    setPlayhead(0)
    resetResult()
  }

  const commitClips = (next: TimelineClip[]) => {
    if (next === clips) return
    setUndoStack((history) => [...history.slice(-49), clips])
    setRedoStack([])
    setClips(next)
  }

  const addSelectedAsset = () => {
    if (!selectedAsset || !media) return
    const clip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId: selectedAsset.id,
      sourceIn: start,
      sourceOut: end,
    }
    commitClips([...clips, clip])
    videoRef.current?.pause()
    setPreviewMode('source')
    setSelectedClipId(null)
  }

  const selectTimelineClip = (clip: TimelineClip, autoplay = false) => {
    const asset = assets.find((candidate) => candidate.id === clip.assetId)
    if (!asset) return
    setPreviewMode('sequence')
    setSelectedClipId(clip.id)
    setFile(asset.file)
    setMedia(asset.media)
    setStart(clip.sourceIn)
    setEnd(clip.sourceOut)
    setPlayhead(clip.sourceIn)
    if (media?.url === asset.media.url && videoRef.current?.readyState) {
      videoRef.current.currentTime = clip.sourceIn
      if (autoplay) void videoRef.current.play().catch(() => setIsPlaying(false))
      else videoRef.current.pause()
    } else {
      pendingPreviewRef.current = { time: clip.sourceIn, autoplay }
    }
  }

  const applyTrim = () => {
    if (!selectedClip) return
    commitClips(trimClip(clips, selectedClip.id, start, end))
    resetResult()
    setStatus('Selected timeline clip updated. Undo is available in the sequence toolbar.')
  }

  const undo = () => {
    const previous = undoStack.at(-1)
    if (!previous) return
    setRedoStack((history) => [...history, clips])
    setClips(previous)
    setUndoStack((history) => history.slice(0, -1))
    if (selectedClipId && !previous.some((clip) => clip.id === selectedClipId)) setSelectedClipId(null)
  }

  const redo = () => {
    const next = redoStack.at(-1)
    if (!next) return
    setUndoStack((history) => [...history, clips])
    setClips(next)
    setRedoStack((history) => history.slice(0, -1))
  }

  const saveNow = async () => {
    if (!assets.length) return
    setSaveState('saving')
    try {
      await saveProject({
        schemaVersion: 1,
        name: projectName,
        assets: assets.map((asset) => ({
          id: asset.id,
          name: asset.file.name,
          type: asset.file.type,
          lastModified: asset.file.lastModified,
          blob: asset.file,
        })),
        clips,
        preset,
        background,
        textOverlay: textOverlay ?? undefined,
        music: music
          ? {
              name: music.file.name,
              type: music.file.type,
              lastModified: music.file.lastModified,
              blob: music.file,
              gain: musicGain,
              offset: musicOffset,
            }
          : undefined,
        sourceGain,
        updatedAt: new Date().toISOString(),
      })
      setSaveState('saved')
    } catch (caught) {
      setSaveState('failed')
      setError(
        caught instanceof Error ? caught.message : 'Local save failed. Check browser storage permissions and quota.',
      )
    }
  }

  const exportVideo = async () => {
    if (!canExport) return
    if (
      clips.length > 0 &&
      textOverlay?.text.trim() &&
      (!Number.isFinite(textOverlay.start) ||
        !Number.isFinite(textOverlay.end) ||
        textOverlay.start < 0 ||
        textOverlay.end <= textOverlay.start ||
        textOverlay.end > sequenceDuration ||
        !Number.isFinite(textOverlay.fontSize) ||
        textOverlay.fontSize < 18 ||
        textOverlay.fontSize > 140)
    ) {
      setError('Check text settings: timing must fit inside your sequence and font size must be between 18 and 140.')
      return
    }
    if (
      clips.length > 0 &&
      music &&
      (!Number.isFinite(musicOffset) || musicOffset < 0 || musicOffset >= sequenceDuration)
    ) {
      setError('Music must start at or after zero and before the end of your sequence.')
      return
    }
    videoRef.current?.pause()
    const job = ++exportJobRef.current
    setError(null)
    resetResult()
    const engine = engineRef.current ?? new FfmpegEngine()
    engineRef.current = engine
    const startedAt = performance.now()

    try {
      setStage('preparing')
      setStatus('Preparing your edit…')
      const rasterizedText = textOverlay?.text.trim()
        ? [
            {
              ...(await rasterizeOverlay(textOverlay)),
              startSeconds: textOverlay.start,
              endSeconds: textOverlay.end,
              x: textOverlay.x,
              y: textOverlay.y,
            },
          ]
        : []
      if (job !== exportJobRef.current) return
      const onUpdate = (update: { stage: ExportStage; detail: string; progress?: number }) => {
        if (job !== exportJobRef.current) return
        setStage(update.stage)
        setStatus(update.detail)
        setProgress(update.progress)
      }
      const blob = clips.length
        ? await engine.exportTimeline({
            assets: assets.map((asset) => ({ id: asset.id, file: asset.file })),
            clips,
            output: { width: output.width, height: output.height, background },
            textOverlays: rasterizedText,
            music: music
              ? {
                  file: music.file,
                  timelineStartSeconds: musicOffset,
                  sourceInSeconds: 0,
                  gain: musicGain,
                }
              : undefined,
            sourceGain,
            onUpdate,
          })
        : file && media
          ? await engine.exportTrimmed({
              source: file,
              sourceGain,
              startSeconds: start,
              endSeconds: end,
              output: {
                width: output.width,
                height: output.height,
                background,
              },
              onUpdate,
            })
          : null
      if (job !== exportJobRef.current) return
      if (!blob) throw new Error('Choose a video or add clips to the timeline before exporting.')
      const url = URL.createObjectURL(blob)
      resultUrlRef.current = url
      setResultUrl(url)
      setElapsed((performance.now() - startedAt) / 1000)
      setStage('complete')
      setProgress(1)
      setStatus(
        `${clips.length ? 'Timeline' : 'Clip'} export complete. Play the independent result below before downloading.`,
      )
    } catch (caught) {
      if (job !== exportJobRef.current) return
      const cancelled = caught instanceof DOMException && caught.name === 'AbortError'
      setStage(cancelled ? 'cancelled' : 'failed')
      setStatus(cancelled ? 'Export cancelled. The engine will reload on your next attempt.' : 'Export failed.')
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'An unknown export error occurred.')
    }
  }

  const cancelExport = () => {
    exportJobRef.current += 1
    engineRef.current?.cancel()
    setStage('cancelled')
    setProgress(undefined)
    setStatus('Export cancelled. The engine will reload on your next attempt.')
  }

  const chooseMusic = async (selected: File | undefined) => {
    if (!selected) return
    try {
      if (selected.size > 50 * 1024 * 1024) throw new Error('Choose a soundtrack smaller than 50 MB.')
      const importedMusic = await readAudioMetadata(selected)
      if (music) URL.revokeObjectURL(music.url)
      setMusic(importedMusic)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Music import failed.')
    }
  }

  const seek = (time: number) => {
    const next = Math.max(0, Math.min(time, media?.duration ?? 0))
    if (videoRef.current) videoRef.current.currentTime = next
    setPlayhead(next)
  }

  const stepFrame = (direction: -1 | 1) => {
    videoRef.current?.pause()
    seek(playhead + direction / 30)
  }

  const togglePlayback = async () => {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      return
    }
    if (video.currentTime < start || video.currentTime >= end) seek(start)
    try {
      await video.play()
    } catch {
      setError('Playback could not start. Select another clip or try again.')
    }
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video) return
    const boundary = previewMode === 'sequence' && selectedClip ? selectedClip.sourceOut : end
    if (video.currentTime >= boundary - 0.015) {
      if (previewMode === 'sequence' && selectedClip) {
        const index = clips.findIndex((clip) => clip.id === selectedClip.id)
        const next = clips[index + 1] ?? (loopSelection ? clips[0] : undefined)
        if (next && (!video.paused || video.ended)) {
          selectTimelineClip(next, true)
          return
        }
      } else if (loopSelection && (!video.paused || video.ended)) {
        video.currentTime = start
        if (video.ended || video.paused) void video.play().catch(() => setIsPlaying(false))
        return
      }
      video.pause()
    }
    setPlayhead(video.currentTime)
  }

  const seekFromTimeline = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!media) return
    const bounds = event.currentTarget.getBoundingClientRect()
    seek(((event.clientX - bounds.left) / bounds.width) * media.duration)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Spool home">
          <span className="brand-mark">
            <span />
          </span>
          <span>spool</span>
        </a>
        <div className="project-name">
          <input
            aria-label="Project name"
            maxLength={80}
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            disabled={isWorking || !hydrated}
          />
          <span className="project-dot" title={saveState === 'saved' ? 'Saved on this device' : 'Local project'} />
        </div>
        <div className="top-actions">
          <span className="local-pill">
            <ShieldCheck size={14} /> Your media stays on this device
          </span>
          <button
            className={`ghost-button save-${saveState}`}
            onClick={() => void saveNow()}
            disabled={!assets.length || saveState === 'saving'}
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Saved locally'
                : saveState === 'failed'
                  ? 'Save failed · Retry'
                  : 'Save project'}
          </button>
          <button className="primary-button compact" onClick={exportVideo} disabled={!canExport}>
            <Sparkles size={16} /> Export
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow">
            <span /> A little less editing. A lot more creating.
          </div>
          <h1>
            Good stories.
            <br />
            <em>Beautifully cut.</em>
          </h1>
          <p>
            Turn the moments on your device into something worth sharing.
            <br className="desktop-break" /> Trim, arrange, add your soundtrack. Keep it all yours.
          </p>
          <a className="primary-button hero-cta" href="#studio">
            Open your studio <ArrowUpRight size={17} />
          </a>
          <div className="hero-notes">
            <span>
              <ShieldCheck size={14} /> Private by design
            </span>
            <span>
              <Film size={14} /> No sign-up needed
            </span>
            <span>
              <Download size={14} /> Export to MP4
            </span>
          </div>
        </section>

        <div className="studio-heading" id="studio">
          <div>
            <span className="section-label">01 / THE STUDIO</span>
            <h2>A space for your next story.</h2>
          </div>
          <span className="studio-badge">
            <span />{' '}
            {isWorking
              ? 'Export in progress'
              : isImporting
                ? 'Reading your media'
                : 'Everything happens on your device'}
          </span>
        </div>
        <fieldset className="editing-controls" disabled={isWorking || isImporting || !hydrated}>
          <section className="workspace" aria-label="Video export workspace">
            <aside className="side-panel">
              <div className="panel-heading">
                <div>
                  <span className="step">01</span>
                  <h2>Source</h2>
                </div>
                {file && <span className="asset-count">{assets.length}/5</span>}
              </div>

              {!assets.length ? (
                <label
                  className="drop-zone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    void chooseFiles(event.dataTransfer.files)
                  }}
                >
                  <input
                    type="file"
                    accept="video/*"
                    multiple
                    onChange={(event) => {
                      void chooseFiles(event.target.files)
                      event.target.value = ''
                    }}
                  />
                  <span className="upload-icon">
                    <FolderOpen size={25} />
                  </span>
                  <strong>Drop your first moment</strong>
                  <span className="browse-link">
                    or browse videos <ArrowUpRight size={12} />
                  </span>
                  <small>Up to 5 clips · 250 MB total</small>
                </label>
              ) : (
                <div className="media-bin">
                  {assets.map((asset) => (
                    <button
                      key={asset.id}
                      aria-pressed={asset.file === file}
                      className={asset.file === file ? 'asset-card selected' : 'asset-card'}
                      onClick={() => selectAsset(asset)}
                    >
                      <div className="asset-thumb">
                        <Film size={18} />
                      </div>
                      <div className="asset-copy">
                        <strong>{asset.file.name}</strong>
                        <span>
                          {(asset.file.size / (1024 * 1024)).toFixed(1)} MB · {formatTime(asset.media.duration)}
                        </span>
                      </div>
                      {asset.file === file && <CheckCircle2 className="success" size={16} />}
                    </button>
                  ))}
                  <label className="add-media">
                    <input
                      type="file"
                      accept="video/*"
                      multiple
                      onChange={(event) => {
                        void chooseFiles(event.target.files)
                        event.target.value = ''
                      }}
                    />
                    <Plus size={14} /> Import more
                  </label>
                  <button className="add-timeline" onClick={addSelectedAsset}>
                    <Plus size={14} /> Add selection to timeline
                  </button>
                </div>
              )}

              <div className="facts">
                <div>
                  <HardDrive size={15} />
                  <span>Processed locally</span>
                </div>
                <div>
                  <Gauge size={15} />
                  <span>60 second output limit</span>
                </div>
              </div>
            </aside>

            <section className="preview-panel">
              <div className="preview-toolbar">
                <span>YOUR CANVAS</span>
                <div className="preview-tabs" role="group" aria-label="Preview mode">
                  <button
                    aria-pressed={previewMode === 'source'}
                    onClick={() => {
                      videoRef.current?.pause()
                      setPreviewMode('source')
                      setSelectedClipId(null)
                    }}
                  >
                    Source
                  </button>
                  <button
                    aria-pressed={previewMode === 'sequence'}
                    disabled={!clips.length}
                    onClick={() => selectTimelineClip(clips[0])}
                  >
                    Sequence
                  </button>
                </div>
              </div>
              <div className="preview-stage">
                <div
                  ref={previewFrameRef}
                  className={`preview-frame frame-${preset}`}
                  style={{ aspectRatio: output.ratio, background }}
                >
                  {media ? (
                    <video
                      ref={videoRef}
                      key={media.url}
                      src={media.url}
                      playsInline
                      onLoadedMetadata={() => {
                        const pending = pendingPreviewRef.current
                        if (!pending || !videoRef.current) return
                        pendingPreviewRef.current = null
                        videoRef.current.currentTime = pending.time
                        if (pending.autoplay) void videoRef.current.play().catch(() => setIsPlaying(false))
                      }}
                      onEnded={handleTimeUpdate}
                      onTimeUpdate={handleTimeUpdate}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  ) : (
                    <div className="empty-preview">
                      <div className="canvas-art" aria-hidden="true">
                        <span className="orbit orbit-one" />
                        <span className="orbit orbit-two" />
                        <span className="art-play">
                          <Play size={28} fill="currentColor" />
                        </span>
                        <span className="art-label">a moment, made yours.</span>
                      </div>
                      <strong>Your story starts here.</strong>
                      <small>Bring a video. We’ll make room for the possibilities.</small>
                    </div>
                  )}
                  {textOverlay?.text && overlayTime >= textOverlay.start && overlayTime < textOverlay.end && (
                    <div
                      className="preview-text"
                      style={{
                        left: `${textOverlay.x * 100}%`,
                        top: `${textOverlay.y * 100}%`,
                        color: textOverlay.colour,
                        background: textOverlay.background,
                        fontSize: `${(textOverlay.fontSize * previewWidth) / output.width}px`,
                      }}
                    >
                      {textOverlay.text.split('\n').slice(0, 5).join('\n')}
                    </div>
                  )}
                </div>
              </div>
              <div className="preview-footer">
                <span>
                  {output.label.toUpperCase()} · {output.width} × {output.height}
                </span>
                <span>{formatTime(previewMode === 'sequence' ? sequencePlayhead : playhead)} · 30 FPS</span>
              </div>
              {media && (
                <div className="transport" aria-label="Preview controls">
                  <button onClick={() => stepFrame(-1)} aria-label="Previous frame">
                    <SkipBack size={15} />
                  </button>
                  <button
                    className="play-button"
                    onClick={() => void togglePlayback()}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
                  </button>
                  <button onClick={() => stepFrame(1)} aria-label="Next frame">
                    <SkipForward size={15} />
                  </button>
                  <span className="transport-time">{formatTime(playhead)}</span>
                  <label className="loop-toggle">
                    <input
                      type="checkbox"
                      checked={loopSelection}
                      onChange={(event) => setLoopSelection(event.target.checked)}
                    />{' '}
                    Loop {previewMode === 'sequence' ? 'sequence' : 'selection'}
                  </label>
                </div>
              )}
            </section>

            <aside className="side-panel inspector">
              <div className="panel-heading">
                <div>
                  <span className="step">02</span>
                  <h2>Trim</h2>
                </div>
                <Scissors size={18} />
              </div>
              <p className="hint">
                Keep the part that matters. Set your in and out points, then add the selection to your story.
              </p>
              <div className="time-inputs">
                <label>
                  Start
                  <input
                    type="number"
                    min="0"
                    max={end}
                    step="0.01"
                    value={start}
                    disabled={!media || isWorking}
                    onChange={(e) => setStart(Math.max(0, Math.min(Number(e.target.value), end - 0.01)))}
                  />
                </label>
                <span>→</span>
                <label>
                  End
                  <input
                    type="number"
                    min={start}
                    max={media?.duration ?? 0}
                    step="0.01"
                    value={end}
                    disabled={!media || isWorking}
                    onChange={(e) =>
                      setEnd(Math.min(media?.duration ?? 0, Math.max(Number(e.target.value), start + 0.01)))
                    }
                  />
                </label>
              </div>
              {selectedClip && (
                <button
                  className="apply-trim"
                  onClick={applyTrim}
                  disabled={selectedClip.sourceIn === start && selectedClip.sourceOut === end}
                >
                  Apply trim to selected clip
                </button>
              )}
              <div className="duration-card">
                <span>{clips.length ? 'Sequence duration' : 'Selection duration'}</span>
                <strong>{formatTime(clips.length ? sequenceDuration : trimDuration)}</strong>
              </div>
              <div className="format-studio">
                <div className="control-label">
                  <span>Canvas format</span>
                  <small>
                    {output.width} × {output.height}
                  </small>
                </div>
                <div className="preset-grid" role="group" aria-label="Output format">
                  {(Object.keys(OUTPUT_PRESETS) as OutputPreset[]).map((key) => (
                    <button
                      key={key}
                      className={preset === key ? 'preset active' : 'preset'}
                      onClick={() => setPreset(key)}
                      disabled={isWorking}
                      aria-pressed={preset === key}
                    >
                      <span className={`ratio-icon ratio-${key}`} />
                      {OUTPUT_PRESETS[key].label}
                    </button>
                  ))}
                </div>
                <div className="control-label colour-label">
                  <span>Letterbox colour</span>
                  <small>{background}</small>
                </div>
                <div className="swatches" role="group" aria-label="Letterbox colour">
                  {BACKGROUNDS.map((colour) => (
                    <button
                      key={colour}
                      className={background === colour ? 'swatch active' : 'swatch'}
                      style={{ backgroundColor: colour }}
                      onClick={() => setBackground(colour)}
                      disabled={isWorking}
                      aria-label={`Use ${colour} background`}
                      aria-pressed={background === colour}
                    />
                  ))}
                </div>
              </div>
              <label className="source-volume">
                Source audio <span>{Math.round(sourceGain * 100)}%</span>
                <input
                  aria-label="Source audio volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={sourceGain}
                  onChange={(event) => setSourceGain(Number(event.target.value))}
                />
              </label>
              <button className="primary-button full" onClick={exportVideo} disabled={!canExport}>
                {isWorking ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}
                {isWorking ? 'Exporting…' : clips.length ? `Export ${clips.length} clips` : 'Export MP4'}
              </button>
            </aside>
          </section>

          {media && (
            <section className="precision-trimmer" aria-label="Precision trimmer">
              <div className="trimmer-heading">
                <div>
                  <span className="step">03</span>
                  <div>
                    <h2>Precision trimmer</h2>
                    <p>Drag the handles, click the filmstrip to seek, or use I / O to mark the playhead.</p>
                  </div>
                </div>
                <span className="selection-readout">SELECTED · {formatTime(trimDuration)}</span>
              </div>
              <div className="filmstrip" onClick={seekFromTimeline}>
                {thumbnails.length
                  ? thumbnails.map((thumbnail, index) => (
                      <img src={thumbnail} alt="" key={`${thumbnail.slice(-12)}-${index}`} />
                    ))
                  : Array.from({ length: 8 }, (_, index) => <span className="film-placeholder" key={index} />)}
                <div className="excluded before" style={{ width: `${(start / media.duration) * 100}%` }} />
                <div
                  className="excluded after"
                  style={{
                    width: `${((media.duration - end) / media.duration) * 100}%`,
                  }}
                />
                <div
                  className="selected-range"
                  style={{
                    left: `${(start / media.duration) * 100}%`,
                    width: `${((end - start) / media.duration) * 100}%`,
                  }}
                />
                <div className="playhead" style={{ left: `${(playhead / media.duration) * 100}%` }}>
                  <span />
                </div>
              </div>
              <div className="range-controls">
                <input
                  aria-label="Trim start"
                  type="range"
                  min="0"
                  max={media.duration}
                  step={1 / 30}
                  value={start}
                  onChange={(event) => {
                    const value = Math.min(Number(event.target.value), end - 1 / 30)
                    setStart(value)
                    seek(value)
                  }}
                />
                <input
                  aria-label="Trim end"
                  type="range"
                  min="0"
                  max={media.duration}
                  step={1 / 30}
                  value={end}
                  onChange={(event) => {
                    const value = Math.max(Number(event.target.value), start + 1 / 30)
                    setEnd(value)
                    seek(value)
                  }}
                />
              </div>
              <div className="mark-controls">
                <button onClick={() => setStart(Math.min(playhead, end - 1 / 30))}>
                  <kbd>I</kbd> Set In <span>{formatTime(start)}</span>
                </button>
                <button onClick={() => seek(start)}>Go to In</button>
                <button onClick={() => seek(end)}>Go to Out</button>
                <button onClick={() => setEnd(Math.max(playhead, start + 1 / 30))}>
                  <kbd>O</kbd> Set Out <span>{formatTime(end)}</span>
                </button>
              </div>
            </section>
          )}

          {clips.length > 0 && (
            <section className="sequence-editor" aria-label="Clip timeline">
              <div className="sequence-toolbar">
                <div>
                  <span className="step">04</span>
                  <div>
                    <h2>Sequence</h2>
                    <p>Clips ripple automatically · {formatTime(timelineDuration(clips))} total</p>
                  </div>
                </div>
                <div className="history-actions">
                  <button onClick={undo} disabled={!undoStack.length} aria-label="Undo">
                    <Undo2 size={15} />
                  </button>
                  <button onClick={redo} disabled={!redoStack.length} aria-label="Redo">
                    <Redo2 size={15} />
                  </button>
                </div>
              </div>
              <div className="clip-lane" role="group" aria-label="Sequence clips">
                {clips.map((clip, index) => {
                  const asset = assets.find((candidate) => candidate.id === clip.assetId)
                  const duration = clip.sourceOut - clip.sourceIn
                  return (
                    <button
                      key={clip.id}
                      aria-pressed={selectedClipId === clip.id}
                      className={selectedClipId === clip.id ? 'timeline-clip selected' : 'timeline-clip'}
                      style={{ flexGrow: Math.max(1, duration) }}
                      onClick={() => selectTimelineClip(clip)}
                    >
                      <span className="clip-index">{String(index + 1).padStart(2, '0')}</span>
                      <strong>{asset?.file.name ?? 'Missing asset'}</strong>
                      <small>{formatTime(duration)}</small>
                    </button>
                  )
                })}
              </div>
              {selectedClipId &&
                (() => {
                  const selected = clips.find((clip) => clip.id === selectedClipId)
                  const index = clips.findIndex((clip) => clip.id === selectedClipId)
                  if (!selected) return null
                  return (
                    <div className="clip-actions">
                      <button disabled={index === 0} onClick={() => commitClips(moveClip(clips, selected.id, -1))}>
                        ← Move earlier
                      </button>
                      <button
                        onClick={() => {
                          const next = splitClip(clips, selected.id, playhead)
                          if (next === clips) {
                            setError('Move the playhead inside the selected clip before splitting.')
                            return
                          }
                          commitClips(next)
                          selectTimelineClip(next[index + 1])
                        }}
                      >
                        <Scissors size={13} /> Split at playhead
                      </button>
                      <button
                        disabled={index === clips.length - 1}
                        onClick={() => commitClips(moveClip(clips, selected.id, 1))}
                      >
                        Move later →
                      </button>
                      <button onClick={() => commitClips(duplicateClip(clips, selected.id))}>
                        <Copy size={13} /> Duplicate
                      </button>
                      <button
                        className="danger-action"
                        onClick={() => {
                          commitClips(removeClip(clips, selected.id))
                          setSelectedClipId(null)
                        }}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  )
                })()}
              {sequenceDuration > MAX_OUTPUT_SECONDS ? (
                <p className="sequence-note error-note">
                  Sequence is {formatTime(sequenceDuration)}. Shorten it to the 60-second export limit.
                </p>
              ) : (
                <p className="sequence-note">
                  Export will compose this complete sequence with continuous source audio and generated silence where
                  needed.
                </p>
              )}
            </section>
          )}

          {clips.length > 0 && (
            <section className="composition-tools" aria-label="Text and audio tools">
              <div className="composition-card">
                <div className="tool-heading">
                  <Type size={17} />
                  <div>
                    <h2>Timed text</h2>
                    <p>Add a title or a small thought. Play the sequence to preview it.</p>
                  </div>
                </div>
                {!textOverlay ? (
                  <button
                    className="tool-add"
                    onClick={() =>
                      setTextOverlay({
                        id: crypto.randomUUID(),
                        text: 'Your story starts here',
                        start: 0,
                        end: Math.min(3, sequenceDuration),
                        x: 0.5,
                        y: 0.82,
                        fontSize: 56,
                        colour: '#ffffff',
                        background: '#11110fcc',
                      })
                    }
                  >
                    <Plus size={14} /> Add text overlay
                  </button>
                ) : (
                  <div className="tool-fields">
                    <textarea
                      aria-label="Overlay text"
                      rows={2}
                      value={textOverlay.text}
                      onChange={(event) =>
                        setTextOverlay({
                          ...textOverlay,
                          text: event.target.value,
                        })
                      }
                    />
                    <div className="field-row">
                      <label>
                        Start
                        <input
                          type="number"
                          min="0"
                          max={textOverlay.end}
                          step="0.1"
                          value={textOverlay.start}
                          onChange={(event) =>
                            setTextOverlay({
                              ...textOverlay,
                              start: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        End
                        <input
                          type="number"
                          min={textOverlay.start}
                          max={sequenceDuration}
                          step="0.1"
                          value={textOverlay.end}
                          onChange={(event) =>
                            setTextOverlay({
                              ...textOverlay,
                              end: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Size
                        <input
                          type="number"
                          min="18"
                          max="140"
                          value={textOverlay.fontSize}
                          onChange={(event) =>
                            setTextOverlay({
                              ...textOverlay,
                              fontSize: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="field-row">
                      <label>
                        X
                        <input
                          type="range"
                          min="0.05"
                          max="0.95"
                          step="0.01"
                          value={textOverlay.x}
                          onChange={(event) =>
                            setTextOverlay({
                              ...textOverlay,
                              x: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Y
                        <input
                          type="range"
                          min="0.05"
                          max="0.95"
                          step="0.01"
                          value={textOverlay.y}
                          onChange={(event) =>
                            setTextOverlay({
                              ...textOverlay,
                              y: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Colour
                        <input
                          type="color"
                          value={textOverlay.colour}
                          onChange={(event) =>
                            setTextOverlay({
                              ...textOverlay,
                              colour: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <button className="remove-tool" onClick={() => setTextOverlay(null)}>
                      <Trash2 size={13} /> Remove text
                    </button>
                  </div>
                )}
              </div>
              <div className="composition-card">
                <div className="tool-heading">
                  <Music2 size={17} />
                  <div>
                    <h2>Background music</h2>
                    <p>Set the mood. Music plays in sync with sequence preview.</p>
                  </div>
                </div>
                {!music ? (
                  <label className="tool-add">
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(event) => void chooseMusic(event.target.files?.[0])}
                    />
                    <Plus size={14} /> Choose music
                  </label>
                ) : (
                  <div className="tool-fields">
                    <div className="music-file">
                      <strong>{music.file.name}</strong>
                      <span>{formatTime(music.duration)}</span>
                    </div>
                    <p className="music-preview-hint">Play the sequence to hear your mix.</p>
                    <div className="field-row">
                      <label>
                        Source {Math.round(sourceGain * 100)}%
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={sourceGain}
                          onChange={(event) => setSourceGain(Number(event.target.value))}
                        />
                      </label>
                      <label>
                        Music {Math.round(musicGain * 100)}%
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={musicGain}
                          onChange={(event) => setMusicGain(Number(event.target.value))}
                        />
                      </label>
                      <label>
                        Starts at
                        <input
                          type="number"
                          min="0"
                          max={sequenceDuration}
                          step="0.1"
                          value={musicOffset}
                          onChange={(event) => setMusicOffset(Number(event.target.value))}
                        />
                      </label>
                    </div>
                    <button
                      className="remove-tool"
                      onClick={() => {
                        URL.revokeObjectURL(music.url)
                        setMusic(null)
                      }}
                    >
                      <Trash2 size={13} /> Remove music
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}
        </fieldset>
        {music && <audio ref={musicPreviewRef} src={music.url} preload="auto" />}
        <section className={`status-card status-${stage}`} aria-live="polite">
          <div className="status-icon">
            {isWorking ? <LoaderCircle className="spin" /> : stage === 'complete' ? <CheckCircle2 /> : <Info />}
          </div>
          <div className="status-copy">
            <strong>{status}</strong>
            <span>
              {progress !== undefined && isWorking
                ? 'Measured encoder progress'
                : 'No upload. No server. No surprises.'}
            </span>
          </div>
          {progress !== undefined && isWorking && (
            <div className="progress-track">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </section>

        {isWorking && (
          <button className="cancel-button" onClick={cancelExport}>
            Cancel export
          </button>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <Info size={18} />
            <span>{error}</span>
          </div>
        )}

        {resultUrl && (
          <section className="result-card">
            <div className="result-copy">
              <span className="step">05</span>
              <div>
                <h2>Your cut is ready</h2>
                <p>Encoded in {elapsed?.toFixed(1)} seconds. Verify playback, then save the MP4.</p>
              </div>
            </div>
            <video src={resultUrl} controls playsInline />
            <a
              className="primary-button download"
              href={resultUrl}
              download={`${projectName.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'spool-export'}.mp4`}
            >
              <Download size={18} /> Download MP4
            </a>
          </section>
        )}
        <section className="why-spool" aria-label="Why Spool">
          <div className="why-intro">
            <span className="section-label">02 / MADE FOR THE MOMENT</span>
            <h2>
              Less between you
              <br />
              and <span>your next idea.</span>
            </h2>
            <p>A focused little studio. Everything you need to make a short video feel like you.</p>
          </div>
          <div className="benefit-card">
            <ShieldCheck size={24} />
            <strong>
              100%<span>yours.</span>
            </strong>
            <p>Your files stay on your device. From the first import to the final frame.</p>
          </div>
          <div className="benefit-card mint">
            <Film size={24} />
            <strong>
              One story.<span>Any canvas.</span>
            </strong>
            <p>Landscape, portrait or square. Ready for wherever your story goes next.</p>
          </div>
        </section>
      </main>

      <footer>
        <a className="brand" href="#">
          <span className="brand-mark">
            <span />
          </span>
          spool
        </a>
        <span>Small edits. Lasting moments.</span>
        <a href="#studio">Back to your studio ↗</a>
      </footer>
    </div>
  )
}
