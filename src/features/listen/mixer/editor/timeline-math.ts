import { valueAt } from '../presets.ts'
import { deckPosition } from '../timeline.ts'
import type { DeckAutomation, Keyframe, TrackMix, Transition } from '../types.ts'

/**
 * The transition editor's arithmetic, without DOM or React (node tests it): the time axis, where each deck is and what it
 * sounds like at each moment, its beat and bar grid in transition time, and keyframe edits. Times are transition time
 * (0: A at `aOut`; `length`: A gone), the editor's x axis spans −preRoll … length + postRoll.
 */

export type Deck = 'a' | 'b'

/** The lanes the editor shows, per deck. 'rate' is the transition's rateA / rateB. */
export type LaneParam = 'gain' | 'low' | 'mid' | 'high' | 'filter' | 'reverb' | 'rate' | 'drums' | 'vocals' | 'instrumental'

export interface LaneSpec {
  param: LaneParam
  /** Value range drawn from the bottom to the top of the row. */
  min: number
  max: number
  /** The value an empty lane means. */
  neutral: number
}

export const LANES: Record<LaneParam, LaneSpec> = {
  gain: { param: 'gain', min: 0, max: 1, neutral: 1 },
  low: { param: 'low', min: 0, max: 1, neutral: 1 },
  mid: { param: 'mid', min: 0, max: 1, neutral: 1 },
  high: { param: 'high', min: 0, max: 1, neutral: 1 },
  filter: { param: 'filter', min: -1, max: 1, neutral: 0 },
  reverb: { param: 'reverb', min: 0, max: 1, neutral: 0 },
  // A deck's tempo: ±8 % covers every beatmatch the planner makes (it keeps within 3.5 %).
  rate: { param: 'rate', min: 0.92, max: 1.08, neutral: 1 },
  drums: { param: 'drums', min: 0, max: 1, neutral: 1 },
  vocals: { param: 'vocals', min: 0, max: 1, neutral: 1 },
  instrumental: { param: 'instrumental', min: 0, max: 1, neutral: 1 },
}

// ---- the axis ----

/** Seconds shown (and played) before the transition and after it. */
export const PRE_ROLL = 8
export const POST_ROLL = 8

export interface Axis {
  /** Transition time at x = 0 and seconds per pixel. */
  from: number
  to: number
  pxPerSecond: number
}

export const xOf = (axis: Axis, t: number) => (t - axis.from) * axis.pxPerSecond
export const tOf = (axis: Axis, x: number) => axis.from + x / axis.pxPerSecond
export const axisWidth = (axis: Axis) => Math.max(1, Math.round((axis.to - axis.from) * axis.pxPerSecond))

// ---- keyframes ----

/** A deck's keyframes for a lane (rate: the transition's rateA/rateB). */
export function laneKeys(transition: Transition, deck: Deck, param: LaneParam): Keyframe[] {
  if (param === 'rate') return (deck === 'a' ? transition.rateA : transition.rateB) ?? []
  return (transition[deck] as DeckAutomation)[param] ?? []
}

/** The transition with a lane's keyframes replaced (sorted by time). */
export function withLaneKeys(transition: Transition, deck: Deck, param: LaneParam, keys: Keyframe[]): Transition {
  const sorted = [...keys].sort((p, q) => p.t - q.t)
  if (param === 'rate') return deck === 'a' ? { ...transition, rateA: sorted } : { ...transition, rateB: sorted }
  return { ...transition, [deck]: { ...transition[deck], [param]: sorted } }
}

/** A lane's value at t (its neutral value when empty). */
export function laneValue(transition: Transition, deck: Deck, param: LaneParam, t: number): number {
  const keys = laneKeys(transition, deck, param)
  return keys.length ? valueAt(keys, t, LANES[param].neutral) : LANES[param].neutral
}

const clampTo = (spec: LaneSpec, v: number) => Math.min(spec.max, Math.max(spec.min, v))

/**
 * Adds a keyframe at t (value clamped to the lane); returns the keys and the new one's index. An empty lane first gets
 * its value pinned at the transition's start and end (`bounds`), so moving the new point bends the curve there instead
 * of shifting the whole lane.
 */
