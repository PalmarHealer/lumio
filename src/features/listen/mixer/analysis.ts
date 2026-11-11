import type { MixSection, TrackMix } from './types.ts'

/**
 * A `TrackMix` as the planner and the sorter read it: every list cleaned (finite, sorted, inside the song), the gaps
 * the analysis may leave filled with safe guesses, and the questions asked again and again (how loud is the song
 * between two moments, does it sing at a moment) answered from prepared tables. Anything the server sends is
 * distrusted here, so the planner itself can assume sane data.
 */

export interface Span {
  start: number
  end: number
}

export interface PreparedTrack {
  mix: TrackMix
  duration: number
  /** The beat grid is usable for beatmatching and phrase alignment. */
  grid: boolean
  beats: number[]
  downbeats: number[]
  /** Phrase starts as analysed. */
  phrases: number[]
  /**
   * The analysed phrase starts plus every 8 bars counted on from each of them (until the next one): the places a DJ
   * would count to when the analysis found only the bigger section changes.
   */
  phraseGrid: number[]
  /** Seconds per beat over the whole song (median of 16-beat slopes). */
  period: number
  bpm: number
  bpmConfidence: number
  key: number
  minor: boolean
  keyClarity: number
  loudness: number
  /** Where singing is (measured), or where it may be (assumed from the structure when nothing was found). */
  vocals: Span[]
  /** `vocals` were measured (synced lyrics or the audio). */
  vocalsKnown: boolean
  /**
   * Nothing was measured, so `vocals` are assumed: the body sections (not intro, outro or break) whose mid band is up
   * like a voice's, padded by a bar each side. Treated like measured singing, at lower trust where cutting it.
   */
  vocalsAssumed: boolean
  /** First and last moment the song is clearly audible (leading silence and a fade-out tail left out). */
  start: number
  end: number
  introEnd: number
  outroStart: number
  sections: MixSection[]
  drops: number[]
  cuesIn: number[]
  cuesOut: number[]
  /** Mean energy between two moments (0–1 relative to the song's loudest; 0.5 without an energy curve). */
  energyBetween(from: number, to: number): number
  /** Seconds between two moments where the song plays at more than a third of its loudest. */
  loudSeconds(from: number, to: number): number
  /** Seconds of singing between two moments (0 when the vocals are only assumed). */
  sungSeconds(from: number, to: number): number
  /**
   * The song's band energies at a moment, relative to its own loud parts (1 = as in its loud sections, the 90th
   * percentile of the band over the song; capped at 1.5). Without band curves: 1 for every band.
   */
  bandsAt(t: number): { low: number; mid: number; high: number }
  /** The song's loudness (whole-track RMS) as an amplitude factor (10^(dBFS/20)). */
  level: number
  /** The harmonic profile (12 pitch classes, see `phraseChroma`) of the phrase playing at a moment, or null. */
  chromaAt(t: number): number[] | null
  /**
   * The least clear attacks (0–1, the share of beats with an audible onset on the grid) over [from, to]: per bar where
   * the analysis measured bars, else per phrase; 0 where it reaches before the song's first phrase or beat; NaN when
   * the analysis has no clarity at all.
   */
  clarityBetween(from: number, to: number): number
  /**
   * The same for the kick alone (its low-band attacks on the grid), where the analysis measured it per bar; else the
   * combined measure above. A kick only flams where both decks' lows are heard.
   */
  kickClarityBetween(from: number, to: number): number
}

/** A section's mean mid band (against the song's loud mids) from which it may hold a voice, when nothing was measured. */
const ASSUMED_VOICE_MID = 0.5
/** The same where the song has lyrics that couldn't be placed (singing is certain, only where is unknown). */
const UNPLACED_VOICE_MID = 0.35

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const unit = (x: unknown) => (finite(x) ? clamp(x, 0, 1) : 0)

/** Finite times inside [0, duration], sorted, without near-duplicates. */
export function cleanTimes(list: unknown, duration: number): number[] {
  if (!Array.isArray(list)) return []
  const times = list.filter((t): t is number => finite(t) && t >= 0 && t <= duration).sort((p, q) => p - q)
  const result: number[] = []
  for (const t of times) if (result.length === 0 || t - result[result.length - 1] > 0.05) result.push(t)
  return result
}

