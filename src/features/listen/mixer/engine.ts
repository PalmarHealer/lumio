import type { DeckAutomation, Keyframe, Transition, TransitionEffect } from './types'

/**
 * The mixer's audio graph: one "deck" per playing track, the same for live playback (an AudioContext fed by the
 * player's <audio> elements) and for rendering a transition offline (an OfflineAudioContext fed by decoded buffers),
 * so what the editor previews is what the player plays.
 *
 *   input → brake → gain ┬→ dry ─────────────────────────────────────────────────────┬→ post → (+ echo) → level → master
 *                         └→ 3-band isolator (low / mid / high) → high-pass → low-pass → coloured ┘
 *
 * - The isolator and filters only carry the sound while they colour it. They are flat in magnitude at neutral, but
 *   their phase turns (an all-pass around 200 Hz and 2 kHz), and on loud, brickwall-limited masters that alone raised
 *   sample peaks by over 5 dB (the limiter's flattened peaks come back). So a deck plays through `dry` (exactly the
 *   input) and switches to `coloured` just before its first EQ or filter move, and back once neutral again: hard at a
 *   moment the deck is silent, else with a 5 ms crossfade. The two paths differ in phase, so while they mix the sum
 *   dips around the crossovers; a short crossfade keeps that brief (measured: about −10 dB for 2 ms near 200 Hz and
 *   2 kHz, where 30 ms gave up to −32 dB for 17 ms) and is still a ramp, not a jump.
 * - All decks meet in the master (`createMaster`): a lookahead limiter (AudioWorklet) at full scale (0 dBFS sample
 *   peaks). Two loud tracks overlapping, or the coloured path, can exceed full scale; the limiter catches that instead
 *   of the output clipping. It only acts while a transition runs (`engage`): a single neutral
 *   deck passes exactly as the plain player plays it, loud masters' own peaks included.
 *
 * - `brake` is the brake effect's fade, `gain` the transition's volume curve, `level` the player's own volume,
 *   normalization and pause fades (left at 1 when rendering). `level` comes last, so a pause also silences an echo
 *   still ringing.
 * - The EQ is an isolator, as on a club mixer: the signal is split into three bands by Linkwitz–Riley crossovers
 *   (24 dB/octave, at 200 Hz and 2 kHz) and each band has its own gain. Low-pass and high-pass halves of an LR4
 *   crossover add up to an all-pass, so with every band at 1 the sum has exactly the input's magnitude (only the phase
 *   turns a little around the crossovers, which the ear doesn't hear), and a band at 0 is gone completely (a real
 *   "kill"), which shelving filters can't do: a low shelf at -40 dB still lets the bass through above its corner.
 * - Band values are amplitude factors (0.5 = -6 dB), like `gain`, so automation is a plain linear ramp per keyframe.
 * - The filter knob (-1…1) moves a low-pass down (below 0) or a high-pass up (above 0) on a logarithmic frequency
 *   scale, with a slight resonance. At 0 both are exactly transparent: a low-pass at the Nyquist frequency and a
 *   high-pass at 0 Hz have the transfer function 1.
 * - The echo is a tempo-synced delay with feedback, fed by a send that opens at the effect's moment; its tail rings on
 *   after the deck's volume is gone ("echo out").
 * - Automation uses only `setValueAtTime` and `linearRampToValueAtTime` (non-linear curves are sampled into short
 *   ramps), and the engine keeps its own copy of what it scheduled per param. Holding a param where it is (a pause, a
 *   seek) then needs only `cancelScheduledValues`, which every browser has, and never reads `param.value` (which
 *   says nothing about the future, and nothing at all before an offline render runs).
 *
 * Nothing here touches the DOM, so node and OfflineAudioContext can use it as well.
 */

/** Crossover frequencies of the isolator: low < 200 Hz, mid 200–2000 Hz, high > 2000 Hz (as the analysis' bands). */
export const LOW_CROSSOVER = 200
export const HIGH_CROSSOVER = 2000

/** The filter knob's range: the low-pass closes down to this, the high-pass rises from/to these. */
const LOWPASS_MIN_HZ = 70
const HIGHPASS_MIN_HZ = 20
const HIGHPASS_MAX_HZ = 9000
/** Resonance of the sweep filters, in dB (Web Audio's low-/high-pass Q is in dB): a slight peak at the cutoff. */
const FILTER_RESONANCE_DB = 3
/** Butterworth Q (1/√2): in dB for low-/high-pass biquads, linear for the all-pass. */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2)
/** How finely the filter's (non-linear) frequency curve is sampled into ramps. */
const FILTER_CURVE_RATE = 200
/** Steps of a filter's glide back to open (on the log scale). */
const GLIDE_STEPS = 12
/** Longest echo delay a deck allows (seconds). */
const MAX_DELAY_S = 4
/** A tempo that isn't a usable number counts as this (the contract already sends 120 for unknown ones). */
export const DEFAULT_BPM = 120
/** The dry ↔ coloured switch when the deck isn't silent at a moment it could switch at (see the top). */
const CROSSFADE_S = 0.005
/** A deck this quiet (gain) may switch paths at once. */
const SILENT = 0.001