export function addKey(keys: readonly Keyframe[], param: LaneParam, t: number, v: number, bounds?: { from: number; to: number }): { keys: Keyframe[]; index: number } {
  const key = { t, v: clampTo(LANES[param], v) }
  const pins = !keys.length && bounds ? [bounds.from, bounds.to].filter((at) => Math.abs(at - t) > 0.05).map((at) => ({ t: at, v: key.v })) : []
  const next = [...keys, ...pins, key].sort((p, q) => p.t - q.t)
  return { keys: next, index: next.indexOf(key) }
}

/** Moves keyframe i to (t, v): kept between its neighbours in time (the order never changes), value clamped. */
export function moveKey(keys: readonly Keyframe[], param: LaneParam, i: number, t: number, v: number): Keyframe[] {
  const lo = i > 0 ? keys[i - 1]!.t : -Infinity
  const hi = i + 1 < keys.length ? keys[i + 1]!.t : Infinity
  return keys.map((key, k) => (k === i ? { t: Math.min(hi, Math.max(lo, t)), v: clampTo(LANES[param], v) } : key))
}

export const removeKey = (keys: readonly Keyframe[], i: number) => keys.filter((_, k) => k !== i)

// ---- the decks over time ----

/**
 * Where a deck is in its track at each pixel column's start (null: not playing, B before it comes in). With `ghost`,
 * what the deck leaves out instead: A's material after it is gone, B's before it comes in (drawn faintly, so a cut outro
 * or a skipped intro shows), and null where the deck plays.
 */
export function deckTrack(transition: Transition, deck: Deck, axis: Axis, ghost = false): Array<number | null> {
  const width = axisWidth(axis)
  const positions: Array<number | null> = new Array(width + 1)
  const aEnd = deckPosition(transition, 'a', transition.length) ?? transition.aOut + transition.length
  for (let x = 0; x <= width; x++) {
    const t = tOf(axis, x)
    if (deck === 'a') {
      const playing = t <= transition.length
      // Before 0 A plays toward aOut at its own pace; after length it is gone.
      positions[x] = ghost ? (playing ? null : aEnd + (t - transition.length)) : playing ? (t < 0 ? transition.aOut + t : deckPosition(transition, 'a', t)) : null
    } else {
      const playing = t >= transition.bAt
      positions[x] = ghost ? (playing ? null : transition.bIn + (t - transition.bAt)) : playing ? deckPosition(transition, 'b', t) : null
    }
  }
  return positions
}

/** What a column sounds like, per band (0–1 each, before the deck's level). */
export interface Column {
  low: number
  mid: number
  high: number
  /** Overall energy (0–1). */
  energy: number
  /** Singing here (from the analysis). */
  vocal: boolean
}

/** Level curves over a song: the analysis' (10 a second), or finer ones worked out from the loaded audio. */
export interface Curves {
  frameRate: number
  duration: number
  energy: number[]
  bands: { low: number[]; mid: number[]; high: number[] }
}

/** The loudest frame between two track positions (a column), per band. */
function frameMax(curves: Curves, from: number, to: number): Column {
  const rate = curves.frameRate || 10
  const lo = Math.max(0, Math.floor(Math.min(from, to) * rate))
  const hi = Math.min(curves.energy.length - 1, Math.max(lo, Math.ceil(Math.max(from, to) * rate)))
  const column: Column = { low: 0, mid: 0, high: 0, energy: 0, vocal: false }
  for (let i = lo; i <= hi; i++) {
    column.low = Math.max(column.low, curves.bands.low[i] ?? 0)
    column.mid = Math.max(column.mid, curves.bands.mid[i] ?? 0)
    column.high = Math.max(column.high, curves.bands.high[i] ?? 0)
    column.energy = Math.max(column.energy, curves.energy[i] ?? 0)
  }
  return column
}

/**
 * Each column of a deck (null where it doesn't play or nothing is known): its levels from `fine` curves where they
 * reach, else from the analysis; singing from the analysis.
 */
export function deckColumns(mix: TrackMix | null, positions: ReadonlyArray<number | null>, fine: Curves | null = null): Array<Column | null> {
  const columns: Array<Column | null> = []
  for (let x = 0; x + 1 < positions.length; x++) {
    const p = positions[x]
    const q = positions[x + 1]
    const curves = fine && p !== null && p <= fine.duration ? fine : mix
    if (!curves || p === null || q === null || p < 0 || p > curves.duration) {
      columns.push(null)
      continue
    }
    // A loop jumps back: the column holds what plays right after the jump.
    const column = frameMax(curves, q < p ? q : p, q < p ? q + 0.01 : q)
    const middle = (p + q) / 2
    column.vocal = !!mix?.vocals.some((span) => middle >= span.start && middle < span.end)
    columns.push(column)
  }
  return columns
}

