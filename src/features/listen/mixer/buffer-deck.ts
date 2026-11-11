import { deckSchedule, positionAt, rateOf, type DeckPlan } from './deck-schedule'
import { createDeckLimiter, holdAt, rampAt, setAt, type LimiterStats } from './engine'
import { createStretch } from './stretch'

/**
 * A deck playing a transition from decoded audio, sample-exactly on the transition's clock: its path (loops,
 * segments) at its rate curve. Two ways to play it:
 *
 * - `exact`: the audio itself (AudioBufferSourceNodes), each piece of the path from its position, the rate curve on
 *   `playbackRate` (so the pitch follows the tempo, as on a DJ deck without key lock). The waveform stays the track's
 *   own (no change in peaks), loops land to the sample, it costs nothing. Joins crossfade over 4 ms (equal power: the
 *   two sides are different audio).
 * - `stretch`: Signalsmith Stretch (stretch.ts), pitch kept. Its phase reconstruction raises the peaks of loud
 *   masters by 1–6 dB (same loudness).
 * - `hybrid` (what decks whose tempo changes play): exact wherever the rate is exactly 1, stretched only while it
 *   isn't, switching at the moments the rate leaves or reaches 1 with a 10 ms equal-power crossfade (the two ways are
 *   lined up to the sample). The stretched sound passes a deck limiter whose ceiling is the track's own local peak
 *   (the unstretched audio's, ±37.5 ms, at the position the deck plays): the peaks the stretcher made up go, the
 *   track's own dynamics stay.
 *
 * Both take their audio as channels plus the track position of the first sample, and follow a `DeckPlan` from
 * transition time `from` to `to`, with the transition's t = 0 at context time `zero`.
 */
export type BufferDeckKind = 'exact' | 'stretch' | 'hybrid'

/**
 * How a deck whose tempo changes is played, in the player and in render.ts alike: `hybrid` (pitch kept while the
 * tempo differs), `stretch` (stretched throughout), or `exact` (the pitch follows the tempo). Decks whose rate stays 1
 * always play exactly.
 */
export let tempoChangeKind: BufferDeckKind = 'hybrid'
export const setTempoChangeKind = (kind: BufferDeckKind) => (tempoChangeKind = kind)

export interface BufferDeck {
  kind: BufferDeckKind
  /** How far ahead (seconds) playback must be scheduled to land exactly. */
  latency: number
  load(channels: Float32Array<ArrayBuffer>[], origin: number, sampleRate: number): Promise<void>
  play(plan: DeckPlan, from: number, to: number, zero: number, semitones?: (t: number) => number): void
  /** Fades out over a few ms from context time `when` and stops. */
  stopAt(when: number): void
  /** Resolves once everything scheduled so far has reached the audio thread (an offline render waits for it). */
  settled(): Promise<void>
  dispose(): void
}

const JOIN_FADE_S = 0.004
const CURVE_POINTS = 32
/** Equal-power fade shapes (sine/cosine quarter waves). */
const fadeIn = Float32Array.from({ length: CURVE_POINTS }, (_, i) => Math.sin(((i / (CURVE_POINTS - 1)) * Math.PI) / 2))
const fadeOut = Float32Array.from({ length: CURVE_POINTS }, (_, i) => Math.cos(((i / (CURVE_POINTS - 1)) * Math.PI) / 2))

export interface BufferDeckOptions {
  /** The deck limiter's statistics (hybrid only). */
  onLimiter?: (stats: LimiterStats) => void
}

