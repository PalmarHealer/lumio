import type { DeckAutomation, Keyframe, Transition, TransitionEffect } from './types'

/**
 * The mixer's audio graph: one "deck" per playing track, the same for live playback (an AudioContext fed by the
 * player's <audio> elements) and for rendering a transition offline (an OfflineAudioContext fed by decoded buffers),
 * so what the editor previews is what the player plays.
 *
 *   input → brake → gain → 3-band isolator (low / mid / high) → high-pass → low-pass → (+ echo) → level → destination
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
/** How finely the filter's (non-linear) frequency curve is sampled. */
const FILTER_CURVE_RATE = 200
/** Longest echo delay a deck allows (seconds). */
const MAX_DELAY_S = 4
/** A tempo that isn't a usable number counts as this (the contract already sends 120 for unknown ones). */
export const DEFAULT_BPM = 120
/** B's rate eases back to 1 over this many beats after the overlap (8 bars of 4/4). */
const RATE_EASE_BEATS = 32
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
  /** The player's volume, normalization and fades; 1 when rendering. */
  level: GainNode
  /** Disconnects the deck from its destination and its nodes from each other. */
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

  const level = new GainNode(ctx)
  lowpass.connect(level)
  const send = new GainNode(ctx, { gain: 0 })
  const delay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY_S, delayTime: 0.5 })
  const feedback = new GainNode(ctx, { gain: 0 })
  const wet = new GainNode(ctx)
  lowpass.connect(send).connect(delay)
  delay.connect(feedback).connect(delay)
  delay.connect(wet).connect(level)
  level.connect(destination)

  const nodes: AudioNode[] = [input, brake, gain, lowA, lowB, lowAllpass, upperA, upperB, midA, midB, highA, highB, low, mid, high, sum, highpass, lowpass, send, delay, feedback, wet, level]
  return {
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
    level,
    dispose() {
      for (const node of nodes) node.disconnect()
    },
  }
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

/**
 * B's playback rate at `t` seconds from the transition's start: `rate` during the overlap, then easing back to 1 over
 * the 8 bars after it (smoothly, so the tempo change isn't heard as a step).
 */
export function rateAt(transition: Pick<Transition, 'rate' | 'length' | 'tempo'>, t: number) {
  const { rate, length } = transition
  if (t <= length || rate === 1) return rate
  const ease = rateEaseSeconds(transition.tempo.b)
  const p = Math.min(1, (t - length) / ease)
  return rate + (1 - rate) * p * p * (3 - 2 * p)
}

/** How long B's rate takes to get back to 1 after the overlap. */
export const rateEaseSeconds = (bpmB?: number | null) => RATE_EASE_BEATS * beatSeconds(bpmB)

/** How loud deck A is at `t` (its volume curve and a brake's fade), for deciding when B takes over. */
function levelOfA(transition: Transition, t: number) {
  const brake = transition.effects.find((effect) => effect.kind === 'brake')
  const braking = brake ? brakeGainAt(t - brake.at, brake.length) : 1
  return valueAt(transition.a.gain, t, 1) * braking
}

/**
 * When B takes over as "the track playing" (what the UI shows, what is reported): the first moment B is louder than
 * A, or the middle of the overlap when their volumes never cross (both full, say). A hard cut hands over at once.
 */
export function handoverPoint(transition: Transition) {
  const { length } = transition
  if (length <= 0) return 0
  const step = Math.min(0.05, length / 100)
  for (let t = 0; t <= length + 1e-9; t += step) {
    if (valueAt(transition.b.gain, t, 1) > levelOfA(transition, t) + 1e-6) return Math.min(t, length)
  }
  return length / 2
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

/** Stops a param's automation at `time`, keeping the value it has then (no jump back to an older value). */
export function holdAt(param: AudioParam, time: number) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time)
    return
  }
  // Browsers without cancelAndHoldAtTime (older Firefox): the value as it is now, held.
  const value = param.value
  param.cancelScheduledValues(time)
  param.setValueAtTime(value, time)
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
  param.setValueAtTime(value, now)
  if (begin > now) param.setValueAtTime(value, begin)
  for (const keyframe of keyframes) {
    if (keyframe.t <= from) continue
    param.linearRampToValueAtTime(keyframe.v, start + keyframe.t * scale)
  }
}

/**
 * The filter knob's curve: its frequency mapping isn't linear, so the curve is sampled finely (5 ms) and handed over
 * as one value curve per filter.
 */
function scheduleFilter(deck: Deck, keyframes: Keyframe[], start: number, scale: number, from: number, now: number) {
  const begin = Math.max(now, start + from * scale)
  const rate = deck.ctx.sampleRate
  for (const param of [deck.lowpass.frequency, deck.highpass.frequency]) holdAt(param, now)
  const last = keyframes.length ? keyframes[keyframes.length - 1]!.t : 0
  const span = last - from
  const moving = keyframes.length > 1 && span > 0 && keyframes.some((keyframe) => keyframe.v !== keyframes[0]!.v)
  const initial = filterFrequencies(valueAt(keyframes, from, 0), rate)
  if (!moving || begin > now) {
    deck.lowpass.frequency.setValueAtTime(initial.lowpass, now)
    deck.highpass.frequency.setValueAtTime(initial.highpass, now)
  }
  if (!moving) return
  const count = Math.max(2, Math.ceil(span * FILTER_CURVE_RATE) + 1)
  const lowCurve = new Float32Array(count)
  const highCurve = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const { lowpass, highpass } = filterFrequencies(valueAt(keyframes, from + (span * i) / (count - 1), 0), rate)
    lowCurve[i] = lowpass
    highCurve[i] = highpass
  }
  const duration = Math.max(1e-3, start + last * scale - begin)
  deck.lowpass.frequency.setValueCurveAtTime(lowCurve, begin, duration)
  deck.highpass.frequency.setValueCurveAtTime(highCurve, begin, duration)
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
}

