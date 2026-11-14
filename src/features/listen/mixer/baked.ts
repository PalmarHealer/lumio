import { bSettled, deckPlan, positionAt } from './deck-schedule.ts'
import { tailsEnd } from './engine.ts'
import { renderTransition, type RenderTransitionOptions } from './render.ts'
import type { Transition } from './types.ts'
import { locate } from './xcorr.ts'

/**
 * Baked transitions: a transition rendered once (with real stems, when it was made in Mix-Modus) and played back as a
 * clip between A and B. The clip is two stereo parts, deck A's output and deck B's, each after the deck's automation,
 * effects and tails but before the player's level (normalization, volume) and the master limiter, which stay live. It
 * runs from transition time `start` (before anything happens: A plays plainly there) to `start + length` (after B
 * plays plainly at its own tempo again and the tails have died), so both ends sound as plain playback does and the
 * player crossfades there. Samples are stored at half scale (`CLIP_GAIN`; a deck may exceed full scale before the
 * limiter). Delivered lossy too, the parts may come with a codec's delay: `alignPart` finds where they really start
 * against the songs' own audio.
 */

/** Raised when what a render sounds like changes (it is part of a clip's key: older clips are stale then). */
export const ENGINE_VERSION = 1

/** How far before anything happens a clip starts, and after everything has ended it stops. */
export const BAKE_MARGIN_S = 0.5

/** Clips store their samples at this gain (the engine plays them at its inverse). */
export const CLIP_GAIN = 0.5

/** Clips are rendered at most at this sample rate. */
export const MAX_CLIP_RATE = 48000

/** The transition time span a clip covers: from `start` to `end`. */
export function clipRange(transition: Transition) {
  const length = Math.max(0, transition.length)
  return { start: -BAKE_MARGIN_S, end: Math.max(length, bSettled(transition), tailsEnd(transition) ?? -Infinity) + BAKE_MARGIN_S }
}

/** A song's identity in a clip's key: its item and its length (a replaced file usually changes it). */
export const sourceIdentity = (item: { Id?: string | null; RunTimeTicks?: number | null }) => `${item.Id ?? ''}:${item.RunTimeTicks ?? 0}`

/** A value as JSON with sorted keys and numbers rounded to 1e-4 (so equal transitions give equal text). */
function canonical(value: unknown): string {
  if (typeof value === 'number') return JSON.stringify(Math.round(value * 1e4) / 1e4)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** What a clip's key is made of: the playlist it belongs to, both songs (`sourceIdentity`) and the transition. */
export interface KeyParts {
  /** The server keeps each clip for one playlist: the same pair in two playlists bakes two clips. */
  playlist: string
  transition: Transition
  a: string
  b: string
}

/**
 * The text a clip's key hashes: engine version, playlist, both songs and the transition as it sounds. (Not the sample
 * rate it was rendered at: the player checks a clip's key without knowing it, and it doesn't change the sound.)
 */
export function keyText(options: KeyParts) {
  const { baked: _baked, custom: _custom, confidence: _confidence, ...sound } = options.transition
  return canonical({ engine: ENGINE_VERSION, playlist: options.playlist, a: options.a, b: options.b, transition: sound })
}

/** A clip's key: the first 32 hex digits of the SHA-256 of `keyText`. */
export async function bakeKey(options: KeyParts) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyText(options)))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

export interface BakedClip {
  start: number
  length: number
  sampleRate: number
  /** Deck A's and deck B's parts (stereo each, at `CLIP_GAIN`). */
  a: Float32Array[]
  b: Float32Array[]
}

/** Renders a transition's clip from the songs' decoded audio (whole songs, or windows with `origins`). */
export async function bakeTransition(options: {
  a: AudioBuffer
  b: AudioBuffer
  transition: Transition
  sampleRate?: number
  /** Track positions of `a`'s and `b`'s first samples, for windows of the songs (see `renderTransition`). */
  origins?: RenderTransitionOptions['origins']
  stems?: RenderTransitionOptions['stems']
}): Promise<BakedClip> {
  const sampleRate = Math.min(MAX_CLIP_RATE, options.sampleRate ?? options.a.sampleRate)
  const { start, end } = clipRange(options.transition)
  const length = Math.max(0, options.transition.length)
  const rendered = await renderTransition({ a: options.a, b: options.b, transition: options.transition, preRoll: -start, postRoll: end - length, sampleRate, parts: true, origins: options.origins, stems: options.stems })
  const part = (first: number) => [0, 1].map((c) => Float32Array.from(rendered.getChannelData(first + c), (x) => x * CLIP_GAIN))
  return { start, length: rendered.length / sampleRate, sampleRate, a: part(0), b: part(2) }
}

/** Stereo PCM as a 24-bit WAV file (interleaved, clipped at full scale). */
export function wav24(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const count = channels[0]!.length
  const dataSize = count * channels.length * 3
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
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 3, true)
  view.setUint16(32, channels.length * 3, true)
  view.setUint16(34, 24, true)
  text(36, 'data')
  view.setUint32(40, dataSize, true)
  let at = 44
  for (let i = 0; i < count; i++) {
    for (const channel of channels) {
      const value = Math.round(Math.max(-1, Math.min(1, channel[i]!)) * 8388607)
      view.setUint8(at, value & 0xff)
      view.setUint8(at + 1, (value >> 8) & 0xff)
      view.setUint8(at + 2, (value >> 16) & 0xff)
      at += 3
    }
  }
  return out
}

/** How far into the decoded part its first clip sample lies (a codec's delay; seconds), and how sure that is. */
export interface PartAlignment {
  delay: number
  score: number
}

/**
 * Where a decoded clip part really starts: a stretch of it where the deck plays plainly (A's head, B's tail) is found
 * in that song's own audio (`reference`, mono, its first sample at track position `referenceStart`) by
 * cross-correlation, near where the deck's plan puts it. `from` is that stretch's start in the decoded part (seconds,
 * counted from its first sample); the result's `delay` is how much later than the clip's own time the decoded part
 * runs (0 for a lossless part). Null when not found clearly (score under 0.8).
 */
export function alignPart(options: {
  part: Float32Array
  sampleRate: number
  from: number
  span?: number
  reference: Float32Array
  referenceStart: number
  transition: Transition
  deck: 'a' | 'b'
  clipStart: number
  search?: number
}): PartAlignment | null {
  const { part, sampleRate: rate, from, reference, referenceStart, clipStart } = options
  const span = options.span ?? 0.4
  const search = options.search ?? 0.3
  const plan = deckPlan(options.transition, options.deck)
  const needle = part.subarray(Math.round(from * rate), Math.round((from + span) * rate))
  // Assuming no delay: the needle is clip time `from`, the deck's track position there.
  const expected = (positionAt(plan, clipStart + from) - referenceStart) * rate
  const match = locate(needle, reference, expected - search * rate, expected + search * rate)
  if (!match || match.score < 0.8) return null
  // The deck plays plainly (rate 1) there: track position and clip time advance alike.
  return { delay: (expected - match.offset) / rate, score: match.score }
}
