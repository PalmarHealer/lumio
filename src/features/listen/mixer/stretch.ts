import type { StretchNode } from 'signalsmith-stretch'
import type { SchedulePoint } from './deck-schedule'

/**
 * A deck playing from decoded audio with time-stretching (pitch kept): Signalsmith Stretch (MIT, WASM in an
 * AudioWorklet; also runs in an OfflineAudioContext, so render.ts plays transitions the way the player does).
 *
 * Chosen over SoundTouch (LGPL) and Rubber Band (GPL) for its licence and its quality. Measured on click tracks and
 * steady tones with its "cheaper" preset, which came out better than the default for this use: clicks land within
 * 0.4 ms of where they should at rates 0.97–1.03 (default: up to 2.1 ms; see `INTERVAL_S` for 44.1 kHz), less than 0.2 % of a click's energy smears
 * outside ±2 ms, pre-echo stays below −52 dB, steady tones (55 Hz – 3 kHz) wobble by less than 0.1 dB, at rate 1 it
 * passes clicks exactly, and it costs about 1.5 % of one desktop core per deck.
 *
 * The node follows a map of (output time → input position, rate) entries and works out its input position from it at
 * every render quantum; it plays from buffers loaded into it and compensates its own latency (140 ms), as long as
 * changes are scheduled at least that far ahead. A jump in the map is smoothed by the stretcher's own overlap (a loop
 * going round is click-free and keeps the beat, see deck-schedule.ts).
 */

/**
 * Signalsmith's "cheaper" preset (blocks of 100 ms, a new spectrum every 40 ms), with the interval rounded to whole
 * render quanta. The worklet works out its input position once per quantum (128 frames), at the quantum's start; a new
 * spectrum taken partway into a quantum is placed by that position anyway, so the sound comes out up to a quantum late.
 * At 48 kHz 40 ms is 15 quanta and every spectrum starts on one; at 44.1 kHz (13.8 quanta) clicks landed anywhere
 * between 0 and 2.9 ms late, at a whole 14 within 0.4 ms (checks/glide-check.ts).
 */
const BLOCK_S = 0.1
const INTERVAL_S = 0.04
const QUANTUM = 128

export interface Stretch {
  node: StretchNode
  /** How far ahead (seconds) changes must be scheduled to land exactly. */
  latency: number
  /** Loads a deck's audio (one Float32Array per channel); `origin` is the track position of its first sample. */
  load(channels: Float32Array[], origin: number): Promise<void>
  /**
   * Follows a deck's points from context time `start` (transition time 0); `semitones` optionally detunes (a brake).
   * Earlier scheduled changes from the first point's time on are replaced.
   */
  follow(points: SchedulePoint[], start: number, semitones?: (t: number) => number): void
  /** Stops producing sound at context time `when` (and drops what was scheduled after). */
  stopAt(when: number): void
  /**
   * Resolves once every change scheduled so far has reached the audio thread. The changes travel by message: an
   * offline render must wait for them before it starts, or it may play past the first ones before they arrive (and,
   * missing them, go on at the rate it had).
   */
  settled(): Promise<void>
  dispose(): void
}

export async function createStretch(ctx: BaseAudioContext, destination: AudioNode): Promise<Stretch> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch')
  // One (unconnected) input: with none, the worklet throws while inactive (it reads the missing input's channels) and
  // stays silent for good.
  const node = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  const interval = Math.max(1, Math.round((INTERVAL_S * ctx.sampleRate) / QUANTUM)) * QUANTUM
  await node.configure({ blockMs: BLOCK_S * 1000, intervalMs: (interval / ctx.sampleRate) * 1000, splitComputation: true })
  const latency = await node.latency()
  node.connect(destination)
  let origin = 0
  // The worklet answers messages in order: the last one's answer means all have arrived.
  let last: Promise<unknown> = Promise.resolve()
  return {
    node,
    latency,
    async load(channels, at) {
      await node.dropBuffers()
      await node.addBuffers(channels)
      origin = at
    },
    follow(points, start, semitones) {
      for (const point of points) {
        const output = start + point.t
        last = node.schedule({ active: true, output, outputTime: output, input: point.position - origin, rate: point.rate, semitones: semitones?.(point.t) ?? 0 })
      }
    },
    stopAt(when) {
      last = node.schedule({ active: false, output: when, outputTime: when })
    },
    settled: () => last.then(() => undefined),
    dispose() {
      node.disconnect()
      void node.dropBuffers()
    },
  }
}
