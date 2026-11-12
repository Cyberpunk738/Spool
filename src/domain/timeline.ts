export interface TimelineClip {
  id: string
  assetId: string
  sourceIn: number
  sourceOut: number
}

export function clipDuration(clip: TimelineClip): number {
  return clip.sourceOut - clip.sourceIn
}

export function timelineDuration(clips: TimelineClip[]): number {
  return clips.reduce((total, clip) => total + clipDuration(clip), 0)
}

export function splitClip(clips: TimelineClip[], clipId: string, sourceTime: number): TimelineClip[] {
  const index = clips.findIndex((clip) => clip.id === clipId)
  if (index < 0 || !Number.isFinite(sourceTime)) return clips
  const clip = clips[index]
  if (sourceTime <= clip.sourceIn || sourceTime >= clip.sourceOut) return clips
  const left: TimelineClip = {
    ...clip,
    id: crypto.randomUUID(),
    sourceOut: sourceTime,
  }
  const right: TimelineClip = {
    ...clip,
    id: crypto.randomUUID(),
    sourceIn: sourceTime,
  }
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)]
}

export function removeClip(clips: TimelineClip[], clipId: string): TimelineClip[] {
  return clips.filter((clip) => clip.id !== clipId)
}

export function moveClip(clips: TimelineClip[], clipId: string, direction: -1 | 1): TimelineClip[] {
  const index = clips.findIndex((clip) => clip.id === clipId)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= clips.length) return clips
  const next = [...clips]
  ;[next[index], next[destination]] = [next[destination], next[index]]
  return next
}

export function clipTimelineStart(clips: TimelineClip[], clipId: string): number {
  const index = clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return 0
  return timelineDuration(clips.slice(0, index))
}

/** Replace a clip's source range without changing its identity or neighbours. */
export function trimClip(clips: TimelineClip[], clipId: string, sourceIn: number, sourceOut: number): TimelineClip[] {
  if (!Number.isFinite(sourceIn) || !Number.isFinite(sourceOut) || sourceIn < 0 || sourceOut <= sourceIn) return clips
  const clip = clips.find((item) => item.id === clipId)
  if (!clip || (clip.sourceIn === sourceIn && clip.sourceOut === sourceOut)) return clips
  return clips.map((item) => (item.id === clipId ? { ...item, sourceIn, sourceOut } : item))
}

export function duplicateClip(clips: TimelineClip[], clipId: string): TimelineClip[] {
  const index = clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return clips
  return [...clips.slice(0, index + 1), { ...clips[index], id: crypto.randomUUID() }, ...clips.slice(index + 1)]
}