/** Short ramps that keep switches click-free (also a hard cut's: A out and B in over this). */
const DECLICK_S = 0.005

export interface Deck {
  ctx: BaseAudioContext
  /** Connect the deck's source here. */
  input: GainNode
  /** The brake effect's fade (1 otherwise). */
  brake: GainNode
  /** The transition's volume curve. */
  gain: GainNode
  /** Band gains of the isolator. */
  low: GainNode
  mid: GainNode
  high: GainNode
  highpass: BiquadFilterNode
  lowpass: BiquadFilterNode
  echo: { send: GainNode; delay: DelayNode; feedback: GainNode; wet: GainNode }
  /** Which way the sound goes: straight (`dry`, neutral) or through the isolator and filters (`coloured`). */
  paths: { dry: GainNode; coloured: GainNode }
  /** The player's volume, normalization and fades; 1 when rendering. */
  level: GainNode
  /** The source feeding `input` (set by whoever connects one), disconnected with the deck. */
  source: AudioNode | null
  /** Disconnects the deck (and its source) from everything. */
  dispose(): void
}

const nyquist = (ctx: BaseAudioContext) => ctx.sampleRate / 2

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, Q: number) {
  return new BiquadFilterNode(ctx, { type, frequency, Q })
}

/** Two Butterworth sections in a row: a 4th-order Linkwitz–Riley low-pass or high-pass. */
function linkwitzRiley(ctx: BaseAudioContext, type: 'lowpass' | 'highpass', frequency: number): [BiquadFilterNode, BiquadFilterNode] {
  const first = biquad(ctx, type, frequency, BUTTERWORTH_Q_DB)
  const second = biquad(ctx, type, frequency, BUTTERWORTH_Q_DB)
  first.connect(second)
  return [first, second]
}

/** A deck with neutral settings (inaudible: unity gain, flat EQ, open filter, no echo), connected to `destination`. */
export function createDeck(ctx: BaseAudioContext, destination: AudioNode): Deck {
  const input = new GainNode(ctx)
  const brake = new GainNode(ctx)
  const gain = new GainNode(ctx)
  input.connect(brake).connect(gain)

  // The isolator. low = LP(200)² · AP(2000); mid = HP(200)² · LP(2000)²; high = HP(200)² · HP(2000)². The all-pass
  // gives the low band the same phase turn at 2 kHz that mid + high have, so the three add up to AP(200) · AP(2000).
  const [lowA, lowB] = linkwitzRiley(ctx, 'lowpass', LOW_CROSSOVER)
  const lowAllpass = biquad(ctx, 'allpass', HIGH_CROSSOVER, Math.SQRT1_2)
  const [upperA, upperB] = linkwitzRiley(ctx, 'highpass', LOW_CROSSOVER)
  const [midA, midB] = linkwitzRiley(ctx, 'lowpass', HIGH_CROSSOVER)
  const [highA, highB] = linkwitzRiley(ctx, 'highpass', HIGH_CROSSOVER)
  const low = new GainNode(ctx)
  const mid = new GainNode(ctx)
  const high = new GainNode(ctx)
  const sum = new GainNode(ctx)
  gain.connect(lowA)
  lowB.connect(lowAllpass).connect(low).connect(sum)
  gain.connect(upperA)
  upperB.connect(midA)
  midB.connect(mid).connect(sum)
  upperB.connect(highA)
  highB.connect(high).connect(sum)

  const highpass = biquad(ctx, 'highpass', 0, FILTER_RESONANCE_DB)
  const lowpass = biquad(ctx, 'lowpass', nyquist(ctx), FILTER_RESONANCE_DB)
  sum.connect(highpass).connect(lowpass)

  const dry = new GainNode(ctx)
  const coloured = new GainNode(ctx, { gain: 0 })
  const post = new GainNode(ctx)
  gain.connect(dry).connect(post)
  lowpass.connect(coloured).connect(post)

  const level = new GainNode(ctx)
  post.connect(level)
  const send = new GainNode(ctx, { gain: 0 })
  const delay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY_S, delayTime: 0.5 })
  const feedback = new GainNode(ctx, { gain: 0 })
  const wet = new GainNode(ctx)
  post.connect(send).connect(delay)
  delay.connect(feedback).connect(delay)
  delay.connect(wet).connect(level)
  level.connect(destination)

  const nodes: AudioNode[] = [input, brake, gain, lowA, lowB, lowAllpass, upperA, upperB, midA, midB, highA, highB, low, mid, high, sum, highpass, lowpass, dry, coloured, post, send, delay, feedback, wet, level]
  // What each automated param starts at (its constructor value), for the engine's own copy of its timeline.
  for (const param of [brake.gain, gain.gain, low.gain, mid.gain, high.gain, lowpass.frequency, highpass.frequency, send.gain, feedback.gain, delay.delayTime, wet.gain, dry.gain, coloured.gain]) {
    timelines.set(param, [{ t: 0, v: param.value, ramp: false }])
  }
  const deck: Deck = {
    ctx,
    input,
    brake,
    gain,
    low,
    mid,
    high,
    highpass,
    lowpass,
    echo: { send, delay, feedback, wet },
    paths: { dry, coloured },
    level,
    source: null,
    dispose() {
      deck.source?.disconnect()
      deck.source = null
      for (const node of nodes) node.disconnect()
    },
  }
  return deck
}

