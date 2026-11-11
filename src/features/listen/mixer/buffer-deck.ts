import { deckSchedule, rateOf, type DeckPlan } from './deck-schedule'
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
 *   masters by 1–6 dB (same loudness), which the master limiter then has to catch.
 *
 * Both take their audio as channels plus the track position of the first sample, and follow a `DeckPlan` from
 * transition time `from` to `to`, with the transition's t = 0 at context time `zero`.
 */
export type BufferDeckKind = 'exact' | 'stretch'

export interface BufferDeck {
  kind: BufferDeckKind
  /** How far ahead (seconds) playback must be scheduled to land exactly. */
  latency: number
  load(channels: Float32Array<ArrayBuffer>[], origin: number, sampleRate: number): Promise<void>
  play(plan: DeckPlan, from: number, to: number, zero: number, semitones?: (t: number) => number): void
  /** Fades out over a few ms from context time `when` and stops. */
  stopAt(when: number): void
  dispose(): void
}

const JOIN_FADE_S = 0.004
const CURVE_POINTS = 32
/** Equal-power fade shapes (sine/cosine quarter waves). */
const fadeIn = Float32Array.from({ length: CURVE_POINTS }, (_, i) => Math.sin(((i / (CURVE_POINTS - 1)) * Math.PI) / 2))
const fadeOut = Float32Array.from({ length: CURVE_POINTS }, (_, i) => Math.cos(((i / (CURVE_POINTS - 1)) * Math.PI) / 2))

export async function createBufferDeck(ctx: BaseAudioContext, destination: AudioNode, kind: BufferDeckKind): Promise<BufferDeck> {
  if (kind === 'stretch') {
    const stretch = await createStretch(ctx, destination)
    return {
      kind,
      latency: stretch.latency,
      load: (channels, origin) => stretch.load(channels, origin),
      play: (plan, from, to, zero, semitones) => stretch.follow(deckSchedule(plan, from, to), zero, semitones),
      stopAt: (when) => stretch.stopAt(when),
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

/** Which way a deck plays: exactly while its rate stays 1 over the window, else as `tempoChange` says. */
export function bufferDeckKind(plan: DeckPlan, from: number, to: number, tempoChange: BufferDeckKind): BufferDeckKind {
  const changes = plan.rate.some((keyframe) => Math.abs(keyframe.v - 1) > 1e-6 && keyframe.t <= to) || Math.abs(rateOf(plan, from) - 1) > 1e-6
  return changes ? tempoChange : 'exact'
}
