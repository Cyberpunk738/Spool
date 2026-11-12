import { describe, expect, it } from 'vitest'
import {
  clipTimelineStart,
  duplicateClip,
  trimClip,
  moveClip,
  removeClip,
  splitClip,
  timelineDuration,
  type TimelineClip,
} from './timeline'

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
    expect(splitClip(clips, 'a', NaN)).toBe(clips)
    expect(splitClip(clips, 'a', Infinity)).toBe(clips)
  })

  it('ripples after deletion and reorder', () => {
    expect(clipTimelineStart(removeClip(clips, 'a'), 'b')).toBe(0)
    expect(moveClip(clips, 'b', -1).map((clip) => clip.id)).toEqual(['b', 'a'])
  })
})

describe('editing an existing sequence clip', () => {
  it('updates only the target range and preserves identity and ordering', () => {
    const result = trimClip(clips, 'b', 3, 7)
    expect(result[0]).toBe(clips[0])
    expect(result[1]).toEqual({ ...clips[1], sourceIn: 3, sourceOut: 7 })
    expect(timelineDuration(result)).toBe(8)
    expect(clips[1].sourceIn).toBe(2)
  })

  it('rejects invalid, nonfinite, reversed, missing and unchanged trims', () => {
    for (const [start, end] of [
      [-1, 5],
      [5, 5],
      [8, 3],
      [NaN, 5],
      [0, Infinity],
      [1, 5],
    ]) {
      expect(trimClip(clips, 'a', start, end)).toBe(clips)
    }
    expect(trimClip(clips, 'missing', 0, 1)).toBe(clips)
  })

  it('duplicates immediately after the selected clip with independent identity', () => {
    const result = duplicateClip(clips, 'a')
    expect(result.map((clip) => clip.assetId)).toEqual(['one', 'one', 'two'])
    expect(result[1]).toMatchObject({
      assetId: 'one',
      sourceIn: 1,
      sourceOut: 5,
    })
    expect(result[1].id).not.toBe('a')
    expect(timelineDuration(result)).toBe(14)
    expect(duplicateClip(clips, 'missing')).toBe(clips)
  })
})