// ---- pure helpers (also used by the player and the editor) ----

/** A curve's value at `t`: linear between keyframes, held before the first and after the last; `neutral` if empty. */
export function valueAt(keyframes: Keyframe[], t: number, neutral: number) {
  if (!keyframes.length) return neutral
  const first = keyframes[0]!
  if (t <= first.t) return first.v
  for (let i = 1; i < keyframes.length; i++) {
    const to = keyframes[i]!
    if (t > to.t) continue
    const from = keyframes[i - 1]!
    return to.t === from.t ? to.v : from.v + ((to.v - from.v) * (t - from.t)) / (to.t - from.t)
  }
  return keyframes[keyframes.length - 1]!.v
}

/** The filter knob (-1…1) as the two filters' cutoffs: a closing low-pass below 0, a rising high-pass above. */
export function filterFrequencies(knob: number, sampleRate: number) {
  const v = Math.max(-1, Math.min(1, knob))
  const top = sampleRate / 2
  return {
    lowpass: v < 0 ? top * (LOWPASS_MIN_HZ / top) ** -v : top,
    highpass: v > 0 ? HIGHPASS_MIN_HZ * (HIGHPASS_MAX_HZ / HIGHPASS_MIN_HZ) ** v : 0,
  }
}

export const beatSeconds = (bpm?: number | null) => 60 / (bpm !== null && bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM)

/**
 * The brake: the deck's speed falls like a turntable whose motor was switched off (linearly, to a stop), and its
 * volume fades out over the last quarter, where a real record only rumbles.
 */
export function brakeRateAt(t: number, length: number) {
  if (t <= 0) return 1
  if (length <= 0 || t >= length) return 0
  return 1 - t / length
}

export function brakeGainAt(t: number, length: number) {
  const fadeFrom = length * 0.75
  if (t <= fadeFrom) return 1
  if (t >= length) return 0
  return 1 - (t - fadeFrom) / (length - fadeFrom)
}

/** How loud deck A is at `t` (its volume curve and a brake's fade), for deciding when B takes over. */
function levelOfA(transition: Transition, t: number) {
  const brake = transition.effects.find((effect) => effect.kind === 'brake')
  const braking = brake ? brakeGainAt(t - brake.at, brake.length) : 1
  return valueAt(transition.a.gain, t, 1) * braking
}

/**
 * When B takes over as "the track playing" (what the UI shows, what is reported): the first moment B (once it has
 * started) is louder than A, or the middle of their overlap when their volumes never cross (both full, say).
 */
export function handoverPoint(transition: Transition) {
  const { length } = transition
  const bAt = Math.max(0, transition.bAt ?? 0)
  if (length <= bAt) return Math.max(0, Math.min(bAt, length))
  // B can't take over before it sounds.
  const step = Math.min(0.05, (length - bAt) / 100)
  for (let t = bAt; t <= length + 1e-9; t += step) {
    if (valueAt(transition.b.gain, t, 1) > levelOfA(transition, t) + 1e-6) return Math.min(t, length)
  }
  return (bAt + length) / 2
}

/**
 * How B's playback rate should be nudged to close an alignment error (seconds; positive: B is ahead). A gentle
 * proportional correction, at most ±`limit` of the rate, so the pitch-preserving stretch never becomes audible; it
 * closes 40 ms in about a second.
 */
export function driftCorrection(error: number, rate: number, limit = 0.04) {
  const nudge = Math.max(-limit, Math.min(limit, -error * 1.0))
  return rate * (1 + nudge)
}

// ---- scheduling ----

/**
 * The engine's copy of what is scheduled on a param: points in time order, each reached by a jump (`ramp: false`) or
 * a linear ramp from the point before.
 */
interface Point {
  t: number
  v: number
  ramp: boolean
}
const timelines = new WeakMap<AudioParam, Point[]>()

const timelineOf = (param: AudioParam) => {
  let points = timelines.get(param)
  if (!points) timelines.set(param, (points = [{ t: 0, v: param.defaultValue, ramp: false }]))
  return points
}

