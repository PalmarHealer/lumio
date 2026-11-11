import { harmonicScore } from './camelot.ts'
import {
  floorIndex,
  nearest,
  periodAt,
  periodOver,
  prepareTrack,
  spanAt,
  spansTouch,
  type PreparedTrack,
} from './analysis.ts'
import { NEEDS_BEATMATCH, keyframes, matchLevels, plainCrossfade, presetShape, valueAt, type ConcretePreset, type PresetShape } from './presets.ts'
import type { DeckAutomation, MixStyle, PresetId, TrackMix, Transition } from './types.ts'

/**
 * Plans the transition from one song into the next the way a DJ would, from both songs' whole-track analysis.
 *
 * It tries many placements and keeps the one that scores best:
 * - Where: a phrase start of A where A goes out and a phrase start of B where B comes in, lined up so both songs'
 *   phrases (and bars) meet at the same moment. In clean style the songs play (nearly) in full and the overlap sits in
 *   A's outro and B's intro; in party style A leaves after its last chorus or drop (`cuesOut`) and B comes in on its
 *   drop, chorus or the end of its intro (`cuesIn`), so intros and outros are cut.
 * - How: a preset (bass swap, crossfade, filter build, echo out, drop swap, hard cut, brake, fades). Long overlaps only
 *   when the tempos match within 6 % (straight, half or double time): then B plays at `rate` so its beats sit on A's.
 *   Otherwise only the techniques that need no beatmatch.
 * - Hard rules: never two voices at once (checked against both songs' vocals, B's moving at `rate`), never two
 *   basslines at once (the presets swap the lows in one step). A placement that breaks one is dropped.
 * - Preferences, as score terms: the overlap length that suits the tempo and key fit, keys that blend while both decks
 *   sound, no vocal line cut off mid-word, the energy not falling away (party) or jumping (clean), little of either
 *   song skipped (clean) or the good cue points used (party).
 *
 * The score splits into what's known from the placement alone and the vocal checks, which need sampling; placements
 * are checked best-first and the search stops as soon as no remaining one could beat the best found (the vocal terms
 * only ever subtract), so it stays fast enough to plan a few hundred transitions at once.
 *
 * Analyses that are missing, unsure or broken lead to a short plain crossfade or to the beatmatch-free techniques, and
 * a lower `confidence`. The result is always a valid transition: aOut within A, bIn within B, sorted keyframes in
 * [0, length].
 */

export interface PlanOptions {
  /** Use this technique (the editor's preset menu, or switching one transition's style); the planner picks where. */
  preset?: PresetId
}

export interface TempoMatch {
  /** Beatmatched: B plays at `rate` during the overlap. */
  synced: boolean
  /** B's playback rate that puts its beats on A's (B's tempo × rate ≈ A's tempo × multiple). */
  rate: number
  /** How many of A's beats one beat of B spans: 1, 2 (B in half time) or 0.5 (B in double time). */
  multiple: number
  /** |rate − 1|. */
  diff: number
}

const MAX_TEMPO_DIFF = 0.06
const MIN_BPM_CONFIDENCE = 0.45
/** A voice (gain × mid band, damped by a closed filter) above this counts as heard. */
const VOICE_HEARD = 0.3
/**
 * An echoed voice over B's singing distracts even when quiet: its repeats count as heard down to this level (with the
 * usual feedback of 0.5, the first three repeats).
 */
const ECHO_HEARD = 0.12
/** Median distance (seconds) between both decks' beats above which a beatmatch is rejected. */
const MAX_DRIFT = 0.025
/** Least attack clarity (share of beats with an audible onset) a beatmatch needs in each song's phrases it covers. */
const MIN_CLARITY = 0.6
/** Mean offset (seconds) between the decks' beats allowed in any two bars of a beatmatched overlap. */
const MAX_WINDOW_DRIFT = 0.025

/** How B's tempo relates to A's: the closest of straight, half and double time. */
export function matchTempo(a: PreparedTrack, b: PreparedTrack): TempoMatch {
  let best = { multiple: 1, rate: 1, score: Infinity }
  for (const multiple of [1, 2, 0.5]) {
    const rate = b.period / (multiple * a.period)
    // Straight time wins a near tie: half/double time is a judgment of the analysis that may be off.
    const score = Math.abs(rate - 1) + (multiple === 1 ? 0 : 0.005)
    if (score < best.score) best = { multiple, rate, score }
  }
  const diff = Math.abs(best.rate - 1)
  const sure = Math.min(a.bpmConfidence, b.bpmConfidence) >= MIN_BPM_CONFIDENCE
  return { synced: a.grid && b.grid && sure && diff <= MAX_TEMPO_DIFF, rate: best.rate, multiple: best.multiple, diff }
}

/** A phrase start a transition can be lined up on: what it is (B's drop, a chorus start) and how good a spot it is. */
interface Anchor {
  t: number
  bonus: number
  drop: boolean
  chorus: boolean
}

/** Adds a spot; one already there (within half a second) keeps the higher bonus and gains the other's kind. */
function addAnchor(list: Anchor[], t: number, bonus: number, kind?: 'drop' | 'chorus') {
  if (!Number.isFinite(t)) return
  const same = list.find((anchor) => Math.abs(anchor.t - t) < 0.5)
  const drop = kind === 'drop'
  const chorus = kind === 'chorus'
  if (!same) list.push({ t, bonus, drop, chorus })
  else {
    same.bonus = Math.max(same.bonus, bonus)
    same.drop ||= drop
    same.chorus ||= chorus
  }
}

/** The phrase start closest to t when one is within two bars, else the closest downbeat. */
function snapToPhrase(track: PreparedTrack, t: number) {
  const phrase = nearest(track.phraseGrid, t)
  if (Math.abs(phrase - t) <= 8 * track.period) return phrase
  const downbeat = nearest(track.downbeats, t)
  return Number.isFinite(downbeat) ? downbeat : t
}