function cleanSpans(list: unknown, duration: number): Span[] {
  if (!Array.isArray(list)) return []
  const spans = list
    .filter((s): s is Span => !!s && typeof s === 'object' && finite((s as Span).start) && finite((s as Span).end))
    .map((s) => ({ start: clamp(s.start, 0, duration), end: clamp(s.end, 0, duration) }))
    .filter((s) => s.end > s.start)
    .sort((p, q) => p.start - q.start)
  const merged: Span[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start - last.end < 0.3) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

function cleanSections(list: unknown, duration: number): MixSection[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((s): s is MixSection => !!s && typeof s === 'object' && finite((s as MixSection).start) && finite((s as MixSection).end))
    .map((s) => ({
      start: clamp(s.start, 0, duration),
      end: clamp(s.end, 0, duration),
      kind: s.kind,
      group: finite(s.group) ? s.group : -1,
      energy: unit(s.energy),
    }))
    .filter((s) => s.end > s.start)
    .sort((p, q) => p.start - q.start)
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((p, q) => p - q)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Index of the last element ≤ t (-1 when none). */
export function floorIndex(sorted: readonly number[], t: number): number {
  let lo = -1
  let hi = sorted.length
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= t) lo = mid
    else hi = mid
  }
  return lo
}

/** The element of a sorted list closest to t (NaN for an empty list). */
export function nearest(sorted: readonly number[], t: number): number {
  if (sorted.length === 0) return NaN
  const i = floorIndex(sorted, t)
  if (i < 0) return sorted[0]
  if (i === sorted.length - 1) return sorted[i]
  return t - sorted[i] <= sorted[i + 1] - t ? sorted[i] : sorted[i + 1]
}

/** The span containing t, if any. */
export function spanAt(spans: readonly Span[], t: number): Span | undefined {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].end <= t) lo = mid + 1
    else if (spans[mid].start > t) hi = mid - 1
    else return spans[mid]
  }
  return undefined
}

/** Whether any span overlaps [from, to]. */
export function spansTouch(spans: readonly Span[], from: number, to: number): boolean {
  return spans.some((s) => s.start < to && s.end > from)
}

function durationOf(mix: TrackMix): number {
  if (finite(mix.duration) && mix.duration > 0) return mix.duration
  const rate = finite(mix.frameRate) && mix.frameRate > 0 ? mix.frameRate : 10
  if (Array.isArray(mix.energy) && mix.energy.length > 0) return mix.energy.length / rate
  const beats = Array.isArray(mix.beats) ? mix.beats.filter(finite) : []
  return beats.length > 0 ? Math.max(...beats) : NaN
}

/** Cleans an analysis; null when not even the song's length can be told. */
/** Prepared tracks by analysis object: "sort & build" plans each song twice (as A and as B). */
const prepared = new WeakMap<object, PreparedTrack | null>()

export function prepareTrack(mix: TrackMix | null | undefined): PreparedTrack | null {
  if (!mix || typeof mix !== 'object') return null
  if (prepared.has(mix)) return prepared.get(mix)!
  const track = prepareUncached(mix)
  prepared.set(mix, track)
  return track
}