/** A param's scheduled value at context time `time` (from the engine's copy, not `param.value`). */
export function valueOn(param: AudioParam, time: number) {
  const points = timelineOf(param)
  let before: Point | undefined
  for (const point of points) {
    if (point.t > time) {
      if (!before) return point.v
      return point.ramp && point.t > before.t ? before.v + ((point.v - before.v) * (time - before.t)) / (point.t - before.t) : before.v
    }
    before = point
  }
  return before ? before.v : param.defaultValue
}

function insert(param: AudioParam, point: Point) {
  const points = timelineOf(param)
  let at = points.length
  while (at > 0 && points[at - 1]!.t > point.t) at--
  points.splice(at, 0, point)
}

/** `setValueAtTime`, remembered. */
export function setAt(param: AudioParam, time: number, value: number) {
  param.setValueAtTime(value, time)
  insert(param, { t: time, v: value, ramp: false })
}

/** `linearRampToValueAtTime`, remembered. */
export function rampAt(param: AudioParam, time: number, value: number) {
  param.linearRampToValueAtTime(value, time)
  insert(param, { t: time, v: value, ramp: true })
}

/**
 * Stops a param's automation at `time`, keeping the value it has then: everything from `time` on is cancelled and the
 * value at `time` is set again (a ramp under way is cut there, ending on the same line).
 */
export function holdAt(param: AudioParam, time: number) {
  const points = timelineOf(param)
  const value = valueOn(param, time)
  const next = points.find((point) => point.t >= time)
  const crossing = !!next && next.ramp && points.some((point) => point.t < time)
  param.cancelScheduledValues(time)
  // Only the last point before `time` is still needed (a cut ramp starts there).
  const earlier = points.filter((point) => point.t < time)
  timelines.set(param, earlier.slice(-1))
  if (crossing) rampAt(param, time, value)
  else setAt(param, time, value)
}

interface ScheduleOptions {
  /** Context seconds per transition second (1 = real time). */
  timeScale?: number
  /** Start this far into the transition (resuming after a pause): keyframes before it are already past. */
  from?: number
}

/** A linear curve on a param: its value at `from`, then a ramp to each later keyframe. */
function scheduleLinear(param: AudioParam, keyframes: Keyframe[], neutral: number, start: number, scale: number, from: number, now: number) {
  const begin = Math.max(now, start + from * scale)
  const value = valueAt(keyframes, from, neutral)
  // The start value holds from now on (a deck that starts a little early is already where the curve begins).
  holdAt(param, now)
  setAt(param, now, value)
  if (begin > now) setAt(param, begin, value)
  for (const keyframe of keyframes) {
    if (keyframe.t <= from) continue
    rampAt(param, start + keyframe.t * scale, keyframe.v)
  }
}

/** The filter knob's curve: its frequency mapping isn't linear, so it is sampled finely (5 ms) into short ramps. */
function scheduleFilter(deck: Deck, keyframes: Keyframe[], start: number, scale: number, from: number, now: number) {
  const begin = Math.max(now, start + from * scale)
  const rate = deck.ctx.sampleRate
  for (const param of [deck.lowpass.frequency, deck.highpass.frequency]) holdAt(param, now)
  const last = keyframes.length ? keyframes[keyframes.length - 1]!.t : 0
  const span = last - from
  const moving = keyframes.length > 1 && span > 0 && keyframes.some((keyframe) => keyframe.v !== keyframes[0]!.v)
  const initial = filterFrequencies(valueAt(keyframes, from, 0), rate)
  setAt(deck.lowpass.frequency, now, initial.lowpass)
  setAt(deck.highpass.frequency, now, initial.highpass)
  if (!moving) return
  if (begin > now) {
    setAt(deck.lowpass.frequency, begin, initial.lowpass)
    setAt(deck.highpass.frequency, begin, initial.highpass)
  }
  const count = Math.max(2, Math.ceil(span * FILTER_CURVE_RATE) + 1)
  const duration = Math.max(1e-3, start + last * scale - begin)
  for (let i = 1; i < count; i++) {
    const { lowpass, highpass } = filterFrequencies(valueAt(keyframes, from + (span * i) / (count - 1), 0), rate)
    const time = begin + (duration * i) / (count - 1)
    rampAt(deck.lowpass.frequency, time, lowpass)
    rampAt(deck.highpass.frequency, time, highpass)
  }
}

/**
 * Plays a deck's automation: the transition starts at context time `startTime`. Can be called again at any time
 * (a pause or seek during the transition): what was scheduled before is replaced from now on.
 */
export function scheduleAutomation(deck: Deck, automation: DeckAutomation, startTime: number, options: ScheduleOptions = {}) {
  const scale = options.timeScale ?? 1
  const from = Math.max(0, options.from ?? 0)
  const now = deck.ctx.currentTime
  scheduleLinear(deck.gain.gain, automation.gain, 1, startTime, scale, from, now)
  scheduleLinear(deck.low.gain, automation.low, 1, startTime, scale, from, now)
  scheduleLinear(deck.mid.gain, automation.mid, 1, startTime, scale, from, now)
  scheduleLinear(deck.high.gain, automation.high, 1, startTime, scale, from, now)
  scheduleFilter(deck, automation.filter, startTime, scale, from, now)
  scheduleRouting(deck, automation, startTime, scale, from, now)
}

