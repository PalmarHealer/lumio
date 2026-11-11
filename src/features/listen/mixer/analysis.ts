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
  /** Median seconds per beat. */
  period: number
  bpm: number
  bpmConfidence: number
  key: number
  minor: boolean
  keyClarity: number
  loudness: number
  /** Where singing is (measured), or where it may be (assumed from the structure when nothing was found). */
  vocals: Span[]
  vocalsKnown: boolean
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
}

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
export function prepareTrack(mix: TrackMix | null | undefined): PreparedTrack | null {
  if (!mix || typeof mix !== 'object') return null
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
  const intervals: number[] = []
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1])
  let period = median(intervals)
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

  // Vocals: as measured; when nothing was found, assume singing through the body of the song (between intro and
  // outro, or the middle 80 %), so the planner keeps overlaps to the edges.
  const vocalsKnown = (mix.vocalSource === 'lyrics' || mix.vocalSource === 'audio') && Array.isArray(mix.vocals)
  let vocals = vocalsKnown ? cleanSpans(mix.vocals, duration) : []
  if (!vocalsKnown) {
    const body = outroStart - introEnd > duration * 0.3 ? { start: introEnd, end: outroStart } : { start: duration * 0.1, end: duration * 0.9 }
    vocals = [body]
  }

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
    start,
    end,
    introEnd,
    outroStart,
    sections: cleanSections(mix.sections, duration),
    drops: cleanTimes(mix.drops, duration),
    cuesIn: Array.isArray(mix.cuesIn) ? mix.cuesIn.filter((t): t is number => finite(t) && t >= 0 && t < duration) : [],
    cuesOut: Array.isArray(mix.cuesOut) ? mix.cuesOut.filter((t): t is number => finite(t) && t > 0 && t <= duration) : [],
    energyBetween,
    loudSeconds,
  }
}

/** Seconds per beat around a moment (median of the 16 beats around it), or the song's median. */
export function periodAt(track: PreparedTrack, t: number): number {
  const i = floorIndex(track.beats, t)
  const from = Math.max(1, i - 8)
  const to = Math.min(track.beats.length - 1, i + 8)
  const local: number[] = []
  for (let k = from; k <= to; k++) local.push(track.beats[k] - track.beats[k - 1])
  const value = median(local)
  return finite(value) && Math.abs(value / track.period - 1) < 0.08 ? value : track.period
}

/** Analyses by track id, as a Map or a plain object (missing or null: not analysed yet). */
export type MixLookup = ReadonlyMap<string, TrackMix | null | undefined> | Readonly<Record<string, TrackMix | null | undefined>>

export function mixOf(mixes: MixLookup, id: string): TrackMix | null {
  if (mixes instanceof Map) return mixes.get(id) ?? null
  const record = mixes as Readonly<Record<string, TrackMix | null | undefined>>
  const mix = Object.hasOwn(record, id) ? record[id] : null
  return mix ?? null
}
