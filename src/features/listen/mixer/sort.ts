import { harmonicScore } from './camelot.ts'
import { mixOf, prepareTrack, type MixLookup, type PreparedTrack } from './analysis.ts'
import { pairKey, type MixStyle, type TrackMix, type Transition } from './types.ts'

/**
 * "Sort & build transitions": puts a playlist in an order that mixes well.
 *
 * Every ordered pair of songs gets a cost (1 − `pairScore`: how well the keys blend, how close the tempos are, straight
 * or half/double time, the energy step, and how good a transition the two allow: instrumental room at A's end and B's
 * start in clean style, cue points and drops in party style). On top comes a cost per position that shapes the
 * playlist as a whole:
 * - Clean: a gentle rise from the calmer songs to the more intense ones, weak enough that smooth neighbours win.
 * - Party: an energy arc. A build, then peaks with a short breather between them (about one per dozen songs), ending
 *   on a peak. The most intense songs, those with drops among them, land in the peaks.
 * "Intensity" is compared across the playlist by rank (loudness, tempo, drops, how dense the song is), since each
 * song's energy curve is relative to its own loudest moment.
 *
 * Finding the order is a shortest-path problem over these costs (an open path, both directions differ). It's solved
 * with nearest neighbour from several starts, then improved by 2-opt (reversing a stretch) and or-opt (moving one to
 * three songs elsewhere) until nothing improves or the time budget is spent. A few hundred songs sort well within a
 * second.
 *
 * Songs without a usable analysis (none yet, or no beat grid) can't be scored; they keep their place in the playlist
 * (the same index) and the analysed songs are sorted into the other places around them, so a half-analysed playlist
 * isn't pushed to one end.
 */

export interface SortOptions {
  /** Stop improving after this many milliseconds (default 700). */
  timeBudgetMs?: number
}

interface Features {
  track: PreparedTrack
  /** Intensity before ranking (loudness, tempo, drops, density), and its rank in the playlist (0–1). */
  intensity: number
  rank: number
  /** Seconds without singing at the start and at the end (the room for a long clean blend). */
  introRoom: number
  outroRoom: number
  hasEntry: boolean
  hasExit: boolean
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))

function features(track: PreparedTrack): Features {
  const loud = clamp((track.loudness + 16) / 11)
  const tempo = clamp((track.bpm - 80) / 60)
  const drops = clamp(track.drops.length / 2)
  const density = track.energyBetween(track.start, track.end)
  const intensity = 0.45 * loud + 0.3 * tempo + 0.15 * drops + 0.1 * density
  // Without measured vocals, assume half the intro and outro are free of singing.
  const firstVoice = track.vocals.length > 0 ? track.vocals[0].start : track.end
  const lastVoice = track.vocals.length > 0 ? track.vocals[track.vocals.length - 1].end : track.start
  const share = track.vocalsKnown ? 1 : 0.5
  return {
    track,
    intensity,
    rank: intensity,
    introRoom: Math.max(0, firstVoice - track.start) * share,
    outroRoom: Math.max(0, track.end - lastVoice) * share,
    hasEntry: track.drops.length > 0 || track.cuesIn.length > 0 || track.sections.some((s) => s.kind === 'chorus' || s.kind === 'drop'),
    hasExit: track.cuesOut.length > 0 || track.sections.some((s) => s.kind === 'chorus' || s.kind === 'drop'),
  }
}

/** 0–1: tempos within 2 % score 1, beatmatchable (≤ 6 %, also half/double time) high, beyond that falling off. */
function tempoScore(a: PreparedTrack, b: PreparedTrack, style: MixStyle) {
  let diff = Infinity
  for (const multiple of [1, 2, 0.5]) diff = Math.min(diff, Math.abs(b.period / (multiple * a.period) - 1) + (multiple === 1 ? 0 : 0.01))
  const floor = style === 'party' ? 0.3 : 0.05
  let score = diff <= 0.02 ? 1 : diff <= 0.06 ? 1 - ((diff - 0.02) / 0.04) * 0.35 : Math.max(floor, 0.65 - (diff - 0.06) * 3)
  // An unsure tempo can't be trusted either way.
  const sure = clamp((Math.min(a.bpmConfidence, b.bpmConfidence) - 0.2) / 0.5)
  score = 0.5 + (score - 0.5) * sure
  return score
}

