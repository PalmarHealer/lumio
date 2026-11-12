import type { DeckSegment, Keyframe, Transition } from './types.ts'

/**
 * Where each deck is in its track during a transition. A deck starts at a track position and advances by the integral
 * of its rate curve, walking its path: each segment plays from → to, `repeat` times (a loop jumps back from `to` to
 * `from`); after the last one the deck plays straight on from that segment's end.
 */

/** A deck's material: where it starts and the loops it walks. */
export interface Lane {
  start: number
  path: DeckSegment[]
}

const validSegment = (s: DeckSegment) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from && s.repeat >= 1

/** The track position after `advance` seconds of the deck's own material. */
export function lanePosition(lane: Lane, advance: number): number {
  if (advance <= 0) return lane.start + advance
  let left = advance
  let position = lane.start
  for (const segment of lane.path) {
    if (!validSegment(segment)) continue
    const span = segment.to - segment.from
    const total = span * Math.round(segment.repeat)
    if (left < total) return segment.from + (left % span)
    left -= total
    position = segment.to
  }
  return position + left
}

/** The advances (sorted) at which the lane plays one of the track's beats, up to `maxAdvance`. */
export function laneBeats(lane: Lane, beats: readonly number[], maxAdvance: number): number[] {
  const result: number[] = []
  const take = (from: number, to: number, offset: number) => {
    // Beats in [from, to), placed at offset + (beat − from).
    let lo = 0
    let hi = beats.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (beats[mid] < from - 1e-6) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < beats.length && beats[i] < to - 1e-6; i++) {
      const advance = offset + beats[i] - from
      if (advance > maxAdvance) return false
      result.push(advance)
    }
    return true
  }
  let offset = 0
  let position = lane.start
  for (const segment of lane.path) {
    if (!validSegment(segment)) continue
    const span = segment.to - segment.from
    for (let k = 0; k < Math.round(segment.repeat); k++) {
      if (!take(segment.from, segment.to, offset)) return result
      offset += span
      if (offset > maxAdvance) return result
    }
    position = segment.to
  }
  take(position, Infinity, offset)
  return result
}

/** The track stretches the lane plays over advances [0, maxAdvance] (each once, in order). */
export function laneStretches(lane: Lane, maxAdvance: number): Array<[number, number]> {
  const result: Array<[number, number]> = []
  let left = maxAdvance
  let position = lane.start
  for (const segment of lane.path) {
    if (!validSegment(segment) || left <= 0) continue
    const span = segment.to - segment.from
    const total = span * Math.round(segment.repeat)
    result.push([segment.from, segment.from + Math.min(span, left)])
    left -= total
    position = segment.to
  }
  if (left > 0) result.push([position, position + left])
  return result
}

/** The furthest track position the lane reaches within `maxAdvance`. */
export function laneReach(lane: Lane, maxAdvance: number): number {
  return Math.max(lane.start, ...laneStretches(lane, maxAdvance).map(([, to]) => to))
}

/** ∫ rate dt from t0 to t1 for a keyframed rate (linear between keyframes, held outside; empty = 1). */
export function rateAdvance(curve: readonly Keyframe[], t0: number, t1: number): number {
  if (t1 <= t0) return 0
  if (curve.length === 0) return t1 - t0
  const at = (t: number) => {
    // At a keyframe's time the value after it counts (a step at t is the new value from t on).
    if (t < curve[0].t) return curve[0].v
    const last = curve[curve.length - 1]
    if (t >= last.t) return last.v
    for (let i = 1; i < curve.length; i++)
      if (t < curve[i].t) {
        const p = curve[i - 1]
        const q = curve[i]
        return p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t)
      }
    return last.v
  }
  // Exact for a piecewise-linear curve: trapezoids between the breakpoints inside [t0, t1].
  const points = [t0, ...curve.map((k) => k.t).filter((t) => t > t0 && t < t1), t1]
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += ((at(points[i - 1]) + at(points[i])) / 2) * (points[i] - points[i - 1])
  return sum
}

/** A deck's track position at transition time t (B: null before it starts). */
export function deckPosition(transition: Transition, deck: 'a' | 'b', t: number): number | null {
  if (deck === 'a') return lanePosition({ start: transition.aOut, path: transition.pathA ?? [] }, rateAdvance(transition.rateA ?? [], 0, t))
  if (t < transition.bAt) return null
  return lanePosition({ start: transition.bIn, path: transition.pathB ?? [] }, rateAdvance(transition.rateB ?? [], transition.bAt, t))
}

/** The rate of a deck at transition time t. */
export function rateAt(curve: readonly Keyframe[], t: number): number {
  return rateAdvance(curve, t, t + 1e-3) / 1e-3
}
