import type { DeckAutomation, Keyframe, PresetId, TransitionEffect } from './types.ts'

/**
 * The shapes of the transition techniques: for each preset, how both decks' volume, EQ bands and filter move over the
 * overlap, and which effects fire. The planner decides where a transition happens (which phrase of A, which of B, how
 * many bars, the tempo match); a preset only decides how it sounds, in transition time (seconds from A's `aOut`).
 *
 * Rules every shape keeps, so the planner and the tests can rely on them:
 * - Never two basslines: B's low band stays killed until the swap and A's is killed from it on (a 20 ms gap, no
 *   overlap). A crossfade swaps the lows halfway through instead of blending them.
 * - The lead (the mid band, where voices live, with the highs of A that carry a voice's air) changes deck around the
 *   swap in the shapes meant for long overlaps: A's mids and highs leave in the beat before it, B's mids arrive in the
 *   beat after (B's highs come in early: hi-hats under A, which is fine as long as B isn't singing yet). Whether the voices really keep apart depends
 *   on where the planner puts the swap; it checks that against both songs' vocals.
 * - At `length` A is silent (gain 0) and B is neutral (gain 1, bands 1, filter open), so nothing jumps when the
 *   transition ends. Shapes without overlap (hard cut, drop swap without pre-roll, none) have length 0 and no
 *   keyframes; the engine declicks the cut.
 * - Steps are two keyframes 20 ms apart, curves are sampled into short linear pieces (equal-power fades).
 */

export type ConcretePreset = Exclude<PresetId, 'auto'>

export const PRESETS: readonly ConcretePreset[] = [
  'crossfade',
  'fadeOut',
  'fadeIn',
  'bassSwap',
  'filterBuild',
  'echoOut',
  'dropSwap',
  'hardCut',
  'brake',
  'none',
]

/** Presets that let both decks' beats sound together for bars, so they want B beatmatched. */
export const NEEDS_BEATMATCH: ReadonlySet<ConcretePreset> = new Set(['crossfade', 'bassSwap', 'filterBuild'])

export interface PresetContext {
  /** Seconds per beat of A at the transition (transition time; B is played at A's tempo while synced). */
  beat: number
  /** Length of the overlap in A's bars, for the shapes with a free length (crossfade, fades, bass swap, filter build). */
  bars: number
  /** B is beatmatched to A. Without it the shapes keep both beats from sounding together for more than a beat or so. */
  synced: boolean
  /** Bar of the overlap where the bass changes deck (bass swap, crossfade, filter build); defaults per shape. */
  swapBar?: number
  /** Drop swap: bars of B's build-up played under the end of A before B's drop lands (0 = a straight cut). */
  preRollBars?: number
  /** Echo out: delay in beats and feedback (defaults 1 beat, 0.5). */
  echoBeats?: number
  echoFeedback?: number
}

export interface PresetShape {
  preset: ConcretePreset
  length: number
  a: DeckAutomation
  b: DeckAutomation
  effects: TransitionEffect[]
  /**
   * Where, in transition time, the planner lines up the phrase start it chose in A and the one it chose in B (the
   * moment both songs meet: the swap, the drop, the downbeat after an echo). `aOut = phraseA - anchorA`,
   * `bIn = phraseB - anchorB * rate`.
   */
  anchorA: number
  anchorB: number
  /** Where the bass (and lead) changes deck; the moment A stops counting as "the song playing". */
  swap: number
}

export const RAMP = 0.02

type Point = [number, number]

const empty = (): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [] })

/** Points → sorted keyframes inside [0, length], rounded to the millisecond, duplicates and NaN dropped. */
export function keyframes(points: Point[], length: number, min = 0, max = 1): Keyframe[] {
  const result: Keyframe[] = []
  const sorted = points
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .map(([t, v]): Point => [Math.round(Math.min(length, Math.max(0, t)) * 1000) / 1000, Math.min(max, Math.max(min, v))])
    .sort((p, q) => p[0] - q[0])
  for (const [t, v] of sorted) {
    const last = result[result.length - 1]
    if (last && last.t === t && last.v === v) continue
    result.push({ t, v: Math.round(v * 1000) / 1000 })
  }
  return result
}