function energyScore(from: number, to: number, style: MixStyle) {
  const step = to - from
  if (style === 'clean') return 1 - clamp(2 * Math.abs(step))
  return step >= 0 ? 1 - clamp(step - 0.35) : 1 - clamp(1.5 * -step)
}

function roomScore(a: Features, b: Features, style: MixStyle) {
  if (style === 'party') return 0.4 + (b.hasEntry ? 0.3 : 0) + (a.hasExit ? 0.3 : 0)
  const need = 64 * a.track.period
  return 0.5 * clamp(a.outroRoom / need) + 0.5 * clamp(b.introRoom / need)
}

function scoreFeatures(a: Features, b: Features, style: MixStyle, useRank: boolean) {
  const harmony = harmonicScore(a.track, b.track)
  const tempo = tempoScore(a.track, b.track, style)
  const energy = energyScore(useRank ? a.rank : a.intensity, useRank ? b.rank : b.intensity, style)
  const room = roomScore(a, b, style)
  return style === 'clean'
    ? 0.35 * harmony + 0.3 * tempo + 0.15 * energy + 0.2 * room
    : 0.2 * harmony + 0.3 * tempo + 0.2 * energy + 0.3 * room
}

/**
 * How well B follows A (0–1): key, tempo, energy step and the room for a good transition. Unusable analyses score a
 * neutral 0.5.
 */
export function pairScore(a: TrackMix | null, b: TrackMix | null, style: MixStyle): number {
  const pa = prepareTrack(a)
  const pb = prepareTrack(b)
  if (!pa?.grid || !pb?.grid) return 0.5
  return scoreFeatures(features(pa), features(pb), style, false)
}

/** The shape of the playlist: the wanted intensity (0–1) at each position, as ranks so it fits any playlist. */
function arcTargets(n: number, style: MixStyle): Float64Array {
  const raw = new Float64Array(n)
  const peaks = Math.max(1, Math.round((n * 0.8) / 12))
  for (let i = 0; i < n; i++) {
    const p = n > 1 ? i / (n - 1) : 0
    if (style === 'clean') raw[i] = p
    else if (p < 0.2) raw[i] = 0.3 + (p / 0.2) * 0.5
    else {
      const phase = ((p - 0.2) / 0.8) * peaks
      const cycle = Math.min(peaks - 1, Math.floor(phase))
      const f = phase - cycle
      // Rise to a peak over three quarters of the cycle, then a breather; the last cycle ends on its peak.
      raw[i] = f < 0.75 || cycle === peaks - 1 ? 0.8 + 0.2 * Math.min(1, f / 0.75) : 0.6
    }
  }
  // As ranks: the k-th lowest target asks for the k-th least intense song.
  const order = [...raw.keys()].sort((p, q) => raw[p] - raw[q] || p - q)
  const ranks = new Float64Array(n)
  order.forEach((position, k) => (ranks[position] = n > 1 ? k / (n - 1) : 0))
  return ranks
}

