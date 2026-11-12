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
 * - Constant power: in every band the two decks' summed power (gain × band, squared) stays at about one deck's, so a
 *   transition is never louder than the songs around it. Highs and mids cross over equal-power (both near 0.7 while
 *   both are up), the lows swap in one step.
 * - At `length` A is silent (gain 0) and B is neutral (gain 1, bands 1, filter open), so nothing jumps when the
 *   transition ends. Shapes without overlap (hard cut, drop swap without pre-roll, none) have length 0 and no
 *   keyframes; the engine declicks the cut.
 * - Steps are two keyframes 20 ms apart, curves are sampled into short linear pieces (equal-power fades).
 */

export type ConcretePreset = Exclude<PresetId, 'auto'>

export const PRESETS: readonly ConcretePreset[] = [
  'blend',
  'crossfade',
  'fadeOut',
  'fadeIn',
  'bassSwap',
  'filterBuild',
  'echoOut',
  'reverbOut',
  'dropSwap',
  'hardCut',
  'brake',
  'none',
]

/** Presets that let both decks' beats sound together for bars, so they want B beatmatched. */
export const NEEDS_BEATMATCH: ReadonlySet<ConcretePreset> = new Set(['blend', 'crossfade', 'bassSwap', 'filterBuild'])

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
  /** Drop swap without pre-roll: A's last beat goes into an echo that rings on over B's drop instead of a dry cut. */
  echoTail?: boolean
  /** Blend: the old 16-bar layout's filters (B's high-pass opening, A's rising); `filterIn`/`filterOut` take over. */
  filter?: boolean
  /**
   * Blend: the tonal content (mids, and the highs that carry melody too) changes deck in the beat around the middle
   * instead of overlapping, for keys that clash: B comes in with mids killed and highs halved, A leaves them at the
   * middle (drums and hats still blend).
   */
  midSwap?: boolean
  /**
   * Blend: how the volumes run. 'overlap' (both decks at full volume the whole time, A out at the end of the last bar:
   * the usual DJ blend, loudness kept by choosing thin parts and by EQ and filters), 'fade' (B fades in over the first
   * half, the bands cross equal-power: the long party blend), 'scurve' (A out and B in on S-curves across a short
   * blend: the seamless crossfade), 'mashup' (B in on an S-curve under an opening low-pass over the first fifth, then
   * both at full volume, one singing over the other's instrumental; the bass hands over gradually on the swap, late,
   * and A leaves under a rising high-pass over the last fifth).
   */
  volume?: 'overlap' | 'fade' | 'scurve' | 'mashup' | 'answer' | 'jumpcut'
  /** Blend: where the bass changes deck (start, middle) or 'none' (one of the two parts has no bass of its own). */
  bassAt?: 'start' | 'middle' | 'none'
  /**
   * Blend: a filter on B opening up to the swap, and on A closing after it (high- or low-pass); or A's EQ worked down
   * before the swap, highs first, then mids (its voice), bass last on the swap ('eq': making a gap for B).
   */
  filterIn?: 'hp' | 'lp' | null
  filterOut?: 'hp' | 'lp' | 'eq' | null
  /**
   * Blend: the callback (the user's "interessant"): B, faded in under its opening low-pass, is muted for the bar before
   * the swap so A's element there is heard alone once more, and returns in full with its bass on the swap.
   */
  callback?: boolean
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

/**
 * Equal-power pair over [t0, t1]: the angle θ moves from `from` to `to` (radians, 0 = all A, π/2 = all B) and A gets
 * cos θ, B sin θ, so the two decks' power in the band always adds up to one deck's.
 */