/** A phrase start counted on from the analysed ones (not found itself) is a little less sure. */
const counted = (track: PreparedTrack, t: number) => (Math.abs(nearest(track.phrases, t) - t) < 0.05 ? 0 : -0.02)

const isPeakSection = (kind: string) => kind === 'chorus' || kind === 'drop'

/** Where A may go out: the phrase where the transition (or its swap) happens. */
function outAnchors(a: PreparedTrack, style: MixStyle): Anchor[] {
  const list: Anchor[] = []
  const party = style === 'party'
  const from = Math.max(a.duration * (party ? 0.4 : 0.35), party ? 0 : Math.min(a.introEnd, a.duration * 0.6))
  const phrases = a.phraseGrid.filter((t) => t >= from && t < a.end)
  for (const t of phrases.slice(-12)) addAnchor(list, t, counted(a, t))
  if (a.outroStart >= from && a.outroStart < a.end) addAnchor(list, snapToPhrase(a, a.outroStart), party ? 0.15 : 0.05)
  const cues = a.cuesOut.filter((t) => t >= from && t < a.end)
  cues.forEach((t, i) => addAnchor(list, snapToPhrase(a, t), (party ? 0.3 : 0.05) * (1 - i / (cues.length + 1))))
  if (!party && a.vocalsKnown && a.vocals.length > 0) {
    // The first 4-bar point (counted from the analysed phrase before it) after A's last sung line: where a clean mix
    // can leave without cutting a word and still on the phrase grid.
    const lastLine = a.vocals[a.vocals.length - 1].end
    const phrase = a.phrases[floorIndex(a.phrases, lastLine)]
    const first = phrase === undefined ? -1 : floorIndex(a.downbeats, phrase + 0.05)
    if (first >= 0 && Math.abs(a.downbeats[first] - phrase) < 0.05) {
      let i = first
      while (i < a.downbeats.length && a.downbeats[i] < lastLine - 0.05) i += 4
      const next = a.downbeats[i]
      if (next !== undefined && next >= from && next < a.duration - 4 * a.period) addAnchor(list, next, 0)
    }
  }
  if (party) {
    // Right after a chorus or drop of the second half (the last one best): the hook was heard, the rest is outro.
    const peaks = a.sections.filter((s) => isPeakSection(s.kind) && s.start >= a.duration * 0.3 && s.end < a.end - 4 * a.period)
    peaks.forEach((s, i) => addAnchor(list, snapToPhrase(a, s.end), i === peaks.length - 1 ? 0.25 : 0.15))
    // A's own late drops: where B's drop can land instead.
    for (const t of a.drops) if (t >= from && t < a.end) addAnchor(list, snapToPhrase(a, t), 0.05, 'drop')
  }
  return list.filter((anchor) => anchor.t > 0 && anchor.t < a.duration)
}

/**
 * Where B may come in: the phrase B's transition (or its swap) is lined up on. In party style the spots worth it are
 * B's drops and its first choruses; a cue point only counts once B's first 8 bars are behind (an entry at the very
 * start skips nothing).
 */
function inAnchors(b: PreparedTrack, style: MixStyle): Anchor[] {
  const list: Anchor[] = []
  const party = style === 'party'
  const until = b.duration * (party ? 0.6 : 0.3)
  const phrases = b.phraseGrid.filter((t) => t <= until)
  for (const t of phrases.slice(0, party ? 4 : 6)) addAnchor(list, t, counted(b, t))
  if (b.downbeats.length > 0 && (phrases.length === 0 || phrases[0] > b.start + 4 * b.period)) {
    const first = b.downbeats[Math.max(0, floorIndex(b.downbeats, b.start - 0.05) + 1)] ?? b.downbeats[0]
    addAnchor(list, first, 0)
  }
  const intoSong = b.start + 32 * b.period
  if (b.introEnd > 0 && b.introEnd <= until) addAnchor(list, snapToPhrase(b, b.introEnd), party ? (b.introEnd >= b.start + 16 * b.period ? 0.1 : 0) : 0.05)
  const cues = b.cuesIn.filter((t) => t <= until)
  cues.forEach((t, i) => addAnchor(list, snapToPhrase(b, t), party ? (t >= intoSong ? 0.2 * (1 - i / (cues.length + 1)) : 0.03) : 0.03))
  if (party) {
    for (const t of b.drops) if (t <= until) addAnchor(list, snapToPhrase(b, t), 0.35, 'drop')
    const peaks = b.sections.filter((s) => isPeakSection(s.kind) && s.start <= until && s.start >= b.start + 8 * b.period).slice(0, 2)
    for (const s of peaks) addAnchor(list, snapToPhrase(b, s.start), s.kind === 'drop' ? 0.35 : 0.3, s.kind === 'drop' ? 'drop' : 'chorus')
  }
  return list.filter((anchor) => anchor.t >= 0 && anchor.t < b.duration)
}

interface Variant {
  preset: ConcretePreset
  bars: number
  swapFraction: number
  preRollBars: number
  echoTail: boolean
  /**
   * 'swap': the chosen phrase starts of both songs meet at the swap, so the moment the bass changes deck lies on a
   * phrase of each (and B's drop or chorus lands on it); 'shape': at the shape's own anchors.
   */
  meet: 'shape' | 'swap'
  prior: number
}

const FREE_LENGTH: ReadonlySet<ConcretePreset> = new Set(['crossfade', 'bassSwap', 'filterBuild', 'fadeOut', 'fadeIn'])

/** The shapes with a swap moment line up the phrases there; the others at their own anchors. */
const meetOf = (preset: ConcretePreset): Variant['meet'] => (preset === 'bassSwap' || preset === 'crossfade' || preset === 'filterBuild' ? 'swap' : 'shape')