/** Whether a deck's EQ or filter changes its sound at transition time `t`. */
const colours = (automation: DeckAutomation, t: number) =>
  valueAt(automation.low, t, 1) !== 1 || valueAt(automation.mid, t, 1) !== 1 || valueAt(automation.high, t, 1) !== 1 || valueAt(automation.filter, t, 0) !== 0

/**
 * When (transition time, from `from` on) a deck's EQ or filter colours it: from `first` until `last` (Infinity when it
 * stays coloured), or null when never. Curves are linear between keyframes, so checking each keyframe and the middle of
 * each stretch between them is exact.
 */
export function colouredSpan(automation: DeckAutomation, from = 0) {
  const keyframes = [automation.low, automation.mid, automation.high, automation.filter].flat()
  const times = [...new Set([from, ...keyframes.map((keyframe) => keyframe.t).filter((t) => t > from)])].sort((x, y) => x - y)
  let first: number | null = null
  let last = from
  times.forEach((t, i) => {
    const next = times[i + 1]
    if (colours(automation, t)) {
      first ??= t
      last = Math.max(last, t)
    }
    if (colours(automation, next === undefined ? t + 1 : (t + next) / 2)) {
      first ??= t
      last = next ?? Infinity
    }
  })
  return first === null ? null : { first, last }
}

/** A moment in [from, to] (transition time) at which the deck's volume curve is silent, latest (or earliest) first. */
function silentMoment(gain: DeckAutomation['gain'], from: number, to: number, latest: boolean) {
  const candidates = [from, to, ...gain.map((keyframe) => keyframe.t).filter((t) => t > from && t < to)].sort((x, y) => (latest ? y - x : x - y))
  return candidates.find((t) => Number.isFinite(t) && valueAt(gain, t, 1) <= SILENT) ?? null
}

/** Moves a deck's sound onto the dry or the coloured path at context time `time`: at once, or crossfading over `fade`. */
function routeTo(deck: Deck, time: number, path: 'dry' | 'coloured', fade: number) {
  const up = path === 'dry' ? deck.paths.dry.gain : deck.paths.coloured.gain
  const down = path === 'dry' ? deck.paths.coloured.gain : deck.paths.dry.gain
  if (valueOn(up, time) === 1 && valueOn(down, time) === 0) return
  if (fade <= 0) {
    setAt(up, time, 1)
    setAt(down, time, 0)
    return
  }
  // Equal gain: the two paths have the same magnitude, so their sum stays level (apart from the phase difference).
  setAt(up, time, valueOn(up, time))
  setAt(down, time, valueOn(down, time))
  rampAt(up, time + fade, 1)
  rampAt(down, time + fade, 0)
}

/**
 * The deck's path over the transition: dry while neutral, coloured from just before its first EQ/filter move until it is
 * neutral again. Switches happen where the deck is silent when there is such a moment, else as a short crossfade.
 */
function scheduleRouting(deck: Deck, automation: DeckAutomation, start: number, scale: number, from: number, now: number) {
  holdAt(deck.paths.dry.gain, now)
  holdAt(deck.paths.coloured.gain, now)
  const at = (t: number) => Math.max(now, start + t * scale)
  const span = colouredSpan(automation, from)
  if (!span) return routeTo(deck, now, 'dry', CROSSFADE_S)
  const silentIn = silentMoment(automation.gain, from, span.first, true)
  if (silentIn !== null) routeTo(deck, at(silentIn), 'coloured', 0)
  else routeTo(deck, Math.max(at(from), at(span.first) - CROSSFADE_S), 'coloured', CROSSFADE_S)
  if (!Number.isFinite(span.last)) return
  const lastKeyframe = Math.max(span.last, ...automation.gain.map((keyframe) => keyframe.t))
  const silentOut = silentMoment(automation.gain, span.last, lastKeyframe, false)
  if (silentOut !== null) routeTo(deck, at(silentOut), 'dry', 0)
  else routeTo(deck, at(span.last), 'dry', CROSSFADE_S)
}

/** Opens a deck's echo at transition time `effect.at` (or at once when resuming past it). */
function scheduleEcho(deck: Deck, effect: Extract<TransitionEffect, { kind: 'echo' }>, start: number, scale: number, from: number, bpm?: number | null) {
  const now = deck.ctx.currentTime
  const begin = Math.max(now, start + from * scale)
  const at = Math.max(begin, start + effect.at * scale)
  const { send, delay, feedback } = deck.echo
  const delayTime = Math.min(MAX_DELAY_S, Math.max(0.01, effect.beats * beatSeconds(bpm)))
  for (const param of [send.gain, delay.delayTime, feedback.gain]) holdAt(param, begin)
  setAt(delay.delayTime, begin, delayTime)
  setAt(feedback.gain, begin, Math.max(0, Math.min(0.95, effect.feedback)))
  holdAt(deck.echo.wet.gain, begin)
  setAt(deck.echo.wet.gain, begin, 1)
  setAt(send.gain, at, 0)
  rampAt(send.gain, at + DECLICK_S, 1)
}