/**
 * The transition times (within the axis) where a deck plays one of `marks` (track seconds: beats or downbeats),
 * found column by column, so loops and rate curves place them where they are heard.
 */
export function marksInTime(axis: Axis, positions: ReadonlyArray<number | null>, marks: readonly number[]): number[] {
  const out: number[] = []
  if (!marks.length) return out
  for (let x = 0; x + 1 < positions.length; x++) {
    const p = positions[x]
    const q = positions[x + 1]
    if (p === null || q === null || q <= p) continue
    // Marks in (p, q]: binary search for the first above p.
    let lo = 0
    let hi = marks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (marks[mid]! <= p) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < marks.length && marks[i]! <= q; i++) out.push(tOf(axis, x + (marks[i]! - p) / (q - p)))
  }
  return out
}

/** How many of B's bars (else A's) the overlap holds, from B's start to A's end: the "16 Takte" on the card. */
export function overlapBars(transition: Transition, aBars: readonly number[], bBars: readonly number[]): number {
  const within = (times: readonly number[]) => times.filter((t) => t >= transition.bAt - 1e-3 && t < transition.length - 1e-3).length
  return bBars.length ? within(bBars) : within(aBars)
}

/** The nearest of `grid` to t within `tolerance` seconds, else t. */
export function snap(t: number, grid: readonly number[], tolerance: number): number {
  let best = t
  let distance = tolerance
  for (const g of grid) {
    const d = Math.abs(g - t)
    if (d < distance) {
      distance = d
      best = g
    }
  }
  return best
}

// ---- timing edits ----

/** A deck's material moved under the transition (slip): A's or B's start in its track by `delta` seconds, loops along. */
export function slipDeck(transition: Transition, deck: Deck, delta: number): Transition {
  const move = (path: Transition['pathA']) => path.map((segment) => ({ ...segment, from: segment.from + delta, to: segment.to + delta }))
  return deck === 'a'
    ? { ...transition, aOut: transition.aOut + delta, pathA: move(transition.pathA ?? []) }
    : { ...transition, bIn: transition.bIn + delta, pathB: move(transition.pathB ?? []) }
}

/** B comes in at another moment with its material where it was (a trim): what played at t still plays at t. */
export function moveBStart(transition: Transition, bAt: number): Transition {
  const at = Math.max(0, Math.min(transition.length, bAt))
  // Before, B's material at transition time `at` was bIn + (at − bAt) (rates aside, close enough for a handle).
  return { ...transition, bAt: at, bIn: Math.max(0, transition.bIn + (at - transition.bAt)) }
}

/** A leaves at another moment. Keyframes after the new end are kept (finalize clamps what it must). */
export const setLength = (transition: Transition, length: number): Transition => ({ ...transition, length: Math.max(transition.bAt, length) })

/** A stretch of a deck's track that loops well (the planner's suggestions), in track seconds. */
export interface LoopSpot {
  deck: Deck
  from: number
  to: number
}

/** Whether the deck's path plays this stretch as a loop now. */
export function hasLoop(transition: Transition, loop: LoopSpot): boolean {
  const path = loop.deck === 'a' ? transition.pathA : transition.pathB
  return (path ?? []).some((segment) => segment.repeat > 1 && Math.abs(segment.from - loop.from) < 0.01 && Math.abs(segment.to - loop.to) < 0.01)
}

/** Whether the deck reaches the stretch at all (a loop can only come after where the deck starts). */
export const loopReachable = (transition: Transition, loop: LoopSpot) => loop.from >= (loop.deck === 'a' ? transition.aOut : transition.bIn) - 0.01

/**
 * The deck plays the stretch twice (once more than straight through), or, when it already loops it, straight through
 * again. The deck plays straight to the stretch first; its other loops go (one loop at a time keeps it readable).
 */
export function toggleLoop(transition: Transition, loop: LoopSpot): Transition {
  const start = loop.deck === 'a' ? transition.aOut : transition.bIn
  const path = hasLoop(transition, loop) || !loopReachable(transition, loop)
    ? []
    : [...(loop.from - start > 0.01 ? [{ from: start, to: loop.from, repeat: 1 }] : []), { from: loop.from, to: loop.to, repeat: 2 }]
  return loop.deck === 'a' ? { ...transition, pathA: path } : { ...transition, pathB: path }
}