function prepareUncached(mix: TrackMix): PreparedTrack | null {
  const duration = durationOf(mix)
  if (!finite(duration) || duration <= 0) return null

  // Energy: per frame, with prefix sums for the mean and for the count of loud frames.
  const frameRate = finite(mix.frameRate) && mix.frameRate > 0 && mix.frameRate <= 100 ? mix.frameRate : 10
  const energy = Array.isArray(mix.energy) ? mix.energy.map(unit) : []
  const sum = new Float64Array(energy.length + 1)
  const loud = new Float64Array(energy.length + 1)
  for (let i = 0; i < energy.length; i++) {
    sum[i + 1] = sum[i] + energy[i]
    loud[i + 1] = loud[i] + (energy[i] > 0.33 ? 1 : 0)
  }
  const frame = (t: number) => clamp(Math.round(t * frameRate), 0, energy.length)
  const energyBetween = (from: number, to: number) => {
    const i = frame(Math.min(from, to))
    const j = frame(Math.max(from, to))
    if (energy.length === 0) return 0.5
    if (j <= i) return energy[Math.min(i, energy.length - 1)]
    return (sum[j] - sum[i]) / (j - i)
  }
  const loudSeconds = (from: number, to: number) => {
    if (to <= from) return 0
    if (energy.length === 0) return to - from
    return (loud[frame(to)] - loud[frame(from)]) / frameRate
  }

  let start = 0
  let end = duration
  if (energy.length > 0) {
    const first = energy.findIndex((e) => e >= 0.06)
    let last = energy.length - 1
    while (last > 0 && energy[last] < 0.1) last--
    if (first >= 0) start = Math.min(first / frameRate, duration * 0.3)
    end = Math.max((last + 1) / frameRate, duration * 0.7, start)
    end = Math.min(end, duration)
  }

  // The beat grid: usable when there are enough beats at a sane tempo on a song long enough to mix.
  const beats = cleanTimes(mix.beats, duration)
  // The song's beat length: the median of 16-beat slopes, unbiased by grids alternating long and short beats and
  // robust to a gap where the analysis lost a few beats.
  const slopes: number[] = []
  for (let i = 0; i + 16 < beats.length; i++) slopes.push((beats[i + 16] - beats[i]) / 16)
  let period = median(slopes)
  const grid = duration >= 30 && beats.length >= 32 && finite(period) && period >= 0.24 && period <= 1.6
  if (!grid) period = finite(mix.bpm) && mix.bpm >= 40 && mix.bpm <= 250 ? 60 / mix.bpm : 0.5

  let downbeats = cleanTimes(mix.downbeats, duration)
  if (grid && downbeats.length < beats.length / 8) downbeats = beats.filter((_, i) => i % 4 === 0)
  let phrases = cleanTimes(mix.phrases, duration)
  if (grid && phrases.length < 2) phrases = downbeats.filter((_, i) => i % 8 === 0)

  const phraseGrid: number[] = []
  for (let k = 0; k < phrases.length; k++) {
    const next = k + 1 < phrases.length ? phrases[k + 1] : duration
    phraseGrid.push(phrases[k])
    const first = floorIndex(downbeats, phrases[k] + 0.05)
    if (first < 0 || Math.abs(downbeats[first] - phrases[k]) > period / 2) continue
    for (let i = first + 8; i < downbeats.length && downbeats[i] < next - 6 * period; i += 8) phraseGrid.push(downbeats[i])
  }

  const introEnd = finite(mix.introEnd) ? clamp(mix.introEnd, 0, duration) : 0
  const outroStart = finite(mix.outroStart) && mix.outroStart > introEnd ? clamp(mix.outroStart, 0, duration) : duration

  // Vocals: as measured; when nothing was placed (no lyrics, or lyrics not placeable), assume singing in every body section
  // with a voice-like mid band, a bar of margin each side, so no voice of the other song lands on it and a clean mix
  // doesn't cut into it. A song without such sections (thin mids: an instrumental) gets none.
  const vocalsKnown = (mix.vocalSource === 'lyrics' || mix.vocalSource === 'audio') && Array.isArray(mix.vocals)
  const sections = cleanSections(mix.sections, duration)
  const bandsAt = bandCurves(mix, frameRate)
  let vocals = vocalsKnown ? cleanSpans(mix.vocals, duration) : []
  if (!vocalsKnown) {
    const pad = 4 * period
    // Lyrics exist but couldn't be placed: someone certainly sings, so thinner mids count too.
    const voiceMid = mix.vocalSource === 'unplaced' ? UNPLACED_VOICE_MID : ASSUMED_VOICE_MID
    const midOver = (from: number, to: number) => {
      let sum = 0
      let count = 0
      for (let t = from; t < to; t += 0.25) {
        sum += bandsAt(t).mid
        count++
      }
      return count > 0 ? sum / count : 0
    }
    const assumed = sections
      .filter((s) => s.kind !== 'intro' && s.kind !== 'outro' && s.kind !== 'break' && midOver(s.start, s.end) >= voiceMid)
      .map((s) => ({ start: Math.max(0, s.start - pad), end: Math.min(duration, s.end + pad) }))
    vocals = cleanSpans(assumed, duration)
  }
  const vocalsAssumed = !vocalsKnown && vocals.length > 0

  return {
    mix,
    duration,
    grid,
    beats,
    downbeats,
    phrases,
    phraseGrid,
    period,
    bpm: 60 / period,
    bpmConfidence: unit(mix.bpmConfidence),
    key: finite(mix.key) ? Math.round(mix.key) : -1,
    minor: !!mix.minor,
    keyClarity: unit(mix.keyClarity),
    loudness: finite(mix.loudness) ? clamp(mix.loudness, -60, 0) : -14,
    vocals,
    vocalsKnown,
    vocalsAssumed,
    start,
    end,
    introEnd,
    outroStart,
    sections,
    drops: cleanTimes(mix.drops, duration),
    cuesIn: Array.isArray(mix.cuesIn) ? mix.cuesIn.filter((t): t is number => finite(t) && t >= 0 && t < duration) : [],
    cuesOut: Array.isArray(mix.cuesOut) ? mix.cuesOut.filter((t): t is number => finite(t) && t > 0 && t <= duration) : [],
    energyBetween,
    loudSeconds,
    bandsAt,
    level: 10 ** ((finite(mix.loudness) ? clamp(mix.loudness, -60, 0) : -14) / 20),
    chromaAt: phraseChromaAt(mix, duration),
    clarityBetween: clarity(mix, duration, beats.length > 0 ? beats[0] : 0),
    kickClarityBetween: kickClarity(mix, duration, beats.length > 0 ? beats[0] : 0),
    sungSeconds: (from: number, to: number) =>
      vocalsKnown || vocalsAssumed ? vocals.reduce((sum, span) => sum + Math.max(0, Math.min(to, span.end) - Math.max(from, span.start)), 0) : 0,
  }
}