function variantsFor(style: MixStyle, synced: boolean, maxBars: number, forced?: ConcretePreset): Variant[] {
  const list: Variant[] = []
  const add = (
    preset: ConcretePreset,
    prior: number,
    bars: number[] = [0],
    extra: { fractions?: number[]; preRolls?: number[]; echoTails?: boolean[] } = {},
  ) => {
    const allowed = FREE_LENGTH.has(preset) ? bars.filter((n) => n <= maxBars) : bars
    const lengths = allowed.length > 0 ? allowed : [Math.min(...bars)]
    for (const n of lengths)
      for (const swapFraction of extra.fractions ?? [0.5])
        for (const preRollBars of extra.preRolls ?? [0])
          for (const echoTail of preRollBars === 0 ? (extra.echoTails ?? [false]) : [false])
            list.push({ preset, bars: n, swapFraction, preRollBars, echoTail, meet: meetOf(preset), prior })
  }
  if (style === 'clean' && synced) {
    add('bassSwap', 0.3, [32, 16, 8, 4], { fractions: [0.5, 0.25, 0.75] })
    add('crossfade', 0.12, [16, 8])
    add('filterBuild', 0.08, [16, 8])
    add('echoOut', 0)
    add('fadeOut', -0.02, [4])
    add('hardCut', -0.35)
  } else if (style === 'clean') {
    add('echoOut', 0.15)
    add('fadeOut', 0.15, [2])
    // Without beatmatch a crossfade lasts one bar: the beats meet for three beats at most.
    add('crossfade', 0.05, [1])
    add('filterBuild', 0.02, [2])
    add('fadeIn', 0, [2])
    add('hardCut', -0.45)
  } else if (synced) {
    add('dropSwap', 0.1, [0], { preRolls: [1, 2, 0], echoTails: [false, true] })
    add('bassSwap', 0.15, [16, 8, 4])
    add('filterBuild', 0.12, [8, 4])
    add('crossfade', 0, [8])
    add('echoOut', 0.05)
    add('hardCut', 0)
    add('brake', -0.2)
  } else {
    add('dropSwap', 0.08, [0], { preRolls: [0], echoTails: [false, true] })
    add('echoOut', 0.12)
    add('hardCut', 0.05)
    add('filterBuild', 0.05, [2])
    add('brake', -0.08)
    add('fadeOut', -0.05, [2])
  }
  if (!forced) return list
  const chosen = list.filter((v) => v.preset === forced)
  if (chosen.length > 0) return chosen.map((v) => ({ ...v, prior: 0 }))
  // A technique this style doesn't use on its own: plain defaults.
  const bars = FREE_LENGTH.has(forced) ? (synced ? [16, 8, 4] : [2]) : [0]
  return bars.map((n) => ({ preset: forced, bars: n, swapFraction: 0.5, preRollBars: forced === 'dropSwap' && synced ? 1 : 0, echoTail: false, meet: meetOf(forced), prior: 0 }))
}

/** What a shape sounds like over its length, sampled once and reused for every placement. */
interface ShapeStats {
  shape: PresetShape
  /** Seconds per beat of A the shape was built with. */
  beat: number
  anchorA: number
  anchorB: number
  /** The echo on A, if the shape has one: its delay in seconds and feedback. */
  echo: { delay: number; feedback: number } | null
  dt: number
  voiceA: Float32Array
  voiceB: Float32Array
  gainA: Float32Array
  gainB: Float32Array
  /** A is gone (gain ≤ 0.05) from here on; B is there (gain > 0.05) from here on. */
  aGone: number
  bHere: number
  /** From here on a voice on B is heard (before it, B's build may play under A with its voice band down). */
  bVoice: number
  /**
   * Seconds both decks are clearly audible; of those, with both mid bands (chords, leads: the harmony) heard; with both
   * basslines up (must be 0).
   */
  together: number
  /** The stretch (transition time) where both decks are clearly audible: first and last such moment. */
  togetherFrom: number
  togetherTo: number
  tonal: number
  basses: number
}

const filterDamp = (f: number) => (Math.abs(f) <= 0.4 ? 1 : 1 - ((Math.abs(f) - 0.4) / 0.6) * 0.7)
const bassThrough = (f: number) => (f > 0.5 ? 0.3 : 1)

/**
 * How loud a voice on a deck comes through: gain x the louder of the mid band (its body) and the high band (its air
 * and consonants, which carry a voice on their own), damped by a closed filter.
 */
const voiceLevel = (automation: DeckAutomation, t: number, gain: number, filter: number) =>
  gain * Math.max(valueAt(automation.mid, t, 1), valueAt(automation.high, t, 1)) * filterDamp(filter)

export function sampleShape(a: DeckAutomation, b: DeckAutomation, length: number) {
  const steps = length > 0 ? Math.min(800, Math.max(2, Math.ceil(length / 0.04))) : 0
  const dt = steps > 0 ? length / steps : 0
  const voiceA = new Float32Array(steps + 1)
  const voiceB = new Float32Array(steps + 1)
  const gainA = new Float32Array(steps + 1)
  const gainB = new Float32Array(steps + 1)
  let aGone = 0
  let bHere = -1
  let bVoice = -1
  let together = 0
  let togetherFrom = -1
  let togetherTo = -1
  let tonal = 0
  let basses = 0
  for (let i = 0; i <= steps; i++) {
    const t = i * dt
    const ga = valueAt(a.gain, t, 1)
    const gb = valueAt(b.gain, t, 1)
    const fa = valueAt(a.filter, t, 0)
    const fb = valueAt(b.filter, t, 0)
    voiceA[i] = voiceLevel(a, t, ga, fa)
    voiceB[i] = voiceLevel(b, t, gb, fb)
    gainA[i] = ga
    gainB[i] = gb
    if (ga > 0.05) aGone = t + dt
    if (gb > 0.05 && bHere < 0) bHere = t
    if (voiceB[i] > VOICE_HEARD && bVoice < 0) bVoice = t
    if (i < steps) {
      if (ga > 0.2 && gb > 0.2) {
        together += dt
        if (togetherFrom < 0) togetherFrom = t
        togetherTo = t + dt
      }
      if (ga * valueAt(a.mid, t, 1) * filterDamp(fa) > VOICE_HEARD && gb * valueAt(b.mid, t, 1) * filterDamp(fb) > VOICE_HEARD) tonal += dt
      if (ga * valueAt(a.low, t, 1) * bassThrough(fa) > 0.5 && gb * valueAt(b.low, t, 1) * bassThrough(fb) > 0.5) basses += dt
    }
  }
  return { dt, voiceA, voiceB, gainA, gainB, aGone: Math.min(aGone, length), bHere: Math.max(0, bHere < 0 ? length : bHere), bVoice: Math.max(0, bVoice < 0 ? length : bVoice), together, togetherFrom: Math.max(0, togetherFrom), togetherTo: Math.max(0, togetherTo), tonal, basses }
}