export async function createBufferDeck(ctx: BaseAudioContext, destination: AudioNode, kind: BufferDeckKind, options: BufferDeckOptions = {}): Promise<BufferDeck> {
  if (kind === 'hybrid') return createHybridDeck(ctx, destination, options)
  if (kind === 'stretch') {
    const stretch = await createStretch(ctx, destination)
    return {
      kind,
      latency: stretch.latency,
      load: (channels, origin) => stretch.load(channels, origin),
      play: (plan, from, to, zero, semitones) => stretch.follow(deckSchedule(plan, from, to), zero, semitones),
      stopAt: (when) => stretch.stopAt(when),
      settled: () => stretch.settled(),
      dispose: () => stretch.dispose(),
    }
  }

  let buffer: AudioBuffer | null = null
  let origin = 0
  const playing: Array<{ source: AudioBufferSourceNode; gain: GainNode }> = []
  return {
    kind,
    latency: 0,
    async load(channels, at, sampleRate) {
      const next = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0]!.length, sampleRate })
      channels.forEach((channel, c) => next.copyToChannel(channel, c))
      buffer = next
      origin = at
    },
    play(plan, from, to, zero) {
      if (!buffer) return
      const points = deckSchedule(plan, from, to)
      // Pieces: runs of points without a jump; each plays from its first point's position.
      const starts = points.map((point, i) => (i === 0 || point.jump ? i : -1)).filter((i) => i >= 0)
      starts.forEach((first, n) => {
        const last = n + 1 < starts.length ? starts[n + 1]! : points.length - 1
        const begin = points[first]!
        const end = points[last]!
        const source = new AudioBufferSourceNode(ctx, { buffer })
        const gain = new GainNode(ctx, { gain: 0 })
        source.connect(gain).connect(destination)
        const at = zero + begin.t
        const stop = zero + end.t + (n + 1 < starts.length ? JOIN_FADE_S : 0)
        // The rate curve itself (linear between keyframes, which are among the points): the position follows its
        // integral, as the plan's does.
        source.playbackRate.setValueAtTime(rateOf(plan, begin.t), at)
        for (let i = first + 1; i <= last; i++) source.playbackRate.linearRampToValueAtTime(rateOf(plan, points[i]!.t), zero + points[i]!.t)
        if (n === 0) gain.gain.setValueAtTime(1, at)
        else gain.gain.setValueCurveAtTime(fadeIn, at, JOIN_FADE_S)
        if (n + 1 < starts.length) gain.gain.setValueCurveAtTime(fadeOut, zero + end.t, JOIN_FADE_S)
        // Started where the deck is at `at` (a hair into the pass if the jump fell between samples).
        source.start(Math.max(ctx.currentTime, at), Math.max(0, begin.position - origin))
        source.stop(stop)
        playing.push({ source, gain })
        source.onended = () => {
          const index = playing.findIndex((entry) => entry.source === source)
          if (index >= 0) playing.splice(index, 1)
          gain.disconnect()
        }
      })
    },
    stopAt(when) {
      for (const { source, gain } of playing) {
        try {
          gain.gain.cancelScheduledValues(when)
          gain.gain.setValueCurveAtTime(fadeOut, when, JOIN_FADE_S)
        } catch {
          // Within a join's own fade: it ends within milliseconds anyway.
        }
        source.stop(when + JOIN_FADE_S)
      }
    },
    // Audio params and sources are set on the main thread.
    settled: () => Promise.resolve(),
    dispose() {
      for (const { source, gain } of playing) {
        source.onended = null
        try {
          source.stop()
        } catch {
          // Not started yet.
        }
        gain.disconnect()
      }
      playing.length = 0
      buffer = null
    },
  }
}

/**
 * How far a deck's rate may stray from 1 and still be played exactly (resampled: its pitch moves with it). 0.3 % is
 * 5 cents, below what the ear tells apart even with both decks sounding; the stretcher, on the other hand, costs
 * transient precision and raises peaks the deck limiter must then take back (it worked on up to 29 % of frames, down
 * to -6 dB, for a mere 0.04 % of beatmatching). Above it the pitch is kept (stretched where the rate isn't 1).
 */
export const EXACT_RATE_TOLERANCE = 0.003

/** Which way a deck plays: exactly while its rate stays within the tolerance of 1 over the window, else `tempoChange`. */
export function bufferDeckKind(plan: DeckPlan, from: number, to: number, tempoChange: BufferDeckKind): BufferDeckKind {
  // The curve is linear between keyframes: its furthest point from 1 is at a keyframe (or where the window starts).
  const deviation = Math.max(Math.abs(rateOf(plan, from) - 1), ...plan.rate.filter((keyframe) => keyframe.t <= to).map((keyframe) => Math.abs(keyframe.v - 1)))
  return deviation > EXACT_RATE_TOLERANCE ? tempoChange : 'exact'
}

