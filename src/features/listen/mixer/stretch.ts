import type { StretchNode } from 'signalsmith-stretch'
import type { SchedulePoint } from './deck-schedule'

/**
 * A deck playing from decoded audio with time-stretching (pitch kept): Signalsmith Stretch (MIT, WASM in an
 * AudioWorklet; also runs in an OfflineAudioContext, so render.ts plays transitions the way the player does).
 *
 * Chosen over SoundTouch (LGPL) and Rubber Band (GPL) for its licence and its quality. Measured on click tracks and
 * steady tones with its "cheaper" preset, which came out better than the default for this use: clicks land within
 * 0.8 ms of where they should at rates 0.97–1.03 (default: up to 2.1 ms), less than 0.2 % of a click's energy smears
 * outside ±2 ms, pre-echo stays below −52 dB, steady tones (55 Hz – 3 kHz) wobble by less than 0.1 dB, at rate 1 it
 * passes clicks exactly, and it costs about 1.5 % of one desktop core per deck.
 *
 * The node follows a map of (output time → input position, rate) entries and works out its input position from it at
 * every render quantum; it plays from buffers loaded into it and compensates its own latency (140 ms), as long as
 * changes are scheduled at least that far ahead. A jump in the map is smoothed by the stretcher's own overlap (a loop
 * going round is click-free and keeps the beat, see deck-schedule.ts).
 */

const PRESET = 'cheaper'

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
  dispose(): void
}

export async function createStretch(ctx: BaseAudioContext, destination: AudioNode): Promise<Stretch> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch')
  // One (unconnected) input: with none, the worklet throws while inactive (it reads the missing input's channels) and
  // stays silent for good.
  const node = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  await node.configure({ blockMs: null, preset: PRESET })
  const latency = await node.latency()
  node.connect(destination)
  let origin = 0
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
        node.schedule({ active: true, output, outputTime: output, input: point.position - origin, rate: point.rate, semitones: semitones?.(point.t) ?? 0 })
      }
    },
    stopAt(when) {
      node.schedule({ active: false, output: when, outputTime: when })
    },
    dispose() {
      node.disconnect()
      void node.dropBuffers()
    },
  }
}