/** Improves an open path in place: 2-opt and or-opt with first improvement, until stable or out of time. */
function improve(tour: Int32Array, cost: Float64Array, arc: Float64Array | null, n: number, deadline: number) {
  const c = (x: number, y: number) => cost[x * n + y]
  const place = (track: number, position: number) => (arc ? arc[track * n + position] : 0)
  const forward = new Float64Array(n)
  const backward = new Float64Array(n)
  const prefix = () => {
    for (let k = 1; k < n; k++) {
      forward[k] = forward[k - 1] + c(tour[k - 1], tour[k])
      backward[k] = backward[k - 1] + c(tour[k], tour[k - 1])
    }
  }
  const eps = 1e-9
  let improved = true
  while (improved && Date.now() < deadline) {
    improved = false
    prefix()
    // 2-opt: reverse tour[i..j].
    for (let i = 0; i < n - 1 && Date.now() < deadline; i++) {
      for (let j = i + 1; j < n; j++) {
        let delta = backward[j] - backward[i] - (forward[j] - forward[i])
        if (i > 0) delta += c(tour[i - 1], tour[j]) - c(tour[i - 1], tour[i])
        if (j < n - 1) delta += c(tour[i], tour[j + 1]) - c(tour[j], tour[j + 1])
        if (arc) for (let k = i; k <= j; k++) delta += place(tour[k], i + j - k) - place(tour[k], k)
        if (delta < -eps) {
          for (let x = i, y = j; x < y; x++, y--) [tour[x], tour[y]] = [tour[y], tour[x]]
          prefix()
          improved = true
        }
      }
    }
    // Or-opt: move tour[i..i+s-1] elsewhere, keeping its direction.
    for (let s = 1; s <= 3; s++) {
      for (let i = 0; i + s <= n && Date.now() < deadline; i++) {
        const first = tour[i]
        const last = tour[i + s - 1]
        const before = i > 0 ? tour[i - 1] : -1
        const after = i + s < n ? tour[i + s] : -1
        // Taking the segment out.
        let removal = 0
        if (before >= 0) removal -= c(before, first)
        if (after >= 0) removal -= c(last, after)
        if (before >= 0 && after >= 0) removal += c(before, after)
        let bestDelta = -eps
        let bestTarget = -1
        // Forward: insert after tour[j] (j ≥ i+s); the songs in between move s places up.
        let shifted = 0
        for (let j = i + s; j < n; j++) {
          if (arc) shifted += place(tour[j], j - s) - place(tour[j], j)
          const next = j + 1 < n ? tour[j + 1] : -1
          let delta = removal + c(tour[j], first) + (next >= 0 ? c(last, next) - c(tour[j], next) : 0) + shifted
          if (arc) for (let q = 0; q < s; q++) delta += place(tour[i + q], j - s + 1 + q) - place(tour[i + q], i + q)
          if (delta < bestDelta) {
            bestDelta = delta
            bestTarget = j
          }
        }
        // Backward: insert before tour[j] (j < i); the songs in between move s places down.
        shifted = 0
        for (let j = i - 1; j >= 0; j--) {
          if (arc) shifted += place(tour[j], j + s) - place(tour[j], j)
          const prev = j > 0 ? tour[j - 1] : -1
          let delta = removal + c(last, tour[j]) + (prev >= 0 ? c(prev, first) - c(prev, tour[j]) : 0) + shifted
          if (arc) for (let q = 0; q < s; q++) delta += place(tour[i + q], j + q) - place(tour[i + q], i + q)
          if (delta < bestDelta) {
            bestDelta = delta
            bestTarget = j
          }
        }
        if (bestTarget >= 0) {
          const list = Array.from(tour)
          const segment = list.splice(i, s)
          const at = bestTarget > i ? bestTarget - s + 1 : bestTarget
          list.splice(at, 0, ...segment)
          tour.set(list)
          improved = true
        }
      }
    }
  }
}

function pathCost(tour: Int32Array, cost: Float64Array, arc: Float64Array | null, n: number) {
  let total = 0
  for (let k = 0; k < n; k++) {
    if (k > 0) total += cost[tour[k - 1] * n + tour[k]]
    if (arc) total += arc[tour[k] * n + k]
  }
  return total
}

/** Nearest neighbour from a start, choosing at each step the cheapest next song for the next position. */
function nearestNeighbour(start: number, cost: Float64Array, arc: Float64Array | null, n: number): Int32Array {
  const tour = new Int32Array(n)
  const used = new Uint8Array(n)
  tour[0] = start
  used[start] = 1
  for (let k = 1; k < n; k++) {
    const from = tour[k - 1]
    let best = -1
    let bestCost = Infinity
    for (let j = 0; j < n; j++) {
      if (used[j]) continue
      const value = cost[from * n + j] + (arc ? arc[j * n + k] : 0)
      if (value < bestCost) {
        bestCost = value
        best = j
      }
    }
    tour[k] = best
    used[best] = 1
  }
  return tour
}

