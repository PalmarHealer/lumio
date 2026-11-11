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
import { deckPosition, laneBeats, lanePosition, laneReach, laneStretches, rateAdvance, type Lane } from './timeline.ts'
import type { DeckAutomation, DeckSegment, Keyframe, MixStyle, PresetId, TrackMix, Transition } from './types.ts'

/**
 * Plans the transition from one song into the next the way a DJ would, from both songs' whole-track analysis.
 *
 * It tries many placements and keeps the one that scores best:
 * - Where: a phrase start of A where A goes out and a phrase start of B where B comes in, lined up so both songs'
 *   phrases (and bars) meet. In clean style the songs play (nearly) in full and the overlap sits in A's outro and B's
 *   intro; in party style A leaves after its last chorus or drop (`cuesOut`) and B arrives on its drop, chorus or the
 *   end of its intro (`cuesIn`), so intros and outros are cut.
 * - How: by default the long blend (16 bars in party style, 16 or 32 in clean): B fades in under a filter, the bass
 *   changes deck on the middle phrase, A's bands taper and A stops at the end. Neither song may run into singing or a
 *   drop meanwhile, so the planner loops instrumental bars of A's outro and/or B's intro (4 or 8 bars, at most 16 bars
 *   of the same material) to make the window long enough. A drop swap only comes as a long pre-roll (8 bars of B's
 *   build-up under A). Songs whose tempos can't be matched get an echo out or a filtered fade, never a cut.
 * - Tempo: within 6 % (straight, half or double time) both decks meet in the middle: A glides to the meeting tempo over
 *   the two bars before B comes in, B starts there and glides back to its own tempo over the 8 bars after A is gone
 *   (each deck at most 3 % off its own tempo, pitch kept). B's beats are then fitted onto A's (least squares over
 *   the overlap), and the beatmatch is checked beat by beat and two bars at a time.
 * - Hard rules: never two voices at once (checked against both songs' vocals along their paths, A's echo included),
 *   never two basslines at once (the shapes swap the lows in one step), clean style never skips a sung line, and a
 *   beatmatch only where both songs have clear attacks. A placement that breaks one is dropped.
 * - Preferences, as score terms: the length that suits the fit, keys that blend while both decks' mids sound, no vocal
 *   line cut, the energy not falling away (party) or jumping (clean), little of either song skipped (clean) or the
 *   good cue points used (party), few loops.
 *
 * The score splits into what's known from the placement alone and the checks that need sampling (vocals, beat phase);
 * placements are checked best-first and the search stops when no remaining one could beat the best found.
 *
 * Planning happens in A's own time (A at rate 1, B at the relative rate `rate`); the transition's clock follows from
 * it: during the overlap transition time = A's advance / A's rate, after the glide that comes before.
 */

export interface PlanOptions {
  /** Use this technique (the editor's preset menu, or switching one transition's style); the planner picks where. */
  preset?: PresetId
}

export interface TempoMatch {
  /** Beatmatched: B plays at `rate` (relative to A) during the overlap. */
  synced: boolean
  /** B's rate relative to A that puts its beats on A's (B's tempo × rate ≈ A's tempo × multiple). */
  rate: number
  /** How many of A's beats one beat of B spans: 1, 2 (B in half time) or 0.5 (B in double time). */
  multiple: number
  /** |rate − 1|. */
  diff: number
}

/** Tempo gap the two decks may bridge, each going at most half of it (3.5 %) towards the other. */
const MAX_TEMPO_DIFF = 0.07
const MIN_BPM_CONFIDENCE = 0.45
/** A voice (gain × the louder of mid and high band, damped by a closed filter) above this counts as heard. */
const VOICE_HEARD = 0.3
/**
 * An echoed voice over B's singing distracts even when quiet: its repeats count as heard down to this level (with the
 * usual feedback of 0.5, the first three repeats).
 */
const ECHO_HEARD = 0.12
/** Median distance (seconds) between both decks' beats above which a beatmatch is rejected. */
const MAX_DRIFT = 0.025
/** How far (seconds) aligning both grids may move B: more means the grids disagree where the songs meet. */
const MAX_PHASE_SHIFT = 0.04
/** Below this harmonic score the keys clash: both decks' tonal content may overlap for one beat at most. */
const KEY_CLASH = 0.5
/**
 * How much louder than the louder song's own loud parts the two decks may sound together, per band (dB, 95th
 * percentile over the overlap), and how far below them the overlap may sink on average before it's a hole.
 */
const MAX_OVER_DB = 1.8
/**
 * The same for a full overlap (both decks at full volume, the user's favourite Spotify blends of two full pop songs):
 * the master limiter catches true overs.
 */
const MAX_OVER_DB_OVERLAP = 3
const HOLE_DB = -6
/**
 * Swing (where the off-beat 16ths fall) further apart than this: a swung and a straight groove flam wherever both are
 * loud, so such a pair hands over with little both-loud time (a bass swap handover, the short S-curve).
 */
const SWING_CLASH = 0.05
/** Room (seconds) a blend's B gets to be moved earlier by the phase fit. */
const PHASE_SLACK = 0.05
/**
 * Below this attack clarity in the bars where both beats are loud, the alignment can't be verified at all; measured
 * with lag3 on the 25 songs, such beatmatches are where the flams are (9 at no floor, 1 at 0.4, for 13 fewer blends).
 */
const MIN_VERIFIABLE = 0.4
/** A deck's low band coming through at least this much (gain × EQ × filter): its kick is heard. */
const KICK_HEARD = 0.5
/** Clarity at which a beatmatch counts as fully verifiable (below it, a soft cost). */
const MIN_CLARITY = 0.6
/** Mean offset (seconds) between the decks' beats allowed in any two bars of a beatmatched overlap. */
const MAX_WINDOW_DRIFT = 0.025
/**
 * How often the same bars may play in a row: a 4-bar loop four times, an 8-bar loop twice. Sixteen bars of the same
 * material is where a listener stops hearing a held groove and starts hearing a song that's stuck.
 */
const MAX_LOOP_BARS = 16
/** Tempo corrections up to this are dropped (both decks at exactly 1) while the drift they leave stays under SNAP_DRIFT. */
const SNAP_RATE = 0.001
const SNAP_DRIFT = 0.005
/** Tempo corrections up to this go to B alone: the player resamples them (no stretcher), A plays bit-exact. */
const RESAMPLE_RATE = 0.003
/** Bars A glides to the meeting tempo before B comes in, and bars B glides back to its own after A is gone. */
const GLIDE_BARS_A = 2
const GLIDE_BARS_B = 8

/** Each deck may move 3.5 % at most: A at 1/√rate, B at √rate (meeting in the middle). */
const rateOk = (rate: number) => Math.abs(Math.sqrt(rate) - 1) <= MAX_TEMPO_DIFF / 2 && Math.abs(1 / Math.sqrt(rate) - 1) <= MAX_TEMPO_DIFF / 2

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
  return { synced: a.grid && b.grid && sure && rateOk(best.rate), rate: best.rate, multiple: best.multiple, diff }
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

/** Where A may go out: the phrase where the transition (or its swap) happens, or where a blend starts. */
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
 * Where B may come in: the phrase B's transition (or its swap) is lined up on, or where a blend has brought B fully in.
 * In party style the spots worth it are B's drops and its first choruses; a cue point only counts once B's first 8 bars
 * are behind (an entry at the very start skips nothing).
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
  if (!party && b.vocalsKnown && b.vocals.length > 0) {
    // Where B's singing starts: a clean blend brings B fully in there, with its whole intro under A.
    addAnchor(list, snapToPhrase(b, b.vocals[0].start), 0.05)
  }
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
  /** Blend: sweep the filters; swap the mids on the phrase instead of crossing them (keys that clash). */
  filter: boolean
  midSwap: boolean
  /** Blend: volume shape, where the bass changes deck, the filters in on B and out on A (see the blend preset). */
  volume?: 'overlap' | 'fade' | 'scurve'
  bassAt?: 'start' | 'middle' | 'none'
  filterIn?: 'hp' | 'lp' | null
  filterOut?: 'hp' | 'lp' | 'eq' | null
  /** Blend: bars of B played under A before B's event lands on A's boundary (the swap); the rest come after. */
  pre?: number
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

/**
 * The blend's layouts as a DJ (and the user's favourite Spotify transitions) uses them: mostly 8 bars with both decks
 * at full volume ("overlap"), also 4 and 16, the long fade over 16 bars, the seamless S-curve over 2. Which EQ and
 * filter it gets is chosen per placement (`blendFinishes`).
 */
const BLEND_LAYOUTS: Array<{ volume: 'overlap' | 'fade' | 'scurve'; pre: number; post: number; prior: number; party: boolean; clean: boolean }> = [
  // B's event lands on A's boundary after `pre` bars of B under A; A plays on, thinned, for `post` bars to its next
  // section, where it leaves. Pop: 4-bar phrases, 8-bar blends; dance music: 8 + 8 or more.
  // Preferred in that order: 8 bars (Spotify's most common), then 16, then 4; the 2-bar S-curve only when nothing longer
  // passes or the material is dense right at the boundary (its own energy term).
  { volume: 'overlap', pre: 4, post: 4, prior: 0, party: true, clean: true },
  { volume: 'overlap', pre: 0, post: 8, prior: 0, party: true, clean: true },
  { volume: 'overlap', pre: 8, post: 8, prior: -0.08, party: true, clean: true },
  { volume: 'overlap', pre: 0, post: 16, prior: -0.09, party: true, clean: true },
  { volume: 'fade', pre: 8, post: 8, prior: -0.1, party: true, clean: true },
  { volume: 'overlap', pre: 16, post: 8, prior: -0.12, party: false, clean: true },
  { volume: 'overlap', pre: 0, post: 4, prior: -0.16, party: true, clean: true },
  { volume: 'scurve', pre: 1, post: 1, prior: -0.28, party: true, clean: true },
]

