import { Worker } from 'node:worker_threads'
import type { LyricLine, TrackMix } from './mix-analysis.ts'
import type { MixJob } from './mix-worker.ts'

/**
 * Analysing whole songs for the mixer mode (see mix-analysis.ts): Jellyfin transcodes the whole song to a stereo
 * 16-bit WAV at 11 kHz (about 10 MB for 4 minutes; the stereo image helps find the voice), and its synced lyrics
 * (Jellyfin's own, else those kept on this server) tell where it is sung. The arithmetic (a few seconds a song) runs
 * in a worker thread (mix-worker.ts), one song at a time, so the server keeps answering meanwhile.
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

/** Jellyfin answered with an error. A 4xx other than 401/403/408/429 means this song can't be fetched at all. */
export class JellyfinError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Jellyfin ${status}`)
    this.status = status
  }

  get definitive() {
    return this.status >= 400 && this.status < 500 && ![401, 403, 408, 429].includes(this.status)
  }
}

/**
 * The analysis worker, started when first needed and again after it crashed or ran out of memory. Its heap is capped
 * (the samples themselves are typed arrays outside it; the heap holds the analysis' own lists, some 100 MB at most).
 */
let worker: Worker | null = null
let jobs = 0
const pending = new Map<number, { resolve: (mix: TrackMix | null) => void; reject: (error: Error) => void }>()
/** The analyses run one after another, in the order asked. */
let queue: Promise<unknown> = Promise.resolve()

function analysisWorker() {
  if (worker) return worker
  const started = new Worker(new URL('./mix-worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 512 } })
  started.on('message', (message: { id: number; mix?: TrackMix | null; error?: string }) => {
    const job = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) job?.reject(new Error(message.error))
    else job?.resolve(message.mix ?? null)
  })
  const fail = (error: Error) => {
    if (worker === started) worker = null
    for (const job of pending.values()) job.reject(error)
    pending.clear()
  }
  started.on('error', fail)
  started.on('exit', (code) => fail(new Error(`Analysis worker stopped (${code})`)))
  // A waiting worker doesn't keep the server's process alive on its own.
  started.unref()
  worker = started
  return started
}

/** Analyses a WAV in the worker, after the ones before it. Its bytes are handed over (not copied): `wav` is emptied. */
export function analyzeWav(wav: ArrayBuffer, lyrics?: LyricLine[]): Promise<TrackMix | null> {
  const run = queue.then(
    () =>
      new Promise<TrackMix | null>((resolve, reject) => {
        const id = ++jobs
        pending.set(id, { resolve, reject })
        analysisWorker().postMessage({ id, wav, lyrics } satisfies MixJob, [wav])
      }),
  )
  queue = run.catch(() => undefined)
  return run
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

/**
 * Analyses a whole song; null when it can't be (too short or too long, silent, not decodable). Throws a JellyfinError
 * when Jellyfin answers with an error, another error when it doesn't answer or the worker fails.
 */
export async function analyzeTrack(jellyfinUrl: string, token: string, track: MixTrack, kept: KeptLyrics): Promise<TrackMix | null> {
  if (track.RunTimeTicks && track.RunTimeTicks / 10_000_000 > MIX_MAX_SECONDS) return null
  const params = new URLSearchParams({ AudioCodec: 'pcm_s16le', AudioSampleRate: String(RATE), AudioChannels: '2', MaxAudioChannels: '2' })
  const controller = new AbortController()
  // A whole song takes Jellyfin a few seconds to transcode; a stuck one is given up after five minutes.
  const timer = setTimeout(() => controller.abort(), 5 * 60_000)
  let wav: Uint8Array
  try {
    const response = await fetch(`${jellyfinUrl}/Audio/${track.Id}/stream.wav?${params}`, {
      headers: { Authorization: `MediaBrowser Token="${token}"` },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new JellyfinError(response.status)
    let parts: Uint8Array[] = []
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
    wav = new Uint8Array(size)
    let at = 0
    for (const part of parts) {
      wav.set(part, at)
      at += part.length
    }
    // The parts are let go before the analysis starts: the bytes are all in `wav` now.
    parts = []
  } finally {
    clearTimeout(timer)
  }
  const lyrics = await syncedLyrics(jellyfinUrl, token, track.Id, kept)
  return analyzeWav(wav.buffer as ArrayBuffer, lyrics)
}

// ---- a playlist's mixer settings (the app's PlaylistMixer, src/features/listen/mixer/types.ts) ----

/** At most this many transitions are kept per playlist (a pair each; far more than a playlist's songs need). */
export const MIXER_MAX_TRANSITIONS = 1000

const PRESETS = new Set(['auto', 'blend', 'crossfade', 'fadeOut', 'fadeIn', 'bassSwap', 'filterBuild', 'echoOut', 'dropSwap', 'hardCut', 'brake', 'none'])
const ID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTOMATION_KEYS = ['gain', 'low', 'mid', 'high', 'filter'] as const
/** Keyframes per curve (an equal-power gain curve over a long blend takes some 70). */
const MAX_KEYFRAMES = 256
const MAX_EFFECTS = 16
/** Longest transition (seconds; loops may draw one out), and how far after it a keyframe may lie (B's rate easing). */
const MAX_LENGTH = 300
const MAX_KEYFRAME_TIME = MAX_LENGTH + 120
/** At most this many stretches per deck's path, each played at most this many times in a row. */
const MAX_SEGMENTS = 32
const MAX_REPEAT = 8
/** Furthest point into a song a transition can name (any track Jellyfin may hold, not only analysed ones). */
const MAX_TIME = 6 * 3600

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
    const t = number(frame.t, 0, MAX_KEYFRAME_TIME)
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

/** A deck's path (see Transition.pathA): stretches with from < to inside a track, each played 1–8 times; null if bad. */
function path(value: unknown): Array<{ from: number; to: number; repeat: number }> | null {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) return null
  const out: Array<{ from: number; to: number; repeat: number }> = []
  for (const segment of value) {
    if (!isRecord(segment)) return null
    const from = number(segment.from, 0, MAX_TIME)
    const to = number(segment.to, 0, MAX_TIME)
    const repeat = number(segment.repeat, 1, MAX_REPEAT)
    if (from === null || to === null || to <= from || repeat === null || !Number.isInteger(repeat)) return null
    out.push({ from, to, repeat })
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

/**
 * One transition (the contract's v2: one clock, paths with loops, rate curves), checked field by field and copied
 * without anything else; null when anything is off, and for transitions of the older v1 shape.
 */
function transition(key: string, value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.v !== 2) return null
  const [from, to, ...rest] = key.split('>')
  if (rest.length || !from || !to || !ID.test(from) || !ID.test(to) || value.from !== from || value.to !== to) return null
  if ((value.style !== 'clean' && value.style !== 'party') || typeof value.preset !== 'string' || !PRESETS.has(value.preset)) return null
  const aOut = number(value.aOut, 0, MAX_TIME)
  const bAt = number(value.bAt, 0, MAX_LENGTH)
  const bIn = number(value.bIn, 0, MAX_TIME)
  const length = number(value.length, 0, MAX_LENGTH)
  const confidence = number(value.confidence, 0, 1)
  // Both songs' tempo as planned with (echo delays are counted in their beats).
  const tempoA = isRecord(value.tempo) ? number(value.tempo.a, 30, 300) : null
  const tempoB = isRecord(value.tempo) ? number(value.tempo.b, 30, 300) : null
  const pathA = path(value.pathA)
  const pathB = path(value.pathB)
  const rateA = keyframes(value.rateA, 0.9, 1.1)
  const rateB = keyframes(value.rateB, 0.9, 1.1)
  const a = automation(value.a)
  const b = automation(value.b)
  if (aOut === null || bAt === null || bIn === null || length === null || confidence === null || tempoA === null || tempoB === null) return null
  if (!pathA || !pathB || !rateA || !rateB || !a || !b || typeof value.custom !== 'boolean') return null
  if (!Array.isArray(value.effects) || value.effects.length > MAX_EFFECTS) return null
  const effects = value.effects.map(effect)
  if (effects.some((entry) => !entry)) return null
  return {
    v: 2,
    from,
    to,
    style: value.style,
    preset: value.preset,
    aOut,
    bAt,
    bIn,
    length,
    pathA,
    pathB,
    rateA,
    rateB,
    tempo: { a: tempoA, b: tempoB },
    a,
    b,
    effects,
    custom: value.custom,
    confidence,
  }
}

/**
 * A playlist's mixer settings as sent by an app, checked and copied (unknown fields dropped); null when they aren't
 * mixer settings at all. A transition that doesn't pass is left out and counted in `dropped`: its pair then gets an
 * automatic one, rather than the whole save failing over it. `updated` is left to the caller (set when it saves).
 */
export function parsePlaylistMixer(body: unknown): { settings: Omit<PlaylistMixer, 'updated'>; dropped: number } | null {
  if (!isRecord(body) || typeof body.on !== 'boolean' || (body.style !== 'clean' && body.style !== 'party') || !isRecord(body.transitions)) return null
  const entries = Object.entries(body.transitions)
  if (entries.length > MIXER_MAX_TRANSITIONS) return null
  const transitions: Record<string, Record<string, unknown>> = {}
  let dropped = 0
  for (const [key, value] of entries) {
    const checked = transition(key, value)
    if (checked) transitions[key] = checked
    else dropped++
  }
  return { settings: { on: body.on, style: body.style, transitions }, dropped }
}