/** The brake's fade on deck A (its speed is the source's business: a buffer's playbackRate or the element's). */
function scheduleBrakeFade(deck: Deck, effect: Extract<TransitionEffect, { kind: 'brake' }>, start: number, scale: number, from: number) {
  const now = deck.ctx.currentTime
  const begin = Math.max(now, start + from * scale)
  const param = deck.brake.gain
  holdAt(param, begin)
  const local = from - effect.at
  setAt(param, begin, brakeGainAt(local, effect.length))
  const fadeFrom = effect.at + effect.length * 0.75
  if (from < fadeFrom) setAt(param, start + fadeFrom * scale, 1)
  if (from < effect.at + effect.length) rampAt(param, start + (effect.at + effect.length) * scale, 0)
}

/**
 * Everything a transition does to both decks, from transition time `options.from` on: their automation, echoes and the
 * brake's fade. The sources' own rates (B's `rate`, the brake's slowdown) are left to the caller, since a buffer
 * source and a media element change speed differently.
 */
export function scheduleTransition(decks: { a: Deck; b: Deck }, transition: Transition, startTime: number, options: ScheduleOptions = {}) {
  const scale = options.timeScale ?? 1
  const from = Math.max(0, options.from ?? 0)
  const now = decks.a.ctx.currentTime
  const begin = Math.max(now, startTime + from * scale)
  const end = startTime + transition.length * scale
  scheduleAutomation(decks.a, transition.a, startTime, options)
  scheduleAutomation(decks.b, transition.b, startTime, options)
  for (const deck of [decks.a, decks.b]) {
    holdAt(deck.echo.send.gain, begin)
    holdAt(deck.brake.gain, now)
    setAt(deck.brake.gain, now, 1)
  }
  let braking = false
  for (const effect of transition.effects) {
    if (effect.kind === 'echo') scheduleEcho(decks[effect.deck], effect, startTime, scale, from, transition.tempo[effect.deck])
    else {
      braking = true
      scheduleBrakeFade(decks.a, effect, startTime, scale, from)
    }
  }
  // Declicking, on the decks' brake gain (unused otherwise): B comes in over a few ms when it starts (mid-song), and A
  // is silent by the end of the overlap, whatever its curve says (length 0 cuts here too).
  const bStart = startTime + Math.max(0, transition.bAt ?? 0) * scale
  if (bStart >= begin) {
    setAt(decks.b.brake.gain, bStart, 0)
    rampAt(decks.b.brake.gain, bStart + DECLICK_S, 1)
  }
  if (!braking) {
    // (A cut right at the start, or resumed in the last few ms, fades from the earliest moment it still can.)
    const fadeFrom = Math.max(begin, end - DECLICK_S)
    setAt(decks.a.brake.gain, fadeFrom, 1)
    rampAt(decks.a.brake.gain, fadeFrom + DECLICK_S, 0)
  }
}

/**
 * Freezes a deck where it is (a pause during a transition): every curve holds its present value until the transition
 * is scheduled again.
 */
export function freezeDeck(deck: Deck, time = deck.ctx.currentTime) {
  for (const param of automatedParams(deck)) holdAt(param, time)
}

function automatedParams(deck: Deck) {
  return [
    deck.brake.gain,
    deck.gain.gain,
    deck.low.gain,
    deck.mid.gain,
    deck.high.gain,
    deck.lowpass.frequency,
    deck.highpass.frequency,
    deck.echo.send.gain,
    deck.echo.feedback.gain,
    deck.echo.delay.delayTime,
    deck.paths.dry.gain,
    deck.paths.coloured.gain,
  ]
}

/**
 * Lets a deck's echo ring out after the deck has gone: its send closes (nothing new goes in) and the tail fades within
 * `tail` seconds. Returns when it has died away (context time).
 */
export function releaseEcho(deck: Deck, time = deck.ctx.currentTime, tail = 6) {
  const { send, wet } = deck.echo
  holdAt(send.gain, time)
  rampAt(send.gain, time + DECLICK_S, 0)
  holdAt(wet.gain, time)
  rampAt(wet.gain, time + tail, 0)
  return time + tail
}

/**
 * Back to neutral: unity gain, flat EQ, open filter, no echo or brake. With `ramp` (seconds) it glides there instead of
 * jumping (B after its transition, which may end on a not quite neutral setting). `level` stays as the player set it.
 */