/**
 * The EQ and filter finishes a blend can take, the common ones first (bass swap in the middle, high-pass in on B and
 * out on A). Keys that clash take the tonal swap at the middle instead of an overlap of mids.
 */
function blendFinishes(variant: Variant, clash: boolean): Variant[] {
  // The bass changes deck on the swap (A's boundary): 'start' when B's event opens the blend.
  const at: NonNullable<Variant['bassAt']> = (variant.pre ?? 0) === 0 ? 'start' : 'middle'
  if (variant.volume === 'scurve') return [{ ...variant, bassAt: 'middle', filterIn: null, filterOut: null, midSwap: clash }]
  const finishes: Array<[NonNullable<Variant['bassAt']>, Variant['filterIn'], Variant['filterOut'], number]> = [
    // The user's Spotify favourites mostly take a filter out on A (high-pass), in on B as well, or a low-pass pair.
    [at, null, 'hp', 0.05],
    [at, 'hp', 'hp', 0.045],
    [at, 'lp', 'lp', 0.04],
    [at, null, 'lp', 0.035],
    [at, null, 'eq', 0.03],
    ['none', null, null, 0],
  ]
  return finishes.map(([bassAt, filterIn, filterOut, prior]) => ({ ...variant, bassAt, filterIn, filterOut, midSwap: clash, prior: variant.prior + prior }))
}

/** The best prior any finish of a blend layout can add (so the bound stays an upper bound). */
const BEST_FINISH = 0.05

/**
 * Added to every blend's score: wherever a blend passes every rule it is chosen; echo outs and fades are the fallback
 * when none does.
 */
const BLEND_FIRST = 3

function variantsFor(style: MixStyle, synced: boolean, maxBars: number, forced?: ConcretePreset): Variant[] {
  const list: Variant[] = []
  const add = (preset: ConcretePreset, prior: number, bars: number[] = [0], extra: { preRolls?: number[] } = {}) => {
    const allowed = FREE_LENGTH.has(preset) ? bars.filter((n) => n <= maxBars) : bars
    const lengths = allowed.length > 0 ? allowed : [Math.min(...bars)]
    for (const n of lengths)
      for (const preRollBars of extra.preRolls ?? [0])
        list.push({ preset, bars: n, swapFraction: 0.5, preRollBars, filter: true, midSwap: false, meet: meetOf(preset), prior })
  }
  const addBlends = (prior: number) => {
    for (const layout of BLEND_LAYOUTS) {
      const bars = layout.pre + layout.post
      if (!(style === 'party' ? layout.party : layout.clean) || bars > maxBars) continue
      list.push({
        preset: 'blend',
        bars,
        pre: layout.pre,
        swapFraction: 0.5,
        preRollBars: 0,
        filter: true,
        midSwap: false,
        volume: layout.volume,
        bassAt: 'middle',
        filterIn: 'hp',
        filterOut: 'hp',
        meet: 'shape',
        prior: prior + layout.prior + BLEND_FIRST,
      })
    }
  }
  // Automatic transitions never cut: a cut has to be perfect to work. The blend is the transition to have wherever the
  // tempos can be matched and it passes every rule (its prior outweighs the score terms of a neat echo out); without a
  // match, an echo out or a filtered fade.
  if (style === 'clean' && synced) {
    addBlends(0.9)
    add('echoOut', 0)
    add('fadeOut', -0.02, [4])
  } else if (style === 'clean') {
    add('echoOut', 0.15)
    add('fadeOut', 0.12, [4])
    add('fadeIn', 0, [2])
  } else if (synced) {
    addBlends(0.75)
    add('echoOut', 0.05)
  } else {
    add('echoOut', 0.12)
    add('fadeOut', 0.05, [4])
  }
  if (!forced) return list
  const chosen = list.filter((v) => v.preset === forced)
  if (chosen.length > 0) return chosen.map((v) => ({ ...v, prior: v.preset === 'blend' ? v.prior - (style === 'clean' ? 0.9 : 0.75) - BLEND_FIRST : 0 }))
  // A technique this style doesn't use on its own (the editor's choice): plain defaults.
  const bars = FREE_LENGTH.has(forced) ? (synced ? [16, 8, 4] : [2]) : [0]
  if (forced === 'blend')
    return [{ preset: 'blend', bars: 8, pre: 4, swapFraction: 0.5, preRollBars: 0, filter: true, midSwap: false, volume: 'overlap', bassAt: 'middle', filterIn: 'hp', filterOut: 'hp', meet: 'shape', prior: 0 }]
  return bars.map((n) => ({
    preset: forced,
    bars: n,
    swapFraction: 0.5,
    preRollBars: forced === 'dropSwap' && synced ? 8 : 0,
    filter: true,
    midSwap: false,
    meet: meetOf(forced),
    prior: 0,
  }))
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
  /** Share of the moments with both decks' beats loud where both kicks (low bands) are up too. */
  kicksTogether: number
  /** The stretch where both decks are clearly audible: first and last such moment. */
  togetherFrom: number
  togetherTo: number
  /**
   * Per sample: the deck's beats are loud (volume and the band that carries them up, no strong filter). Only where both
   * are can beats be heard to flam.
   */
  loudA: Uint8Array
  loudB: Uint8Array
  /** Per sample and band: what of each deck comes through (gain × the band's EQ × the filter's pass). */
  passA: BandSamples
  passB: BandSamples
  tonal: number
  basses: number
  /**
   * Seconds both decks' tonal content is up together: gain × the louder of the mids and half the highs (the highs carry
   * melody too), filter applied, above 0.3 on both. Between clashing keys it may last one beat at most.
   */
  tonalBoth: number
}

interface BandSamples {
  low: Float32Array
  mid: Float32Array
  high: Float32Array
}

const filterDamp = (f: number) => (Math.abs(f) <= 0.4 ? 1 : 1 - ((Math.abs(f) - 0.4) / 0.6) * 0.7)
const bassThrough = (f: number) => (f > 0.5 ? 0.3 : 1)

/** How a filter knob passes each band: a high-pass takes the lows first, then the mids; a low-pass the highs first. */
function filterBands(f: number) {
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
  if (f >= 0) return { low: clamp01(1 - f / 0.4), mid: clamp01(1 - Math.max(0, f - 0.4) / 0.4), high: 1 }
  return { low: 1, mid: clamp01(1 - Math.max(0, -f - 0.4) / 0.4), high: clamp01(1 + f / 0.4) }
}

/**
 * An automation curve read at growing times (as valueAt: linear between keyframes, held outside, `fallback` when empty),
 * keeping its place instead of searching each time.
 */
function walker(curve: readonly Keyframe[], fallback: number) {
  let k = 0
  return (t: number) => {
    if (curve.length === 0) return fallback
    if (t <= curve[0].t) return curve[0].v
    const last = curve[curve.length - 1]
    if (t >= last.t) return last.v
    while (k + 1 < curve.length && curve[k + 1].t <= t) k++
    const p = curve[k]
    const q = curve[k + 1]
    return q.t > p.t ? p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t) : q.v
  }
}

