import { createBufferDeck, type BufferDeck, type BufferDeckKind } from '../mixer/buffer-deck'
import { createTap } from '../mixer/capture'
import { locate, mono } from '../mixer/xcorr'
import type { Slice } from './slices'

/**
 * The player's buffer side of a transition: a deck's sound from a decoded slice (sample-exact paths, loops, rate
 * curves) instead of its <audio> element, and how the two are lined up. The element keeps playing, muted, so the
 * player's state (paused, position, events) stays the element's; only the sound comes from the buffer while it is on.
 */

export interface BufferSide {
  deck: BufferDeck
  /** The buffer's level into the deck (0 while the element sounds). */
  gain: GainNode
  slice: Slice
  /** The slice as mono, for locating the element in it. */
  mono: Float32Array
}

export async function openSide(ctx: BaseAudioContext, destination: AudioNode, slice: Slice, kind: BufferDeckKind): Promise<BufferSide> {
  const gain = new GainNode(ctx, { gain: 0 })
  gain.connect(destination)
  const deck = await createBufferDeck(ctx, gain, kind)
  await deck.load(slice.channels, slice.start, slice.sampleRate)
  return { deck, gain, slice, mono: mono(slice.channels) }
}

export function closeSide(side: BufferSide) {
  side.deck.dispose()
  side.gain.disconnect()
}

/** How long a recording is, and how well it must match to be trusted. */
const RECORD_S = 0.75
const MIN_SCORE = 0.8

export interface Located {
  /** Context frame of the recording's first sample. */
  frame: number
  /** The slice sample the element played at that frame (fractional). */
  index: number
  /** The element's own idea of its position at that frame (its currentTime, a few ms rough). */
  position: number
}

/**
 * Where in `slice` an element plays: records it (through `source`, before its own gain, so a muted element works too)
 * and finds the recording in the slice near where the element thinks it is. Null when it can't be found reliably.
 * The element must play at a steady rate meanwhile.
 */
export async function locateElement(ctx: BaseAudioContext, source: AudioNode, element: HTMLAudioElement, side: Pick<BufferSide, 'slice' | 'mono'>): Promise<Located | null> {
  const tap = await createTap(ctx, source)
  // The element's position against the audio clock, read often while it records: single readings jitter by a render
  // quantum or so, their median doesn't.
  const offsets: number[] = []
  const reading = window.setInterval(() => offsets.push(element.currentTime - ctx.currentTime * element.playbackRate), 5)
  let recording
  try {
    recording = await tap.record(RECORD_S)
  } finally {
    window.clearInterval(reading)
    tap.dispose()
  }
  offsets.push(element.currentTime - ctx.currentTime * element.playbackRate)
  const rate = ctx.sampleRate
  const sorted = [...offsets].sort((x, y) => x - y)
  const position = sorted[sorted.length >> 1]! + (recording.frame / rate) * element.playbackRate
  const expected = (position - side.slice.start) * rate
  const match = locate(recording.samples, side.mono, expected - 0.5 * rate, expected + 0.5 * rate)
  if (!match || match.score < MIN_SCORE) return null
  return { frame: recording.frame, index: match.offset, position }
}

/** The slice's start corrected by a location: the element's position at the recorded frame, back by the index. */
export const calibratedStart = (located: Located, sampleRate: number) => located.position - located.index / sampleRate

/** The median of several locations' calibrated starts (each one's reading of the element's position jitters a little). */
export function medianStart(found: Located[], sampleRate: number) {
  const starts = found.map((located) => calibratedStart(located, sampleRate)).sort((x, y) => x - y)
  return starts[starts.length >> 1]!
}

/**
 * Hands the sound from one gain to another at context time `at`: both carry the same audio lined up, so an equal-gain
 * (linear) crossfade keeps the level (equal power would bulge by 3 dB on identical signals).
 */
export function crossfade(from: AudioParam, to: AudioParam, at: number, seconds = 0.01) {
  for (const [param, start, end] of [
    [from, 1, 0],
    [to, 0, 1],
  ] as const) {
    param.cancelScheduledValues(at)
    param.setValueAtTime(start, at)
    param.linearRampToValueAtTime(end, at + seconds)
  }
}