/** The value of an automation curve at `t`: linear between keyframes, held before the first and after the last. */
export function valueAt(curve: readonly Keyframe[], t: number, fallback: number): number {
  if (curve.length === 0) return fallback
  if (t <= curve[0].t) return curve[0].v
  const last = curve[curve.length - 1]
  if (t >= last.t) return last.v
  let lo = 0
  let hi = curve.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (curve[mid].t <= t) lo = mid
    else hi = mid
  }
  const p = curve[lo]
  const q = curve[hi]
  return q.t === p.t ? q.v : p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t)
}

/** Equal-power fade from 1 to 0 (or 0 to 1) over [t0, t1], in `steps` linear pieces. */
function powerFade(t0: number, t1: number, out: boolean, steps = 8): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const x = i / steps
    points.push([t0 + (t1 - t0) * x, out ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2)])
  }
  return points
}

/** A step from `from` to `to` landing exactly at `t`. */
const stepAt = (t: number, from: number, to: number): Point[] => [
  [t - RAMP, from],
  [t, to],
]

/** A step from `from` to `to` starting at `t` (used for the deck coming in, so the two never overlap). */
const stepFrom = (t: number, from: number, to: number): Point[] => [
  [t, from],
  [t + RAMP, to],
]

function automation(length: number, parts: Partial<Record<keyof DeckAutomation, Point[]>>): DeckAutomation {
  const result = empty()
  for (const band of Object.keys(parts) as Array<keyof DeckAutomation>) {
    result[band] = keyframes(parts[band] ?? [], length, band === 'filter' ? -1 : 0, 1)
  }
  return result
}

function noOverlap(preset: ConcretePreset): PresetShape {
  return { preset, length: 0, a: empty(), b: empty(), effects: [], anchorA: 0, anchorB: 0, swap: 0 }
}

/** Overlap length for the free-length shapes; without beatmatch at most two bars. */
function freeLength(ctx: PresetContext) {
  const bars = Math.max(1, ctx.synced ? ctx.bars : Math.min(ctx.bars, 2))
  return bars * 4 * ctx.beat
}

/** The swap bar, kept inside the overlap and on a whole bar. */
function swapTime(ctx: PresetContext, length: number, fallbackBar: number) {
  const bar = 4 * ctx.beat
  const bars = Math.round(length / bar)
  const wanted = Math.round(ctx.swapBar ?? fallbackBar)
  return Math.min(Math.max(1, bars - 1), Math.max(bars > 1 ? 1 : 0, wanted)) * bar
}