/** Band energies relative to the song's loud level (its 90th percentile per band). */
function bandCurves(mix: TrackMix, frameRate: number) {
  const bands = mix.bands && typeof mix.bands === 'object' ? mix.bands : null
  const curve = (list: unknown) => (Array.isArray(list) ? list.map(unit) : [])
  const low = curve(bands?.low)
  const mid = curve(bands?.mid)
  const high = curve(bands?.high)
  const loudLevel = (list: number[]) => {
    if (list.length === 0) return 1
    const sorted = [...list].sort((p, q) => p - q)
    return Math.max(0.05, sorted[Math.floor(sorted.length * 0.9)])
  }
  const refs = { low: loudLevel(low), mid: loudLevel(mid), high: loudLevel(high) }
  const at = (list: number[], ref: number, t: number) => {
    if (list.length === 0) return 1
    const i = clamp(Math.round(t * frameRate), 0, list.length - 1)
    return Math.min(1.5, list[i] / ref)
  }
  return (t: number) => ({ low: at(low, refs.low, t), mid: at(mid, refs.mid, t), high: at(high, refs.high, t) })
}

/** The chroma of the phrase playing at a moment (phrase list and chroma list paired one to one), or null. */
function phraseChromaAt(mix: TrackMix, duration: number) {
  const starts = Array.isArray(mix.phrases) ? mix.phrases : []
  const chroma = Array.isArray(mix.phraseChroma) ? mix.phraseChroma : []
  const usable = chroma.length === starts.length && chroma.length > 0 && chroma.every((c) => Array.isArray(c) && c.length === 12 && c.every(finite))
  const times = starts.map((t) => (finite(t) ? clamp(t, 0, duration) : NaN))
  return (t: number): number[] | null => {
    if (!usable) return null
    const i = floorIndex(times, t)
    return i >= 0 ? chroma[i] : null
  }
}

/**
 * Attack clarity over a stretch: from the clarity per bar when the analysis has it (pairing up with the downbeats one
 * to one), else per phrase.
 */
function clarity(mix: TrackMix, duration: number, beatsStart: number) {
  const bars = Array.isArray(mix.barClarity) && Array.isArray(mix.downbeats) && mix.barClarity.length === mix.downbeats.length && mix.barClarity.length > 0
  return bars ? stretchClarity(mix.downbeats, mix.barClarity, duration, beatsStart) : stretchClarity(mix.phrases, mix.phraseClarity, duration, beatsStart)
}