export function sampleShape(a: DeckAutomation, b: DeckAutomation, length: number) {
  const steps = length > 0 ? Math.min(800, Math.max(2, Math.ceil(length / 0.04))) : 0
  const dt = steps > 0 ? length / steps : 0
  const voiceA = new Float32Array(steps + 1)
  const voiceB = new Float32Array(steps + 1)
  const gainA = new Float32Array(steps + 1)
  const gainB = new Float32Array(steps + 1)
  const loudA = new Uint8Array(steps + 1)
  const loudB = new Uint8Array(steps + 1)
  const bandSamples = (): BandSamples => ({ low: new Float32Array(steps + 1), mid: new Float32Array(steps + 1), high: new Float32Array(steps + 1) })
  const passA = bandSamples()
  const passB = bandSamples()
  let aGone = 0
  let bHere = -1
  let bVoice = -1
  let together = 0
  let togetherFrom = -1
  let togetherTo = -1
  let tonal = 0
  let tonalBoth = 0
  let basses = 0
  let loudBoth = 0
  let kicksBoth = 0
  // Every curve read once per sample, walking forward (the samples' times only grow).
  const curves = (d: DeckAutomation) => ({
    gain: walker(d.gain, 1),
    low: walker(d.low, 1),
    mid: walker(d.mid, 1),
    high: walker(d.high, 1),
    filter: walker(d.filter, 0),
  })
  const ca = curves(a)
  const cb = curves(b)
  for (let i = 0; i <= steps; i++) {
    const t = i * dt
    const ga = ca.gain(t)
    const gb = cb.gain(t)
    const fa = ca.filter(t)
    const fb = cb.filter(t)
    const la = ca.low(t)
    const lb = cb.low(t)
    const ma = ca.mid(t)
    const mb = cb.mid(t)
    const ha = ca.high(t)
    const hb = cb.high(t)
    const da = filterDamp(fa)
    const db = filterDamp(fb)
    const pa = filterBands(fa)
    const pb = filterBands(fb)
    // A voice comes through as gain × the louder of the mid band (its body) and the high band (its air and consonants,
    // which carry a voice on their own), damped by a closed filter. A deck's beats are loud where any band that carries
    // them is up to half (kick in the lows, snare in the mids, hats in the highs: each can flam on its own) and no
    // filter is past half.
    voiceA[i] = ga * Math.max(ma, ha) * da
    voiceB[i] = gb * Math.max(mb, hb) * db
    gainA[i] = ga
    gainB[i] = gb
    loudA[i] = Math.abs(fa) <= 0.5 && ga * Math.max(la, Math.max(ma, ha) * da) >= 0.5 ? 1 : 0
    loudB[i] = Math.abs(fb) <= 0.5 && gb * Math.max(lb, Math.max(mb, hb) * db) >= 0.5 ? 1 : 0
    passA.low[i] = ga * la * pa.low
    passA.mid[i] = ga * ma * pa.mid
    passA.high[i] = ga * ha * pa.high
    passB.low[i] = gb * lb * pb.low
    passB.mid[i] = gb * mb * pb.mid
    passB.high[i] = gb * hb * pb.high
    if (ga > 0.05) aGone = t + dt
    if (gb > 0.05 && bHere < 0) bHere = t
    if (voiceB[i] > VOICE_HEARD && bVoice < 0) bVoice = t
    if (i < steps) {
      if (ga > 0.2 && gb > 0.2) {
        together += dt
        if (togetherFrom < 0) togetherFrom = t
        togetherTo = t + dt
      }
      if (ga * ma * da > VOICE_HEARD && gb * mb * db > VOICE_HEARD) tonal += dt
      const bassA = ga * la * bassThrough(fa)
      const bassB = gb * lb * bassThrough(fb)
      if (bassA > 0.5 && bassB > 0.5) basses += dt
      // Tonal content: gain × max(mid, half the high), filtered (as tonalLevel).
      if (ga * Math.max(ma * pa.mid, 0.5 * ha * pa.high) > 0.3 && gb * Math.max(mb * pb.mid, 0.5 * hb * pb.high) > 0.3) tonalBoth += dt
      if (loudA[i] && loudB[i]) {
        loudBoth++
        if (bassA >= 0.5 && bassB >= 0.5) kicksBoth++
      }
    }
  }
  return {
    dt,
    voiceA,
    voiceB,
    gainA,
    gainB,
    loudA,
    loudB,
    passA,
    passB,
    aGone: Math.min(aGone, length),
    bHere: Math.max(0, bHere < 0 ? length : bHere),
    bVoice: Math.max(0, bVoice < 0 ? length : bVoice),
    together,
    togetherFrom: Math.max(0, togetherFrom),
    togetherTo: Math.max(0, togetherTo),
    tonal,
    basses,
    tonalBoth,
    kicksTogether: loudBoth > 0 ? kicksBoth / loudBoth : 0,
  }
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
function echoedVoice(stats: ShapeStats, a: PreparedTrack, positionA: (t: number) => number): Float32Array | null {
  const { echo, dt } = stats
  if (!echo || echo.delay <= 0 || dt <= 0) return null
  const level = new Float32Array(stats.voiceA.length)
  for (let i = 0; i < level.length; i++) {
    let gain = echo.feedback
    for (let k = 1; gain >= ECHO_HEARD; k++, gain *= echo.feedback) {
      const j = Math.round((i * dt - k * echo.delay) / dt)
      if (j < 0) break
      if (spanAt(a.vocals, positionA(j * dt))) level[i] = Math.max(level[i], gain * stats.voiceA[j])
    }
  }
  return level
}

/**
 * One way to play a transition, in A's own time τ (A advances at 1): A walks `laneA` from τ = 0, B walks `laneB` from
 * τ = `bStart` at `rate` (its advance per τ).
 */
interface Placement {
  stats: ShapeStats
  variant: Variant
  laneA: Lane
  laneB: Lane
  bStart: number
  rate: number
  bound: number
  /** Beats of both decks sound together, so the placement's beatmatch is checked. */
  beatmatched: boolean
  /** Seconds of measured singing the placement skips (A's after it's gone, B's before its voice comes in). */
  sung: number
  /** For a beatmatch: the least clear attacks of both songs where the decks sound together (NaN: not measured). */
  clarity: number
  /** Extra plays of looped bars (both decks). */
  loops: number
  /**
   * How much later than its phrase B is started at first (seconds): a lane that opens on a loop can't start earlier
   * than its loop, so the phase fit gets room to move B both ways.
   */
  slack: number
  pa: Anchor
  pb: Anchor
}

const positionA = (p: Placement, tau: number) => lanePosition(p.laneA, tau)
const positionB = (p: Placement, tau: number) => (tau < p.bStart - 1e-9 ? null : lanePosition(p.laneB, (tau - p.bStart) * p.rate))

/** Seconds of singing heard over each other, and of each song's singing lost (muffled, cut mid-line, entered mid-line). */
function vocalCost(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const { stats } = p
  const { dt } = stats
  const length = stats.shape.length
  let clash = 0
  let lostA = 0
  let lostB = 0
  const touchA = laneStretches(p.laneA, length).some(([from, to]) => spansTouch(a.vocals, from, to))
  const touchB = laneStretches(p.laneB, Math.max(0, length - p.bStart) * p.rate).some(([from, to]) => spansTouch(b.vocals, from, to))
  if (length > 0 && (touchA || touchB)) {
    const echoed = echoedVoice(stats, a, (t) => positionA(p, t))
    for (let i = 0; i < stats.voiceA.length - 1; i++) {
      const t = i * dt
      const tb = positionB(p, t)
      // Only measured singing counts here (a song whose vocals weren't measured has its body assumed sung, which is no
      // reason to keep a voice of the other song off it: only voice over voice is a violation).
      const aSings = a.vocalsKnown && !!spanAt(a.vocals, positionA(p, t))
      const bSings = b.vocalsKnown && tb !== null && !!spanAt(b.vocals, tb)
      const aHeard = stats.voiceA[i] > VOICE_HEARD
      const bHeard = stats.voiceB[i] > VOICE_HEARD
      if (bSings && bHeard && ((aSings && aHeard) || (echoed !== null && echoed[i] >= ECHO_HEARD))) clash += dt
      if (aSings && !aHeard && stats.gainA[i] > 0.05) lostA += dt
      // B's singing under A before its voice comes in (a pre-roll) is a tease, not a line lost.
      if (bSings && !bHeard && t >= stats.bVoice) lostB += dt
    }
  }
  // A's line still going when A is gone; B coming in on the middle of a line.
  const aLeaves = positionA(p, stats.aGone)
  const lineA = spanAt(a.vocals, aLeaves)
  if (lineA && lineA.end - aLeaves > 0.3 && aLeaves - lineA.start > 0.3) lostA += Math.min(6, lineA.end - aLeaves)
  const bVoiceIn = positionB(p, stats.bVoice) ?? p.laneB.start
  const lineB = spanAt(b.vocals, bVoiceIn)
  if (lineB && bVoiceIn - lineB.start > 0.3) lostB += Math.min(6, bVoiceIn - lineB.start)
  return { clash, lostA, lostB }
}

/**
 * How loud the two decks sound together, from the songs' own band energies along their paths × the automation: per
 * band, the summed power against the louder song's loud level (its loud parts at its loudness), or against what either
 * deck plays alone where that's louder. Returns the 95th percentile over the overlap of the worst band (dB above), the
 * mean of all bands against the loud level (a hole when far below), and the seconds both decks carry a real bassline.
 */
function overlapEnergy(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const { stats } = p
  const { shape, dt } = stats
  const length = shape.length
  const reference = Math.max(a.level, b.level) ** 2
  const over: number[] = []
  let total = 0
  let samples = 0
  let basses = 0
  let busy = 0
  if (length <= 0 || dt <= 0) return { over: -Infinity, mean: 0, basses: 0, busy: 0 }
  const { passA, passB } = stats
  // Two basslines, at every sample (the moments around a swap matter): checked first, it rejects.
  for (let i = 0; i < stats.gainA.length; i++) {
    const t = i * dt
    if (t < p.bStart || t > length || passA.low[i] * 1.5 <= 0.5 || passB.low[i] * 1.5 <= 0.5) continue
    const atB = positionB(p, t)
    if (atB === null) continue
    if (passA.low[i] * a.bandsAt(positionA(p, t)).low > 0.5 && passB.low[i] * b.bandsAt(atB).low > 0.5) basses += dt
  }
  if (basses > 0) return { over: -Infinity, mean: 0, basses, busy: 0 }
  const step = Math.max(1, Math.round(0.1 / dt))
  for (let i = 0; i < stats.gainA.length; i += step) {
    const t = i * dt
    if (t < p.bStart || t > length) continue
    const atB = positionB(p, t)
    if (atB === null) continue
    const eA = a.bandsAt(positionA(p, t))
    const eB = b.bandsAt(atB)
    let worst = -Infinity
    let sum = 0
    for (const band of ['low', 'mid', 'high'] as const) {
      const pa = passA[band][i] * eA[band] * a.level
      const pb = passB[band][i] * eB[band] * b.level
      // Against the louder of the songs' loud level and what either deck plays on its own (a song's own peaks are fine).
      const power = (pa * pa + pb * pb) / Math.max(reference, pa * pa, pb * pb)
      worst = Math.max(worst, 10 * Math.log10(Math.max(power, 1e-9)))
      sum += (pa * pa + pb * pb) / reference
    }
    over.push(worst)
    total += sum / 3
    samples++
    busy += Math.min(1, (eA.mid + eA.high + eB.mid + eB.high) / 4)
  }
  if (samples === 0) return { over: -Infinity, mean: 0, basses: 0, busy: 0 }
  over.sort((x, y) => x - y)
  return { over: over[Math.floor(over.length * 0.95)], mean: 10 * Math.log10(Math.max(total / samples, 1e-9)), basses, busy: busy / samples }
}

/** Cosine of two harmonic profiles (0 when either is missing). */
function cosine(x: number[] | null, y: number[] | null) {
  if (!x || !y) return 0
  let dot = 0
  let nx = 0
  let ny = 0
  for (let i = 0; i < 12; i++) {
    dot += x[i] * y[i]
    nx += x[i] * x[i]
    ny += y[i] * y[i]
  }
  return nx > 0 && ny > 0 ? dot / Math.sqrt(nx * ny) : 0
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
 * Signed offsets (B's beat minus A's nearest, in A's time) of B's beats where both decks are heard, and how many of
 * B's heard beats had an A beat within reach. In double time B's off-beats falling between A's beats count as on.
 */
function beatOffsets(p: Placement, a: PreparedTrack, b: PreparedTrack, multiple: number, reach: number) {
  const { stats } = p
  const { dt } = stats
  const length = stats.shape.length
  const aBeats = laneBeats(p.laneA, a.beats, length + stats.beat)
  const bBeats = laneBeats(p.laneB, b.beats, Math.max(0, length - p.bStart) * p.rate)
  const times: number[] = []
  const offsets: number[] = []
  let heard = 0
  if (dt <= 0 || aBeats.length === 0) return { times, offsets, heard }
  for (const advance of bBeats) {
    const t = p.bStart + advance / p.rate
    const i = Math.round(t / dt)
    if (i < 0 || i >= stats.loudA.length || !stats.loudA[i] || !stats.loudB[i]) continue
    heard++
    let signed = t - nearest(aBeats, t)
    if (multiple === 0.5 && Math.abs(signed) > stats.beat / 4) signed -= Math.sign(signed) * (stats.beat / 2)
    if (Math.abs(signed) >= stats.beat * reach) continue
    times.push(t)
    offsets.push(signed)
  }
  return { times, offsets, heard }
}

/**
 * How far B's beats sit from A's while both are heard: the median and the 90th percentile (seconds). Where A has no beat
 * within half a beat (a beatless break, or beats the analysis lost) the match can't be checked; `checked` is the share
 * of B's beats that could be. `worstWindow`: the largest mean offset over any two bars (a song whose tempo drifts can
 * line up on average and still run late for a bar or two, which is what the ear hears).
 */
function phaseError(p: Placement, a: PreparedTrack, b: PreparedTrack, multiple: number) {
  const { times, offsets, heard } = beatOffsets(p, a, b, multiple, 0.45)
  if (offsets.length === 0) return { median: 0, p90: 0, checked: heard === 0 ? 1 : 0, worstWindow: 0 }
  const window = 8 * p.stats.beat
  const sums = new Map<number, { sum: number; count: number }>()
  times.forEach((t, i) => {
    const w = Math.floor(t / window)
    const entry = sums.get(w) ?? { sum: 0, count: 0 }
    entry.sum += offsets[i]
    entry.count++
    sums.set(w, entry)
  })
  const sorted = offsets.map(Math.abs).sort((x, y) => x - y)
  let worstWindow = 0
  for (const { sum, count } of sums.values()) if (count >= 3) worstWindow = Math.max(worstWindow, Math.abs(sum / count))
  return { median: sorted[sorted.length >> 1], p90: sorted[Math.floor(sorted.length * 0.9)], checked: offsets.length / heard, worstWindow }
}

/**
 * Puts B's beats exactly on A's: the signed offsets of B's beats from A's nearest ones, where both decks are heard, are
 * fitted with a line over the overlap (least squares). Its slope is a tempo left over (the rate is corrected by it, at
 * most 0.5 %), its level a constant lag (B starts that much earlier or later). Returns the moved placement fields, or
 * null when B can't move that way (it would have to start before its loop).
 */
function alignPhase(p: Placement, a: PreparedTrack, b: PreparedTrack, multiple: number) {
  let current: Placement = p
  let fitted = false
  for (let round = 0; round < 2; round++) {
    const { times, offsets } = beatOffsets(current, a, b, multiple, 0.3)
    if (times.length < 4) break
    fitted = true
    const meanT = times.reduce((sum, t) => sum + t, 0) / times.length
    const meanO = offsets.reduce((sum, o) => sum + o, 0) / offsets.length
    let num = 0
    let den = 0
    for (let i = 0; i < times.length; i++) {
      num += (times[i] - meanT) * (offsets[i] - meanO)
      den += (times[i] - meanT) ** 2
    }
    const slope = den > 0 ? num / den : 0
    // B late by o at τ: its beats must come o earlier. A slope s stretches B's time by (1 − s); after it, the offset
    // left at B's start is meanO − slope · (meanT − bStart).
    const rate = Math.abs(slope) < 0.005 ? current.rate / (1 - slope) : current.rate
    const level = rate === current.rate ? meanO : meanO - slope * (meanT - current.bStart)
    let bStart = current.bStart - level
    let laneB = current.laneB
    if (bStart < 0) {
      // B has to start earlier than the transition: begin it further into its track instead, if it doesn't loop there.
      if (laneB.path.length > 0) return null
      laneB = { start: laneB.start - bStart * rate, path: [] }
      bStart = 0
    }
    current = { ...current, rate, bStart, laneB }
  }
  // No beats of both loud at once (a shape that hands the beat over in one go): nothing to fit, B starts on its phrase.
  if (!fitted) return { rate: p.rate, bStart: p.bStart - p.slack, laneB: p.laneB }
  // The grid sits on a song's attacks overall; its kick and its claps/snares may lie a little behind it, each by its own
  // amount. B moves so the kicks' lag and the accents' lag between the decks are as small as they can be together
  // (least squares): kicks and accents weigh alike where one deck's bass is up (the other kick's click still sounds),
  // the kicks 2:1 where both basses sound.
  const kickWeight = 1 + p.stats.kicksTogether
  const kicks = offsetOf(b.mix, 'kickOffset') - offsetOf(a.mix, 'kickOffset')
  const accents = offsetOf(b.mix, 'accentOffset') - offsetOf(a.mix, 'accentOffset')
  const shift = (kickWeight * kicks + accents) / (kickWeight + 1)
  return { rate: current.rate, bStart: Math.max(0, current.bStart - shift), laneB: current.laneB }
}

/** A song's kick or accent offset behind its grid (seconds); 0 when unknown or implausible (older analyses lack it). */
function offsetOf(mix: TrackMix, field: 'kickOffset' | 'accentOffset') {
  const value: unknown = mix[field]
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 0.05 ? value : 0
}

/** A song's swing (0.5 straight); 0.5 when unknown. */
function swingOf(mix: TrackMix) {
  const value: unknown = mix.swing
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.4 && value <= 0.8 ? value : 0.5
}

/**
 * The least attack clarity a beatmatch depends on: the bars of both decks where both decks' beats are loud. Only there
 * can two beats be heard to flam; a deck entering high-passed or quiet, or leaving that way, needn't be clear (measured:
 * requiring it as well halves the blends and lowers no lag). NaN when the analysis has no clarity.
 */
function audibleClarity(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const { stats } = p
  const { dt } = stats
  const length = stats.shape.length
  if (dt <= 0) return 1
  const step = Math.max(1, Math.round(0.1 / dt))
  let least = Infinity
  for (let i = 0; i < stats.loudA.length; i += step) {
    const t = i * dt
    if (t > length || t < p.bStart || !stats.loudA[i] || !stats.loudB[i]) continue
    const atA = positionA(p, t)
    const atB = positionB(p, t) ?? 0
    // B before its first beat has no grid to match: -1 rejects. A after its last beat is its tail (a play-out to its
    // audible end): no beats of A there to flam with.
    if (atB < (b.beats[0] ?? 0) - 0.05) return -1
    if (atA > (a.beats[a.beats.length - 1] ?? Infinity) + 0.05) continue
    // The accents/broadband attacks of both decks always; their kicks too where both lows come through (a killed or
    // filtered low hides a kick: it can't flam).
    let value = Math.min(a.clarityBetween(atA, atA + 0.01), b.clarityBetween(atB, atB + 0.01))
    if (stats.passA.low[i] >= KICK_HEARD && stats.passB.low[i] >= KICK_HEARD)
      value = Math.min(value, a.kickClarityBetween(atA, atA + 0.01), b.kickClarityBetween(atB, atB + 0.01))
    if (Number.isNaN(value)) return NaN
    least = Math.min(least, value)
  }
  return Number.isFinite(least) ? least : 1
}

/** A bar that may be looped: no singing, clear attacks, no drop inside, before the song's end. */
function loopableBar(track: PreparedTrack, k: number) {
  const from = track.downbeats[k]
  const to = track.downbeats[k + 1]
  if (from === undefined || to === undefined || to > track.end) return false
  if (spansTouch(track.vocals, from, to)) return false
  const clarity = track.clarityBetween(from, to - 0.01)
  if (Number.isNaN(clarity) || clarity < MIN_CLARITY) return false
  return !track.drops.some((d) => d > from + 0.05 && d < to - 0.05)
}

/** Bars [first, first + count) can be looped: each loopable, their energies within a narrow band (seamless repeats). */
function loopable(track: PreparedTrack, first: number, count: number) {
  if (first < 0) return false
  const energies: number[] = []
  for (let k = first; k < first + count; k++) {
    if (!loopableBar(track, k)) return false
    energies.push(track.energyBetween(track.downbeats[k], track.downbeats[k + 1]))
  }
  return Math.max(...energies) - Math.min(...energies) <= 0.25
}

/**
 * The bars [first, last) keep the phrase grid of `anchor` (a downbeat index): every analysed phrase start among them
 * lies a whole number of 4 bars from it, and none of them lies before the song's first phrase. Otherwise a blend's
 * middle wouldn't fall on a phrase of the song.
 */
function keepsGrid(track: PreparedTrack, anchor: number, first: number, last: number) {
  const db = track.downbeats
  if (track.phrases.length > 0 && db[first] < track.phrases[0] - 0.05) return false
  for (const phrase of track.phrases) {
    if (phrase <= db[first] + 0.05 || phrase >= db[last] - 0.05) continue
    const k = floorIndex(db, phrase + 0.05)
    if (k < 0 || Math.abs(db[k] - phrase) > 0.05 || (k - anchor) % 4 !== 0) return false
  }
  return true
}

/** One deck's material for a blend: its lane, its length in the deck's own seconds, extra plays of looped bars. */
interface LaneOption {
  lane: Lane
  advance: number
  extra: number
}

/** The ways to split `bars` into `straight` bars played once and a loop of 4 or 8 of them played again. */
function loopSplits(bars: number) {
  const splits: Array<{ straight: number; loopBars: number; plays: number }> = []
  for (const loopBars of [8, 4])
    for (let straight = loopBars; straight < bars; straight += 4) {
      if ((bars - straight) % loopBars !== 0) continue
      const plays = (bars - straight) / loopBars + 1
      if (plays * loopBars <= MAX_LOOP_BARS) splits.push({ straight, loopBars, plays })
    }
  return splits
}

/**
 * A's material for a blend of `bars` bars from `start` on: straight on, or the bars up to a loopable stretch (the last
 * 4 or 8 of them) that then repeats, so A may leave a sung or unclear tail for a clear instrumental phrase of its own.
 */
function lanesFrom(track: PreparedTrack, start: number, bars: number, gridShift = 0): LaneOption[] {
  const i0 = floorIndex(track.downbeats, start + 0.05)
  const db = track.downbeats
  if (i0 < 0 || Math.abs(db[i0] - start) > 0.05) return []
  // The phrase grid is the boundary's: `gridShift` bars after the start (whole 4-bar steps from it count as on grid).
  const grid = i0 + gridShift
  const options: LaneOption[] = []
  if (i0 + bars < db.length && db[i0 + bars] <= track.end && keepsGrid(track, grid, i0, i0 + bars))
    options.push({ lane: { start, path: [] }, advance: db[i0 + bars] - start, extra: 0 })
  for (const { straight, loopBars, plays } of loopSplits(bars)) {
    const first = i0 + straight - loopBars
    if (i0 + straight >= db.length || !loopable(track, first, loopBars) || !keepsGrid(track, grid, i0, i0 + straight)) continue
    const loopStart = db[first]
    const loopEnd = db[i0 + straight]
    const path: DeckSegment[] =
      loopStart === start
        ? [{ from: start, to: loopEnd, repeat: plays }]
        : [
            { from: start, to: loopEnd, repeat: 1 },
            { from: loopStart, to: loopEnd, repeat: plays - 1 },
          ]
    options.push({ lane: { start, path }, advance: loopEnd - start + (plays - 1) * (loopEnd - loopStart), extra: plays - 1 })
  }
  return options
}

/**
 * B's material for a blend of `bars` bars that ends at `end` (where B is fully in: its drop, chorus, first sung phrase):
 * straight up to it, or from a loopable stretch (4 or 8 bars) that repeats first and then plays on to `end`, so B may
 * open on a clear instrumental phrase of its own even when its very first bars are sparse.
 */
function lanesTo(track: PreparedTrack, end: number, bars: number, gridShift = 0): LaneOption[] {
  const iE = floorIndex(track.downbeats, end + 0.05)
  const db = track.downbeats
  if (iE < 0 || Math.abs(db[iE] - end) > 0.05) return []
  // The phrase grid is the event's: `gridShift` bars before the end.
  const grid = iE - gridShift
  const options: LaneOption[] = []
  if (iE - bars >= 0 && keepsGrid(track, grid, iE - bars, iE)) options.push({ lane: { start: db[iE - bars], path: [] }, advance: end - db[iE - bars], extra: 0 })
  for (const { straight, loopBars, plays } of loopSplits(bars)) {
    const first = iE - straight
    if (!loopable(track, first, loopBars) || !keepsGrid(track, grid, first, iE)) continue
    const start = db[first]
    const loopEnd = db[first + loopBars]
    options.push({
      lane: { start, path: [{ from: start, to: loopEnd, repeat: plays }] },
      advance: end - start + (plays - 1) * (loopEnd - start),
      extra: plays - 1,
    })
  }
  return options
}

function emptyAutomation(): DeckAutomation {
  return { gain: [], low: [], mid: [], high: [], filter: [] }
}

const round = (t: number) => Math.round(t * 1000) / 1000

/** The tempo a transition is counted in when a song's tempo isn't known. */
const DEFAULT_TEMPO = 120

const validTempo = (bpm: unknown) => (typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? Math.round(bpm * 100) / 100 : DEFAULT_TEMPO)

/** A song's tempo as the plan used it: from its beat grid, else the analysed BPM, else 120. */
function tempoOf(track: PreparedTrack | null) {
  if (!track) return DEFAULT_TEMPO
  return validTempo(track.grid ? track.bpm : track.mix.bpm)
}

/** Valid path segments inside a track (whole repeats 1–8), or none when the path doesn't start where the deck does. */
function cleanPath(path: unknown, start: number, duration: number): DeckSegment[] {
  if (!Array.isArray(path) || path.length === 0) return []
  const segments = path
    .filter((s): s is DeckSegment => !!s && typeof s === 'object')
    .map((s) => ({ from: round(s.from), to: round(s.to), repeat: Math.round(s.repeat) }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.from >= 0 && s.to > s.from && s.to <= duration + 0.05 && s.repeat >= 1 && s.repeat <= 8)
  if (segments.length !== path.length || Math.abs(segments[0].from - start) > 0.002) return []
  return segments
}

/** Rate keyframes, sorted, finite, within the playable 0.5–2. */
function cleanRate(curve: unknown): Keyframe[] {
  if (!Array.isArray(curve)) return []
  return curve
    .filter((k): k is Keyframe => !!k && Number.isFinite(k.t) && Number.isFinite(k.v) && k.t >= 0)
    .map((k) => ({ t: round(k.t), v: Math.round(Math.min(2, Math.max(0.5, k.v)) * 10000) / 10000 }))
    .sort((p, q) => p.t - q.t)
}

/**
 * Clamps a transition into a valid one: times inside both songs, length ≥ 0, B starting within it, paths inside the
 * tracks, rates playable (B's ending at 1), keyframes sorted inside [0, length].
 */
export function finalizeTransition(transition: Transition, aDuration: number, bDuration: number): Transition {
  const finite = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback)
  const aEnd = Number.isFinite(aDuration) && aDuration > 0 ? aDuration : 0
  const bEnd = Number.isFinite(bDuration) && bDuration > 0 ? bDuration : Infinity
  const aOut = Math.min(aEnd, Math.max(0, finite(transition.aOut, aEnd)))
  const pathA = cleanPath(transition.pathA, aOut, aEnd)
  const rateA = cleanRate(transition.rateA)
  let length = Math.max(0, finite(transition.length, 0))
  // A must not run past its end: with no loop, cut the transition where A's material ends.
  if (pathA.length === 0) {
    const advance = rateAdvance(rateA, 0, length)
    // (to whole milliseconds downwards, so rounding can't carry A past its end)
    if (advance > aEnd - aOut && advance > 0) length = Math.floor(length * ((aEnd - aOut) / advance) * 1000) / 1000
  }
  const bAt = Math.min(length, Math.max(0, finite(transition.bAt, 0)))
  const bIn = Math.max(0, Math.min(finite(transition.bIn, 0), Number.isFinite(bEnd) ? Math.max(0, bEnd - 1) : Infinity))
  const pathB = cleanPath(transition.pathB, bIn, Number.isFinite(bEnd) ? bEnd : Infinity)
  let rateB = cleanRate(transition.rateB)
  if (length === 0) rateB = []
  else if (rateB.length > 0 && rateB[rateB.length - 1].v !== 1) rateB.push({ t: round(rateB[rateB.length - 1].t + 2), v: 1 })
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
    v: 2,
    aOut: round(aOut),
    bAt: round(bAt),
    bIn: round(bIn),
    length: round(length),
    pathA: length > 0 ? pathA : [],
    pathB: length > 0 ? pathB : [],
    rateA: length > 0 ? rateA : [],
    rateB,
    a: deck(transition.a),
    b: deck(transition.b),
    effects,
    confidence: Math.round(Math.min(1, Math.max(0, finite(transition.confidence, 0))) * 100) / 100,
    tempo: { a: validTempo(transition.tempo?.a), b: validTempo(transition.tempo?.b) },
  }
}

/** A transition without overlap, loops or rate changes. */
function plain(ids: { from: string; to: string }, style: MixStyle, preset: PresetId, fields: Partial<Transition>): Transition {
  return {
    v: 2,
    from: ids.from,
    to: ids.to,
    style,
    preset,
    aOut: 0,
    bAt: 0,
    bIn: 0,
    length: 0,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    a: emptyAutomation(),
    b: emptyAutomation(),
    effects: [],
    custom: false,
    confidence: 0,
    tempo: { a: DEFAULT_TEMPO, b: DEFAULT_TEMPO },
    ...fields,
  }
}

/** Back to back: A plays to its end, B from its start. */
function backToBack(ids: { from: string; to: string }, style: MixStyle, aDuration: number, confidence: number, tempo = { a: DEFAULT_TEMPO, b: DEFAULT_TEMPO }) {
  return plain(ids, style, 'none', { aOut: Number.isFinite(aDuration) && aDuration > 0 ? aDuration : 0, confidence, tempo })
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
  const transition = plain(ids, style, 'crossfade', {
    aOut,
    bIn,
    length,
    a: shape.a,
    b: shape.b,
    confidence: a.grid || (b?.grid ?? false) ? 0.4 : 0.3,
    tempo,
  })
  return finalizeTransition(transition, a.duration, b?.duration ?? NaN)
}

/** A plain crossfade of a few seconds at A's end, for a song without analysis yet. */
export function planFallback(fromId: string, toId: string, aDuration: number, style: MixStyle = 'clean'): Transition {
  const ids = { from: fromId, to: toId }
  if (!Number.isFinite(aDuration) || aDuration <= 0) return backToBack(ids, style, NaN, 0)
  const length = Math.min(style === 'party' ? 3 : 4, aDuration * 0.2)
  if (length < 0.5) return backToBack(ids, style, aDuration, 0.3)
  const shape = plainCrossfade(length)
  return finalizeTransition(plain(ids, style, 'crossfade', { aOut: aDuration - length, length, a: shape.a, b: shape.b, confidence: 0.3 }), aDuration, NaN)
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
  if (!a.vocalsKnown || !b.vocalsKnown) maxBars = 16
  if (Math.min(a.keyClarity, b.keyClarity) < 0.3) maxBars = Math.min(maxBars, 16)
  if (tempo.diff > 0.03) maxBars = Math.min(maxBars, 16)
  let targetBars = style === 'party' ? 16 : 32
  if (style === 'clean' && (tempo.diff > 0.015 || harmony < 0.85 || minConfidence < 0.7)) targetBars = 16
  targetBars = Math.min(targetBars, maxBars)

  const variants = variantsFor(style, tempo.synced, maxBars, forced)
  // A's downbeats up to its audible end for clean play-outs: the grid's up to the first within a beat of that end, or
  // bars of the song's length on past the grid's last downbeat while A still sounds more than a beat after it (its last
  // sung line may run past the grid). Empty when that last bar would end more than a bar after A's audio.
  const endBar = a.downbeats.findIndex((t) => t >= a.end - a.period)
  const tailBars = endBar >= 0 ? a.downbeats.slice(0, endBar + 1) : [...a.downbeats]
  while (tailBars.length > 0 && tailBars[tailBars.length - 1] < a.end - a.period) tailBars.push(tailBars[tailBars.length - 1] + 4 * a.period)
  if (tailBars.length === 0 || tailBars[tailBars.length - 1] > a.duration + 4 * a.period) tailBars.length = 0
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
    const rawSwap = variant.pre ?? variant.bars * variant.swapFraction
    const swapBar = tempo.synced && tempo.multiple === 2 ? 2 * Math.round(rawSwap / 2) : Math.round(rawSwap)
    const key = `${variant.preset}:${variant.bars}:${variant.pre}:${swapBar}:${variant.preRollBars}:${variant.filter}:${variant.midSwap}:${variant.volume}:${variant.bassAt}:${variant.filterIn}:${variant.filterOut}:${variant.meet}:${beat.toFixed(5)}`
    let stats = shapes.get(key)
    if (!stats) {
      const shape = presetShape(variant.preset, {
        beat,
        bars: variant.bars,
        synced: tempo.synced,
        swapBar,
        preRollBars: variant.preRollBars,
        filter: variant.filter,
        midSwap: variant.midSwap,
        volume: variant.volume,
        bassAt: variant.bassAt,
        filterIn: variant.filterIn,
        filterOut: variant.filterOut,
      })
      stats = shapeStats(shape, variant.meet, beat)
      shapes.set(key, stats)
    }
    return stats
  }

  /** What's known without sampling: an upper bound of the final score (the sampled checks only subtract). */
  const scoreBound = (p: Omit<Placement, 'bound' | 'sung'>) => {
    const { stats, variant } = p
    const placed = { ...p, bound: 0, sung: 0 }
    const reachA = laneReach(p.laneA, stats.aGone)
    const aLeaves = positionA(placed, stats.aGone)
    const bEnd = positionB(placed, stats.shape.length) ?? p.laneB.start
    const skipA = a.loudSeconds(reachA, a.end)
    const skipB = b.loudSeconds(b.start, p.laneB.start)
    let bound = variant.prior + jitter(`${ids.from}>${ids.to}:${variant.preset}:${variant.preRollBars}:${variant.bars}:${variant.midSwap}`)
    bound += p.pa.bonus + p.pb.bonus - 0.02 * p.loops
    // A blend's length preference is its layout's prior; a fade's or echo's leans to the target length.
    if (FREE_LENGTH.has(variant.preset)) bound -= 0.12 * Math.abs(Math.log2(variant.bars / targetBars))
    if (party) {
      // Cutting intros and outros is the point; cutting away much more than that (a whole last chorus) is not.
      bound -= 0.015 * Math.max(0, skipA - a.duration * 0.25) + 0.01 * Math.max(0, skipB - b.duration * 0.3)
      if (variant.preset === 'dropSwap') {
        // A drop swap is made for B's drop; onto a chorus it still works, onto anything else it's just a cut.
        if (p.pb.drop) bound += 0.35
        else if (p.pb.chorus) bound += 0.05
        else bound -= 0.2
        // The DJ's drop mix: A is cut inside its own pre-drop gap, exactly where its drop would land.
        if (p.pa.drop) bound += forced === 'dropSwap' ? 0.5 : 0.1
      }
      if (variant.preset === 'blend' && (p.pb.drop || p.pb.chorus)) bound += 0.1
    } else {
      bound -= 0.03 * (skipA + skipB)
    }
    const energyA = a.energyBetween(aLeaves - 8, aLeaves)
    const energyB = b.energyBetween(bEnd, bEnd + 8)
    if (party) {
      const fall = Math.max(0, energyA - energyB - 0.1)
      bound -= (variant.preset === 'echoOut' ? 0.3 : 0.6) * fall
      if (variant.preset === 'dropSwap' && energyB < 0.6) bound -= 0.3
    } else {
      bound -= 0.5 * Math.abs(energyA - energyB)
    }
    // Keys clash where both decks' mids (chords, leads, voices) sound together; the bass never overlaps. A blend gets its
    // tonal terms per finish (its finishes differ there), plus the best finish's prior.
    if (variant.preset === 'blend') {
      bound += BEST_FINISH
      // Something must kick in on B as A leaves (its drop, chorus, groove): a thin part there is an anticlimax.
      bound -= 0.3 * Math.max(0, 0.5 - b.energyBetween(bEnd, bEnd + 4 * b.period))
      // Parts whose melodies are alike blend cleanly (the user's favourite): the phrases meeting at the middle.
      const middle = stats.shape.swap
      const likeness = cosine(a.chromaAt(positionA(placed, middle)), b.chromaAt(positionB(placed, middle) ?? p.laneB.start))
      bound += 0.3 * Math.min(1, Math.max(0, (likeness - 0.85) / 0.15))
    } else bound -= (1 - harmony) * 0.6 * Math.min(1, stats.tonal / (16 * stats.beat))
    // Singing that's skipped: A's lines after it's gone, B's before its voice comes in. Clean keeps every sung line
    // (whatever the sections are called); party may cut some, at a price.
    const sungA = trustA * a.sungSeconds(reachA, a.duration)
    const sungB = trustB * b.sungSeconds(0, Math.min(p.laneB.start, positionB(placed, stats.bVoice) ?? p.laneB.start))
    bound -= party ? 0.02 * sungA + 0.01 * sungB : 0.3 * (sungA + sungB)
    if (!tempo.synced && NEEDS_BEATMATCH.has(variant.preset)) bound -= 0.2 * Math.min(1, stats.together / (4 * stats.beat))
    return { bound, sung: sungA + sungB }
  }

  for (const variant of variants) {
    if (variant.preset === 'blend') {
      // The blend: A's material from a phrase on, B's material up to a phrase, each looped where needed. Half time:
      // the blend spans the same time in both, so B covers bars / multiple of its own bars.
      if (!tempo.synced) continue
      const barsB = variant.bars / tempo.multiple
      if (!Number.isInteger(barsB) || barsB < 1) continue
      // Event-based, as a DJ places it: B's event (its kick-in, drop, chorus, first vocal) lands on A's boundary (A's
      // outro start, the end of a chorus, a section change), both on the phrase grid; the bass changes deck there. B
      // plays `pre` bars under A before it, A `post` bars on after it to its next section. In clean style a blend may
      // also end on A's last bar (A plays out completely, B's intro under it).
      const pre = variant.pre ?? variant.bars / 2
      const post = variant.bars - pre
      const preB = pre / tempo.multiple
      const postB = post / tempo.multiple
      if (!Number.isInteger(preB) || !Number.isInteger(postB)) continue
      const onGrid = (track: PreparedTrack, t: number) => Math.abs(nearest(track.phraseGrid, t) - t) < 0.05
      const shiftBars = (track: PreparedTrack, t: number, bars: number) => {
        const i = floorIndex(track.downbeats, t + 0.05)
        const k = i + bars
        return i >= 0 && Math.abs(track.downbeats[i] - t) <= 0.05 && k >= 0 && k < track.downbeats.length ? track.downbeats[k] : NaN
      }
      // B's material per number of bars after the swap (the play-outs below have their own).
      const lanesBFor = new Map<number, Array<{ pb: Anchor; options: LaneOption[] }>>()
      const lanesB = (afterBars: number) => {
        let list = lanesBFor.get(afterBars)
        if (!list) {
          list = ins.map((pb) => {
            const end = shiftBars(b, pb.t, afterBars / tempo.multiple)
            const bars = (pre + afterBars) / tempo.multiple
            const usable = !(party && pb.t > b.duration * 0.6) && onGrid(b, pb.t) && Number.isFinite(end) && Number.isInteger(bars)
            return { pb, options: usable ? lanesTo(b, end, bars, afterBars / tempo.multiple) : [] }
          })
          lanesBFor.set(afterBars, list)
        }
        return list
      }
      // Where A goes out: its boundaries on the phrase grid, A playing `post` bars on after them. In clean style also the
      // play-out: from A's last boundary on the grid A plays on to its audible end (nothing of A skipped, B's intro
      // under it), as many bars as that takes; its last bar may run past A's grid (`tailBars`) and past the end of A's
      // audio, where the transition is cut (finalizeTransition), so it ends where A does.
      const jobs: Array<{ pa: Anchor; after: number; tail: boolean }> = outs.filter((anchor) => onGrid(a, anchor.t)).map((pa) => ({ pa, after: post, tail: false }))
      if (!party && variant.volume === 'overlap' && (pre === 0 || pre === 4) && tailBars.length > 0) {
        const lastBar = tailBars.length - 1
        for (const t of a.phraseGrid) {
          const i = floorIndex(a.downbeats, t + 0.05)
          const after = lastBar - i
          if (i < 0 || after < 2 || after > 16 || (after === post && tailBars[lastBar] <= a.end)) continue
          jobs.push({ pa: { t, bonus: 0, drop: false, chorus: false }, after, tail: true })
        }
      }
      for (const { pa, after, tail } of jobs) {
        const start = shiftBars(a, pa.t, -pre)
        if (!Number.isFinite(start)) continue
        const job = after === post ? variant : { ...variant, bars: pre + after }
        const i0 = floorIndex(a.downbeats, start + 0.05)
        const lanes: LaneOption[] = !tail
          ? lanesFrom(a, start, job.bars, pre)
          : tailBars[i0 + job.bars] !== undefined && keepsGrid(a, i0 + pre, i0, Math.min(i0 + job.bars, a.downbeats.length - 1))
            ? [{ lane: { start, path: [] }, advance: tailBars[i0 + job.bars] - start, extra: 0 }]
            : []
        for (const fromA of lanes) {
          // The shape's beat: A's real bars over the material (loops included), so the swap lands on A's bar.
          const stats = shapeFor(job, fromA.advance / (4 * job.bars))
          if (stats.basses > 0.001) continue
          const length = stats.shape.length
          if (laneReach(fromA.lane, length) > a.duration + (tail ? 4 * a.period : 0)) continue
          for (const { pb, options } of lanesB(after))
            for (const toB of options) {
              // B's rate: its material over the blend's length, so B arrives where it should as A stops. Counted in bars, it
              // must agree with the songs' beats there (a bar the analysis miscounted would put B off by a beat).
              const rate = toB.advance / length
              if (!rateOk(rate)) continue
              const byBeats =
                periodOver(b, toB.lane.start, laneReach(toB.lane, length * rate)) / (tempo.multiple * periodOver(a, fromA.lane.start, laneReach(fromA.lane, length)))
              if (Math.abs(rate / byBeats - 1) > 0.01) continue
              const base = { stats, variant: job, laneA: fromA.lane, laneB: toB.lane, bStart: PHASE_SLACK, rate, beatmatched: true, clarity: NaN, loops: fromA.extra + toB.extra, slack: PHASE_SLACK, pa, pb }
              placements.push({ ...base, ...scoreBound(base) })
            }
        }
      }
      continue
    }
    for (const pa of outs) {
      const localBeat = periodAt(a, pa.t)
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
          if (!rateOk(rate)) continue
        }
        // B's phrase start meets A's exactly; when it lies too close to B's start, B starts a little later.
        const bIn = pb.t - stats.anchorB * rate
        if (bIn < -2) continue
        const laneB: Lane = { start: Math.max(0, bIn), path: [] }
        const bStart = bIn < 0 ? -bIn / rate : 0
        if (laneB.start + (length - bStart) * rate > b.duration - 2) continue
        const clarity = NaN
        const bEnters = bIn + stats.bHere * rate
        if (party && bEnters > b.duration * 0.6) continue
        const base = { stats, variant, laneA: { start: aOut, path: [] }, laneB, bStart, rate, beatmatched: tempo.synced && beatsTogether, clarity, loops: 0, slack: 0, pa, pb }
        placements.push({ ...base, ...scoreBound(base) })
      }
    }
  }

  // Best-first with the sampled checks; stop when no remaining placement can beat the best one.
  placements.sort((p, q) => q.bound - p.bound)
  const lostWeight = party ? 0.05 : 0.1
  const clash = harmony < KEY_CLASH
  /** The sampled checks of one placement: its score, or null when it breaks a rule. */
  const judge = (start: Placement): { placement: Placement; score: number } | null => {
    let placement = start
    if (placement.beatmatched) {
      const aligned = alignPhase(placement, a, b, tempo.multiple)
      // Grids that disagree by more than a few tens of milliseconds where they meet aren't to be trusted with a beatmatch
      // (a drop anchored on one beat, the beats around it elsewhere). How far B moved from where its phrase meets A's
      // (the slack it started late with doesn't count):
      const moved = aligned
        ? Math.abs(aligned.bStart - (placement.bStart - placement.slack)) + Math.abs(aligned.laneB.start - placement.laneB.start) / aligned.rate
        : Infinity
      if (!aligned || moved > MAX_PHASE_SHIFT || !rateOk(aligned.rate)) return null
      const length = placement.stats.shape.length
      const shifted = { ...placement, ...aligned }
      if (laneReach(shifted.laneB, (length - shifted.bStart) * shifted.rate) > b.duration - 2) return null
      // Attack clarity says how well the alignment can be verified, not whether it flams (the grids are steady): a
      // soft preference for clear placements. Only where a song has no grid at all (before its first beat) it rejects.
      // (clarityBetween reads 0 before the first phrase, so the grid itself is what's checked there.)
      const clarity = audibleClarity(shifted, a, b)
      if (clarity < 0 || (!Number.isNaN(clarity) && clarity < MIN_VERIFIABLE)) return null
      placement = { ...shifted, clarity }
      // A tiny tempo correction is left out (both decks play at exactly 1, no stretching) where the drift it leaves
      // stays within a few milliseconds each side of the overlap's middle.
      const overlap = length - placement.bStart
      const off = Math.abs(placement.rate - 1)
      if (off > 0 && off <= SNAP_RATE && (off * overlap) / 2 <= SNAP_DRIFT) {
        const middle = (placement.bStart + length) / 2
        const bStart = middle - (middle - placement.bStart) * placement.rate
        if (bStart >= 0) placement = { ...placement, rate: 1, bStart }
      }
    }
    const { stats } = placement
    // A blend's middle (where the bass changes deck) on a downbeat of both songs as they actually play there: bars of
    // uneven length can carry one song's downbeat away from the other's over a long blend.
    if (placement.variant.preset === 'blend' && placement.variant.bassAt === 'middle') {
      const middle = stats.shape.swap
      const length = stats.shape.length
      const downA = laneBeats(placement.laneA, a.downbeats, length)
      const downB = laneBeats(placement.laneB, b.downbeats, Math.max(0, length - placement.bStart) * placement.rate).map((x) => placement.bStart + x / placement.rate)
      if (downA.length === 0 || downB.length === 0) return null
      const atA = nearest(downA, middle)
      if (Math.abs(atA - middle) > 0.06 || Math.abs(nearest(downB, atA) - atA) > 0.06) return null
    }
    // Keys that clash: their tonal content may sound together for a beat at most.
    if (clash && stats.tonalBoth > stats.beat) return null
    let tonalTerm = 0
    if (placement.variant.preset === 'blend') tonalTerm = (1 - harmony) * 0.6 * Math.min(1, stats.tonal / (16 * stats.beat))
    // Loudness from what plays: the two parts together no more than a little above the louder song's loud parts (no
    // gain dips needed: thin parts and EQ keep it there), and no hole far below them.
    let energyTerm = 0
    if (stats.shape.length > 0) {
      const energy = overlapEnergy(placement, a, b)
      if (energy.over > (placement.variant.volume === 'overlap' ? MAX_OVER_DB_OVERLAP : MAX_OVER_DB) || energy.basses > 0) return null
      if (placement.variant.preset === 'blend') {
        energyTerm = 0.05 * Math.max(0, HOLE_DB - energy.mean)
        // Busy parts (mids and highs up) take a filter, thin ones blend open; long blends suit thin parts, the short
        // seamless one dense parts.
        const filtered = placement.variant.filterIn || placement.variant.filterOut ? 1 : 0
        energyTerm -= 0.02 * (filtered ? energy.busy : 1 - energy.busy)
        if (placement.variant.bars >= 16) energyTerm += 0.04 * energy.busy
        if (placement.variant.volume === 'scurve') energyTerm += 0.3 * (1 - energy.busy)
        else if (placement.variant.bars <= 4) energyTerm += 0.04 * (1 - energy.busy)
      }
    }
    const { clash: voices, lostA, lostB } = vocalCost(placement, a, b)
    // The short S-curve may let one voice end as the other starts (a beat at most); otherwise never voice over voice.
    if (voices > (placement.variant.volume === 'scurve' ? stats.beat : 0.1)) return null
    // Beats that drift apart flam audibly from about 25 ms on (and a stretch of the overlap may drift worse than the
    // middle): such a placement is out, a smaller drift costs a little. So is one whose match can't mostly be checked
    // against A's beats. Judged two bars at a time too.
    const drift = placement.beatmatched ? phaseError(placement, a, b, tempo.multiple) : { median: 0, p90: 0, checked: 1, worstWindow: 0 }
    if (drift.median > MAX_DRIFT || drift.p90 > 2.5 * MAX_DRIFT || drift.checked < 0.75 || drift.worstWindow > MAX_WINDOW_DRIFT) return null
    // A swung groove against a straight one flams wherever both beats are loud: a little of that is a handover, more
    // costs (up to a 16-beat stretch, then the full price).
    let swingTerm = 0
    if (placement.beatmatched && Math.abs(swingOf(a.mix) - swingOf(b.mix)) > SWING_CLASH) {
      let loudBoth = 0
      for (let i = 0; i < stats.loudA.length; i++) if (i * stats.dt >= placement.bStart && stats.loudA[i] && stats.loudB[i]) loudBoth += stats.dt
      swingTerm = 0.5 * Math.min(1, Math.max(0, loudBoth - 4 * stats.beat) / (16 * stats.beat))
    }
    const finish = placement.variant.preset === 'blend' ? placement.variant.prior - start.variant.prior - BEST_FINISH : 0
    const clarityTerm = Number.isNaN(placement.clarity) ? 0.1 : 0.3 * Math.max(0, 1 - placement.clarity / MIN_CLARITY)
    const score = placement.bound + finish - tonalTerm - energyTerm - swingTerm - clarityTerm - lostWeight * (trustA * Math.min(8, lostA) + trustB * Math.min(8, lostB)) - drift.median
    return { placement, score }
  }
  let best: { placement: Placement; score: number } | null = null
  for (const placement of placements) {
    if (best && placement.bound <= best.score) break
    // Clean style never skips a sung line: such a placement is out.
    if (!party && placement.sung > 0.5) continue
    // A blend's finishes, each sampled only when it could still beat the best.
    const tries = placement.variant.preset === 'blend' ? blendFinishes(placement.variant, clash) : [placement.variant]
    for (const variant of tries) {
      if (best && placement.bound + variant.prior - placement.variant.prior - BEST_FINISH <= best.score) continue
      const candidate = variant === placement.variant ? placement : { ...placement, variant, stats: shapeFor(variant, placement.stats.beat) }
      if (candidate.stats.basses > 0.001 && candidate.variant.bassAt !== 'none') continue
      const judged = judge(candidate)
      if (judged && (!best || judged.score > best.score)) best = judged
    }
  }
  // Back to back is always clean: when nothing fits (odd phrase data, songs too short for any overlap, or in clean
  // style a song that sings into its last seconds, so every overlap would cut a line).
  if (!best) return finalizeTransition(backToBack(ids, style, a.duration, 0.5, tempoUsed), a.duration, b.duration)

  const { placement } = best
  // The louder song comes down by the loudness difference while both play (both analyses must have measured it).
  const louder = Number.isFinite(a.mix.loudness) && Number.isFinite(b.mix.loudness) ? a.mix.loudness - b.mix.loudness : 0
  // Blends keep both decks at their volume (loudness comes from the parts chosen and their EQ, checked above).
  const shape = placement.variant.preset === 'blend' ? placement.stats.shape : matchLevels(placement.stats.shape, placement.stats.beat, louder)
  let confidence = 0.9
  if (tempo.synced && shape.length > 0) confidence *= 0.55 + 0.45 * minConfidence
  else confidence *= 0.6 + 0.3 * minConfidence
  if (placement.stats.tonal > 4 * placement.stats.beat) confidence *= 0.7 + 0.3 * harmony
  if (!a.vocalsKnown || !b.vocalsKnown) confidence *= 0.85
  if (!tempo.synced && NEEDS_BEATMATCH.has(shape.preset)) confidence *= 0.6
  if (placement.beatmatched) confidence *= Number.isNaN(placement.clarity) ? 0.8 : 0.7 + 0.3 * placement.clarity
  confidence *= 1 - 0.03 * placement.loops

  return finalizeTransition(toTransition(placement, shape, a, b, ids, style, confidence, tempoUsed), a.duration, b.duration)
}