function powerPair(t0: number, t1: number, from: number, to: number, steps = 6): { a: Point[]; b: Point[] } {
  const a: Point[] = []
  const b: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const x = i / steps
    const angle = from + (to - from) * x
    const t = t0 + (t1 - t0) * x
    a.push([t, Math.cos(angle)])
    b.push([t, Math.sin(angle)])
  }
  return { a, b }
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
  const inEnd = Math.max(beat, Math.min(swap / 2, swap - beat))
  // Highs: B's hi-hats come in to half power (A's go down to it) over the first half, the rest of the way at the swap.
  const early = powerPair(0, inEnd, 0, Math.PI / 4)
  const late = powerPair(Math.max(inEnd, swap - beat), swap, Math.PI / 4, Math.PI / 2, 3)
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
      high: [...early.a, ...late.a],
    }),
    b: automation(length, {
      gain: powerFade(0, beat, false, 4),
      low: [[0, 0], ...stepFrom(swap, 0, 1)],
      mid: [
        [swap, 0.15],
        [swap + beat, 1],
      ],
      high: [...early.b, ...late.b],
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
  // Highs cross equal-power as in the bass swap: B's halfway in over the first three quarters, the rest at the swap.
  const inEnd = Math.max(beat, Math.min(swap * 0.75, swap - beat))
  const highs = {
    early: powerPair(0, inEnd, 0, Math.PI / 4),
    late: powerPair(Math.max(inEnd, swap - beat), swap, Math.PI / 4, Math.PI / 2, 3),
  }
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
      high: ctx.synced ? [...highs.early.a, ...highs.late.a] : [
        [swap - beat, 1],
        [swap, 0.2],
      ],
    }),
    b: ctx.synced
      ? automation(length, {
          gain: powerFade(0, beat, false, 4),
          low: [[0, 0], ...stepFrom(swap, 0, 1)],
          mid: [
            [swap, 0.15],
            [swap + beat, 1],
          ],
          high: [...highs.early.b, ...highs.late.b],
        })
      : automation(length, { gain: [[0, 0], ...stepFrom(swap, 0, 1)], low: [[0, 0], ...stepFrom(swap, 0, 1)] }),
    effects: [],
    anchorA: swap,
    anchorB: swap,
    swap,
  }
}

/**
 * A fades out (equal power) under a closing low-pass; B only comes in for the last quarter, so the beats barely meet.
 * Works without beatmatch.
 */
function fadeOut(ctx: PresetContext): PresetShape {
  const length = Math.max(1, ctx.bars) * 4 * ctx.beat
  const enter = length * 0.75
  return {
    preset: 'fadeOut',
    length,
    // A low-pass closes on A as it fades (its kick and hats go first), so where B comes in only A's body is left.
    // A's low goes over the bar before B's comes in (one bassline; a low-pass alone keeps it).
    a: automation(length, {
      gain: powerFade(0, length, true),
      filter: [
        [0, 0],
        [length, -0.7],
      ],
      low: [
        [Math.max(0, enter - 4 * ctx.beat), 1],
        [enter, 0],
      ],
    }),
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
      // A's low goes on the meet, so neither A nor its echoes carry a bassline under B's.
      low: [[0, 1], ...stepAt(meet, 1, 0)],
    }),
    b: automation(length, { gain: [[0, 0], ...stepFrom(meet, 0, 1)], low: [[0, 0], ...stepFrom(meet, 0, 1)] }),
    effects: [{ kind: 'echo', deck: 'a', at: 0, beats, feedback }],
    anchorA: meet,
    anchorB: meet,
    swap: meet,
  }
}

/**
 * Reverb out (the user's "Hall-Effekt am Ende"): A plays on at full volume, unfiltered, while its reverb send rises over
 * its last bars (up to 4, at most a third of the transition) to 0.7, and is cut on the end, where its hall rings on into
 * B (about 3 s). Beatmatched, B comes in early, rising over the first two fifths, its bass held back to the cut; without
 * a beatmatch B comes in on the cut, so no two beats run side by side.
 */
function reverbOut(ctx: PresetContext): PresetShape {
  const bars = Math.max(2, ctx.bars)
  const length = bars * 4 * ctx.beat
  const send = Math.min(16 * ctx.beat, length / 3)
  return {
    preset: 'reverbOut',
    length,
    a: automation(length, {
      gain: [[0, 1], ...stepAt(length, 1, 0)],
      reverb: [
        [length - send, 0],
        [length, 0.7],
      ],
    }),
    b: automation(length, {
      gain: ctx.synced
        ? [
            [0, 0],
            [(length * 2) / 5, 1],
          ]
        : [[0, 0], ...stepAt(length, 0, 1)],
      low: [[0, 0], ...stepAt(length, 0, 1)],
    }),
    effects: [],
    anchorA: length,
    anchorB: length,
    swap: length,
  }
}