function shapeStats(shape: PresetShape, meet: Variant['meet'], beat: number): ShapeStats {
  const sampled = sampleShape(shape.a, shape.b, shape.length)
  const anchorA = meet === 'swap' ? shape.swap : shape.anchorA
  const anchorB = meet === 'swap' ? shape.swap : shape.anchorB
  const effect = shape.effects.find((e) => e.kind === 'echo' && e.deck === 'a')
  const echo = effect?.kind === 'echo' ? { delay: effect.beats * beat, feedback: effect.feedback } : null
  return { shape, beat, anchorA, anchorB, echo, ...sampled }
}

/**
 * How loud A's singing comes back through its echo at each sample: what went into the echo k delays earlier, at
 * feedback^k (the echo sits after A's gain, so it rings on after A's dry signal is gone).
 */
function echoedVoice(stats: ShapeStats, a: PreparedTrack, aOut: number): Float32Array | null {
  const { echo, dt } = stats
  if (!echo || echo.delay <= 0 || dt <= 0) return null
  const level = new Float32Array(stats.voiceA.length)
  for (let i = 0; i < level.length; i++) {
    let gain = echo.feedback
    for (let k = 1; gain >= ECHO_HEARD; k++, gain *= echo.feedback) {
      const j = Math.round((i * dt - k * echo.delay) / dt)
      if (j < 0) break
      if (spanAt(a.vocals, aOut + j * dt)) level[i] = Math.max(level[i], gain * stats.voiceA[j])
    }
  }
  return level
}

/** Seconds of singing heard over each other, and of each song's singing lost (muffled, cut mid-line, entered mid-line). */
function vocalCost(stats: ShapeStats, a: PreparedTrack, b: PreparedTrack, aOut: number, bIn: number, rate: number) {
  const { shape, dt } = stats
  let clash = 0
  let lostA = 0
  let lostB = 0
  const length = shape.length
  if (length > 0 && (spansTouch(a.vocals, aOut, aOut + length) || spansTouch(b.vocals, bIn, bIn + length * rate))) {
    const echoed = echoedVoice(stats, a, aOut)
    let ia = 0
    let ib = 0
    for (let i = 0; i < stats.voiceA.length - 1; i++) {
      const t = i * dt
      const ta = aOut + t
      const tb = bIn + t * rate
      while (ia < a.vocals.length && a.vocals[ia].end <= ta) ia++
      while (ib < b.vocals.length && b.vocals[ib].end <= tb) ib++
      const aSings = ia < a.vocals.length && a.vocals[ia].start <= ta
      const bSings = tb >= 0 && ib < b.vocals.length && b.vocals[ib].start <= tb
      const aHeard = stats.voiceA[i] > VOICE_HEARD
      const bHeard = stats.voiceB[i] > VOICE_HEARD
      if (bSings && bHeard && ((aSings && aHeard) || (echoed !== null && echoed[i] >= ECHO_HEARD))) clash += dt
      if (aSings && !aHeard && stats.gainA[i] > 0.05) lostA += dt
      // B's singing under A before its voice comes in (a pre-roll) is a tease, not a line lost.
      if (bSings && !bHeard && t >= stats.bVoice) lostB += dt
    }
  }
  // A's line still going when A is gone; B coming in on the middle of a line.
  const aLeaves = aOut + stats.aGone
  const lineA = spanAt(a.vocals, aLeaves)
  if (lineA && lineA.end - aLeaves > 0.3 && aLeaves - lineA.start > 0.3) lostA += Math.min(6, lineA.end - aLeaves)
  const bVoiceIn = bIn + stats.bVoice * rate
  const lineB = spanAt(b.vocals, bVoiceIn)
  if (lineB && bVoiceIn - lineB.start > 0.3) lostB += Math.min(6, bVoiceIn - lineB.start)
  return { clash, lostA, lostB }
}

/**
 * Between drop swaps that fit equally well, B's build-up under A (which only a beatmatch allows) gets a small lead; the
 * dry cut and the echo tail are left to the per-pair nudge below, so a party playlist gets all three.
 */
function variety(variant: Variant, synced: boolean) {
  if (variant.preset !== 'dropSwap') return 0
  if (variant.preRollBars > 0) return synced ? 0.03 : 0
  return 0
}

/** A small, stable per-pair nudge so near-equal choices don't always fall the same way across a playlist. */
function jitter(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return ((hash >>> 0) / 4294967296) * 0.03
}

/** The beat `count` beats before `anchor` (which must be one of the song's beats), or null. */
function beatsBack(track: PreparedTrack, anchor: number, count: number): number | null {
  const i = floorIndex(track.beats, anchor + 0.05)
  if (i < 0 || Math.abs(track.beats[i] - anchor) > 0.05 || i - count < 0) return null
  return track.beats[i - count]
}

/**
 * How far B's beats sit from A's while both are heard, with B at `rate` from `bIn`: the median and the 90th percentile
 * (seconds). In double time (B's beat half of A's) B's off-beats fall between A's beats, which counts as on the beat.
 * Where A has no beat within half a beat (a beatless break, or beats the analysis lost) the match can't be checked;
 * `checked` is the share of B's beats that could be. `worstWindow`: the largest mean offset over any two bars.
 */