/** Equal-power crossfade; the lows swap halfway (on a bar) so the two basslines never sound together. */
function crossfade(ctx: PresetContext): PresetShape {
  const length = freeLength(ctx)
  const swap = ctx.synced ? swapTime(ctx, length, length / (8 * ctx.beat)) : length / 2
  return {
    preset: 'crossfade',
    length,
    a: automation(length, { gain: powerFade(0, length, true), low: [[0, 1], ...stepAt(swap, 1, 0)] }),
    b: automation(length, { gain: powerFade(0, length, false), low: [[0, 0], ...stepFrom(swap, 0, 1)] }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap,
  }
}

/** A crossfade of any length, without a beat grid (the safe fallback); the lows swap halfway. */
export function plainCrossfade(length: number): PresetShape {
  const swap = length / 2
  return {
    preset: 'crossfade',
    length,
    a: automation(length, { gain: powerFade(0, length, true), low: [[0, 1], ...stepAt(swap, 1, 0)] }),
    b: automation(length, { gain: powerFade(0, length, false), low: [[0, 0], ...stepFrom(swap, 0, 1)] }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap,
  }
}

/**
 * The clean club blend: B's highs come in first (hi-hats under A), on the swap downbeat the bass changes deck in one
 * go, A's mids leave in the beat before it and B's arrive in the beat after (the voices hand over), then A fades out.
 */
function bassSwap(ctx: PresetContext): PresetShape {
  const length = freeLength(ctx)
  const beat = Math.min(ctx.beat, length / 8)
  const swap = ctx.synced ? swapTime(ctx, length, length / (8 * ctx.beat)) : length / 2
  const inEnd = Math.max(beat, swap / 2)
  return {
    preset: 'bassSwap',
    length,
    a: automation(length, {
      gain: [[swap, 1], ...powerFade(swap, length, true)],
      low: [[0, 1], ...stepAt(swap, 1, 0)],
      mid: [
        [swap - beat, 1],
        [swap, 0.2],
      ],
      // A voice lives in the highs too (its air and consonants): they leave with the mids.
      high: [
        [swap - beat, 1],
        [swap, 0.2],
      ],
    }),
    b: automation(length, {
      gain: powerFade(0, inEnd, false),
      low: [[0, 0], ...stepFrom(swap, 0, 1)],
      mid: [
        [swap, 0.15],
        [swap + beat, 1],
      ],
      high: [
        [0, 0.5],
        [inEnd, 1],
      ],
    }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap,
  }
}

/**
 * A high-pass sweeps up through A (its bass and body thin out, tension rises) while B comes in underneath without
 * bass; on the swap B's bass (ideally its drop or chorus) lands and A is gone within the bar. Without beatmatch B stays
 * silent until the swap and A clears out in one beat.
 */
function filterBuild(ctx: PresetContext): PresetShape {
  const sweep = freeLength(ctx)
  const bar = 4 * ctx.beat
  const swap = ctx.synced ? swapTime(ctx, sweep, Math.round(sweep / bar) - 1) : sweep
  const length = ctx.synced ? Math.max(swap + Math.min(bar, sweep - swap), swap + ctx.beat) : swap + ctx.beat
  const beat = Math.min(ctx.beat, swap / 2 || ctx.beat)
  return {
    preset: 'filterBuild',
    length,
    a: automation(length, {
      filter: [
        [0, 0],
        [swap, 0.7],
        [length, 0.9],
      ],
      gain: [[swap, 1], ...powerFade(swap, length, true, 4)],
      low: [[0, 1], ...stepAt(swap, 1, 0)],
      mid: [
        [swap - beat, 1],
        [swap, 0.2],
      ],
      high: [
        [swap - beat, 1],
        [swap, 0.2],
      ],
    }),
    b: ctx.synced
      ? automation(length, {
          gain: powerFade(0, Math.max(beat, swap * 0.75), false),
          low: [[0, 0], ...stepFrom(swap, 0, 1)],
          mid: [
            [swap, 0.15],
            [swap + beat, 1],
          ],
          high: [
            [0, 0.6],
            [swap, 1],
          ],
        })
      : automation(length, { gain: [[0, 0], ...stepFrom(swap, 0, 1)], low: [[0, 0], ...stepFrom(swap, 0, 1)] }),
    effects: [],
    anchorA: swap,
    anchorB: swap,
    swap,
  }
}

/**
 * A fades out (equal power); B only comes in for the last quarter, so the beats barely meet. Works without beatmatch.
 */
function fadeOut(ctx: PresetContext): PresetShape {
  const length = Math.max(1, ctx.bars) * 4 * ctx.beat
  const enter = length * 0.75
  return {
    preset: 'fadeOut',
    length,
    a: automation(length, { gain: powerFade(0, length, true) }),
    b: automation(length, { gain: [[0, 0], ...powerFade(enter, length, false, 4)], low: [[enter, 0], [length, 1]] }),
    effects: [],
    anchorA: 0,
    anchorB: enter,
    swap: enter,
  }
}

/** The mirror of a fade out: A ends in the first quarter, B fades in from silence over the whole length. */
function fadeIn(ctx: PresetContext): PresetShape {
  const length = Math.max(1, ctx.bars) * 4 * ctx.beat
  const leave = length * 0.25
  return {
    preset: 'fadeIn',
    length,
    a: automation(length, { gain: powerFade(0, leave, true, 4), low: [[0, 1], [leave, 0]] }),
    b: automation(length, { gain: powerFade(0, length, false) }),
    effects: [],
    anchorA: leave,
    anchorB: 0,
    swap: leave,
  }
}

/**
 * Echo out: on A's last beat before the phrase an echo catches it, on the downbeat A's dry signal is gone (the echo
 * rings on, thinned by a high-pass) and B starts at full on its phrase. No beatmatch needed.
 */
function echoOut(ctx: PresetContext): PresetShape {
  const beats = ctx.echoBeats ?? 1
  const feedback = ctx.echoFeedback ?? 0.5
  const meet = ctx.beat
  const length = meet + 8 * ctx.beat
  return {
    preset: 'echoOut',
    length,
    a: automation(length, {
      gain: [[0, 1], ...stepAt(meet, 1, 0)],
      filter: [
        [0, 0],
        [meet, 0.35],
        [length, 0.6],
      ],
      low: [
        [0, 1],
        [meet, 0.2],
      ],
    }),
    b: automation(length, { gain: [[0, 0], ...stepFrom(meet, 0, 1)], low: [[0, 0], ...stepFrom(meet, 0, 1)] }),
    effects: [{ kind: 'echo', deck: 'a', at: 0, beats, feedback }],
    anchorA: meet,
    anchorB: meet,
    swap: meet,
  }
}

/**
 * Drop swap: A is cut exactly on the downbeat where B's drop lands. With a pre-roll (beatmatched only) B's build-up
 * rises under A first, high-passed, bassless and with its mids down, so the drop arrives as a release.
 */
function dropSwap(ctx: PresetContext): PresetShape {
  const preRoll = ctx.synced ? Math.max(0, Math.round(ctx.preRollBars ?? 1)) * 4 * ctx.beat : 0
  if (preRoll === 0) return noOverlap('dropSwap')
  const length = preRoll
  return {
    preset: 'dropSwap',
    length,
    a: automation(length, { gain: [[0, 1], ...stepAt(length, 1, 0)] }),
    b: automation(length, {
      gain: [...powerFade(0, length - RAMP, false, 4).map(([t, v]): Point => [t, v * 0.7]), [length, 1]],
      filter: [
        [0, 0.6],
        [length - RAMP, 0.3],
        [length, 0],
      ],
      low: [...stepAt(length, 0, 1)],
      mid: [...stepAt(length, 0.25, 1)],
    }),
    effects: [],
    anchorA: length,
    anchorB: length,
    swap: length,
  }
}

/** Brake: A slows to a stop over three beats (a turntable's motor switched off), B drops in on the next downbeat. */
function brake(ctx: PresetContext): PresetShape {
  const meet = 4 * ctx.beat
  return {
    preset: 'brake',
    length: meet,
    a: automation(meet, { gain: [[0, 1], ...stepAt(meet, 1, 0)] }),
    b: automation(meet, { gain: [[0, 0], ...stepAt(meet, 0, 1)] }),
    effects: [{ kind: 'brake', deck: 'a', at: 0, length: 3 * ctx.beat }],
    anchorA: meet,
    anchorB: meet,
    swap: meet,
  }
}

/** The shape of a preset in the given context. */
export function presetShape(preset: ConcretePreset, context: PresetContext): PresetShape {
  const beat = Number.isFinite(context.beat) && context.beat > 0.2 && context.beat < 2 ? context.beat : 0.5
  const ctx: PresetContext = { ...context, beat, bars: Number.isFinite(context.bars) ? context.bars : 8 }
  switch (preset) {
    case 'crossfade':
      return crossfade(ctx)
    case 'bassSwap':
      return bassSwap(ctx)
    case 'filterBuild':
      return filterBuild(ctx)
    case 'fadeOut':
      return fadeOut(ctx)
    case 'fadeIn':
      return fadeIn(ctx)
    case 'echoOut':
      return echoOut(ctx)
    case 'dropSwap':
      return dropSwap(ctx)
    case 'brake':
      return brake(ctx)
    case 'hardCut':
    case 'none':
      return noOverlap(preset)
  }
}
