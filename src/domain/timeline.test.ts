import { describe, expect, it } from 'vitest'
import { clipTimelineStart, moveClip, removeClip, splitClip, timelineDuration, type TimelineClip } from './timeline'

const clips: TimelineClip[] = [
  { id: 'a', assetId: 'one', sourceIn: 1, sourceOut: 5 },
  { id: 'b', assetId: 'two', sourceIn: 2, sourceOut: 8 },
]

describe('timeline operations', () => {
  it('splits without losing source coverage or duration', () => {
    const result = splitClip(clips, 'a', 3)
    expect(result).toHaveLength(3)
    expect(result[0].sourceIn).toBe(1)
    expect(result[0].sourceOut).toBe(3)
    expect(result[1].sourceIn).toBe(3)
    expect(result[1].sourceOut).toBe(5)
    expect(timelineDuration(result)).toBe(timelineDuration(clips))
  })

  it('rejects endpoint splits', () => {
    expect(splitClip(clips, 'a', 1)).toBe(clips)
    expect(splitClip(clips, 'a', 5)).toBe(clips)
  })

  it('ripples after deletion and reorder', () => {
    expect(clipTimelineStart(removeClip(clips, 'a'), 'b')).toBe(0)
    expect(moveClip(clips, 'b', -1).map((clip) => clip.id)).toEqual(['b', 'a'])
  })
})