function phaseError(stats: ShapeStats, a: PreparedTrack, b: PreparedTrack, aOut: number, bIn: number, rate: number, multiple: number) {
  const { dt } = stats
  const length = stats.shape.length
  const offsets: number[] = []
  // Signed offsets summed per window of two bars of A: a song whose tempo drifts can line up on average and still
  // run a bar or two late somewhere, which is what the ear hears.
  const window = 8 * stats.beat
  const sums = new Map<number, { sum: number; count: number }>()
  let heard = 0
  if (dt <= 0) return { median: 0, p90: 0, checked: 1, worstWindow: 0 }
  for (let k = Math.max(0, floorIndex(b.beats, Math.max(0, bIn)) + 1); k < b.beats.length && b.beats[k] <= bIn + length * rate; k++) {
    const t = (b.beats[k] - bIn) / rate
    const i = Math.round(t / dt)
    if (i < 0 || i >= stats.gainA.length || stats.gainA[i] < 0.2 || stats.gainB[i] < 0.2) continue
    const ta = aOut + t
    heard++
    // Positive: B's beat comes after A's.
    let signed = ta - nearest(a.beats, ta)
    if (multiple === 0.5 && Math.abs(signed) > stats.beat / 4) signed -= Math.sign(signed) * (stats.beat / 2)
    const offset = Math.abs(signed)
    if (offset >= stats.beat * 0.45) continue
    offsets.push(offset)
    const w = Math.floor(t / window)
    const entry = sums.get(w) ?? { sum: 0, count: 0 }
    entry.sum += signed
    entry.count++
    sums.set(w, entry)
  }
  if (offsets.length === 0) return { median: 0, p90: 0, checked: heard === 0 ? 1 : 0, worstWindow: 0 }
  offsets.sort((p, q) => p - q)
  let worstWindow = 0
  for (const { sum, count } of sums.values()) if (count >= 3) worstWindow = Math.max(worstWindow, Math.abs(sum / count))
  return { median: offsets[offsets.length >> 1], p90: offsets[Math.floor(offsets.length * 0.9)], checked: offsets.length / heard, worstWindow }
}

interface Placement {
  stats: ShapeStats
  variant: Variant
  aOut: number
  bIn: number
  rate: number
  bound: number
  /** Beats of both decks sound together, so the placement's beatmatch is checked. */
  beatmatched: boolean
  /** Seconds of measured singing the placement skips (A's after it's gone, B's before its voice comes in). */
  sung: number
  /** For a beatmatch: the least clear attacks of both songs where the decks sound together (NaN: not measured). */
  clarity: number
  pa: Anchor
  pb: Anchor
}

function emptyAutomation(): DeckAutomation {
  return { gain: [], low: [], mid: [], high: [], filter: [] }
}

/** Clamps a transition into a valid one: times inside both songs, length ≥ 0, keyframes sorted inside [0, length]. */
export function finalizeTransition(transition: Transition, aDuration: number, bDuration: number): Transition {
  const finite = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback)
  const aEnd = Number.isFinite(aDuration) && aDuration > 0 ? aDuration : 0
  const bEnd = Number.isFinite(bDuration) && bDuration > 0 ? bDuration : Infinity
  const aOut = Math.min(aEnd, Math.max(0, finite(transition.aOut, aEnd)))
  const length = Math.min(Math.max(0, finite(transition.length, 0)), aEnd - aOut)
  // B may start up to 2 s after the transition (negative bIn) and must still be playing when the overlap ends.
  const rate = length > 0 && Number.isFinite(transition.rate) && transition.rate >= 0.5 && transition.rate <= 2 ? transition.rate : 1
  const bIn = Math.max(MIN_B_IN, Math.min(finite(transition.bIn, 0), Number.isFinite(bEnd) ? Math.max(0, bEnd - 1 - length * rate) : Infinity))
  const deck = (automation: DeckAutomation): DeckAutomation => {
    if (length === 0) return emptyAutomation()
    const fix = (list: DeckAutomation['gain'], min: number) =>
      keyframes(
        (Array.isArray(list) ? list : []).map((k): [number, number] => [k.t, k.v]),
        length,
        min,
        1,
      )
    return { gain: fix(automation.gain, 0), low: fix(automation.low, 0), mid: fix(automation.mid, 0), high: fix(automation.high, 0), filter: fix(automation.filter, -1) }
  }
  const effects = (Array.isArray(transition.effects) ? transition.effects : []).filter(
    (e) => length > 0 && Number.isFinite(e.at) && e.at >= 0 && e.at <= length,
  )
  return {
    ...transition,
    v: 1,
    aOut: round(aOut),
    bIn: round(bIn),
    length: round(length),
    rate: Math.round(rate * 10000) / 10000,
    a: deck(transition.a),
    b: deck(transition.b),
    effects,
    confidence: Math.round(Math.min(1, Math.max(0, finite(transition.confidence, 0))) * 100) / 100,
    tempo: { a: validTempo(transition.tempo?.a), b: validTempo(transition.tempo?.b) },
  }
}

const round = (t: number) => Math.round(t * 1000) / 1000

/** How late B may start after the transition began (the contract's negative `bIn`). */
export const MIN_B_IN = -2

/** The tempo a transition is counted in when a song's tempo isn't known. */
const DEFAULT_TEMPO = 120

const validTempo = (bpm: unknown) => (typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? Math.round(bpm * 100) / 100 : DEFAULT_TEMPO)

/** A song's tempo as the plan used it: from its beat grid, else the analysed BPM, else 120. */
function tempoOf(track: PreparedTrack | null) {
  if (!track) return DEFAULT_TEMPO
  return validTempo(track.grid ? track.bpm : track.mix.bpm)
}