/**
 * The plan on the transition's own clock. A beatmatch meets in the middle: A plays at 1/√rate, B at √rate (each the
 * same share of the gap); A glides there over the two bars before the overlap (when A has them), B glides back to its
 * own tempo over the 8 bars after A is gone. During the overlap transition time is A's advance / A's rate.
 */
function toTransition(
  p: Placement,
  shape: PresetShape,
  a: PreparedTrack,
  b: PreparedTrack,
  ids: { from: string; to: string },
  style: MixStyle,
  confidence: number,
  tempo: { a: number; b: number },
): Transition {
  const matched = p.beatmatched && shape.length > 0 && p.rate !== 1
  // A small correction goes to B alone (played resampled, without the stretcher; A stays bit-exact); a larger one
  // meets in the middle.
  const rateA = matched && Math.abs(p.rate - 1) > RESAMPLE_RATE ? 1 / Math.sqrt(p.rate) : 1
  const rateB = matched ? p.rate * rateA : 1
  let glide = 0
  let aOut = p.laneA.start
  if (matched && Math.abs(rateA - 1) > 1e-4) {
    const back = beatsBack(a, p.laneA.start, 4 * GLIDE_BARS_A)
    if (back !== null) {
      aOut = back
      glide = (2 * (p.laneA.start - back)) / (1 + rateA)
    }
  }
  const clock = (tau: number) => glide + tau / rateA
  const moveKeys = (list: Keyframe[]) => list.map((k) => ({ t: clock(k.t), v: k.v }))
  const moveDeck = (deck: DeckAutomation): DeckAutomation => ({
    gain: moveKeys(deck.gain),
    low: moveKeys(deck.low),
    mid: moveKeys(deck.mid),
    high: moveKeys(deck.high),
    filter: moveKeys(deck.filter),
  })
  const length = clock(shape.length)
  const bAt = clock(p.bStart)
  const pathA = p.laneA.path.length > 0 && glide > 0 ? [{ from: aOut, to: p.laneA.start, repeat: 1 }, ...p.laneA.path] : p.laneA.path
  const rateCurveA: Keyframe[] = matched && rateA !== 1 ? (glide > 0 ? [{ t: 0, v: 1 }, { t: glide, v: rateA }] : [{ t: 0, v: rateA }]) : []
  const rateCurveB: Keyframe[] =
    matched && rateB !== 1
      ? [
          { t: bAt, v: rateB },
          { t: length, v: rateB },
          { t: length + 4 * GLIDE_BARS_B * periodAt(b, positionB(p, shape.length) ?? p.laneB.start), v: 1 },
        ]
      : []
  return {
    v: 2,
    from: ids.from,
    to: ids.to,
    style,
    preset: shape.preset,
    aOut,
    bAt,
    bIn: p.laneB.start,
    length: shape.length > 0 ? length : 0,
    pathA: shape.length > 0 ? pathA : [],
    pathB: shape.length > 0 ? p.laneB.path : [],
    rateA: rateCurveA,
    rateB: rateCurveB,
    tempo,
    a: moveDeck(shape.a),
    b: moveDeck(shape.b),
    effects: shape.effects.map((e) => (e.kind === 'brake' ? { ...e, at: clock(e.at), length: e.length / rateA } : { ...e, at: clock(e.at) })),
    custom: false,
    confidence,
  }
}

