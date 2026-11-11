import { analyzeMix, readWavChannels, type LyricLine, type TrackMix } from './mix-analysis.ts'

/**
 * Analysing whole songs for the mixer mode (see mix-analysis.ts): Jellyfin transcodes the whole song to a stereo
 * 16-bit WAV at 11 kHz (about 10 MB for 4 minutes; the stereo image helps find the voice), and its synced lyrics
 * (Jellyfin's own, else those kept on this server) tell where it is sung. A few seconds a song.
 */
const RATE = 11025
/** Longer tracks (DJ sets, audio plays) aren't mixed into: not analysed, and kept as "can't be" (null). */
export const MIX_MAX_SECONDS = 20 * 60
const MAX_BYTES = (MIX_MAX_SECONDS + 30) * RATE * 2 * 2 + 4096

export interface MixTrack {
  Id: string
  Name?: string
  RunTimeTicks?: number
  Artists?: string[]
  AlbumArtist?: string
}

/** Kept lyrics as the store has them (see main.ts, PUT /music/lyrics/:id). */
type KeptLyrics = { lines?: Array<{ time?: number; text?: string }>; synced?: boolean } | null | undefined

/**
 * A song's synced lyrics: Jellyfin's (embedded, an .lrc file, a lyrics plugin's), else the ones kept on this server.
 * Undefined when there are none with times.
 */