/** Back to back: A plays to its end, B from its start. */
function backToBack(
  ids: { from: string; to: string },
  style: MixStyle,
  aDuration: number,
  confidence: number,
  tempo = { a: DEFAULT_TEMPO, b: DEFAULT_TEMPO },
): Transition {
  return {
    v: 1,
    from: ids.from,
    to: ids.to,
    style,
    preset: 'none',
    aOut: Number.isFinite(aDuration) && aDuration > 0 ? aDuration : 0,
    bIn: 0,
    length: 0,
    rate: 1,
    a: emptyAutomation(),
    b: emptyAutomation(),
    effects: [],
    custom: false,
    confidence,
    tempo,
  }
}

/**
 * The safe transition when the beat grid of either song can't be trusted: a few seconds' plain crossfade over A's last
 * audible moments into B's first audible one.
 */
function safeCrossfade(a: PreparedTrack | null, b: PreparedTrack | null, ids: { from: string; to: string }, style: MixStyle): Transition {
  const tempo = { a: tempoOf(a), b: tempoOf(b) }
  if (!a) return backToBack(ids, style, NaN, 0, tempo)
  const wanted = style === 'party' ? 3 : 5
  const length = Math.max(0, Math.min(wanted, a.duration * 0.2, b ? b.duration * 0.2 : wanted))
  if (length < 0.5) return finalizeTransition(backToBack(ids, style, a.duration, 0.3, tempo), a.duration, b?.duration ?? NaN)
  const shape = plainCrossfade(length)
  // Let the fade run into A's tail (fade-out or silence) by half its length, but never past the song's end.
  const aOut = Math.max(0, Math.min(a.duration - length, a.end - length / 2))
  const bIn = b ? Math.max(0, Math.min(b.start, b.duration * 0.25) - length / 4) : 0
  const transition: Transition = {
    v: 1,
    from: ids.from,
    to: ids.to,
    style,
    preset: 'crossfade',
    aOut,
    bIn,
    length,
    rate: 1,
    a: shape.a,
    b: shape.b,
    effects: [],
    custom: false,
    confidence: a.grid || (b?.grid ?? false) ? 0.4 : 0.3,
    tempo,
  }
  return finalizeTransition(transition, a.duration, b?.duration ?? NaN)
}

/** A plain crossfade of a few seconds at A's end, for a song without analysis yet. */
export function planFallback(fromId: string, toId: string, aDuration: number, style: MixStyle = 'clean'): Transition {
  const ids = { from: fromId, to: toId }
  if (!Number.isFinite(aDuration) || aDuration <= 0) return backToBack(ids, style, NaN, 0)
  const length = Math.min(style === 'party' ? 3 : 4, aDuration * 0.2)
  if (length < 0.5) return backToBack(ids, style, aDuration, 0.3)
  const shape = plainCrossfade(length)
  return finalizeTransition(
    {
      v: 1,
      from: fromId,
      to: toId,
      style,
      preset: 'crossfade',
      aOut: aDuration - length,
      bIn: 0,
      length,
      rate: 1,
      a: shape.a,
      b: shape.b,
      effects: [],
      custom: false,
      confidence: 0.3,
      tempo: { a: DEFAULT_TEMPO, b: DEFAULT_TEMPO },
    },
    aDuration,
    NaN,
  )
}