function kickClarity(mix: TrackMix, duration: number, beatsStart: number) {
  const kicks: unknown = mix.barKickClarity
  const bars = Array.isArray(kicks) && Array.isArray(mix.downbeats) && kicks.length === mix.downbeats.length && kicks.length > 0
  return bars ? stretchClarity(mix.downbeats, kicks, duration, beatsStart) : clarity(mix, duration, beatsStart)
}

/** Clarity per stretch (bar or phrase), kept only when the values pair up with the stretch starts one to one. */
function stretchClarity(startList: unknown, valueList: unknown, duration: number, beatsStart: number) {
  const starts = Array.isArray(startList) ? (startList as number[]) : []
  const values = Array.isArray(valueList) ? (valueList as number[]) : []
  const pairs = starts
    .map((t, i) => ({ t, clarity: values[i] }))
    .filter((p) => finite(p.t) && p.t >= 0 && p.t <= duration && finite(p.clarity))
    .sort((p, q) => p.t - q.t)
  const usable = values.length === starts.length && pairs.length > 0
  const times = pairs.map((p) => p.t)
  return (from: number, to: number) => {
    if (!usable) return NaN
    // Before the first phrase (or the first beat) the song has no grid at all: nothing there can be beatmatched.
    if (from < Math.max(times[0], beatsStart) - 0.05) return 0
    let least = Infinity
    const first = Math.max(0, floorIndex(times, from))
    for (let i = first; i < pairs.length && pairs[i].t < to; i++) least = Math.min(least, clamp(pairs[i].clarity, 0, 1))
    return Number.isFinite(least) ? least : NaN
  }
}

/**
 * Seconds per beat around a moment: the slope over the 16 beats around it ((beats[i+8] − beats[i−8]) / 16), which a
 * grid alternating long and short beats (swing, a tracker's jitter) doesn't bias the way a median of intervals does.
 * The song's median only when the beats there are missing or absurd (more than 20 % off).
 */
export function periodAt(track: PreparedTrack, t: number): number {
  const i = floorIndex(track.beats, t)
  const from = Math.max(0, i - 8)
  const to = Math.min(track.beats.length - 1, Math.max(i, 0) + 8)
  const value = to > from ? (track.beats[to] - track.beats[from]) / (to - from) : NaN
  return finite(value) && Math.abs(value / track.period - 1) < 0.2 ? value : track.period
}

/**
 * Seconds per beat over a stretch of the song: the least-squares slope of beat time over beat number for the beats in
 * [from, to] (what a constant playback rate has to match there), or `periodAt` its middle when it holds under 8 beats.
 */
export function periodOver(track: PreparedTrack, from: number, to: number): number {
  const first = Math.max(0, floorIndex(track.beats, from - 1e-6) + 1)
  const last = floorIndex(track.beats, to + 1e-6)
  const n = last - first + 1
  if (n < 8) return periodAt(track, (from + to) / 2)
  let sumX = 0
  let sumY = 0
  for (let k = 0; k < n; k++) {
    sumX += k
    sumY += track.beats[first + k]
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let num = 0
  let den = 0
  for (let k = 0; k < n; k++) {
    num += (k - meanX) * (track.beats[first + k] - meanY)
    den += (k - meanX) ** 2
  }
  const value = num / den
  return finite(value) && Math.abs(value / track.period - 1) < 0.2 ? value : periodAt(track, (from + to) / 2)
}

/** Analyses by track id, as a Map or a plain object (missing or null: not analysed yet). */
export type MixLookup = ReadonlyMap<string, TrackMix | null | undefined> | Readonly<Record<string, TrackMix | null | undefined>>

export function mixOf(mixes: MixLookup, id: string): TrackMix | null {
  if (mixes instanceof Map) return mixes.get(id) ?? null
  const record = mixes as Readonly<Record<string, TrackMix | null | undefined>>
  const mix = Object.hasOwn(record, id) ? record[id] : null
  return mix ?? null
}
