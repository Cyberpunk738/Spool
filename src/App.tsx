import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
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
  Undo2,
  Scissors,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { FfmpegEngine, type ExportStage } from './services/ffmpegEngine'
import { moveClip, removeClip, splitClip, timelineDuration, type TimelineClip } from './domain/timeline'
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

type OutputPreset = 'landscape' | 'portrait' | 'square'

const OUTPUT_PRESETS: Record<OutputPreset, { label: string; width: number; height: number; ratio: string }> = {
  landscape: { label: 'Landscape', width: 1280, height: 720, ratio: '16 / 9' },
  portrait: { label: 'Portrait', width: 720, height: 1280, ratio: '9 / 16' },
  square: { label: 'Square', width: 720, height: 720, ratio: '1 / 1' },
}

const BACKGROUNDS = ['#11110f', '#edece5', '#d9ff53', '#2738d1', '#d04b32'] as const

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
      resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight, url })
    }
    video.onerror = () => {
      window.clearTimeout(timeout)
      URL.revokeObjectURL(url)
      reject(new Error('This browser cannot decode the selected video. Try MP4 (H.264) or WebM.'))
    }
    video.src = url
  })
}

export default function App() {
  const engineRef = useRef<FfmpegEngine | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
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
  const [background, setBackground] = useState<string>('#11110f')
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

  const isWorking = ['loading-engine', 'preparing', 'encoding', 'finalizing'].includes(stage)
  const trimDuration = Math.max(0, end - start)
  const sequenceDuration = timelineDuration(clips)
  const output = OUTPUT_PRESETS[preset]
  const canExport = clips.length
    ? sequenceDuration > 0 && sequenceDuration <= MAX_OUTPUT_SECONDS && !isWorking
    : Boolean(file && media && trimDuration > 0 && trimDuration <= MAX_OUTPUT_SECONDS && !isWorking)

  const selectedAsset = assets.find((asset) => asset.file === file)

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
          const restoredFile = new File([stored.blob], stored.name, { type: stored.type, lastModified: stored.lastModified })
          const restoredMedia = await readVideoMetadata(restoredFile)
          restored.push({ id: stored.id, file: restoredFile, media: restoredMedia })
        }
        if (cancelled) {
          for (const asset of restored) URL.revokeObjectURL(asset.media.url)
          return
        }
        setAssets(restored)
        setClips(saved.clips)
        setPreset(saved.preset)
        setBackground(saved.background)
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
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!hydrated || !assets.length) return
    setSaveState('saving')
    const timeout = window.setTimeout(() => {
      void saveProject({
        schemaVersion: 1,
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
        updatedAt: new Date().toISOString(),
      }).then(() => setSaveState('saved')).catch((caught: unknown) => {
        setSaveState('failed')
        setError(caught instanceof Error ? caught.message : 'Local autosave failed.')
      })
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [assets, background, clips, hydrated, preset])

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

    const seekTo = (time: number) => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Thumbnail seek timed out.')), 4_000)
      capture.onseeked = () => { window.clearTimeout(timeout); resolve() }
      capture.onerror = () => { window.clearTimeout(timeout); reject(new Error('Thumbnail decode failed.')) }
      capture.currentTime = time
    })

    const generate = async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          if (capture.readyState >= 1) { resolve(); return }
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
      if (!media || target?.matches('input, textarea, select, [contenteditable="true"]')) return
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

  const chooseFiles = async (selectedFiles: FileList | File[] | null | undefined) => {
    if (!selectedFiles?.length) return
    setError(null)
    resetResult()
    const incoming = Array.from(selectedFiles)
    if (assets.length + incoming.length > 5) {
      setError('Spool supports up to five source videos in this release.')
      return
    }
    if (assets.reduce((sum, asset) => sum + asset.file.size, 0) + incoming.reduce((sum, item) => sum + item.size, 0) > MAX_FILE_BYTES) {
      setError('Those files exceed Spool’s 250 MB project limit.')
      return
    }

    try {
      setStatus(`Reading ${incoming.length} video${incoming.length === 1 ? '' : 's'}…`)
      const imported = await Promise.all(incoming.map(async (selected) => ({
        id: crypto.randomUUID(),
        file: selected,
        media: await readVideoMetadata(selected),
      })))
      const first = imported[0]
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
    }
  }

  const selectAsset = (asset: MediaAsset) => {
    videoRef.current?.pause()
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
    setSelectedClipId(clip.id)
  }

  const selectTimelineClip = (clip: TimelineClip) => {
    const asset = assets.find((candidate) => candidate.id === clip.assetId)
    if (!asset) return
    selectAsset(asset)
    setStart(clip.sourceIn)
    setEnd(clip.sourceOut)
    setSelectedClipId(clip.id)
    seek(clip.sourceIn)
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
        assets: assets.map((asset) => ({ id: asset.id, name: asset.file.name, type: asset.file.type, lastModified: asset.file.lastModified, blob: asset.file })),
        clips,
        preset,
        background,
        updatedAt: new Date().toISOString(),
      })
      setSaveState('saved')
    } catch (caught) {
      setSaveState('failed')
      setError(caught instanceof Error ? caught.message : 'Local save failed. Check browser storage permissions and quota.')
    }
  }

  const exportVideo = async () => {
    if (!canExport) return
    setError(null)
    resetResult()
    const engine = engineRef.current ?? new FfmpegEngine()
    engineRef.current = engine
    const startedAt = performance.now()

    try {
      const onUpdate = (update: { stage: ExportStage; detail: string; progress?: number }) => {
        setStage(update.stage)
        setStatus(update.detail)
        setProgress(update.progress)
      }
      const blob = clips.length
        ? await engine.exportTimeline({
          assets: assets.map((asset) => ({ id: asset.id, file: asset.file })),
          clips,
          output: { width: output.width, height: output.height, background },
          onUpdate,
        })
        : file && media
          ? await engine.exportTrimmed({
            source: file,
            startSeconds: start,
            endSeconds: end,
            output: { width: output.width, height: output.height, background },
            onUpdate,
          })
          : null
      if (!blob) throw new Error('Choose a video or add clips to the timeline before exporting.')
      const url = URL.createObjectURL(blob)
      resultUrlRef.current = url
      setResultUrl(url)
      setElapsed((performance.now() - startedAt) / 1000)
      setStage('complete')
      setProgress(1)
      setStatus(`${clips.length ? 'Timeline' : 'Clip'} export complete. Play the independent result below before downloading.`)
    } catch (caught) {
      const cancelled = caught instanceof DOMException && caught.name === 'AbortError'
      setStage(cancelled ? 'cancelled' : 'failed')
      setStatus(cancelled ? 'Export cancelled. The engine will reload on your next attempt.' : 'Export failed.')
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'An unknown export error occurred.')
    }
  }

  const cancelExport = () => {
    engineRef.current?.cancel()
    setStage('cancelled')
    setProgress(undefined)
    setStatus('Export cancelled. The engine will reload on your next attempt.')
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
    await video.play()
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video) return
    if (loopSelection && video.currentTime >= end) {
      video.currentTime = start
      if (!video.paused) void video.play()
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
          <span className="brand-mark"><span /></span>
          <span>spool</span>
        </a>
        <div className="project-name">
          <span>Untitled project</span>
          <ChevronDown size={14} />
        </div>
        <div className="top-actions">
          <span className="local-pill"><ShieldCheck size={14} /> Your media stays on this device</span>
          <button className={`ghost-button save-${saveState}`} onClick={() => void saveNow()} disabled={!assets.length || saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved locally' : saveState === 'failed' ? 'Save failed · Retry' : 'Save project'}
          </button>
          <button className="primary-button compact" onClick={exportVideo} disabled={!canExport}>
            <Sparkles size={16} /> Export
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow"><span /> Milestone 0 · Export lab</div>
          <h1>Make the cut.<br /><em>Keep the moment.</em></h1>
          <p>Spool is a private video editor that works entirely in your browser. This first working slice proves precise, local MP4 export before the full timeline arrives.</p>
        </section>

        <section className="workspace" aria-label="Video export workspace">
          <aside className="side-panel">
            <div className="panel-heading">
              <div><span className="step">01</span><h2>Source</h2></div>
              {file && <span className="asset-count">{assets.length}/5</span>}
            </div>

            {!assets.length ? (
              <label className="drop-zone">
                <input type="file" accept="video/*" multiple onChange={(event) => void chooseFiles(event.target.files)} />
                <span className="upload-icon"><FolderOpen size={25} /></span>
                <strong>Choose videos</strong>
                <small>Up to 5 clips · 250 MB total</small>
              </label>
            ) : (
              <div className="media-bin">
                {assets.map((asset) => (
                  <button key={asset.id} className={asset.file === file ? 'asset-card selected' : 'asset-card'} onClick={() => selectAsset(asset)}>
                    <div className="asset-thumb"><Film size={18} /></div>
                    <div className="asset-copy"><strong>{asset.file.name}</strong><span>{(asset.file.size / (1024 * 1024)).toFixed(1)} MB · {formatTime(asset.media.duration)}</span></div>
                    {asset.file === file && <CheckCircle2 className="success" size={16} />}
                  </button>
                ))}
                <label className="add-media">
                  <input type="file" accept="video/*" multiple onChange={(event) => void chooseFiles(event.target.files)} />
                  <Plus size={14} /> Import more
                </label>
                <button className="add-timeline" onClick={addSelectedAsset}><Plus size={14} /> Add selection to timeline</button>
              </div>
            )}

            <div className="facts">
              <div><HardDrive size={15} /><span>Processed locally</span></div>
              <div><Gauge size={15} /><span>60 second output limit</span></div>
            </div>
          </aside>

          <section className="preview-panel">
            <div className="preview-stage">
            <div className="preview-frame" style={{ aspectRatio: output.ratio, background }}>
              {media ? <video ref={videoRef} key={media.url} src={media.url} playsInline onTimeUpdate={handleTimeUpdate} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} /> : (
                <div className="empty-preview">
                  <span><Play size={24} fill="currentColor" /></span>
                  <strong>Your preview lives here</strong>
                  <small>Import a clip to start shaping your story.</small>
                </div>
              )}
            </div>
            </div>
            <div className="preview-footer">
              <span>{output.label.toUpperCase()} · {output.width} × {output.height}</span>
              <span>{formatTime(playhead)} · 30 FPS</span>
            </div>
            {media && (
              <div className="transport" aria-label="Preview controls">
                <button onClick={() => stepFrame(-1)} aria-label="Previous frame"><SkipBack size={15} /></button>
                <button className="play-button" onClick={() => void togglePlayback()} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
                <button onClick={() => stepFrame(1)} aria-label="Next frame"><SkipForward size={15} /></button>
                <span className="transport-time">{formatTime(playhead)}</span>
                <label className="loop-toggle"><input type="checkbox" checked={loopSelection} onChange={(event) => setLoopSelection(event.target.checked)} /> Loop selection</label>
              </div>
            )}
          </section>

          <aside className="side-panel inspector">
            <div className="panel-heading"><div><span className="step">02</span><h2>Trim</h2></div><Scissors size={18} /></div>
            <p className="hint">Set the exact section to keep. Spool decodes through the cut for frame-accurate output.</p>
            <div className="time-inputs">
              <label>Start<input type="number" min="0" max={end} step="0.01" value={start} disabled={!media || isWorking} onChange={(e) => setStart(Math.max(0, Math.min(Number(e.target.value), end - 0.01)))} /></label>
              <span>→</span>
              <label>End<input type="number" min={start} max={media?.duration ?? 0} step="0.01" value={end} disabled={!media || isWorking} onChange={(e) => setEnd(Math.min(media?.duration ?? 0, Math.max(Number(e.target.value), start + 0.01)))} /></label>
            </div>
            <div className="duration-card"><span>Output duration</span><strong>{formatTime(trimDuration)}</strong></div>
            <div className="format-studio">
              <div className="control-label"><span>Canvas format</span><small>{output.width} × {output.height}</small></div>
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
              <div className="control-label colour-label"><span>Letterbox colour</span><small>{background}</small></div>
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
            <button className="primary-button full" onClick={exportVideo} disabled={!canExport}>
              {isWorking ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}
              {isWorking ? 'Exporting…' : clips.length ? `Export ${clips.length} clips` : 'Export MP4'}
            </button>
            {isWorking && <button className="cancel-button" onClick={cancelExport}>Cancel export</button>}
          </aside>
        </section>

        {media && (
          <section className="precision-trimmer" aria-label="Precision trimmer">
            <div className="trimmer-heading">
              <div><span className="step">03</span><div><h2>Precision trimmer</h2><p>Drag the handles, click the filmstrip to seek, or use I / O to mark the playhead.</p></div></div>
              <span className="selection-readout">SELECTED · {formatTime(trimDuration)}</span>
            </div>
            <div className="filmstrip" onClick={seekFromTimeline}>
              {thumbnails.length ? thumbnails.map((thumbnail, index) => <img src={thumbnail} alt="" key={`${thumbnail.slice(-12)}-${index}`} />) : Array.from({ length: 8 }, (_, index) => <span className="film-placeholder" key={index} />)}
              <div className="excluded before" style={{ width: `${(start / media.duration) * 100}%` }} />
              <div className="excluded after" style={{ width: `${((media.duration - end) / media.duration) * 100}%` }} />
              <div className="selected-range" style={{ left: `${(start / media.duration) * 100}%`, width: `${((end - start) / media.duration) * 100}%` }} />
              <div className="playhead" style={{ left: `${(playhead / media.duration) * 100}%` }}><span /></div>
            </div>
            <div className="range-controls">
              <input aria-label="Trim start" type="range" min="0" max={media.duration} step={1 / 30} value={start} onChange={(event) => { const value = Math.min(Number(event.target.value), end - 1 / 30); setStart(value); seek(value) }} />
              <input aria-label="Trim end" type="range" min="0" max={media.duration} step={1 / 30} value={end} onChange={(event) => { const value = Math.max(Number(event.target.value), start + 1 / 30); setEnd(value); seek(value) }} />
            </div>
            <div className="mark-controls">
              <button onClick={() => setStart(Math.min(playhead, end - 1 / 30))}><kbd>I</kbd> Set In <span>{formatTime(start)}</span></button>
              <button onClick={() => seek(start)}>Go to In</button>
              <button onClick={() => seek(end)}>Go to Out</button>
              <button onClick={() => setEnd(Math.max(playhead, start + 1 / 30))}><kbd>O</kbd> Set Out <span>{formatTime(end)}</span></button>
            </div>
          </section>
        )}

        {clips.length > 0 && (
          <section className="sequence-editor" aria-label="Clip timeline">
            <div className="sequence-toolbar">
              <div><span className="step">04</span><div><h2>Sequence</h2><p>Clips ripple automatically · {formatTime(timelineDuration(clips))} total</p></div></div>
              <div className="history-actions">
                <button onClick={undo} disabled={!undoStack.length} aria-label="Undo"><Undo2 size={15} /></button>
                <button onClick={redo} disabled={!redoStack.length} aria-label="Redo"><Redo2 size={15} /></button>
              </div>
            </div>
            <div className="clip-lane">
              {clips.map((clip, index) => {
                const asset = assets.find((candidate) => candidate.id === clip.assetId)
                const duration = clip.sourceOut - clip.sourceIn
                return (
                  <button
                    key={clip.id}
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
            {selectedClipId && (() => {
              const selected = clips.find((clip) => clip.id === selectedClipId)
              const index = clips.findIndex((clip) => clip.id === selectedClipId)
              if (!selected) return null
              return (
                <div className="clip-actions">
                  <button disabled={index === 0} onClick={() => commitClips(moveClip(clips, selected.id, -1))}>← Move earlier</button>
                  <button onClick={() => {
                    const next = splitClip(clips, selected.id, playhead)
                    if (next === clips) { setError('Move the playhead inside the selected clip before splitting.'); return }
                    commitClips(next)
                    setSelectedClipId(next[index + 1].id)
                  }}><Scissors size={13} /> Split at playhead</button>
                  <button disabled={index === clips.length - 1} onClick={() => commitClips(moveClip(clips, selected.id, 1))}>Move later →</button>
                  <button className="danger-action" onClick={() => { commitClips(removeClip(clips, selected.id)); setSelectedClipId(null) }}><Trash2 size={13} /> Delete</button>
                </div>
              )
            })()}
            {sequenceDuration > MAX_OUTPUT_SECONDS
              ? <p className="sequence-note error-note">Sequence is {formatTime(sequenceDuration)}. Shorten it to the 60-second export limit.</p>
              : <p className="sequence-note">Export will compose this complete sequence with continuous source audio and generated silence where needed.</p>}
          </section>
        )}

        <section className={`status-card status-${stage}`} aria-live="polite">
          <div className="status-icon">{isWorking ? <LoaderCircle className="spin" /> : stage === 'complete' ? <CheckCircle2 /> : <Info />}</div>
          <div className="status-copy"><strong>{status}</strong><span>{progress !== undefined && isWorking ? 'Measured encoder progress' : 'No upload. No server. No surprises.'}</span></div>
          {progress !== undefined && isWorking && <div className="progress-track"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        </section>

        {error && <div className="error-banner" role="alert"><Info size={18} /><span>{error}</span></div>}

        {resultUrl && (
          <section className="result-card">
            <div className="result-copy"><span className="step">05</span><div><h2>Your cut is ready</h2><p>Encoded in {elapsed?.toFixed(1)} seconds. Verify playback, then save the MP4.</p></div></div>
            <video src={resultUrl} controls playsInline />
            <a className="primary-button download" href={resultUrl} download={`spool-export-${Date.now()}.mp4`}><Download size={18} /> Download MP4</a>
          </section>
        )}
      </main>

      <footer><span>spool / local video tools</span><span>Built for short, intentional edits.</span></footer>
    </div>
  )
}