/** Plans the transition from A into B. */
export function planTransition(
  aMix: TrackMix | null,
  bMix: TrackMix | null,
  ids: { from: string; to: string },
  style: MixStyle,
  opts: PlanOptions = {},
): Transition {
  const a = prepareTrack(aMix)
  const b = prepareTrack(bMix)
  if (!a || !b || !a.grid || !b.grid) return safeCrossfade(a, b, ids, style)
  const tempoUsed = { a: tempoOf(a), b: tempoOf(b) }
  if (opts.preset === 'none') return finalizeTransition(backToBack(ids, style, a.duration, 0.9, tempoUsed), a.duration, b.duration)

  const tempo = matchTempo(a, b)
  const harmony = harmonicScore(a, b)
  const minConfidence = Math.min(a.bpmConfidence, b.bpmConfidence)
  const forced = opts.preset && opts.preset !== 'auto' ? opts.preset : undefined

  // How long the decks may play together: shorter when the fit is loose or the analysis unsure.
  let maxBars = 32
  if (!a.vocalsKnown || !b.vocalsKnown) maxBars = 8
  if (Math.min(a.keyClarity, b.keyClarity) < 0.3) maxBars = Math.min(maxBars, 16)
  if (tempo.diff > 0.03) maxBars = Math.min(maxBars, 16)
  if (tempo.diff > 0.045 || harmony < 0.4) maxBars = Math.min(maxBars, 8)
  let targetBars = style === 'party' ? 8 : 16
  if (style === 'clean' && tempo.diff < 0.015 && harmony >= 0.85 && minConfidence >= 0.7) targetBars = 32
  if (style === 'clean' && (tempo.diff > 0.03 || harmony < 0.6)) targetBars = 8
  targetBars = Math.min(targetBars, maxBars)

  const variants = variantsFor(style, tempo.synced, maxBars, forced)
  const outs = outAnchors(a, style)
  const ins = inAnchors(b, style)
  const party = style === 'party'
  const placements: Placement[] = []
  const shapes = new Map<string, ShapeStats>()

  // Vocals estimated from the audio (no synced lyrics) count for less: they also catch leads and synths.
  // Assumed vocals (nothing measured: one span over the song's body) have no lines to cut, so they don't count here.
  const vocalTrust = (track: PreparedTrack) => (!track.vocalsKnown ? 0 : track.mix.vocalSource === 'lyrics' ? 1 : 0.6)
  const trustA = vocalTrust(a)
  const trustB = vocalTrust(b)

  const shapeFor = (variant: Variant, beat: number) => {
    // Half time: B's bar spans two of A's, so the swap goes on an even bar of A.
    const rawSwap = variant.bars * variant.swapFraction
    const swapBar = tempo.synced && tempo.multiple === 2 ? 2 * Math.round(rawSwap / 2) : Math.round(rawSwap)
    const key = `${variant.preset}:${variant.bars}:${swapBar}:${variant.preRollBars}:${variant.echoTail}:${variant.meet}:${beat.toFixed(5)}`
    let stats = shapes.get(key)
    if (!stats) {
      const shape = presetShape(variant.preset, {
        beat,
        bars: variant.bars,
        synced: tempo.synced,
        swapBar,
        preRollBars: variant.preRollBars,
        echoTail: variant.echoTail,
      })
      stats = shapeStats(shape, variant.meet, beat)
      shapes.set(key, stats)
    }
    return stats
  }

  for (const pa of outs) {
    const localBeat = periodAt(a, pa.t)
    for (const variant of variants) {
      let stats = shapeFor(variant, localBeat)
      if (stats.basses > 0.001) continue
      // A's phrase start lands exactly on the shape's anchor: aOut is counted back in A's own beats and the shape is
      // stretched to the length those beats really have (the beats follow the music, not a fixed tempo).
      let aOut = pa.t - stats.anchorA
      if (stats.anchorA > 0) {
        const count = Math.round(stats.anchorA / localBeat)
        const back = Math.abs(stats.anchorA / localBeat - count) <= 0.15 ? beatsBack(a, pa.t, count) : null
        const beat = back !== null ? (pa.t - back) / count : NaN
        if (back !== null && Math.abs(beat / localBeat - 1) < 0.1) {
          stats = shapeFor(variant, beat)
          aOut = back
        }
      }
      const length = stats.shape.length
      if (aOut < 0 || aOut + length > a.duration) continue
      // The part of A that plays on after the transition starts must be A's own, not skipped too early.
      if (aOut + stats.aGone < a.duration * (party ? 0.45 : 0.6)) continue
      const beatsTogether = stats.together > 2 * stats.beat
      // A's tempo over the overlap itself, which is what B's rate has to match.
      const periodA = length > 0 ? periodOver(a, aOut, aOut + length) : stats.beat

      for (const pb of ins) {
        // B beatmatched: its rate from both songs' beats over the very stretch they overlap (a song's tempo drifts:
        // an outro may run slower than the song's average). Too far apart there: no beatmatch for this placement.
        let rate = 1
        if (tempo.synced && beatsTogether) {
          const guess = periodAt(b, pb.t) / (tempo.multiple * periodA)
          const from = pb.t - stats.anchorB * guess
          rate = periodOver(b, from, from + length * guess) / (tempo.multiple * periodA)
          if (Math.abs(rate - 1) > MAX_TEMPO_DIFF) continue
        }
        // A beatmatch needs clear attacks on both songs wherever their beats sound together: in a soft outro or a pad
        // intro the beats can't be heard to line up. Without the measure (older analyses) only a short one is risked.
        let clarity = NaN
        if (tempo.synced && beatsTogether) {
          const bStart = pb.t - stats.anchorB * rate
          clarity = Math.min(
            a.clarityBetween(aOut + stats.togetherFrom, aOut + stats.togetherTo),
            b.clarityBetween(bStart + stats.togetherFrom * rate, bStart + stats.togetherTo * rate),
          )
          if (Number.isNaN(clarity) ? stats.together > 16 * stats.beat : clarity < MIN_CLARITY) continue
        }
        // B's phrase start meets A's exactly; B may start up to two seconds late when it lies too close to its start.
        const bIn = pb.t - stats.anchorB * rate
        if (bIn < -2) continue
        if (bIn + length * rate > b.duration - 2) continue
        const bEnters = bIn + stats.bHere * rate
        if (party && bEnters > b.duration * 0.6) continue

        // What's known without sampling the vocals: an upper bound of the final score.
        const aLeaves = aOut + stats.aGone
        const skipA = a.loudSeconds(aLeaves, a.end)
        const skipB = b.loudSeconds(b.start, bEnters)
        let bound = variant.prior + variety(variant, tempo.synced) + jitter(`${ids.from}>${ids.to}:${variant.preset}:${variant.preRollBars}:${variant.echoTail}`)
        bound += pa.bonus + pb.bonus
        if (FREE_LENGTH.has(variant.preset)) bound -= 0.12 * Math.abs(Math.log2(variant.bars / targetBars))
        if (party) {
          // Cutting intros and outros is the point; cutting away much more than that (a whole last chorus) is not.
          bound -= 0.015 * Math.max(0, skipA - a.duration * 0.25) + 0.01 * Math.max(0, skipB - b.duration * 0.3)
          if (variant.preset === 'dropSwap') {
            // A drop swap is made for B's drop; onto a chorus it still works, onto anything else it's just a cut.
            if (pb.drop) bound += 0.35
            else if (pb.chorus) bound += 0.05
            else bound -= 0.2
            if (pa.drop) bound += 0.1
          }
        } else {
          bound -= 0.03 * (skipA + skipB)
        }
        const energyA = a.energyBetween(aLeaves - 8, aLeaves)
        const energyB = b.energyBetween(bIn + length * rate, bIn + length * rate + 8)
        if (party) {
          const fall = Math.max(0, energyA - energyB - 0.1)
          bound -= (variant.preset === 'echoOut' || variant.preset === 'brake' ? 0.3 : 0.6) * fall
          if (variant.preset === 'dropSwap' && energyB < 0.6) bound -= 0.3
        } else {
          bound -= 0.5 * Math.abs(energyA - energyB)
        }
        // Keys clash where both decks' mids (chords, leads, voices) sound together; the bass never overlaps.
        bound -= (1 - harmony) * 0.6 * Math.min(1, stats.tonal / (16 * stats.beat))
        // Singing that's skipped: A's lines after it's gone, B's before its voice comes in. Clean keeps every sung line
        // (whatever the sections are called); party may cut some, at a price.
        const sungA = trustA * a.sungSeconds(aLeaves, a.duration)
        const sungB = trustB * b.sungSeconds(0, bIn + stats.bVoice * rate)
        bound -= party ? 0.02 * sungA + 0.01 * sungB : 0.3 * (sungA + sungB)
        if (!tempo.synced && NEEDS_BEATMATCH.has(variant.preset)) bound -= 0.2 * Math.min(1, stats.together / (4 * stats.beat))
        placements.push({ stats, variant, aOut, bIn, rate, bound, beatmatched: tempo.synced && beatsTogether, sung: sungA + sungB, clarity, pa, pb })
      }
    }
  }

  // Best-first with the vocal checks; stop when no remaining placement can beat the best one.
  placements.sort((p, q) => q.bound - p.bound)
  const lostWeight = party ? 0.05 : 0.1
  let best: { placement: Placement; score: number } | null = null
  for (const placement of placements) {
    if (best && placement.bound <= best.score) break
    // Clean style never skips a sung line: such a placement is out.
    if (!party && placement.sung > 0.5) continue
    const { clash, lostA, lostB } = vocalCost(placement.stats, a, b, placement.aOut, placement.bIn, placement.rate)
    if (clash > 0.1) continue
    // Beats that drift apart flam audibly from about 25 ms on (and a stretch of the overlap may drift worse than the
    // middle): such a placement is out, a smaller drift costs a little. So is one whose match can't mostly be checked
    // against A's beats (unsure: the safe techniques remain).
    const drift = placement.beatmatched
      ? phaseError(placement.stats, a, b, placement.aOut, placement.bIn, placement.rate, tempo.multiple)
      : { median: 0, p90: 0, checked: 1, worstWindow: 0 }
    // Judged two bars at a time too: a stretch where B runs late flams even when the whole lines up on average. A
    // longer overlap that drifts loses here; a shorter variant of it, or a technique without beatmatch, takes over.
    if (drift.median > MAX_DRIFT || drift.p90 > 2.5 * MAX_DRIFT || drift.checked < 0.75 || drift.worstWindow > MAX_WINDOW_DRIFT) continue
    const score = placement.bound - lostWeight * (trustA * Math.min(8, lostA) + trustB * Math.min(8, lostB)) - drift.median
    if (!best || score > best.score) best = { placement, score }
  }
  // Back to back is always clean: when nothing fits (odd phrase data, songs too short for any overlap, or in clean
  // style a song that sings into its last seconds, so every overlap would cut a line).
  if (!best) {
    return finalizeTransition(backToBack(ids, style, a.duration, 0.5, tempoUsed), a.duration, b.duration)
  }

  const { placement } = best
  // The louder song comes down by the loudness difference while both play (both analyses must have measured it).
  const louder = Number.isFinite(a.mix.loudness) && Number.isFinite(b.mix.loudness) ? a.mix.loudness - b.mix.loudness : 0
  const shape = matchLevels(placement.stats.shape, placement.stats.beat, louder)
  const overlapping = shape.length > 0
  let confidence = 0.9
  if (tempo.synced && overlapping) confidence *= 0.55 + 0.45 * minConfidence
  else confidence *= 0.6 + 0.3 * minConfidence
  if (placement.stats.tonal > 4 * placement.stats.beat) confidence *= 0.7 + 0.3 * harmony
  if (!a.vocalsKnown || !b.vocalsKnown) confidence *= 0.85
  if (!tempo.synced && NEEDS_BEATMATCH.has(shape.preset)) confidence *= 0.6
  if (placement.beatmatched) confidence *= Number.isNaN(placement.clarity) ? 0.8 : 0.7 + 0.3 * placement.clarity

  return finalizeTransition(
    {
      v: 1,
      from: ids.from,
      to: ids.to,
      style,
      preset: shape.preset,
      aOut: placement.aOut,
      bIn: placement.bIn,
      length: shape.length,
      rate: overlapping ? placement.rate : 1,
      a: shape.a,
      b: shape.b,
      effects: shape.effects,
      custom: false,
      confidence,
      tempo: tempoUsed,
    },
    a.duration,
    b.duration,
  )
}