/** Orders analysed songs (indices into `list`) for the style. */
function orderAnalysed(list: Features[], style: MixStyle, budgetMs: number): number[] {
  const n = list.length
  if (n <= 1) return list.map((_, i) => i)
  const started = Date.now()
  // Intensity as a rank within the playlist.
  const byIntensity = [...list.keys()].sort((p, q) => list[p].intensity - list[q].intensity)
  byIntensity.forEach((index, k) => (list[index].rank = k / (n - 1)))

  const cost = new Float64Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cost[i * n + j] = i === j ? 0 : 1 - scoreFeatures(list[i], list[j], style, true)

  const weight = style === 'party' ? 1.5 : 0.15
  const targets = arcTargets(n, style)
  const arc = new Float64Array(n * n)
  for (let t = 0; t < n; t++) for (let p = 0; p < n; p++) arc[t * n + p] = weight * (list[t].rank - targets[p]) ** 2

  // Starts: the songs that suit the opening best, and some spread over the playlist.
  const openers = [...list.keys()].sort((p, q) => arc[p * n] - arc[q * n]).slice(0, 5)
  const spread = Array.from({ length: 5 }, (_, k) => Math.floor((k * n) / 5))
  const starts = [...new Set([...openers, ...spread])]
  const tours = starts
    .map((start) => nearestNeighbour(start, cost, arc, n))
    .map((tour) => ({ tour, cost: pathCost(tour, cost, arc, n) }))
    .sort((p, q) => p.cost - q.cost)
    .slice(0, 3)

  let best = tours[0]
  for (const [k, candidate] of tours.entries()) {
    const remaining = budgetMs - (Date.now() - started)
    if (remaining <= 0) break
    // The best start gets most of the time; the others a share each.
    improve(candidate.tour, cost, arc, n, Date.now() + (k === 0 ? remaining * 0.6 : remaining / (tours.length - k)))
    candidate.cost = pathCost(candidate.tour, cost, arc, n)
    if (candidate.cost < best.cost) best = candidate
  }
  return Array.from(best.tour)
}

/**
 * The playlist in mixing order (track ids). Songs without a usable analysis stay at their index; the others are
 * ordered into the remaining places.
 */
export function sortForMix(tracks: Array<{ id: string; mix: TrackMix | null }>, style: MixStyle, opts: SortOptions = {}): string[] {
  const analysed: Array<{ index: number; features: Features }> = []
  const fixed = new Set<number>()
  tracks.forEach((entry, index) => {
    const track = prepareTrack(entry.mix)
    if (track?.grid) analysed.push({ index, features: features(track) })
    else fixed.add(index)
  })
  const order = orderAnalysed(
    analysed.map((entry) => entry.features),
    style,
    opts.timeBudgetMs ?? 700,
  )
  const result: string[] = []
  let next = 0
  for (let index = 0; index < tracks.length; index++) {
    if (fixed.has(index)) result.push(tracks[index].id)
    else result.push(tracks[analysed[order[next++]].index].id)
  }
  return result
}

export interface MixLength {
  /** Seconds of all songs played in full, back to back. */
  original: number
  /** Seconds with the transitions (overlaps, skipped intros and outros). */
  mixed: number
  /** How much shorter, 0–1 (0.3 = "the playlist gets ~30 % shorter"). */
  shorterBy: number
  /** Songs whose length isn't known (left out of both sums). */
  unknown: number
}

/**
 * How long the playlist plays with its transitions. Per transition: A plays up to `aOut`, the overlap lasts `length`,
 * then B goes on from `bIn + length × rate` to its own out point. A pair without a transition plays back to back. B's
 * easing back to its own tempo after a beatmatch is left out (a second or two at most).
 */
export function estimateMixLength(
  order: readonly string[],
  mixes: MixLookup,
  transitions: Readonly<Record<string, Transition>>,
  durations: Readonly<Record<string, number>> = {},
): MixLength {
  const lengthOf = (id: string) => {
    const mix = mixOf(mixes, id)
    const value = mix && Number.isFinite(mix.duration) && mix.duration > 0 ? mix.duration : durations[id]
    return Number.isFinite(value) && value > 0 ? value : NaN
  }
  let original = 0
  let mixed = 0
  let unknown = 0
  // Where the current song starts playing on its own (after the overlap that brought it in).
  let from = 0
  let inOverlap = 0
  for (let i = 0; i < order.length; i++) {
    const duration = lengthOf(order[i])
    const next = i + 1 < order.length ? transitions[pairKey(order[i], order[i + 1])] : undefined
    if (!Number.isFinite(duration)) {
      unknown++
      from = 0
      inOverlap = 0
      continue
    }
    original += duration
    const usable = next && Number.isFinite(next.aOut) && Number.isFinite(next.length) && Number.isFinite(lengthOf(order[i + 1]))
    const out = usable ? Math.min(duration, Math.max(from, next.aOut)) : duration
    mixed += inOverlap + Math.max(0, out - from)
    if (usable) {
      const length = Math.max(0, Math.min(next.length, duration - out))
      const rate = Number.isFinite(next.rate) && next.rate > 0 ? next.rate : 1
      from = Math.max(0, next.bIn) + length * rate
      inOverlap = length
    } else {
      from = 0
      inOverlap = 0
    }
  }
  return { original, mixed, shorterBy: original > 0 ? clamp(1 - mixed / original) : 0, unknown }
}