export async function syncedLyrics(jellyfinUrl: string, token: string, id: string, kept: KeptLyrics): Promise<LyricLine[] | undefined> {
  const response = await fetch(`${jellyfinUrl}/Audio/${id}/Lyrics`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (response?.ok) {
    const lines = ((await response.json()) as { Lyrics?: Array<{ Text?: string | null; Start?: number | null }> }).Lyrics ?? []
    const timed = lines.filter((line) => typeof line.Start === 'number').map((line) => ({ time: line.Start! / 10_000_000, text: line.Text ?? '' }))
    if (timed.length >= 4) return timed
  }
  if (kept?.synced && Array.isArray(kept.lines)) {
    const timed = kept.lines.filter((line) => typeof line.time === 'number' && Number.isFinite(line.time)).map((line) => ({ time: line.time!, text: line.text ?? '' }))
    if (timed.length >= 4) return timed
  }
  return undefined
}

/** Analyses a whole song; null when it can't be (too short or too long, silent, not decodable). */
export async function analyzeTrack(jellyfinUrl: string, token: string, track: MixTrack, kept: KeptLyrics): Promise<TrackMix | null> {
  if (track.RunTimeTicks && track.RunTimeTicks / 10_000_000 > MIX_MAX_SECONDS) return null
  const params = new URLSearchParams({ AudioCodec: 'pcm_s16le', AudioSampleRate: String(RATE), AudioChannels: '2', MaxAudioChannels: '2' })
  const controller = new AbortController()
  // A whole song takes Jellyfin a few seconds to transcode; a stuck one is given up after five minutes.
  const timer = setTimeout(() => controller.abort(), 5 * 60_000)
  try {
    const response = await fetch(`${jellyfinUrl}/Audio/${track.Id}/stream.wav?${params}`, {
      headers: { Authorization: `MediaBrowser Token="${token}"` },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`Jellyfin ${response.status}`)
    const parts: Uint8Array[] = []
    let size = 0
    const reader = response.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.length
      // Longer than any song worth mixing (the runtime was unknown or wrong): stop the transcode, keep "can't be".
      if (size > MAX_BYTES) {
        controller.abort()
        return null
      }
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const part of parts) {
      bytes.set(part, at)
      at += part.length
    }
    const wav = readWavChannels(bytes)
    if (!wav) return null
    const lyrics = await syncedLyrics(jellyfinUrl, token, track.Id, kept)
    return analyzeMix(wav.channels.slice(0, 2), wav.rate, lyrics)
  } finally {
    clearTimeout(timer)
  }
}

// ---- a playlist's mixer settings (the app's PlaylistMixer, src/features/listen/mixer/types.ts) ----

/** At most this many transitions are kept per playlist (a pair each; far more than a playlist's songs need). */
export const MIXER_MAX_TRANSITIONS = 1000

const PRESETS = new Set(['auto', 'crossfade', 'fadeOut', 'fadeIn', 'bassSwap', 'filterBuild', 'echoOut', 'dropSwap', 'hardCut', 'brake', 'none'])
const ID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTOMATION_KEYS = ['gain', 'low', 'mid', 'high', 'filter'] as const
const MAX_KEYFRAMES = 64
const MAX_EFFECTS = 16
/** Longest overlap of two songs (seconds) and furthest point into a song a transition can name. */
const MAX_LENGTH = 120
const MAX_TIME = MIX_MAX_SECONDS

export interface PlaylistMixer {
  on: boolean
  style: 'clean' | 'party'
  transitions: Record<string, Record<string, unknown>>
  updated: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null)

/** Keyframes as sent, checked and copied ({t, v} with t in the transition, v in range, in time order); null if bad. */
function keyframes(value: unknown, min: number, max: number): Array<{ t: number; v: number }> | null {
  if (!Array.isArray(value) || value.length > MAX_KEYFRAMES) return null
  const out: Array<{ t: number; v: number }> = []
  for (const frame of value) {
    if (!isRecord(frame)) return null
    const t = number(frame.t, 0, MAX_LENGTH)
    const v = number(frame.v, min, max)
    if (t === null || v === null || (out.length && t < out[out.length - 1]!.t)) return null
    out.push({ t, v })
  }
  return out
}

function automation(value: unknown) {
  if (!isRecord(value)) return null
  const out: Record<string, Array<{ t: number; v: number }>> = {}
  for (const key of AUTOMATION_KEYS) {
    const frames = keyframes(value[key] ?? [], key === 'filter' ? -1 : 0, 1)
    if (!frames) return null
    out[key] = frames
  }
  return out
}

function effect(value: unknown) {
  if (!isRecord(value)) return null
  const at = number(value.at, 0, MAX_LENGTH)
  if (at === null) return null
  if (value.kind === 'echo') {
    const beats = number(value.beats, 0.125, 16)
    const feedback = number(value.feedback, 0, 1)
    if ((value.deck !== 'a' && value.deck !== 'b') || beats === null || feedback === null) return null
    return { kind: 'echo', deck: value.deck, at, beats, feedback }
  }
  if (value.kind === 'brake') {
    const length = number(value.length, 0, 30)
    if (value.deck !== 'a' || length === null) return null
    return { kind: 'brake', deck: 'a', at, length }
  }
  return null
}

/** One transition, checked field by field and copied without anything else; null when anything is off. */
function transition(key: string, value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.v !== 1) return null
  const [from, to, ...rest] = key.split('>')
  if (rest.length || !from || !to || !ID.test(from) || !ID.test(to) || value.from !== from || value.to !== to) return null
  if ((value.style !== 'clean' && value.style !== 'party') || typeof value.preset !== 'string' || !PRESETS.has(value.preset)) return null
  const aOut = number(value.aOut, 0, MAX_TIME)
  const bIn = number(value.bIn, 0, MAX_TIME)
  const length = number(value.length, 0, MAX_LENGTH)
  const rate = number(value.rate, 0.5, 2)
  const confidence = number(value.confidence, 0, 1)
  const a = automation(value.a)
  const b = automation(value.b)
  if (aOut === null || bIn === null || length === null || rate === null || confidence === null || !a || !b || typeof value.custom !== 'boolean') return null
  if (!Array.isArray(value.effects) || value.effects.length > MAX_EFFECTS) return null
  const effects = value.effects.map(effect)
  if (effects.some((entry) => !entry)) return null
  return { v: 1, from, to, style: value.style, preset: value.preset, aOut, bIn, length, rate, a, b, effects, custom: value.custom, confidence }
}

/**
 * A playlist's mixer settings as sent by an app, checked and copied (unknown fields dropped); null when they aren't
 * mixer settings. `updated` is left to the caller (the server sets it when it saves).
 */
export function parsePlaylistMixer(body: unknown): Omit<PlaylistMixer, 'updated'> | null {
  if (!isRecord(body) || typeof body.on !== 'boolean' || (body.style !== 'clean' && body.style !== 'party') || !isRecord(body.transitions)) return null
  const entries = Object.entries(body.transitions)
  if (entries.length > MIXER_MAX_TRANSITIONS) return null
  const transitions: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of entries) {
    const checked = transition(key, value)
    if (!checked) return null
    transitions[key] = checked
  }
  return { on: body.on, style: body.style, transitions }
}