/** Equal-power crossfades between the exact and the stretched sound, and how far each plays into the other's turn. */
const SWITCH_FADE_S = 0.01
const SWITCH_STEPS = 8
/** Blocks and window of the track's own peak envelope (the deck limiter's ceiling), and how often it is set. */
const PEAK_BLOCK_S = 0.0025
const PEAK_WINDOW_S = 0.075
const CEILING_STEP_S = 0.01
/** The ceiling where nothing is stretched (never reached). */
const OPEN_CEILING = 16

/**
 * The stretches within [from, to] (transition time) where a deck's rate isn't exactly 1: its rate curve is linear
 * between keyframes, so a stretch between two keyframes is at 1 only if both are.
 */
export function stretchedSpans(plan: DeckPlan, from: number, to: number): Array<[number, number]> {
  const keys = [...plan.rate].sort((x, y) => x.t - y.t)
  if (!keys.length) return []
  const off = (v: number) => Math.abs(v - 1) > 1e-9
  const pieces: Array<[number, number, boolean]> = []
  pieces.push([-Infinity, keys[0]!.t, off(keys[0]!.v)])
  for (let i = 0; i + 1 < keys.length; i++) pieces.push([keys[i]!.t, keys[i + 1]!.t, off(keys[i]!.v) || off(keys[i + 1]!.v)])
  pieces.push([keys[keys.length - 1]!.t, Infinity, off(keys[keys.length - 1]!.v)])
  const spans: Array<[number, number]> = []
  for (const [a, b, stretched] of pieces) {
    // Before its start a deck plays straight (rate 1).
    const start = Math.max(a, from, plan.at)
    const end = Math.min(b, to)
    if (!stretched || end <= start) continue
    const last = spans[spans.length - 1]
    if (last && Math.abs(last[1] - start) < 1e-9) last[1] = end
    else spans.push([start, end])
  }
  return spans
}

/** Per block of `PEAK_BLOCK_S`: the loudest sample within ±`PEAK_WINDOW_S`/2 (either channel). */
function peakEnvelope(channels: Float32Array[], sampleRate: number) {
  const block = Math.max(1, Math.round(PEAK_BLOCK_S * sampleRate))
  const count = Math.ceil(channels[0]!.length / block)
  const blocks = new Float32Array(count)
  for (const channel of channels) {
    for (let b = 0; b < count; b++) {
      let peak = blocks[b]!
      const end = Math.min(channel.length, (b + 1) * block)
      for (let i = b * block; i < end; i++) {
        const x = Math.abs(channel[i]!)
        if (x > peak) peak = x
      }
      blocks[b] = peak
    }
  }
  const half = Math.ceil(PEAK_WINDOW_S / 2 / PEAK_BLOCK_S)
  const windowed = new Float32Array(count)
  for (let b = 0; b < count; b++) {
    let peak = 0
    for (let k = Math.max(0, b - half); k <= Math.min(count - 1, b + half); k++) peak = Math.max(peak, blocks[k]!)
    windowed[b] = peak
  }
  return { windowed, blockSeconds: block / sampleRate }
}

/**
 * Exact where the rate is 1, stretched (and limited to the track's own peaks) where it isn't. The stretched way is
 * scheduled the deck limiter's latency early, so both come out together.
 */