export function resetDeck(deck: Deck, time = deck.ctx.currentTime, ramp = 0) {
  const top = nyquist(deck.ctx)
  for (const param of automatedParams(deck)) holdAt(param, time)
  const unity = [deck.brake.gain, deck.gain.gain, deck.low.gain, deck.mid.gain, deck.high.gain]
  const end = time + ramp
  for (const param of unity) {
    if (ramp > 0) rampAt(param, end, 1)
    else setAt(param, time, 1)
  }
  // The filters glide open on the log scale (short ramps); the transparent end points are then set exactly.
  if (ramp > 0) {
    const lowFrom = Math.max(LOWPASS_MIN_HZ, valueOn(deck.lowpass.frequency, time))
    const highFrom = Math.max(HIGHPASS_MIN_HZ, valueOn(deck.highpass.frequency, time))
    for (let i = 1; i <= GLIDE_STEPS; i++) {
      const p = i / GLIDE_STEPS
      rampAt(deck.lowpass.frequency, time + ramp * p, lowFrom * (top / lowFrom) ** p)
      rampAt(deck.highpass.frequency, time + ramp * p, highFrom * (HIGHPASS_MIN_HZ / highFrom) ** p)
    }
  }
  setAt(deck.lowpass.frequency, end, top)
  setAt(deck.highpass.frequency, end, 0)
  // Back on the dry path once neutral (a glide ends with a crossfade; an instant reset switches at once).
  routeTo(deck, end, 'dry', ramp > 0 ? CROSSFADE_S : 0)
  // The echo: nothing goes in any more, and its return stays shut until the delay line has emptied itself.
  const { send, feedback, wet } = deck.echo
  holdAt(wet.gain, time)
  setAt(send.gain, time, 0)
  setAt(feedback.gain, time, 0)
  setAt(wet.gain, time, 0)
  setAt(wet.gain, time + MAX_DELAY_S + 0.05, 1)
}

/**
 * A transition as it is played: 'none' is back to back, so it has no overlap, automation, effects or tempo change,
 * and A plays to its real end (`aEnd`, when known; the player waits for A's own end otherwise).
 */
export function asPlayed(transition: Transition, aEnd?: number): Transition {
  if (transition.preset !== 'none') return transition
  const still = () => ({ gain: [], low: [], mid: [], high: [], filter: [] })
  return { ...transition, aOut: aEnd && aEnd > 0 ? aEnd : Number.NaN, bAt: 0, length: 0, pathA: [], pathB: [], rateA: [], rateB: [], a: still(), b: still(), effects: [] }
}

// ---- the master: a lookahead limiter after all decks ----

/**
 * The limiter's ceiling (on sample peaks) and lookahead. At full scale, a loud master on its own never reaches it (its
 * samples are at most full scale), so engaging the limiter changes nothing until two tracks really add up past it. A
 * lower ceiling, or one on true peaks, would also turn down single masters that are mastered that hot (measured: at
 * −0.1 dBFS, Don't You Worry Child and Animals alone were turned down on 84 % / 67 % of frames; at 0 dBTP true peak
 * by up to 1.05 dB), which would be heard as a level step whenever a transition starts.
 */
export const LIMITER_CEILING_DB = 0
const LIMITER_LOOKAHEAD_S = 0.005
const LIMITER_RELEASE_S = 0.15

/**
 * The limiter, run as an AudioWorklet. Per sample it takes the louder channel's peak, asks for the gain that keeps it
 * under the ceiling, takes the minimum of that over the lookahead window and smooths it with a moving average as long as the
 * window: the gain is down by the time a peak comes out of the delay line, never later, and ramps there instead of
 * jumping (no distortion). It recovers with a 150 ms release. Both channels share one gain (the stereo image stays).
 * The audio is delayed by the lookahead (`latency` in the node's options).
 *
 * The `active` param says whether it may act. The audio always takes the same delayed path; what changes is how much
 * of the gain reduction is applied (`mix`): engaging and letting go never shift the sound in time or mix two versions
 * of it. Off, the output is exactly the delayed input. It engages within 5 ms and lets go over the release time (150
 * ms), so a reduction still under way rises back like an ordinary release; it can't wait for the reduction to end on
 * its own, as a loud master alone may keep it reducing (its peaks then pass, as in the plain player).
 */