/**
 * What a transition does against the two songs' analyses: seconds where both voices are heard, where both basslines
 * are up. For the editor's warnings and for tests; 0 and 0 is what the planner promises.
 */
export function transitionIssues(transition: Transition, aMix: TrackMix | null, bMix: TrackMix | null) {
  const a = prepareTrack(aMix)
  const b = prepareTrack(bMix)
  const sampled = sampleShape(transition.a, transition.b, transition.length)
  let voices = 0
  if (a && b && transition.length > 0) {
    const dt = sampled.dt
    const effect = transition.effects.find((e) => e.kind === 'echo' && e.deck === 'a')
    const beat = 60 / (transition.tempo?.a || DEFAULT_TEMPO)
    const stats: ShapeStats = {
      shape: { preset: 'crossfade', length: transition.length, a: transition.a, b: transition.b, effects: transition.effects, anchorA: 0, anchorB: 0, swap: 0 },
      beat,
      anchorA: 0,
      anchorB: 0,
      echo: effect?.kind === 'echo' ? { delay: effect.beats * beat, feedback: effect.feedback } : null,
      ...sampled,
    }
    const echoed = echoedVoice(stats, a, transition.aOut)
    for (let i = 0; i < sampled.voiceA.length - 1; i++) {
      const t = i * dt
      const tb = transition.bIn + t * transition.rate
      if (sampled.voiceB[i] <= VOICE_HEARD || tb < 0 || !spanAt(b.vocals, tb)) continue
      const direct = sampled.voiceA[i] > VOICE_HEARD && spanAt(a.vocals, transition.aOut + t)
      if (direct || (echoed !== null && echoed[i] >= ECHO_HEARD)) voices += dt
    }
  }
  return { voices, basses: sampled.basses }
}