async function createHybridDeck(ctx: BaseAudioContext, destination: AudioNode, options: BufferDeckOptions): Promise<BufferDeck> {
  const exactGain = new GainNode(ctx)
  const stretchGain = new GainNode(ctx, { gain: 0 })
  exactGain.connect(destination)
  stretchGain.connect(destination)
  const limiter = await createDeckLimiter(ctx, options.onLimiter)
  limiter.output.connect(stretchGain)
  const [exact, stretch] = await Promise.all([createBufferDeck(ctx, exactGain, 'exact'), createBufferDeck(ctx, limiter.input, 'stretch')])
  const early = limiter.latency
  let envelope: ReturnType<typeof peakEnvelope> | null = null
  let origin = 0
  const peakAt = (position: number) => {
    if (!envelope) return OPEN_CEILING
    const block = Math.floor((position - origin) / envelope.blockSeconds)
    return Math.max(1e-4, envelope.windowed[Math.min(envelope.windowed.length - 1, Math.max(0, block))]!)
  }
  /** An equal-power fade of `param` to `to` over [at, at + SWITCH_FADE_S], as short linear ramps. */
  const fade = (param: AudioParam, at: number, to: 0 | 1) => {
    setAt(param, at, to === 1 ? 0 : 1)
    for (let i = 1; i <= SWITCH_STEPS; i++) {
      const p = i / SWITCH_STEPS
      rampAt(param, at + SWITCH_FADE_S * p, to === 1 ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2))
    }
  }
  return {
    kind: 'hybrid',
    latency: stretch.latency + early,
    async load(channels, at, sampleRate) {
      envelope = peakEnvelope(channels, sampleRate)
      origin = at
      await Promise.all([exact.load(channels, at, sampleRate), stretch.load(channels, at, sampleRate)])
    },
    play(plan, from, to, zero, semitones) {
      // A brake detunes: stretched throughout. Otherwise only where the rate isn't 1.
      const spans: Array<[number, number]> = semitones ? [[from, to]] : stretchedSpans(plan, from, to)
      const now = ctx.currentTime
      for (const param of [exactGain.gain, stretchGain.gain, limiter.ceiling]) holdAt(param, now)
      const inside = (t: number) => spans.some(([a, b]) => t >= a && t < b)
      const start = Math.max(now, zero + from)
      setAt(exactGain.gain, start, inside(from) ? 0 : 1)
      setAt(stretchGain.gain, start, inside(from) ? 1 : 0)
      setAt(limiter.ceiling, now, OPEN_CEILING)
      // The exact sound between the spans (reaching a fade's length into them).
      let cursor = from
      for (const [a, b] of spans) {
        if (a > cursor) exact.play(plan, cursor, Math.min(to, a + SWITCH_FADE_S), zero)
        cursor = b
      }
      if (cursor < to) exact.play(plan, Math.max(from, cursor - SWITCH_FADE_S), to, zero)
      // The stretched sound within them, its ceiling following the track's own peaks at the position played.
      for (const [a, b] of spans) {
        const begin = Math.max(from, a - SWITCH_FADE_S)
        const end = Math.min(to, b + SWITCH_FADE_S)
        stretch.play(plan, begin, end, zero - early, semitones)
        stretch.stopAt(zero - early + end + 0.005)
        setAt(limiter.ceiling, Math.max(now, zero - early + begin), peakAt(positionAt(plan, begin)))
        for (let t = begin + CEILING_STEP_S; t <= end; t += CEILING_STEP_S) rampAt(limiter.ceiling, zero - early + t, peakAt(positionAt(plan, t)))
        rampAt(limiter.ceiling, zero - early + end + 0.005, OPEN_CEILING)
        // The switches, centred on the moments the rate leaves and reaches 1.
        if (a > from) {
          fade(exactGain.gain, zero + a - SWITCH_FADE_S / 2, 0)
          fade(stretchGain.gain, zero + a - SWITCH_FADE_S / 2, 1)
        }
        if (b < to) {
          fade(stretchGain.gain, zero + b - SWITCH_FADE_S / 2, 0)
          fade(exactGain.gain, zero + b - SWITCH_FADE_S / 2, 1)
        }
      }
    },
    stopAt(when) {
      exact.stopAt(when)
      stretch.stopAt(when - early)
      // The stretcher still holds its latency's worth of sound: both ways are faded out here, so it ends at once.
      for (const param of [exactGain.gain, stretchGain.gain]) {
        holdAt(param, Math.max(ctx.currentTime, when))
        rampAt(param, Math.max(ctx.currentTime, when) + 0.005, 0)
      }
    },
    settled: () => stretch.settled(),
    dispose() {
      exact.dispose()
      stretch.dispose()
      limiter.dispose()
      exactGain.disconnect()
      stretchGain.disconnect()
    },
  }
}