const LIMITER_PROCESSOR = `
class LumioLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }]
  }
  constructor(options) {
    super()
    const o = options.processorOptions || {}
    this.ceiling = Math.pow(10, o.ceilingDb / 20)
    this.box = Math.max(1, Math.round(o.lookahead * sampleRate))
    this.window = this.box + 2
    this.delay = this.box + 1
    this.release = 1 - Math.exp(-1 / (o.release * sampleRate))
    this.report = o.report ? Math.round(sampleRate / 10) : 0
    this.lines = [new Float32Array(this.delay + 1), new Float32Array(this.delay + 1)]
    this.write = 0
    this.minValues = new Float64Array(this.window + 1)
    this.minIndex = new Float64Array(this.window + 1)
    this.head = 0
    this.tail = 0
    this.boxValues = new Float64Array(this.box).fill(1)
    this.boxAt = 0
    this.boxSum = this.box
    this.gain = 1
    this.mix = 0
    this.mixUp = 1 / Math.max(1, Math.round(0.005 * sampleRate))
    this.mixDown = 1 / Math.max(1, Math.round(o.release * sampleRate))
    this.n = 0
    this.frames = 0
    this.limited = 0
    this.deep = 0
    this.minGain = 1
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    const length = output[0].length
    const target = parameters.active[0]
    for (let i = 0; i < length; i++) {
      let peak = 0
      for (let c = 0; c < 2; c++) {
        const source = input[Math.min(c, input.length - 1)]
        const x = source ? source[i] : 0
        peak = Math.max(peak, Math.abs(x))
        this.lines[c][this.write] = x
      }
      const wanted = peak > this.ceiling ? this.ceiling / peak : 1
      const n = this.n++
      while (this.tail > this.head && this.minValues[(this.tail - 1) % (this.window + 1)] >= wanted) this.tail--
      this.minValues[this.tail % (this.window + 1)] = wanted
      this.minIndex[this.tail % (this.window + 1)] = n
      this.tail++
      while (this.minIndex[this.head % (this.window + 1)] <= n - this.window) this.head++
      const held = this.minValues[this.head % (this.window + 1)]
      this.boxSum += held - this.boxValues[this.boxAt]
      this.boxValues[this.boxAt] = held
      this.boxAt = (this.boxAt + 1) % this.box
      if ((n & 4095) === 0) this.boxSum = this.boxValues.reduce((sum, value) => sum + value, 0)
      const smooth = Math.min(1, this.boxSum / this.box)
      this.gain = smooth < this.gain ? smooth : this.gain + (smooth - this.gain) * this.release
      if (this.mix < target) this.mix = Math.min(target, this.mix + this.mixUp)
      else if (this.mix > target) this.mix = Math.max(target, this.mix - this.mixDown)
      const applied = this.mix === 0 ? 1 : 1 - this.mix * (1 - this.gain)
      const read = (this.write + 1) % (this.delay + 1)
      for (let c = 0; c < output.length; c++) output[c][i] = this.lines[Math.min(c, 1)][read] * applied
      this.write = read
      if (applied < 0.9999) this.limited++
      if (applied < 0.944) this.deep++
      if (applied < this.minGain) this.minGain = applied
    }
    this.frames += length
    if (this.report && this.frames % this.report < length) this.port.postMessage({ frames: this.frames, limited: this.limited, deep: this.deep, minGain: this.minGain })
    return true
  }
}
registerProcessor('lumio-limiter', LumioLimiter)
`

/** What the limiter did so far (when asked to report): frames seen, frames turned down (at all, by over 0.5 dB), deepest gain. */
export interface LimiterStats {
  frames: number
  limited: number
  deep: number
  minGain: number
}

export interface Master {
  /** Connect the decks here. */
  input: GainNode
  /** How much later the sound comes out (the limiter's lookahead), in seconds. */
  latency: number
  /** Lets the limiter act from context time `time` on (a transition starts), or lets it go (it is over). */
  engage(on: boolean, time?: number): void
  dispose(): void
}

const limiterModules = new WeakMap<BaseAudioContext, Promise<void>>()

/** How many frames later the limiter's output comes (its lookahead, plus one). */
export const limiterLatency = (sampleRate: number) => Math.max(1, Math.round(LIMITER_LOOKAHEAD_S * sampleRate)) + 1

/**
 * The mixer's master bus into `destination`: everything the decks play goes through the limiter. Loads the limiter's
 * worklet into the context first (once per context; from a blob, so no separate file has to be served).
 */
export async function createMaster(ctx: BaseAudioContext, destination: AudioNode, options: { onStats?: (stats: LimiterStats) => void } = {}): Promise<Master> {
  let loading = limiterModules.get(ctx)
  if (!loading) {
    const url = URL.createObjectURL(new Blob([LIMITER_PROCESSOR], { type: 'text/javascript' }))
    loading = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    limiterModules.set(ctx, loading)
  }
  await loading
  const input = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit' })
  const limiter = new AudioWorkletNode(ctx, 'lumio-limiter', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { ceilingDb: LIMITER_CEILING_DB, lookahead: LIMITER_LOOKAHEAD_S, release: LIMITER_RELEASE_S, report: !!options.onStats },
  })
  if (options.onStats) limiter.port.onmessage = (event: MessageEvent<LimiterStats>) => options.onStats!(event.data)
  input.connect(limiter).connect(destination)
  const active = limiter.parameters.get('active')!
  return {
    input,
    latency: limiterLatency(ctx.sampleRate) / ctx.sampleRate,
    engage(on, time = ctx.currentTime) {
      const at = Math.max(ctx.currentTime, time)
      holdAt(active, at)
      setAt(active, at, on ? 1 : 0)
    },
    dispose() {
      input.disconnect()
      limiter.disconnect()
      limiter.port.onmessage = null
    },
  }
}