/**
 * What a transition does against the two songs' analyses: seconds where both voices are heard (A's echo included),
 * where both basslines are up (in the music, when the songs have band curves). For the editor's warnings and for tests; 0 and 0 is what the planner promises.
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
    const at = (t: number) => deckPosition(transition, 'a', t) ?? 0
    const echoed = echoedVoice(stats, a, at)
    for (let i = 0; i < sampled.voiceA.length - 1; i++) {
      const t = i * dt
      const tb = deckPosition(transition, 'b', t)
      if (sampled.voiceB[i] <= VOICE_HEARD || tb === null || !b.vocalsKnown || !spanAt(b.vocals, tb)) continue
      const direct = sampled.voiceA[i] > VOICE_HEARD && a.vocalsKnown && spanAt(a.vocals, at(t))
      if (direct || (echoed !== null && echoed[i] >= ECHO_HEARD)) voices += dt
    }
  }
  // Two basslines: in the music where the songs have band curves (a blend may leave both lows open over a part
  // without bass), else in the automation.
  let basses = sampled.basses
  if (a && b && transition.length > 0 && a.mix.bands?.low?.length && b.mix.bands?.low?.length) {
    basses = 0
    for (let t = transition.bAt; t < transition.length; t += 0.1) {
      const pa = deckPosition(transition, 'a', t)
      const pb = deckPosition(transition, 'b', t)
      if (pa === null || pb === null) continue
      const lowA = valueAt(transition.a.gain, t, 1) * valueAt(transition.a.low, t, 1) * filterBands(valueAt(transition.a.filter, t, 0)).low * a.bandsAt(pa).low
      const lowB = valueAt(transition.b.gain, t, 1) * valueAt(transition.b.low, t, 1) * filterBands(valueAt(transition.b.filter, t, 0)).low * b.bandsAt(pb).low
      if (lowA > 0.5 && lowB > 0.5) basses += 0.1
    }
  }
  return { voices, basses }
}