/**
 * Drop swap: A is cut exactly on the downbeat where B's drop lands. With a pre-roll (beatmatched only) B's build-up
 * rises under A first, high-passed, bassless and with its mids down, so the drop arrives as a release; with an echo
 * tail A's last beat rings on into the drop.
 */
function dropSwap(ctx: PresetContext): PresetShape {
  const preRoll = ctx.synced ? Math.max(0, Math.round(ctx.preRollBars ?? 1)) * 4 * ctx.beat : 0
  if (preRoll === 0 && ctx.echoTail) {
    // A's last beat feeds an echo, A's dry signal stops on the downbeat where B's drop lands; the echo rings on over
    // the drop (thinned by a high-pass). Needs no beatmatch: only the echo meets B.
    const meet = ctx.beat
    return {
      preset: 'dropSwap',
      length: meet,
      a: automation(meet, {
        gain: [[0, 1], ...stepAt(meet, 1, 0)],
        filter: [
          [0, 0],
          [meet, 0.4],
        ],
      }),
      b: automation(meet, { gain: [...stepAt(meet, 0, 1)] }),
      effects: [{ kind: 'echo', deck: 'a', at: 0, beats: ctx.echoBeats ?? 0.5, feedback: ctx.echoFeedback ?? 0.45 }],
      anchorA: meet,
      anchorB: meet,
      swap: meet,
    }
  }
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
      // Under A at full, B's build stays below half power in the highs too, and a voice in it stays a whisper.
      high: [...stepAt(length, 0.5, 1)],
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

/**
 * Matches both songs' levels during the overlap: the louder deck is brought down by the difference of their loudness
 * (dB, A − B, at most 6 dB). A, when louder, eases down over the first bar and leaves at that level; B, when louder,
 * plays lower until the swap and comes up to its own level by the end, so nothing jumps when the transition is over.
 * Only ever lowers a deck, so a shape's constant power and its rules (one bassline, one voice) still hold.
 */
export function matchLevels(shape: PresetShape, beat: number, difference: number): PresetShape {
  const length = shape.length
  const db = Math.min(6, Math.abs(difference))
  if (length <= 0 || !Number.isFinite(db) || db < 0.5) return shape
  const k = 10 ** (-db / 20)
  const bar = 4 * beat
  const scale = (gain: Keyframe[], level: Point[], step: number): Keyframe[] => {
    const times = new Set<number>([...gain.map((key) => key.t), ...level.map(([t]) => t)])
    for (let t = 0; t <= length; t += step) times.add(t)
    times.add(length)
    const points = [...times].sort((p, q) => p - q).map((t): Point => [t, valueAt(gain, t, 1) * valueAt(keyframes(level, length), t, 1)])
    return keyframes(points, length)
  }
  if (difference > 0) {
    const level: Point[] = [
      [0, 1],
      [Math.min(bar, length / 4), k],
    ]
    return { ...shape, a: { ...shape.a, gain: scale(shape.a.gain, level, bar / 4) } }
  }
  const rise = Math.min(Math.max(shape.swap, 0), length - Math.min(bar, length / 4))
  const level: Point[] = [
    [rise, k],
    [length, 1],
  ]
  return { ...shape, b: { ...shape.b, gain: scale(shape.b.gain, level, bar / 4) } }
}

/**
 * The blend, after the transitions a DJ (and Spotify's editor) makes between beatmatched songs, 2–16 bars:
 * - Volume: 'overlap' keeps both decks at full volume and cuts A at the end of the last bar; 'fade' brings B in over
 *   the first half with the mids and highs crossing equal-power (the long party blend); 'scurve' crosses both on
 *   S-curves (the short seamless one).
 * - Bass: changes deck in one step at the start or the middle (never two basslines), or stays on both when one part
 *   has no bass to speak of (the planner checks that against the songs' band energies).
 * - Filters: a high- or low-pass on B opening over the first half ("in"), on A closing over the second ("out").
 * - Keys that clash: the tonal content changes deck at the middle instead (see `midSwap`).
 * Needs B beatmatched; the planner loops bars of either song so neither runs into singing or a drop meanwhile.
 */
/**
 * The jump cut (the user on Heartless → Heartless: "when A says 'heartless', B says it and takes over"): A plays to the
 * end of its line and is cut on the beat (the middle), B starts right there with its answering line; only the lows
 * cross over around the cut, mids and highs switch at once.
 */
function jumpcut(ctx: PresetContext): PresetShape {
  const bars = Math.max(2, ctx.bars)
  const length = bars * 4 * ctx.beat
  const middle = Math.min(length - ctx.beat, Math.max(ctx.beat, (ctx.swapBar ?? bars / 2) * 4 * ctx.beat))
  // The lows cross over a beat around the cut (half a beat each side): soft, but too short for two kicks to flam.
  const from = middle - ctx.beat / 2
  const to = middle + ctx.beat / 2
  return {
    preset: 'blend',
    length,
    a: automation(length, {
      gain: [
        [0, 1],
        [to - RAMP, 1],
        [to, 0],
      ],
      low: [
        [from, 1],
        [to, 0],
      ],
      mid: [[0, 1], ...stepAt(middle, 1, 0)],
      high: [[0, 1], ...stepAt(middle, 1, 0)],
    }),
    b: automation(length, {
      gain: [[0, 0], ...stepFrom(from, 0, 1)],
      low: [
        [from, 0],
        [to, 1],
      ],
      mid: [[0, 0], ...stepFrom(middle, 0, 1)],
      high: [[0, 0], ...stepFrom(middle, 0, 1)],
    }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap: middle,
  }
}

/**
 * The wordplay handover (the user's "der ist krank"): B's beat fades in over the first half under A (its mids and
 * highs down, so no voice of B's is heard yet), A plays in full and is cut on the middle, where the bass and the
 * rest of B change over; B's answering line starts just after.
 */
function answer(ctx: PresetContext): PresetShape {
  const bars = Math.max(2, ctx.bars)
  const length = bars * 4 * ctx.beat
  const middle = Math.min(length - ctx.beat, Math.max(ctx.beat, (ctx.swapBar ?? bars / 2) * 4 * ctx.beat))
  return {
    preset: 'blend',
    length,
    a: automation(length, { gain: [[0, 1], ...stepAt(middle, 1, 0)], low: [[0, 1], ...stepAt(middle, 1, 0)] }),
    b: automation(length, {
      gain: [
        [0, 0],
        [middle, 1],
      ],
      low: [[0, 0], ...stepFrom(middle, 0, 1)],
      // B's voice (and chords) stay down until A is gone: what fades in under A is B's beat; its answering line comes
      // in whole on the middle.
      mid: [[0, 0.1], ...stepFrom(middle, 0.1, 1)],
      high: [[0, 0.15], ...stepFrom(middle, 0.15, 1)],
    }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap: middle,
  }
}

/**
 * The mashup (the user's "eher Mashup-Mixing"): B comes in on an S-curve under a low-pass opening over the first fifth,
 * then both play at full volume (B's voice over A's instrumental part, or the other way round); A's low goes down over
 * the 2 bars before the swap and B's comes up over the 2 bars after it (never two basslines); A leaves under a
 * high-pass rising over the last fifth and is cut at the end.
 */
function mashup(ctx: PresetContext): PresetShape {
  const bars = Math.max(4, ctx.bars)
  const length = bars * 4 * ctx.beat
  const swap = Math.min(length - 8 * ctx.beat, Math.max(8 * ctx.beat, (ctx.swapBar ?? Math.round(bars * 0.85)) * 4 * ctx.beat))
  const edge = length / 5
  const bGain: Point[] = []
  for (let i = 0; i <= 8; i++) {
    const x = i / 8
    bGain.push([edge * x, x * x * (3 - 2 * x)])
  }
  return {
    preset: 'blend',
    length,
    a: automation(length, {
      gain: [[0, 1], ...stepAt(length, 1, 0)],
      low: [
        [swap - 8 * ctx.beat, 1],
        [swap, 0],
      ],
      filter: [
        [length - edge, 0],
        [length, 0.6],
      ],
    }),
    b: automation(length, {
      gain: bGain,
      low: [
        [swap, 0],
        [swap + 8 * ctx.beat, 1],
      ],
      filter: [
        [0, -0.6],
        [edge, 0],
      ],
    }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap,
  }
}

/** A band EQ'd out in a blend: about -16 dB, under the -10 dB from which a deck's hats and snares are heard to flam. */
const EQ_OUT = 0.15

function blend(ctx: PresetContext): PresetShape {
  if (ctx.volume === 'mashup') return mashup(ctx)
  if (ctx.volume === 'answer') return answer(ctx)
  if (ctx.volume === 'jumpcut') return jumpcut(ctx)
  const bars = Math.max(1, ctx.bars)
  const length = bars * 4 * ctx.beat
  // The swap: on the bar the planner lines up with A's section boundary (0 = the start).
  const middle = ctx.swapBar !== undefined ? Math.min(length, Math.max(0, Math.round(ctx.swapBar))) * 4 * ctx.beat : bars >= 2 ? swapTime(ctx, length, bars / 2) : length / 2
  const volume = ctx.volume ?? 'fade'
  const bassAt = ctx.bassAt ?? 'middle'
  // The old 16-bar layout: high-pass in on B, high-pass out on A, unless the filters are given.
  const filterIn = ctx.filterIn !== undefined ? ctx.filterIn : ctx.filter === false ? null : 'hp'
  const filterOut = ctx.filterOut !== undefined ? ctx.filterOut : ctx.filter === false ? null : 'hp'
  const beat = Math.min(ctx.beat, middle / 4)
  const steps = 16

  const aGain: Point[] = []
  const bGain: Point[] = []
  const aBand: Point[] = []
  const bBand: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (length * i) / steps
    const x = t / length
    if (volume === 'scurve') {
      const smooth = x * x * (3 - 2 * x)
      aGain.push([t, 1 - smooth])
      bGain.push([t, smooth])
    }
    if (volume === 'fade') {
      // B's band is what's left of sin θ after its volume ramp, so B's mids and highs add up to sin θ (constant power).
      const angle = (Math.PI / 2) * x
      const gainB = Math.min(1, t / middle)
      aBand.push([t, Math.cos(angle)])
      bBand.push([t, gainB > 0 ? Math.min(1, Math.sin(angle) / gainB) : Math.min(1, ((Math.PI / 2) * middle) / length)])
    }
  }
  // A's last bands go over its last beat (not cut: the user hears a song stop), B in full by then.
  const aGainPoints: Point[] = volume === 'scurve' ? aGain : [[0, 1], [Math.max(0, length - ctx.beat), 1], [length, 0]]
  const bGainPoints: Point[] =
    volume === 'scurve'
      ? bGain
      : volume === 'fade'
        ? [
            [0, 0],
            [middle, 1],
          ]
        : [
            // B rises over its first bar (a quarter of a short blend) instead of jumping in.
            [0, 0],
            [Math.max(RAMP, Math.min(4 * ctx.beat, length / 4)), 1],
          ]
  const swapAt = bassAt === 'start' || middle === 0 ? RAMP : middle
  // A DJ's bass swap is gradual: A's low goes down to half over the two bars before the phrase downbeat and is gone on
  // it, where B's low comes in (never both full: B's stays killed until then).
  const preCut = bassAt === 'middle' ? Math.min(8 * ctx.beat, middle / 2) : 0
  const aLow: Point[] = bassAt === 'none' ? [] : preCut > 0 ? [[middle - preCut, 1], [swapAt - RAMP, 0.5], [swapAt, 0]] : [[0, 1], ...stepAt(swapAt, 1, 0)]
  // (On a drop swap the swap is the end: B's bass lands exactly there.)
  const bLow: Point[] = bassAt === 'none' ? [] : [[0, 0], ...(swapAt >= length - RAMP ? stepAt(length, 0, 1) : stepFrom(swapAt, 0, 1))]
  // Tonal content: crossing equal-power in the fade, swapped in the beat around the middle for clashing keys.
  const aMid: Point[] = ctx.midSwap
    ? [
        [middle - beat, 1],
        [middle, 0.1],
      ]
    : filterOut === 'eq' && middle > 0
      ? [
          [Math.max(0, middle - 4 * ctx.beat), 1],
          [middle, EQ_OUT],
        ]
      : volume === 'fade'
        ? aBand
        : []
  // B's tonal swap comes up over the beat after the middle, or (a drop swap, the middle is the end) lands on the end.
  const lateSwap = middle + beat > length
  const bMid: Point[] = ctx.midSwap
    ? lateSwap
      ? [[0, 0.1], ...stepAt(length, 0.1, 1)]
      : [
          [middle, 0.1],
          [middle + beat, 1],
        ]
    : volume === 'fade'
      ? bBand
      : []
  // A's EQ worked down (gap for B): highs over the bars before the swap, mids in its last bar, the bass on it. Down to
  // EQ_OUT, below where its hats and snares would still be heard (and flam) under B's.
  const gap = filterOut === 'eq' && middle > 0
  const aHigh: Point[] = ctx.midSwap
    ? [
        [middle - beat, 1],
        [middle, EQ_OUT],
      ]
    : gap
      ? [
          [Math.max(0, middle - 16 * ctx.beat), 1],
          [Math.max(0, middle - 4 * ctx.beat), EQ_OUT],
        ]
      : volume === 'fade'
        ? aBand
        : []
  const bHigh: Point[] = ctx.midSwap
    ? lateSwap
      ? [[0, EQ_OUT], ...stepAt(length, EQ_OUT, 1)]
      : [
          [middle, EQ_OUT],
          [middle + beat, 1],
        ]
    : volume === 'fade'
      ? bBand
      : []
  const knob = (kind: 'hp' | 'lp' | 'eq') => (kind === 'hp' ? 0.6 : -0.6)
  if (ctx.callback && middle >= 8 * ctx.beat) {
    // B in on an S-curve up to the bar before the swap, muted through that bar, back in full on the swap.
    const gap = middle - 4 * ctx.beat
    const curve: Point[] = []
    for (let i = 0; i <= 8; i++) {
      const x = i / 8
      curve.push([gap * x, x * x * (3 - 2 * x)])
    }
    bGainPoints.splice(0, bGainPoints.length, ...curve, [gap + RAMP, 0], [middle - RAMP, 0], [middle, 1])
  }
  return {
    preset: 'blend',
    length,
    a: automation(length, {
      gain: aGainPoints,
      low: aLow,
      mid: aMid,
      high: aHigh,
      filter:
        filterOut && filterOut !== 'eq'
          ? [
              // A closing low-pass dulls A: at most its last 4 bars, when B already carries the music.
              [filterOut === 'lp' ? Math.max(middle, length - 16 * ctx.beat) : middle, 0],
              [length, knob(filterOut)],
            ]
          : [],
    }),
    b: automation(length, {
      gain: bGainPoints,
      low: bLow,
      mid: bMid,
      high: bHigh,
      filter:
        filterIn && middle > 0
          ? [
              [0, knob(filterIn)],
              [middle, 0],
            ]
          : [],
    }),
    effects: [],
    anchorA: 0,
    anchorB: 0,
    swap: middle,
  }
}

/** The shape of a preset in the given context. */
export function presetShape(preset: ConcretePreset, context: PresetContext): PresetShape {
  const beat = Number.isFinite(context.beat) && context.beat > 0.2 && context.beat < 2 ? context.beat : 0.5
  const ctx: PresetContext = { ...context, beat, bars: Number.isFinite(context.bars) ? context.bars : 8 }
  switch (preset) {
    case 'blend':
      return blend(ctx)
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
    case 'reverbOut':
      return reverbOut(ctx)
    case 'dropSwap':
      return dropSwap(ctx)
    case 'brake':
      return brake(ctx)
    case 'hardCut':
    case 'none':
      return noOverlap(preset)
  }
}
