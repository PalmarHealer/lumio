import { bufferDeckKind, createBufferDeck, tempoChangeKind } from './buffer-deck.ts'
import { bSettled, deckPlan, withBrake } from './deck-schedule.ts'
import { asPlayed, createDeck, createMaster, limiterLatency, loadEngineWorklets, resetDeck, releaseEcho, releaseReverb, scheduleTransition, tailsEnd, switchToRealStem, type LimiterStats } from './engine.ts'
import type { Transition } from './types.ts'

/**
 * Renders a transition to audio, offline: the editor's preview, and demo mixes. It runs what the player runs during a
 * transition: each deck plays from decoded audio through a time-stretcher (paths, loops and rate curves, pitch kept;
 * stretch.ts / deck-schedule.ts), into the same decks (`createDeck` / `scheduleTransition`) and master limiter.
 *
 * The rendered timeline: 0 is `preRoll` seconds before t = 0 (A at `aOut`); B starts at `bAt` (at `bIn`), A is gone at
 * `length`, and the render ends `postRoll` seconds after that. The stretcher needs its changes scheduled a little
 * ahead and the limiter delays by its lookahead; the render starts early enough for both and drops that lead again, so
 * the timeline stays exact to the sample. As in the player the limiter only acts from just before the transition until
 * B plays at its own tempo again: the rolls before and after are the sources as they are (the stretcher passes rate 1
 * through exactly).
 */
export interface RenderTransitionOptions {
  a: AudioBuffer
  b: AudioBuffer
  transition: Transition
  /** Seconds of A before the transition (default 8; less if A doesn't have them: then the render starts silent). */
  preRoll?: number
  /** Seconds of B after A is gone (default 8). */
  postRoll?: number
  /** Default: A's sample rate. */
  sampleRate?: number
  /** The limiter's statistics, as rendering goes on (the last call has the whole render). */
  onLimiter?: (stats: LimiterStats) => void
  /** The same for each deck's own limiter (on its stretched sound, see buffer-deck.ts). */
  onDeckLimiter?: (deck: 'a' | 'b', stats: LimiterStats) => void
  /**
   * The decks apart, without the master: four channels, deck A's output on 0–1 and deck B's on 2–3, each after its
   * automation, effects and tails, before any level and the limiter (a baked clip, see baked.ts).
   */
  parts?: boolean
  /** Real stems of either song (whole songs, aligned with `a` / `b`): they replace the stem lanes' approximation. */
  stems?: { a?: RenderStems; b?: RenderStems }
}

export type RenderStems = Partial<Record<'drums' | 'vocals' | 'instrumental', AudioBuffer>>

/** Sample-rate independent time → frame conversion used for the render's length. */
const frames = (seconds: number, sampleRate: number) => Math.max(1, Math.round(seconds * sampleRate))

/** The limiter is engaged this long before the transition, while B is still silent. */
const LIMITER_LEAD_S = 0.05
/** Rendered before the timeline's 0 and dropped: the stretchers' changes must be scheduled this far ahead (≥ 140 ms). */
const STRETCH_LEAD_S = 0.5

/** How decks whose tempo changes are played: buffer-deck.ts' setting (re-exported for the editor and demos). */
export { setTempoChangeKind } from './buffer-deck.ts'

/** A buffer's channels as two (a mono file plays on both sides). */
const stereo = (buffer: AudioBuffer) => [buffer.getChannelData(0), buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1))] as Float32Array<ArrayBuffer>[]

