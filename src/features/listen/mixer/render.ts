import { asPlayed, brakeRateAt, createDeck, createMaster, limiterLatency, rateAt, rateEaseSeconds, resetDeck, releaseEcho, scheduleTransition, type LimiterStats } from './engine'
import type { Transition } from './types'

/**
 * Renders a transition to audio, offline: the editor's preview, and demo mixes. It runs the very graph the player uses
 * (`createDeck` / `scheduleTransition`), fed by decoded buffers instead of <audio> elements.
 *
 * One difference to live playback: a buffer source changes pitch with its speed, so B's `rate` (and the brake) are
 * heard with the pitch shifted here, while the player keeps B's pitch (the media element's pitch-preserving
 * stretch). For the small beatmatching rates (±6 %) that is about one semitone at most.
 *
 * The rendered timeline: 0 is `preRoll` seconds before A's `aOut`; the transition starts at `preRoll` (B's `bIn`
 * starts there; with a negative `bIn` B's top starts `-bIn / rate` seconds later), A stops `length` seconds later, and the
 * render ends `postRoll` seconds after that. Both decks go through the player's master limiter (−1 dBFS); its lookahead
 * delay is taken out again, so the timeline stays exact to the sample. As in the player the limiter only acts from just
 * before the transition until it is over (and its release has run out): the rolls before and after are the sources
 * as they are.
 */
export interface RenderTransitionOptions {
  a: AudioBuffer
  b: AudioBuffer
  transition: Transition
  /** Seconds of A before the transition (default 8; less if A doesn't have them: then the render starts silent). */
  preRoll?: number
  /** Seconds of B after the overlap (default 8). */
  postRoll?: number
  /** Default: A's sample rate. */
  sampleRate?: number
  /** The limiter's statistics, as rendering goes on (the last call has the whole render). */
  onLimiter?: (stats: LimiterStats) => void
}

/** Sample-rate independent time → frame conversion used for the render's length. */
const frames = (seconds: number, sampleRate: number) => Math.max(1, Math.round(seconds * sampleRate))

/** The limiter is engaged this long before the transition, while B is still silent. */
const LIMITER_LEAD_S = 0.05

/** How finely the sources' speed curves (brake, B's easing) are sampled. */
const RATE_CURVE_RATE = 100

export async function renderTransition(options: RenderTransitionOptions): Promise<AudioBuffer> {
  const { a, b } = options
  // As the player plays it ('none': back to back from A's real end, nothing else).
  const transition = asPlayed(options.transition, a.duration)
  const preRoll = Math.max(0, options.preRoll ?? 8)
  const postRoll = Math.max(0, options.postRoll ?? 8)
  const sampleRate = options.sampleRate ?? a.sampleRate
  const length = Math.max(0, transition.length)
  const total = preRoll + length + postRoll
  const latency = limiterLatency(sampleRate)
  const wanted = frames(total, sampleRate)
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: wanted + latency, sampleRate })
  const master = await createMaster(ctx, ctx.destination, { onStats: options.onLimiter })
  const deckA = createDeck(ctx, master.input)
  const deckB = createDeck(ctx, master.input)
  const start = preRoll
  const end = start + length

  // A: from `aOut - preRoll` (or silent until its start), gone when the overlap ends.
  const sourceA = new AudioBufferSourceNode(ctx, { buffer: a })
  sourceA.connect(deckA.input)
  const aFrom = transition.aOut - preRoll
  if (aFrom >= 0) sourceA.start(0, aFrom)
  else sourceA.start(-aFrom, 0)
  sourceA.stop(end)
  const brake = transition.effects.find((effect) => effect.kind === 'brake')
  if (brake && brake.length > 0) {
    const count = Math.max(2, Math.ceil(brake.length * RATE_CURVE_RATE) + 1)
    const curve = new Float32Array(count)
    for (let i = 0; i < count; i++) curve[i] = brakeRateAt((brake.length * i) / (count - 1), brake.length)
    sourceA.playbackRate.setValueCurveAtTime(curve, start + brake.at, brake.length)
  }

  // B: from `bIn` at the transition's start, at `rate` during the overlap, then easing back to 1.
  const sourceB = new AudioBufferSourceNode(ctx, { buffer: b, playbackRate: transition.rate })
  sourceB.connect(deckB.input)
  // B's position is bIn + t · rate: a negative bIn starts it from its top at t = -bIn / rate (its automation at 0).
  sourceB.start(start + Math.max(0, -transition.bIn) / transition.rate, Math.max(0, transition.bIn))
  if (transition.rate !== 1) {
    const ease = Math.min(rateEaseSeconds(transition.tempo.b), Math.max(0, total - end))
    if (ease > 0) {
      const count = Math.max(2, Math.ceil(ease * RATE_CURVE_RATE) + 1)
      const curve = new Float32Array(count)
      for (let i = 0; i < count; i++) curve[i] = rateAt(transition, length + (ease * i) / (count - 1))
      sourceB.playbackRate.setValueCurveAtTime(curve, end, ease)
    }
  }

  scheduleTransition({ a: deckA, b: deckB }, transition, start)
  // As in the player: A's echo rings out after A is gone; B glides back to neutral and plays on.
  releaseEcho(deckA, end)
  resetDeck(deckB, end, 0.05)
  master.engage(true, Math.max(0, start - LIMITER_LEAD_S))
  master.engage(false, end + 0.05)

  // Without the limiter's delay at the front.
  const rendered = await ctx.startRendering()
  const out = new AudioBuffer({ numberOfChannels: rendered.numberOfChannels, length: wanted, sampleRate })
  for (let channel = 0; channel < rendered.numberOfChannels; channel++) out.copyToChannel(rendered.getChannelData(channel).subarray(latency, latency + wanted), channel)
  return out
}

/** A rendered buffer as a 16-bit PCM WAV file (interleaved, clipped at full scale). */
export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels
  const count = buffer.length
  const bytesPerSample = 2
  const dataSize = count * channels * bytesPerSample
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataSize, true)
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel))
  let offset = 44
  for (let i = 0; i < count; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, data[channel]![i]!))
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
      offset += bytesPerSample
    }
  }
  return out
}