/** Opens a deck's echo at transition time `effect.at` (or at once when resuming past it). */
function scheduleEcho(deck: Deck, effect: Extract<TransitionEffect, { kind: 'echo' }>, start: number, scale: number, from: number, bpm?: number | null) {
  const now = deck.ctx.currentTime
  const begin = Math.max(now, start + from * scale)
  const at = Math.max(begin, start + effect.at * scale)
  const { send, delay, feedback } = deck.echo
  const delayTime = Math.min(MAX_DELAY_S, Math.max(0.01, effect.beats * beatSeconds(bpm)))
  for (const param of [send.gain, delay.delayTime, feedback.gain]) holdAt(param, begin)
  delay.delayTime.setValueAtTime(delayTime, begin)
  feedback.gain.setValueAtTime(Math.max(0, Math.min(0.95, effect.feedback)), begin)
  holdAt(deck.echo.wet.gain, begin)
  deck.echo.wet.gain.setValueAtTime(1, begin)
  send.gain.setValueAtTime(0, at)
  send.gain.linearRampToValueAtTime(1, at + DECLICK_S)
}

/** The brake's fade on deck A (its speed is the source's business: a buffer's playbackRate or the element's). */
function scheduleBrakeFade(deck: Deck, effect: Extract<TransitionEffect, { kind: 'brake' }>, start: number, scale: number, from: number) {
  const now = deck.ctx.currentTime
  const begin = Math.max(now, start + from * scale)
  const param = deck.brake.gain
  holdAt(param, begin)
  const local = from - effect.at
  param.setValueAtTime(brakeGainAt(local, effect.length), begin)
  const fadeFrom = effect.at + effect.length * 0.75
  if (from < fadeFrom) param.setValueAtTime(1, start + fadeFrom * scale)
  if (from < effect.at + effect.length) param.linearRampToValueAtTime(0, start + (effect.at + effect.length) * scale)
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
    deck.brake.gain.setValueAtTime(1, now)
  }
  let braking = false
  for (const effect of transition.effects) {
    if (effect.kind === 'echo') scheduleEcho(decks[effect.deck], effect, startTime, scale, from, transition.tempo[effect.deck])
    else {
      braking = true
      scheduleBrakeFade(decks.a, effect, startTime, scale, from)
    }
  }
  // Declicking, on the decks' brake gain (unused otherwise): B comes in over a few ms (it starts mid-song), and A is
  // silent by the end of the overlap, whatever its curve says (a hard cut, length 0, cuts here too).
  if (from === 0 && startTime >= now) {
    decks.b.brake.gain.setValueAtTime(0, startTime)
    decks.b.brake.gain.linearRampToValueAtTime(1, startTime + DECLICK_S)
  }
  if (!braking) {
    // (A cut right at the start, or resumed in the last few ms, fades from the earliest moment it still can.)
    const fadeFrom = Math.max(begin, end - DECLICK_S)
    decks.a.brake.gain.setValueAtTime(1, fadeFrom)
    decks.a.brake.gain.linearRampToValueAtTime(0, fadeFrom + DECLICK_S)
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
  ]
}

/**
 * Lets a deck's echo ring out after the deck has gone: its send closes (nothing new goes in) and the tail fades within
 * `tail` seconds. Returns when it has died away (context time).
 */
export function releaseEcho(deck: Deck, time = deck.ctx.currentTime, tail = 6) {
  const { send, wet } = deck.echo
  holdAt(send.gain, time)
  send.gain.linearRampToValueAtTime(0, time + DECLICK_S)
  holdAt(wet.gain, time)
  wet.gain.linearRampToValueAtTime(0, time + tail)
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
    if (ramp > 0) param.linearRampToValueAtTime(1, end)
    else param.setValueAtTime(1, time)
  }
  // The filters glide on the log scale (an exponential ramp); the transparent end points are then set exactly.
  if (ramp > 0) {
    deck.lowpass.frequency.exponentialRampToValueAtTime(top, end)
    deck.highpass.frequency.setValueAtTime(Math.max(HIGHPASS_MIN_HZ, deck.highpass.frequency.value), time)
    deck.highpass.frequency.exponentialRampToValueAtTime(HIGHPASS_MIN_HZ, end)
  }
  deck.lowpass.frequency.setValueAtTime(top, end)
  deck.highpass.frequency.setValueAtTime(0, end)
  // The echo: nothing goes in any more, and its return stays shut until the delay line has emptied itself.
  const { send, feedback, wet } = deck.echo
  holdAt(wet.gain, time)
  send.gain.setValueAtTime(0, time)
  feedback.gain.setValueAtTime(0, time)
  wet.gain.setValueAtTime(0, time)
  wet.gain.setValueAtTime(1, time + MAX_DELAY_S + 0.05)
}