export async function renderTransition(options: RenderTransitionOptions): Promise<AudioBuffer> {
  const { a, b } = options
  // As the player plays it ('none': back to back from A's real end, nothing else).
  const transition = asPlayed(options.transition, a.duration)
  const preRoll = Math.max(0, options.preRoll ?? 8)
  const postRoll = Math.max(0, options.postRoll ?? 8)
  const sampleRate = options.sampleRate ?? a.sampleRate
  const length = Math.max(0, transition.length)
  const total = preRoll + length + postRoll
  const parts = !!options.parts
  const latency = parts ? 0 : limiterLatency(sampleRate)
  const lead = frames(STRETCH_LEAD_S, sampleRate)
  const wanted = frames(total, sampleRate)
  const ctx = new OfflineAudioContext({ numberOfChannels: parts ? 4 : 2, length: lead + wanted + latency, sampleRate })
  let master: Awaited<ReturnType<typeof createMaster>> | null = null
  let outA: AudioNode
  let outB: AudioNode
  if (parts) {
    await loadEngineWorklets(ctx)
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 4 })
    merger.connect(ctx.destination)
    const [splitA, splitB] = [0, 2].map((first) => {
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
      split.connect(merger, 0, first)
      split.connect(merger, 1, first + 1)
      return split
    })
    ;[outA, outB] = [splitA!, splitB!]
  } else {
    master = await createMaster(ctx, ctx.destination, { onStats: options.onLimiter })
    outA = outB = master.input
  }
  const deckA = createDeck(ctx, outA)
  const deckB = createDeck(ctx, outB)
  // Context time of transition time 0.
  const zero = lead / sampleRate + preRoll
  // A: straight into the transition, then its path at its rate (and a brake, if any), gone at `length`. (It starts
  // within the dropped lead, so its first sample has settled when the render begins.) B: from `bAt` on its path, at its
  // rate (back at 1 by its last keyframe), playing on to the render's end.
  const braked = withBrake(transition, deckPlan(transition, 'a'))
  const planB = deckPlan(transition, 'b')
  const aFrom = -preRoll - STRETCH_LEAD_S / 2
  const bAt = Math.max(0, transition.bAt)
  const bTo = Math.max(bAt, length) + postRoll
  const [playerA, playerB] = await Promise.all([
    createBufferDeck(ctx, deckA.input, bufferDeckKind(braked.plan, aFrom, length, tempoChangeKind), { onLimiter: (stats) => options.onDeckLimiter?.('a', stats) }),
    createBufferDeck(ctx, deckB.input, bufferDeckKind(planB, bAt, bTo, tempoChangeKind), { onLimiter: (stats) => options.onDeckLimiter?.('b', stats) }),
  ])
  await Promise.all([playerA.load(stereo(a), 0, a.sampleRate), playerB.load(stereo(b), 0, b.sampleRate)])
  playerA.play(braked.plan, aFrom, length, zero, braked.semitones)
  playerA.stopAt(zero + length + 0.02)
  playerB.play(planB, bAt, bTo, zero)
  // Real stems play along with their deck's source, into its stem split.
  const stemPlayers = []
  for (const [deck, stems] of [['a', options.stems?.a], ['b', options.stems?.b]] as const) {
    for (const [stem, buffer] of Object.entries(stems ?? {}) as Array<['drums' | 'vocals' | 'instrumental', AudioBuffer]>) {
      const out = new GainNode(ctx)
      const player = await createBufferDeck(ctx, out, deck === 'a' ? playerA.kind : playerB.kind)
      await player.load(stereo(buffer), 0, buffer.sampleRate)
      if (deck === 'a') {
        player.play(braked.plan, aFrom, length, zero, braked.semitones)
        player.stopAt(zero + length + 0.02)
      } else player.play(planB, bAt, bTo, zero)
      switchToRealStem(deck === 'a' ? deckA : deckB, stem, out, 0, 0)
      stemPlayers.push(player)
    }
  }

  scheduleTransition({ a: deckA, b: deckB }, transition, zero)
  // As in the player: A's echo rings out after A is gone; B glides back to neutral and plays on.
  releaseEcho(deckA, zero + length)
  releaseReverb(deckA, zero + length)
  resetDeck(deckB, zero + length, 0.05)
  // The limiter acts while the decks overlap, while B is still stretched (stretched audio can peak higher than the
  // track itself; at rate 1 the stretcher passes B through exactly again) and while an echo or reverb tail rings.
  master?.engage(true, Math.max(0, zero - LIMITER_LEAD_S))
  master?.engage(false, zero + Math.max(length, bSettled(transition), tailsEnd(transition) ?? -Infinity) + 0.05)

  // The stretchers' changes travel by message: all must have arrived before rendering runs past them.
  await Promise.all([playerA, playerB, ...stemPlayers].map((player) => player.settled()))

  // Without the lead and the limiter's delay at the front.
  const rendered = await ctx.startRendering()
  playerA.dispose()
  playerB.dispose()
  for (const player of stemPlayers) player.dispose()
  const out = new AudioBuffer({ numberOfChannels: rendered.numberOfChannels, length: wanted, sampleRate })
  for (let channel = 0; channel < rendered.numberOfChannels; channel++) out.copyToChannel(rendered.getChannelData(channel).subarray(lead + latency, lead + latency + wanted), channel)
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
