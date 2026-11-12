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
import { NEEDS_BEATMATCH, RAMP, keyframes, matchLevels, plainCrossfade, presetShape, valueAt, type ConcretePreset, type PresetShape } from './presets.ts'
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
  /** Techniques not to use here ("sort & build" keeps a set varied: no two drop swaps in a row, a few of each). */
  avoid?: Technique[]
  /**
   * Test only (review round 2, off by default): a party blend may let the two voices be heard together for up to this
   * many bars (true: 1), and B may come in inside one of its lines while B is filtered (|filter| >= 0.4) there. Its
   * plans are labelled "Test: Gesang darf sich kurz berühren".
   */
  relaxVoices?: boolean | number
}

/** One-knob filter value from which a deck counts as filtered for `relaxVoices`. */
const RELAX_FILTERED = 0.4

/** The special techniques a set should vary (the rest are plain blends, echoes, fades). */
export type Technique = 'dropSwap' | 'callback' | 'wordplay' | 'mashup'

/** The special technique a planned transition uses, when the planner made it in this session (else undefined). */
const techniques = new WeakMap<Transition, Technique>()
/** The plans made with B held under its low-pass ('lpHold'). */
const heldPlans = new WeakSet<Transition>()
export const techniqueOf = (transition: Transition): Technique | undefined => techniques.get(transition)

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
/**
 * A voice (gain × the louder of mid and high band, through the filter's pass of its intelligibility band) above this
 * is intelligible; at 15 dB down or more it is background, and a background voice under another voice is fine.
 */
const VOICE_HEARD = 0.18
/** Chords and leads (gain × mid band, damped by a closed filter) above this count as sounding. */
const TONAL_HEARD = 0.3
/**
 * An echoed voice over B's singing distracts even when quiet: its repeats count as heard down to this level (with the
 * usual feedback of 0.5, the first three repeats).
 */
const ECHO_HEARD = 0.316
/** Median distance (seconds) between both decks' beats above which a beatmatch is rejected. */
const MAX_DRIFT = 0.015
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
/** Both decks together this far below the louder song's loud level: near silence (a hole a fade must not leave). */
const DEEP_HOLE_DB = -15
/** A blend's quietest bar below this (against the loud level) costs. */
const DIP_DB = -10.5
/**
 * Swing (where the off-beat 16ths fall) further apart than this: a swung and a straight groove flam wherever both are
 * loud, so such a pair hands over with little both-loud time (a bass swap handover, the short S-curve). Not lower: the
 * user's favourite 16-bar Legendary Lovers → Heartbeat blend is 0.51 against 0.58.
 */
const SWING_CLASH = 0.1
/** Room (seconds) a blend's B gets to be moved earlier by the phase fit. */
const PHASE_SLACK = 0.05
/**
 * Below this attack clarity in the bars where both beats are loud, the alignment can't be verified at all; measured
 * with lag3 on the 25 songs, such beatmatches are where the flams are (9 at no floor, 1 at 0.4, for 13 fewer blends).
 */
const MIN_VERIFIABLE = 0.4
/**
 * A deck's beats are heard (and can flam) from this level of the band carrying them on (gain × EQ, -10 dB): its kick
 * where its low band comes through that much, its snares, claps and hats where its mids or highs do.
 */
const BEAT_HEARD = 0.3
const KICK_HEARD = BEAT_HEARD
/** The low-pass knob at which the cutoff is 1.2 kHz (engine mapping): a voice under it is background (party). */
const LP_BACKGROUND = Math.log(1200 / 22050) / Math.log(22050 / 70)
/** Clarity at which a beatmatch counts as fully verifiable (below it, a soft cost). */
const MIN_CLARITY = 0.6
/**
 * Mean offset (seconds) between the decks' beats allowed in any one bar where both are heard, after the fitted rate and
 * phase: a drift the fit can't take out (the songs' tempos bending differently) is heard as the beats sliding apart.
 */
const MAX_BAR_OFFSET = 0.03
/** How far the beats may drift apart over the whole overlap (a straight-line fit of their offsets): the tempos meet. */
const MAX_TREND = 0.005
/** Mean offset (seconds) between the decks' beats allowed in any two bars of a beatmatched overlap. */
const MAX_WINDOW_DRIFT = 0.025
/**
 * How often the same bars may play in a row: a 4-bar loop four times, an 8-bar loop twice. Sixteen bars of the same
 * material is where a listener stops hearing a held groove and starts hearing a song that's stuck.
 */
const MAX_LOOP_BARS = 16
/** A loop plays its bars twice at most: more and the transition feels stuck (the user: "you're basically sampling it"). */
const MAX_LOOP_PLAYS = 2
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

/**
 * Wordplay spots: A's late lines and B's early lines that share a content word (a title word weighs most). A's spot is
 * the first downbeat after its line ends, B's the last downbeat before its line starts (within a bar of it), so B's line
 * answers right after A's. The pair's bonus rides on A's spot.
 */
function wordPairs(a: PreparedTrack, b: PreparedTrack, style: MixStyle): Array<{ pa: Anchor; pb: Anchor; title: boolean; onWord: boolean }> {
  const linesA = Array.isArray(a.mix.lines) && a.mix.vocalSource === 'lyrics' ? a.mix.lines : []
  const linesB = Array.isArray(b.mix.lines) && b.mix.vocalSource === 'lyrics' ? b.mix.lines : []
  if (linesA.length === 0 || linesB.length === 0) return []
  const titles = new Set([...(a.mix.titleWords ?? []), ...(b.mix.titleWords ?? [])])
  const pairs: Array<{ pa: Anchor; pb: Anchor; weight: number; title: boolean; onWord: boolean }> = []
  for (const la of linesA) {
    if (!(la.time >= a.duration * (style === 'party' ? 0.45 : 0.6)) || !(la.end < a.duration - 8 * a.period)) continue
    const iA = Math.max(0, floorIndex(a.downbeats, la.end - 0.05) + 1)
    const ta = a.downbeats[iA]
    if (ta === undefined || ta - la.end > 2 * a.period) continue
    for (const lb of linesB) {
      if (!(lb.time <= b.duration * 0.6)) continue
      const shared = [...new Set(la.words.filter((w) => lb.words.includes(w)))]
      if (shared.length === 0) continue
      const tb = b.downbeats[floorIndex(b.downbeats, lb.time - 0.1)]
      if (tb === undefined || lb.time - tb > 4 * b.period) continue
      // A title word (the hook) answers; two shared ordinary words may too; one ordinary word is chance.
      const title = shared.some((w) => titles.has(w))
      if (!title && shared.length < 2) continue
      const weight = title ? WORDPLAY_TITLE : WORDPLAY_WORD
      // With word timing: B delivers the word in A's place (the user: "'heartless' must come from the NEW song"): A is cut
      // on the beat its word would start on, B's same word starts right there. Both words must sit alike on their beats.
      const word = shared.find((w) => titles.has(w)) ?? shared[0]
      const atA = wordStart(la, word)
      const atB = wordStart(lb, word)
      if (atA !== null && atB !== null && atA >= a.duration * (style === 'party' ? 0.45 : 0.6)) {
        // The 8th at or just before each word's reported start (the times lock to the 8th grid within ~30–60 ms); the
        // two must both be on a beat or both between beats, so the beats line up as the words do.
        const ea = eighthBefore(a, atA)
        const eb = eighthBefore(b, atB)
        if (ea && eb && ea.half === eb.half) {
          pairs.push({ pa: { t: ea.t, bonus: weight + WORDPLAY_ON_WORD, drop: false, chorus: false }, pb: { t: eb.t, bonus: 0, drop: false, chorus: false }, weight: weight + WORDPLAY_ON_WORD, title, onWord: true })
          continue
        }
      }
      pairs.push({ pa: { t: ta, bonus: weight, drop: false, chorus: false }, pb: { t: tb, bonus: 0, drop: false, chorus: false }, weight, title, onWord: false })
    }
  }
  // The strongest few (a title word first, then the latest line of A).
  pairs.sort((x, y) => y.weight - x.weight || y.pa.t - x.pa.t)
  return pairs.slice(0, 24)
}

/** Bonus for a drop swap landing on B's drop (half on a chorus). */
const DROP_SWAP_BONUS = 0.5

/** When a line's words are timed (`wordTimes`, in the order of `words`): where `word` starts in it, else null. */
function wordStart(line: { time: number; words: number[]; wordTimes?: number[] }, word: number): number | null {
  const times = line.wordTimes
  if (!Array.isArray(times) || times.length !== line.words.length) return null
  const k = line.words.indexOf(word)
  const t = k >= 0 ? times[k] : undefined
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

/** The 8th note nearest t (a word's reported start locks to the 8th grid), and whether it's off the beat. */
function eighthBefore(track: PreparedTrack, t: number): { t: number; half: boolean } | null {
  const i = floorIndex(track.beats, t)
  if (i < 0 || i + 1 >= track.beats.length) return null
  const points = [
    { t: track.beats[i], half: false },
    { t: (track.beats[i] + track.beats[i + 1]) / 2, half: true },
    { t: track.beats[i + 1], half: false },
  ]
  return points.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best))
}

/** Extra for a wordplay that replaces A's word with B's (timed words), over one that answers after A's line. */
const WORDPLAY_ON_WORD = 0.3

/** Bonus for a wordplay pair answering with a title word, or with another content word. */
const WORDPLAY_TITLE = 1
const WORDPLAY_WORD = 0.1

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
  // A line's end (and a beat): where a fade, echo or reverb out can leave without cutting a word (on a downbeat when
  // one comes within half a bar). Blends keep to the phrase grid and pass these by.
  for (const span of a.vocals) {
    const t = span.end + a.period
    if (t < from || t >= a.end) continue
    const next = a.downbeats[Math.max(0, floorIndex(a.downbeats, t - 0.01) + 1)]
    addAnchor(list, next !== undefined && next - t <= 2 * a.period ? next : t, 0)
  }
  if (!party && a.vocals.length > 0 && (a.vocalsKnown || a.vocalsAssumed)) {
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
  if (!party && b.vocals.length > 0 && (b.vocalsKnown || b.vocalsAssumed)) {
    // Where B's singing starts: a clean blend brings B fully in there, with its whole intro under A.
    addAnchor(list, snapToPhrase(b, b.vocals[0].start), 0.05)
  }
  if (!party) {
    // Skip-in: B entered at a later section (a chorus, its build, a verse), the earlier part skipped whole, where its
    // energy carries A's on; better where the melody of B's hook comes again (the chorus' second time round).
    const hookAt = b.sections.find((s) => isPeakSection(s.kind))?.start
    const hook = hookAt !== undefined ? b.chromaAt(hookAt) : null
    for (const s of b.sections) {
      if (s.start < b.start + 8 * b.period || s.start > b.duration * 0.6) continue
      if (s.kind !== 'chorus' && s.kind !== 'drop' && s.kind !== 'build' && s.kind !== 'verse') continue
      const repeat = hook ? Math.min(1, Math.max(0, (cosine(b.chromaAt(s.start), hook) - 0.85) / 0.15)) : 0
      addAnchor(list, snapToPhrase(b, s.start), 0.02 + 0.1 * repeat, isPeakSection(s.kind) ? 'chorus' : undefined)
    }
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
  volume?: 'overlap' | 'fade' | 'scurve' | 'mashup' | 'answer' | 'jumpcut' | 'tail'
  bassAt?: 'start' | 'middle' | 'none'
  filterIn?: 'hp' | 'lp' | 'lpHold' | null
  filterOut?: 'hp' | 'lp' | 'eq' | null
  /** Blend: the callback finish (B muted for the bar before the swap, A's element heard alone; see `callbackFits`). */
  callback?: boolean
  /** Blend: bars of B played under A before B's event lands on A's boundary (the swap); the rest come after. */
  pre?: number
  /**
   * 'swap': the chosen phrase starts of both songs meet at the swap, so the moment the bass changes deck lies on a
   * phrase of each (and B's drop or chorus lands on it); 'shape': at the shape's own anchors.
   */
  meet: 'shape' | 'swap'
  prior: number
}

const FREE_LENGTH: ReadonlySet<ConcretePreset> = new Set(['crossfade', 'bassSwap', 'filterBuild', 'fadeOut', 'fadeIn', 'reverbOut'])

/** The shapes with a swap moment line up the phrases there; the others at their own anchors. */
const meetOf = (preset: ConcretePreset): Variant['meet'] => (preset === 'bassSwap' || preset === 'crossfade' || preset === 'filterBuild' ? 'swap' : 'shape')

/**
 * The blend's layouts as a DJ uses them: 16 or 32 bars with both decks at full volume ("overlap") or B fading in, also
 * 24 and 8; 4 bars and the seamless S-curve over 2 as the fallback. Which EQ and
 * filter it gets is chosen per placement (`blendFinishes`).
 */
const BLEND_LAYOUTS: Array<{ volume: 'overlap' | 'fade' | 'scurve' | 'mashup' | 'answer' | 'jumpcut' | 'tail'; pre: number; post: number; prior: number; party: boolean; clean: boolean }> = [
  // B's event lands on A's boundary after `pre` bars of B under A; A plays on, thinned, for `post` bars to its next
  // section, where it leaves. Pop: 4-bar phrases, 8-bar blends; dance music: 8 + 8 or more.
  // Preferred in that order (the user: "you can really take more time"): 16 bars, then 32, then 8; 4 bars and the
  // 2-bar S-curve only when nothing longer passes.
  { volume: 'overlap', pre: 8, post: 8, prior: 0, party: true, clean: true },
  { volume: 'overlap', pre: 0, post: 16, prior: -0.01, party: true, clean: true },
  { volume: 'fade', pre: 8, post: 8, prior: -0.02, party: true, clean: true },
  { volume: 'overlap', pre: 16, post: 16, prior: -0.04, party: true, clean: true },
  { volume: 'fade', pre: 16, post: 16, prior: -0.05, party: true, clean: true },
  { volume: 'overlap', pre: 16, post: 8, prior: -0.06, party: true, clean: true },
  { volume: 'overlap', pre: 4, post: 4, prior: -0.1, party: true, clean: true },
  { volume: 'overlap', pre: 0, post: 8, prior: -0.1, party: true, clean: true },
  { volume: 'overlap', pre: 0, post: 4, prior: -0.5, party: true, clean: true },
  { volume: 'scurve', pre: 1, post: 1, prior: -0.6, party: true, clean: true },
  // The mashup: only where its conditions hold (see `mashupFits`), and then it's the one to have.
  { volume: 'mashup', pre: 12, post: 4, prior: 0.15, party: true, clean: true },
  { volume: 'mashup', pre: 28, post: 4, prior: 0.12, party: true, clean: true },
  // Wordplay (the user's "der ist krank"): B's line answers A's with the same word, a quick 4-bar handover; only placed
  // on a pair of lines sharing a word (`wordPairs`), whose anchors carry the bonus.
  { volume: 'answer', pre: 2, post: 2, prior: -0.2, party: true, clean: true },
  // The wordplay jump cut, preferred where the shared word is a title word (see `wordPairs`).
  { volume: 'jumpcut', pre: 1, post: 1, prior: 0.2, party: true, clean: true },
  // The tail overlap: B under A's own fade-out tail (only where A ends in one, see `fadesOut`), 2 or 4 bars.
  { volume: 'tail', pre: 4, post: 0, prior: -0.15, party: true, clean: true },
  { volume: 'tail', pre: 2, post: 0, prior: -0.17, party: true, clean: true },
  // The drop swap the user asked for more of: B's drop (or chorus) lands on A's boundary after a short beatmatched
  // run-up under A, A goes on it and the bass changes there (party; a bonus where B's event is a drop).
  { volume: 'overlap', pre: 4, post: 0, prior: -0.3, party: true, clean: false },
  { volume: 'overlap', pre: 2, post: 0, prior: -0.32, party: true, clean: false },
]

/**
 * The EQ and filter finishes a blend can take, the common ones first (bass swap in the middle, high-pass in on B and
 * out on A). Keys that clash take the tonal swap at the middle instead of an overlap of mids.
 */
function blendFinishes(variant: Variant, clash: boolean, hold = false): Variant[] {
  // The bass changes deck on the swap (A's boundary): 'start' when B's event opens the blend.
  const at: NonNullable<Variant['bassAt']> = (variant.pre ?? 0) === 0 ? 'start' : 'middle'
  if (variant.volume === 'scurve') return [{ ...variant, bassAt: 'middle', filterIn: null, filterOut: null, midSwap: clash }]
  if (variant.volume === 'tail') return [{ ...variant, bassAt: 'start', filterIn: null, filterOut: null, midSwap: false, prior: variant.prior + BEST_FINISH }]
  if (variant.volume === 'jumpcut') return [{ ...variant, bassAt: 'middle', filterIn: null, filterOut: null, midSwap: false, prior: variant.prior + BEST_FINISH }]
  // A drop swap: B high-passed under A (no bass), A out on B's event, where B's bass comes in.
  if (variant.volume === 'overlap' && (variant.bars - (variant.pre ?? 0)) === 0) return [{ ...variant, bassAt: 'middle', filterIn: 'hp', filterOut: null, midSwap: clash, prior: variant.prior + BEST_FINISH }]
  if (variant.volume === 'answer') return [{ ...variant, bassAt: 'middle', filterIn: null, filterOut: null, midSwap: clash, prior: variant.prior + BEST_FINISH }]
  if (variant.volume === 'mashup') return clash ? [] : [{ ...variant, bassAt: 'middle', filterIn: 'lp', filterOut: 'hp', midSwap: false, prior: variant.prior + BEST_FINISH }]
  const finishes: Array<[NonNullable<Variant['bassAt']>, Variant['filterIn'], Variant['filterOut'], number]> = [
    // The user's Spotify favourites mostly take a filter out on A (high-pass), in on B as well, or a low-pass pair.
    [at, null, 'hp', 0.05],
    [at, 'hp', 'hp', 0.045],
    [at, 'lp', 'lp', 0.04],
    [at, null, 'lp', 0.035],
    [at, null, 'eq', 0.03],
    // B held under a hard low-pass until the swap, then open (for a B entered on unclear bars: its accents stay unheard
    // while A's are; the user's Spotify Rock That Body → Outside). Only its kick and bass come through, so the bass
    // changes deck at the start.
    ['start', 'lpHold', null, 0.025],
    ['none', null, null, 0],
  ]
  const list: Variant[] = finishes
    // (The held low-pass under a full overlap of at most 16 bars.)
    .filter(([, filterIn]) => filterIn !== 'lpHold' || (hold && variant.volume === 'overlap' && variant.bars <= 16))
    .map(([bassAt, filterIn, filterOut, prior]) => ({ ...variant, bassAt, filterIn, filterOut, midSwap: clash, prior: variant.prior + prior }))
  // The callback: B under an opening low-pass, muted for the bar before the swap, back with its bass on it; A out under
  // a closing low-pass. Placed only where A has something to hear alone there and B returns on an event (`callbackFits`).
  if (variant.volume === 'overlap' && (variant.pre ?? 0) >= 4) list.unshift({ ...variant, bassAt: 'middle', filterIn: 'lp', filterOut: 'lp', midSwap: clash, callback: true, prior: variant.prior - 0.05 })
  return list
}

/** How far an echo out's prior sits under the reverb out's (round 2). */
const ECHO_BELOW = 0.1

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
        // Clean prefers B fading in (the user's pick among Titanium → Animals' variants) where all else is equal.
        prior: prior + layout.prior + BLEND_FIRST + (style === 'clean' && layout.volume === 'fade' ? 0.03 : 0),
      })
    }
  }
  // Automatic transitions never cut: a cut has to be perfect to work. The blend is the transition to have wherever the
  // tempos can be matched and it passes every rule (its prior outweighs the score terms of a neat echo out); without a
  // match, an echo out or a filtered fade.
  // The reverb out is the softer echo out: A dissolves into B (a sparse or sung ending suits it).
  // Round 2: echo outs were rated "schlecht" or 3 stars on four pairs (the Right Round → Beauty And A Beat one stays
  // "gut"): an echo out comes after the blends, the reverb out and the fades (ECHO_BELOW).
  if (style === 'clean' && synced) {
    addBlends(0.9)
    add('echoOut', -ECHO_BELOW)
    add('reverbOut', 0.01, [4, 2])
    add('fadeOut', -0.02, [4])
  } else if (style === 'clean') {
    add('echoOut', 0.15 - ECHO_BELOW)
    add('reverbOut', 0.16, [2])
    add('fadeOut', 0.12, [4])
    add('fadeIn', 0, [2])
  } else if (synced) {
    addBlends(0.75)
    add('echoOut', 0.05 - ECHO_BELOW)
    add('reverbOut', 0.05, [4, 2])
  } else {
    add('echoOut', 0.12 - ECHO_BELOW)
    add('reverbOut', 0.12, [2])
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
  /**
   * Per sample: the level of the deck's snares, claps, hats (and chops) as heard: gain × the louder of mids and highs
   * through the filter. (Mids under a low-pass count too: taking them off let Outside → Beauty And A Beat through as an
   * 8-bar blend the lag judge hears flam.)
   */
  accentA: Float32Array
  accentB: Float32Array
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

/**
 * How much of a voice's intelligibility (its 1–4 kHz) a filter knob lets through, with the player's knob-to-cutoff
 * mapping (engine.ts filterFrequencies: high-pass 20 Hz × 450^knob, low-pass Nyquist × (70 Hz / Nyquist)^-knob, at
 * 44.1 kHz). A rising high-pass takes the bass first and leaves a voice clear until its cutoff passes about 1 kHz; a
 * closing low-pass turns it into background (no longer intelligible) by about 800 Hz.
 */
const voicePasses = new Map<number, number>()
function voicePass(f: number) {
  if (f === 0) return 1
  const key = Math.round(f * 1000)
  let pass = voicePasses.get(key)
  if (pass === undefined) {
    pass = voicePassAt(key / 1000)
    voicePasses.set(key, pass)
  }
  return pass
}

function voicePassAt(f: number) {
  const knob = Math.max(-1, Math.min(1, f))
  const cutoff = knob > 0 ? 20 * 450 ** knob : knob < 0 ? 22050 * (70 / 22050) ** -knob : NaN
  if (Number.isNaN(cutoff)) return 1
  const passed = knob > 0 ? Math.log(4000 / cutoff) / Math.log(4000 / 1000) : Math.log(cutoff / 800) / Math.log(4000 / 800)
  return Math.min(1, Math.max(0, passed))
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
    if (t < curve[0].t) return curve[0].v
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
  const accentA = new Float32Array(steps + 1)
  const accentB = new Float32Array(steps + 1)
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
    // which carry a voice on their own), through the filter as far as it passes the voice's 1–4 kHz. A deck's beats are heard where its kick (gain × low,
    // no high-pass) or its accents (gain × the louder of mids and highs, no low-pass) are up to BEAT_HEARD: each can
    // flam on its own, hats at -8 dB too.
    voiceA[i] = ga * Math.max(ma, ha) * voicePass(fa)
    voiceB[i] = gb * Math.max(mb, hb) * voicePass(fb)
    gainA[i] = ga
    gainB[i] = gb
    loudA[i] = (ga * la >= BEAT_HEARD && fa <= 0.4) || (ga * Math.max(ma, ha) >= BEAT_HEARD && fa >= -0.4) ? 1 : 0
    loudB[i] = (gb * lb >= BEAT_HEARD && fb <= 0.4) || (gb * Math.max(mb, hb) >= BEAT_HEARD && fb >= -0.4) ? 1 : 0
    passA.low[i] = ga * la * pa.low
    passA.mid[i] = ga * ma * pa.mid
    passA.high[i] = ga * ha * pa.high
    passB.low[i] = gb * lb * pb.low
    passB.mid[i] = gb * mb * pb.mid
    passB.high[i] = gb * hb * pb.high
    accentA[i] = Math.max(passA.mid[i], passA.high[i])
    accentB[i] = Math.max(passB.mid[i], passB.high[i])
    if (ga > 0.05) aGone = t + dt
    if (gb > 0.05 && bHere < 0) bHere = t
    if (voiceB[i] > VOICE_HEARD && bVoice < 0) bVoice = t
    if (i < steps) {
      if (ga > 0.2 && gb > 0.2) {
        together += dt
        if (togetherFrom < 0) togetherFrom = t
        togetherTo = t + dt
      }
      if (ga * ma * da > TONAL_HEARD && gb * mb * db > TONAL_HEARD) tonal += dt
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
    accentA,
    accentB,
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
  /** Seconds where one deck's accents were ducked under a risky bar of its own (see `duckRisky`). */
  ducked?: number
}

const positionA = (p: Placement, tau: number) => lanePosition(p.laneA, tau)
const positionB = (p: Placement, tau: number) => (tau < p.bStart - 1e-9 ? null : lanePosition(p.laneB, (tau - p.bStart) * p.rate))

/** Seconds of singing heard over each other, and of each song's singing lost (muffled, cut mid-line, entered mid-line). */
function vocalCost(p: Placement, a: PreparedTrack, b: PreparedTrack, party = false) {
  let muffledUnder = 0
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
      // Measured singing, or singing assumed where nothing was measured (voice-like body sections): both count.
      const aSings = !!spanAt(a.vocals, positionA(p, t))
      const bSings = tb !== null && !!spanAt(b.vocals, tb)
      // In a tail overlap A's own fade counts: its last line under -10 dB of its loud level is background.
      const aHeard = stats.voiceA[i] > VOICE_HEARD && (p.variant.volume !== 'tail' || a.energyBetween(positionA(p, t), positionA(p, t) + 0.2) >= 0.32)
      const bHeard = stats.voiceB[i] > VOICE_HEARD
      if (bSings && bHeard && ((aSings && aHeard) || (echoed !== null && echoed[i] >= ECHO_HEARD))) {
        // Party: B's voice under A's while B is low-passed at 1.2 kHz or less is background, for 4 bars at most.
        if (party && muffledUnder < 16 * stats.beat && valueAt(stats.shape.b.filter, t, 0) <= LP_BACKGROUND) muffledUnder += dt
        else clash += dt
      }
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
  let hole = 0
  let run = 0
  const levels: number[] = []
  if (length <= 0 || dt <= 0) return { over: -Infinity, mean: 0, basses: 0, busy: 0, hole: 0, dip: 0 }
  const { passA, passB } = stats
  // Two basslines, at every sample (the moments around a swap matter): checked first, it rejects.
  for (let i = 0; i < stats.gainA.length; i++) {
    const t = i * dt
    if (t < p.bStart || t > length || passA.low[i] * 1.5 <= 0.5 || passB.low[i] * 1.5 <= 0.5) continue
    const atB = positionB(p, t)
    if (atB === null) continue
    if (passA.low[i] * a.bandsAt(positionA(p, t)).low > 0.5 && passB.low[i] * b.bandsAt(atB).low > 0.5) basses += dt
  }
  if (basses > 0) return { over: -Infinity, mean: 0, basses, busy: 0, hole: 0, dip: 0 }
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
    levels.push(sum / 3)
    total += sum / 3
    samples++
    // A stretch where both together sit far below the louder song's loud level: a hole.
    if (10 * Math.log10(Math.max(sum / 3, 1e-9)) < DEEP_HOLE_DB) {
      run += step * dt
      hole = Math.max(hole, run)
    } else run = 0
    busy += Math.min(1, (eA.mid + eA.high + eB.mid + eB.high) / 4)
  }
  if (samples === 0) return { over: -Infinity, mean: 0, basses: 0, busy: 0, hole: 0, dip: 0 }
  over.sort((x, y) => x - y)
  // The quietest bar (mean power over any bar's worth of samples) against the loud level.
  const perBar = Math.max(1, Math.round((4 * stats.beat) / (step * dt)))
  let dip = 0
  if (levels.length >= perBar) {
    let windowSum = 0
    dip = Infinity
    for (let i = 0; i < levels.length; i++) {
      windowSum += levels[i]
      if (i >= perBar) windowSum -= levels[i - perBar]
      if (i >= perBar - 1) dip = Math.min(dip, 10 * Math.log10(Math.max(windowSum / perBar, 1e-9)))
    }
  }
  return { over: over[Math.floor(over.length * 0.95)], mean: 10 * Math.log10(Math.max(total / samples, 1e-9)), basses, busy: busy / samples, hole, dip }
}

/**
 * Whether a track at `pos` is inside one of its measured sung lines, more than 0.15 s after its first sung word (the
 * line's start where its words aren't timed: Judas → Cannibal's 4-star blend enters 0.2 s after a line's start, 0.2 s
 * before its first word).
 */
function entersMidLine(track: PreparedTrack, pos: number) {
  const lines = Array.isArray(track.mix.lines) && track.mix.vocalSource === 'lyrics' ? track.mix.lines : []
  return lines.some((line) => pos > Math.max(line.time, line.wordTimes?.[0] ?? line.time) + 0.15 && pos < line.end)
}

/** Whether one of a track's measured lines started within `seconds` before `pos` (and is still going there). */
function lineStartedBefore(track: PreparedTrack, pos: number, seconds: number) {
  const lines = Array.isArray(track.mix.lines) && track.mix.vocalSource === 'lyrics' ? track.mix.lines : []
  return lines.some((line) => line.time < pos && pos - line.time < seconds && pos < line.end)
}

/** A song's absolute level over a stretch (amplitude, its loudness × the stretch's energy against its mean). */
function levelOver(track: PreparedTrack, from: number, to: number) {
  const mean = track.energyBetween(track.start, track.end)
  return mean > 0 ? (track.level * track.energyBetween(from, to)) / mean : track.level
}

/**
 * How far B's level after the handover (its 4 bars after A is gone) falls below A's before it (A's 2 bars before the
 * swap, where it still plays in full), in dB; negative where B is louder.
 */
function handoverDrop(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const { stats } = p
  const swap = stats.shape.length > 0 ? Math.min(stats.shape.swap, stats.aGone) : 0
  const atA = positionA(p, swap)
  const atB = positionB(p, stats.aGone) ?? p.laneB.start
  const before = levelOver(a, atA - 8 * a.period, atA)
  const after = levelOver(b, atB, atB + 16 * b.period)
  let drop = before > 0 && after > 0 ? 20 * Math.log10(before / after) : 0
  // Per band where both analyses carry absolute band levels (an EDM drop into a piano ballad loses its highs): the
  // worst of A's bands that mattered (within 12 dB of A's loudest band there).
  const bandA = bandLevels(a, atA - 8 * a.period, atA)
  const bandB = bandLevels(b, atB, atB + 16 * b.period)
  if (bandA && bandB) {
    const top = Math.max(bandA.low, bandA.mid, bandA.high)
    for (const band of ['low', 'mid', 'high'] as const) if (bandA[band] >= top - 12) drop = Math.max(drop, bandA[band] - bandB[band])
  }
  return drop
}

/** Most a transition may rise from A's level just before B comes in to B's just after A is gone (dB). */
const MAX_RISE_DB = 6

/** dB from A's level over the 3 s before B is heard to B's over the 3 s after A is gone (positive: louder after). */
function continuityRise(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const { stats } = p
  const atA = positionA(p, stats.bHere)
  const atB = positionB(p, stats.aGone) ?? p.laneB.start
  const before = levelOver(a, atA - 3, atA)
  const after = levelOver(b, atB, atB + 3)
  return before > 0 && after > 0 ? 20 * Math.log10(after / before) : 0
}

/** A track's absolute band levels (dB FS) over a stretch, from bandLoudness and its band curves; null when unknown. */
function bandLevels(track: PreparedTrack, from: number, to: number) {
  const loud = track.mix.bandLoudness
  const bands = track.mix.bands
  const rate = track.mix.frameRate
  if (!loud || !bands || !(rate > 0) || !Number.isFinite(loud.low) || !Number.isFinite(loud.mid) || !Number.isFinite(loud.high)) return null
  const mean = (curve: number[]) => {
    let sum = 0
    let count = 0
    for (let f = Math.max(0, Math.floor(from * rate)); f < Math.min(curve.length, Math.ceil(to * rate)); f++) {
      sum += curve[f] ** 2
      count++
    }
    return count > 0 ? Math.sqrt(sum / count) : 0
  }
  const db = (base: number, curve: number[]) => base + 20 * Math.log10(Math.max(1e-3, mean(curve)))
  return { low: db(loud.low, bands.low), mid: db(loud.mid, bands.mid), high: db(loud.high, bands.high) }
}

/**
 * How much B's heard level (gain × EQ × filter over its absolute bands) jumps from the beat before the swap to the beat
 * after it, in dB: a B held thin and then thrown in at once.
 */
function handoverJump(p: Placement, b: PreparedTrack) {
  const { stats } = p
  const { dt, passB } = stats
  if (dt <= 0) return 0
  const swap = stats.shape.swap
  const heard = (t0: number, t1: number) => {
    let sum = 0
    let count = 0
    for (let i = Math.max(0, Math.round(t0 / dt)); i <= Math.min(passB.low.length - 1, Math.round(t1 / dt)); i++) {
      const at = positionB(p, i * dt)
      if (at === null) continue
      const e = b.bandsAt(at)
      sum += (passB.low[i] * e.low) ** 2 + (passB.mid[i] * e.mid) ** 2 + (passB.high[i] * e.high) ** 2
      count++
    }
    return count > 0 ? sum / count : 0
  }
  const before = heard(swap - stats.beat, swap - 0.02)
  const after = heard(swap + 0.02, swap + stats.beat)
  return before > 1e-6 && after > 0 ? 10 * Math.log10(after / before) : 0
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
    // Every beat while both decks play, however quiet one of them is (a deck at -16 dB still flams audibly).
    if (i < 0 || i >= stats.gainA.length || stats.gainA[i] <= 0.02 || stats.gainB[i] <= 0.02) continue
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
  if (offsets.length === 0) return { median: 0, p90: 0, checked: heard === 0 ? 1 : 0, worstWindow: 0, worstBar: 0, trend: 0 }
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
  // Per bar of A (4 beats) where both decks' beats are heard in any band (the offsets are taken only there): the mean
  // offset, which the fitted rate and phase must keep within MAX_BAR_OFFSET everywhere.
  const bars = new Map<number, { sum: number; count: number }>()
  times.forEach((t, i) => {
    const w = Math.floor(t / (4 * p.stats.beat))
    const entry = bars.get(w) ?? { sum: 0, count: 0 }
    entry.sum += offsets[i]
    entry.count++
    bars.set(w, entry)
  })
  let worstBar = 0
  for (const { sum, count } of bars.values()) if (count >= 3) worstBar = Math.max(worstBar, Math.abs(sum / count))
  // What the offsets drift by over the overlap (a straight-line fit): the tempos not quite meeting.
  let trend = 0
  if (times.length >= 4) {
    const meanT = times.reduce((sum, t) => sum + t, 0) / times.length
    const meanO = offsets.reduce((sum, o) => sum + o, 0) / offsets.length
    let num = 0
    let den = 0
    for (let i = 0; i < times.length; i++) {
      num += (times[i] - meanT) * (offsets[i] - meanO)
      den += (times[i] - meanT) ** 2
    }
    trend = den > 0 ? Math.abs((num / den) * (times[times.length - 1] - times[0])) : 0
  }
  return { median: sorted[sorted.length >> 1], p90: sorted[Math.floor(sorted.length * 0.9)], checked: offsets.length / heard, worstWindow, worstBar, trend }
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
  for (let round = 0; round < 3; round++) {
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
    // The tempos must meet exactly over the overlap: any slope left is a drift (rateOk is checked by the caller).
    const rate = Math.abs(slope) < 0.03 ? current.rate / (1 - slope) : current.rate
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
  // (least squares): the accents always, the kicks 2:1 for the share of the time both basses sound.
  // Where both decks' accents are heard most of the overlap, the accents decide (snares flaming are what's heard; the
  // kicks only count for the time both lows sound and the accents don't).
  const { stats } = p
  let accentsBoth = 0
  let heardBoth = 0
  for (let i = 0; i < stats.loudA.length; i++) {
    if (!stats.loudA[i] || !stats.loudB[i]) continue
    heardBoth++
    if (Math.max(stats.passA.mid[i], stats.passA.high[i]) >= BEAT_HEARD && Math.max(stats.passB.mid[i], stats.passB.high[i]) >= BEAT_HEARD) accentsBoth++
  }
  const accentShare = heardBoth > 0 ? accentsBoth / heardBoth : 1
  const kickWeight = 2 * stats.kicksTogether * (1 - accentShare)
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

/**
 * Whether a mashup fits: keys the same or relative (harmonic score ≥ 0.9), the phrases meeting at the swap alike in
 * harmony (chroma cosine ≥ 0.8), and exactly one deck singing in the overlap (its voice heard for 2 s or more, the
 * other's for a quarter second at most) — one song's vocals over the other's instrumental part.
 */
function mashupFits(p: Placement, a: PreparedTrack, b: PreparedTrack, harmony: number) {
  if (harmony < 0.9) return false
  const { stats } = p
  const swap = stats.shape.swap
  if (cosine(a.chromaAt(positionA(p, swap)), b.chromaAt(positionB(p, swap) ?? p.laneB.start)) < 0.8) return false
  let singsA = 0
  let singsB = 0
  for (let i = 0; i < stats.voiceA.length - 1; i++) {
    const t = i * stats.dt
    if (t < p.bStart || t > stats.shape.length) continue
    const tb = positionB(p, t)
    if (stats.voiceA[i] > VOICE_HEARD && spanAt(a.vocals, positionA(p, t))) singsA += stats.dt
    if (tb !== null && stats.voiceB[i] > VOICE_HEARD && spanAt(b.vocals, tb)) singsB += stats.dt
  }
  return (singsA >= 2 && singsB <= 0.25) || (singsB >= 2 && singsA <= 0.25)
}

/**
 * Whether a callback fits: B returns on an event (its drop or chorus is the anchor it lands on), and A has something
 * to be heard alone in the bar before the swap: a sung line ending there or a mid-band hit standing out.
 */
function callbackFits(p: Placement, a: PreparedTrack) {
  if (!p.pb.drop && !p.pb.chorus) return false
  const swap = p.stats.shape.swap
  const from = positionA(p, swap - 4 * p.stats.beat)
  const to = positionA(p, swap)
  // A sung line that ends in that bar or just before it (measured lines: an assumed span ends anywhere), or a hit
  // standing out in the mids.
  if (a.vocalsKnown && a.vocals.some((span) => span.end > from - 2 * p.stats.beat && span.end <= to)) return true
  for (let t = from; t < to; t += 0.1) if (a.bandsAt(t).mid >= 1.2) return true
  return false
}

/**
 * A only goes out and B only comes in: A's gain and bands never rise and its filter never moves back towards open; B's
 * the other way round (B's gain may dip on the callback's muted bar). A tolerance of 0.1 lets equal-power curves be.
 */
function monotonic(shape: PresetShape, callback: boolean) {
  // `dir`: the way the curve may go (-1 down, 1 up); a step of more than 0.1 the other way breaks it.
  const never = (curve: Keyframe[], dir: 1 | -1, magnitude = false) => {
    for (let k = 1; k < curve.length; k++) {
      const x = magnitude ? Math.abs(curve[k - 1].v) : curve[k - 1].v
      const y = magnitude ? Math.abs(curve[k].v) : curve[k].v
      if (-dir * (y - x) > 0.1) return false
    }
    return true
  }
  const { a, b } = shape
  const aDown = [a.gain, a.low, a.mid, a.high].every((curve) => never(curve, -1))
  const aFilter = never(a.filter, 1, true)
  const bUp = (callback ? [b.low, b.mid, b.high] : [b.gain, b.low, b.mid, b.high]).every((curve) => never(curve, 1))
  const bFilter = never(b.filter, -1, true)
  return aDown && aFilter && bUp && bFilter
}

/**
 * B is in (gain 0.9, every band 0.8, filter open) over the 2 beats before A's last band falls under BEAT_HEARD: B
 * carries the music when A goes.
 */
function readyAtExit(stats: ShapeStats) {
  const { passA, passB, gainB, dt } = stats
  let exit = -1
  for (let i = 0; i < passA.low.length; i++) if (Math.max(passA.low[i], passA.mid[i], passA.high[i]) >= BEAT_HEARD) exit = i
  if (exit < 0) return true
  const from = Math.max(0, exit - Math.round((2 * stats.beat) / Math.max(dt, 1e-6)))
  for (let i = from; i <= exit; i++) if (gainB[i] < 0.9 || Math.min(passB.low[i], passB.mid[i], passB.high[i]) < 0.8) return false
  return true
}

/**
 * A reverb out is cut on a line's end, not in one, and its hall (about a second at full, then -10 dB and below) isn't
 * laid under B's first line: when A sings into its last second, B's voice waits a second after the cut.
 */
function reverbFits(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const length = p.stats.shape.length
  const end = positionA(p, length)
  if (spanAt(a.vocals, end - 0.05)) return false
  if (!spansTouch(a.vocals, end - 1, end)) return true
  const atB = positionB(p, length)
  return atB === null || !spansTouch(b.vocals, atB, atB + 1)
}

/**
 * Whether a song ends in its own fade-out: its level over the 2 bars before its audible end at least 6 dB under that of
 * the 4 bars before them (the energy curve is relative amplitude).
 */
function fadesOut(track: PreparedTrack) {
  const bar = 4 * track.period
  // Up to where anything is left at all (its `end` stops at the loud part and would cut the fade itself off).
  const energy = track.mix.energy
  const rate = track.mix.frameRate
  let last = Array.isArray(energy) ? energy.length - 1 : -1
  while (last > 0 && energy[last] < 0.03) last--
  const end = last > 0 && rate > 0 ? Math.min(track.duration, (last + 1) / rate) : track.end
  const tailLevel = track.energyBetween(end - 2 * bar, end)
  const before = track.energyBetween(end - 6 * bar, end - 2 * bar)
  return before > 0.05 && tailLevel <= 0.5 * before
}

/**
 * The placement with A's mid, high and filter moves held back until A's last sung line within the blend has ended (they
 * then run over the time left, in the same shape); itself when they already wait; null when A sings to the end.
 */
function keepLineClear(p: Placement, a: PreparedTrack): Placement | null {
  const { stats } = p
  const length = stats.shape.length
  if (length <= 0 || stats.dt <= 0) return p
  let lineEnd = -1
  for (let t = 0; t <= length; t += 0.05) if (spanAt(a.vocals, positionA(p, t))) lineEnd = t
  if (lineEnd < 0) return p
  const shape = stats.shape
  const moves = (curve: Keyframe[], neutral: number) => curve.findIndex((k) => Math.abs(k.v - neutral) > 0.02)
  const starts = [moves(shape.a.mid, 1), moves(shape.a.high, 1), moves(shape.a.filter, 0)]
  const first = Math.min(...[shape.a.mid, shape.a.high, shape.a.filter].map((curve, n) => (starts[n] >= 0 ? curve[Math.max(0, starts[n] - 1)].t : Infinity)))
  const from = lineEnd + 0.05
  if (!Number.isFinite(first) || first >= from) return p
  if (from >= length - stats.beat) return null
  const remap = (curve: Keyframe[], neutral: number): Keyframe[] => {
    if (curve.length === 0) return curve
    const span = length - first
    return [{ t: 0, v: neutral }, { t: from, v: neutral }, ...curve.filter((k) => k.t >= first).map((k) => ({ t: from + ((k.t - first) * (length - from)) / span, v: k.v }))]
  }
  const next: PresetShape = { ...shape, a: { ...shape.a, mid: remap(shape.a.mid, 1), high: remap(shape.a.high, 1), filter: remap(shape.a.filter, 0) } }
  return { ...p, stats: shapeStats(next, p.variant.meet, stats.beat) }
}

/** A song's accent spread (seconds); 0 when unknown. */
function spreadOf(mix: TrackMix) {
  const value: unknown = mix.accentSpread
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 0.1 ? value : 0
}

/**
 * Combined accent spread (both songs', root of squares) from which a long both-heard overlap starts to cost: above the
 * user's approved Right Round → Beauty And A Beat (0.016) and Legendary Lovers → Heartbeat (0.018).
 */
const GROOVE_SPREAD = 0.02

/** A bar repeats the one, two or four before it (barRepeat) from here; 40 % such bars in A's overlap sound looped. */
const REPEATED_BAR = 0.8

/** The share of a track's bars in [from, to] that repeat the bar or two before them; 0 without the measure or bars. */
function repeatedShare(track: PreparedTrack, from: number, to: number) {
  const repeat: unknown = track.mix.barRepeat
  if (!Array.isArray(repeat) || repeat.length !== track.downbeats.length) return 0
  const first = Math.max(0, floorIndex(track.downbeats, from + 0.05))
  let count = 0
  let same = 0
  for (let k = first; k < repeat.length && track.downbeats[k] < to - 0.05; k++) {
    const value = repeat[k]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    count++
    if (value > REPEATED_BAR) same++
  }
  return count >= 4 ? same / count : 0
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
  // A faint accent over a scattered bar for a beat at most (a deck's last beat fading under its filter) passes.
  let faint = 0
  let faintLeast = Infinity
  for (let i = 0; i < stats.loudA.length; i += step) {
    const t = i * dt
    if (t > length || t < p.bStart || !bothHeard(stats, i)) continue
    const atA = positionA(p, t)
    const atB = positionB(p, t) ?? 0
    // B before its first beat has no grid to match: -1 rejects. A after its last beat is its tail (a play-out to its
    // audible end): no beats of A there to flam with.
    if (atB < (b.beats[0] ?? 0) - 0.05) return -1
    if (atA > (a.beats[a.beats.length - 1] ?? Infinity) + 0.05) continue
    const risk = riskAt(stats, i, a, b, atA, atB)
    const value = risk.value
    if (Number.isNaN(value)) return NaN
    if (risk.faint) {
      faint += step * dt
      faintLeast = Math.min(faintLeast, value)
    } else least = Math.min(least, value)
  }
  if (faint > stats.beat) least = Math.min(least, faintLeast)
  return Number.isFinite(least) ? least : 1
}

/**
 * How safe the attacks both decks let be heard at a sample are (0–1): a deck's accent clarity where its snares, claps
 * and hats come through (its mids or highs at BEAT_HEARD, through the filter), and both kicks' clarity where both lows
 * do (a killed or filtered low hides a kick; a ducked deck is left with its kick alone). `riskyA`/`riskyB`: whose
 * accents fall under MIN_VERIFIABLE; `kickRisk`: the kicks do.
 */
/** Whether B has a scattered bar (clarity SCATTERED or less) while it's held under its low-pass ('lpHold', all but the last beat). */
function heldUnclear(p: Placement, b: PreparedTrack) {
  const { stats } = p
  const length = stats.shape.length
  for (let t = Math.max(0, p.bStart); t < length - stats.beat; t += stats.beat) {
    const atB = positionB(p, t)
    if (atB === null) continue
    const c = b.clarityBetween(atB, atB + 0.01)
    if (Number.isFinite(c) && c <= SCATTERED) return true
  }
  return false
}

/**
 * B's mean attack clarity over the overlap where its accents are heard (1 without a clarity analysis): B is better
 * entered on clear bars than on a scattered texture (Rock That Body → Outside: Outside's chops at 1:09–1:25).
 */
function entryClarity(p: Placement, b: PreparedTrack) {
  const { stats } = p
  const { dt } = stats
  if (dt <= 0 || stats.shape.length <= 0) return 1
  const step = Math.max(1, Math.round(0.25 / dt))
  let sum = 0
  let n = 0
  for (let i = 0; i < stats.passB.mid.length; i += step) {
    const t = i * dt
    if (t < p.bStart || t > stats.shape.length || stats.accentB[i] < ACCENT_FAINT) continue
    const atB = positionB(p, t)
    if (atB === null) continue
    const c = b.clarityBetween(atB, atB + 0.01)
    if (!Number.isFinite(c)) return 1
    sum += c
    n++
  }
  return n > 0 ? sum / n : 1
}

/**
 * Both decks heard at a sample: loud (a band at -10 dB) or with accents at -20 dB through their filters, which flam
 * against a scattered bar (see `riskAt`, which decides).
 */
const bothHeard = (stats: ShapeStats, i: number) =>
  (stats.loudA[i] || stats.accentA[i] >= ACCENT_FAINT) && (stats.loudB[i] || stats.accentB[i] >= ACCENT_FAINT)

function riskAt(stats: ShapeStats, i: number, a: PreparedTrack, b: PreparedTrack, atA: number, atB: number) {
  const clarA = a.clarityBetween(atA, atA + 0.01)
  const clarB = b.clarityBetween(atB, atB + 0.01)
  // Against a bar with next to no clear attacks (a scattered texture: vocal chops, an arp; clarity 0.25 or less) the
  // other deck's accents count from -20 dB, not -10 (Rock That Body → Outside at 1:09: A's low-passed snare at -16 dB
  // over Outside's chops measured 20–25 ms apart).
  const levelA = stats.accentA[i]
  const levelB = stats.accentB[i]
  // (The scattered deck's own texture counts where it's heard as usual, from -10 dB.)
  const scatteredA = Number.isFinite(clarA) && clarA <= SCATTERED && levelA >= BEAT_HEARD
  const scatteredB = Number.isFinite(clarB) && clarB <= SCATTERED && levelB >= BEAT_HEARD
  const accA = levelA >= (scatteredB ? ACCENT_FAINT : BEAT_HEARD)
  const accB = levelB >= (scatteredA ? ACCENT_FAINT : BEAT_HEARD)
  // Snares, claps and hats flam against the other deck's (both heard); a deck left with its kick alone doesn't.
  const cA = accA && accB ? clarA : 1
  const cB = accA && accB ? clarB : 1
  let kick = 1
  if (stats.passA.low[i] >= KICK_HEARD && stats.passB.low[i] >= KICK_HEARD) kick = Math.min(a.kickClarityBetween(atA, atA + 0.01), b.kickClarityBetween(atB, atB + 0.01))
  // `faint`: risky only through an accent between -20 and -10 dB over a scattered bar.
  const faint = Math.min(cA, cB) < MIN_VERIFIABLE && (levelA < BEAT_HEARD || levelB < BEAT_HEARD) && kick >= MIN_VERIFIABLE
  return { value: Math.min(cA, cB, kick), riskyA: cA < MIN_VERIFIABLE, riskyB: cB < MIN_VERIFIABLE, kickRisk: kick < MIN_VERIFIABLE, cA, cB, faint }
}

/** Seconds (every 0.1 s) where both decks' beats are heard on a risky bar of either (clarity under MIN_VERIFIABLE). */
function riskyTime(p: Placement, a: PreparedTrack, b: PreparedTrack) {
  const { stats } = p
  const { dt } = stats
  if (dt <= 0) return 0
  const step = Math.max(1, Math.round(0.1 / dt))
  const lastBeatA = a.beats[a.beats.length - 1] ?? Infinity
  let risky = 0
  for (let i = 0; i < stats.loudA.length; i += step) {
    const t = i * dt
    if (t > stats.shape.length || t < p.bStart || !bothHeard(stats, i)) continue
    const atA = positionA(p, t)
    if (atA > lastBeatA + 0.05) continue
    const atB = positionB(p, t) ?? 0
    if (riskAt(stats, i, a, b, atA, atB).value < MIN_VERIFIABLE) risky += step * dt
  }
  return risky
}

/**
 * The level a ducked deck's mids and highs go down to: -16 dB, under the -10 dB from which its accents are heard (not
 * under the -20 dB that counts against a scattered bar: such a bar with both decks' accents is out, not ducked).
 */
const DUCK = 0.15
/** Attack clarity at or under which a bar is a scattered texture (see `riskAt`). */
const SCATTERED = 0.25
/** Where accents count as heard against a scattered bar: -20 dB. */
const ACCENT_FAINT = 0.1
/**
 * How many candidates get the sampled checks before the best found so far is taken (measured on 25 songs: the best is
 * found within the first 60 for 90 % of pairs; a few with many long blends failing their gates take thousands).
 */
const JUDGE_BUDGET = 1500

/** At most this many bars of a blend may be ducked (more is no longer the blend it was meant to be). */
const MAX_DUCK_BARS = 4

/**
 * Ducks the accents (mids and highs) of the deck whose bars are risky (clarity under MIN_VERIFIABLE) wherever both decks'
 * beats are heard there, so those bars aren't heard on both any more. Kicks are not ducked (a placement whose kicks
 * would flam is out). Null when there's nothing to duck that way or too much of it.
 */
function duckRisky(p: Placement, a: PreparedTrack, b: PreparedTrack): Placement | null {
  const { stats } = p
  const { dt } = stats
  const length = stats.shape.length
  if (dt <= 0) return null
  const lastBeatA = a.beats[a.beats.length - 1] ?? Infinity
  const runs = { a: [] as Array<[number, number]>, b: [] as Array<[number, number]> }
  // A coarse pass first (every 0.1 s): most placements have too much risk to duck, or flamming kicks.
  const coarse = Math.max(1, Math.round(0.1 / dt))
  let estimate = 0
  for (let i = 0; i < stats.loudA.length; i += coarse) {
    const t = i * dt
    if (t > length || t < p.bStart || !bothHeard(stats, i)) continue
    const atA = positionA(p, t)
    const atB = positionB(p, t) ?? 0
    if (atA > lastBeatA + 0.05) continue
    const risk = riskAt(stats, i, a, b, atA, atB)
    if (risk.kickRisk) return null
    if (risk.riskyA || risk.riskyB) estimate += coarse * dt
    if (estimate > MAX_DUCK_BARS * 4 * stats.beat + 0.2) return null
  }
  let total = 0
  for (let i = 0; i < stats.loudA.length; i++) {
    const t = i * dt
    if (t > length || t < p.bStart || !bothHeard(stats, i)) continue
    const atA = positionA(p, t)
    const atB = positionB(p, t) ?? 0
    if (atA > lastBeatA + 0.05) continue
    const risk = riskAt(stats, i, a, b, atA, atB)
    if (risk.kickRisk) return null
    if (!risk.riskyA && !risk.riskyB) continue
    // A's accents go down (A is leaving anyway): then no accents of both decks are heard together there.
    const last = runs.a[runs.a.length - 1]
    if (last && t - last[1] <= 2 * dt) last[1] = t + dt
    else runs.a.push([t, t + dt])
    total += dt
  }
  if (total === 0 || total > MAX_DUCK_BARS * 4 * stats.beat) return null
  // Monotonic: once ducked, A's accents stay down to its end (a deck never comes back up after going out).
  if (runs.a.length > 0) runs.a = [[runs.a[0][0], length]]
  const margin = 0.03
  const duck = (curve: Keyframe[], spans: Array<[number, number]>) => {
    if (spans.length === 0) return curve
    const factor = (t: number) => {
      let f = 1
      for (const [from, to] of spans) {
        const start = from - margin
        // A span reaching the shape's end stays down (no ramp back up after it).
        const end = to >= length - 1e-6 ? Infinity : to + margin
        if (t >= start && t <= end) f = Math.min(f, DUCK)
        else if (t > start - RAMP && t < start) f = Math.min(f, 1 - ((1 - DUCK) * (t - (start - RAMP))) / RAMP)
        else if (t > end && t < end + RAMP) f = Math.min(f, DUCK + ((1 - DUCK) * (t - end)) / RAMP)
      }
      return f
    }
    const times = curve.map((k) => k.t)
    for (const [from, to] of spans) {
      times.push(Math.max(0, from - margin - RAMP), Math.max(0, from - margin))
      if (to < length - 1e-6) times.push(to + margin, to + margin + RAMP)
    }
    const points = [
      ...curve.map((k, n) => ({ t: k.t, v: k.v * factor(k.t), n })),
      ...times.slice(curve.length).map((t) => ({ t, v: valueAt(curve, t, 1) * factor(t), n: Infinity })),
    ]
    points.sort((x, y) => x.t - y.t || x.n - y.n)
    return points.map(({ t, v }) => ({ t, v }))
  }
  const shape = stats.shape
  const next: PresetShape = {
    ...shape,
    a: { ...shape.a, mid: duck(shape.a.mid, runs.a), high: duck(shape.a.high, runs.a) },
    b: { ...shape.b, mid: duck(shape.b.mid, runs.b), high: duck(shape.b.high, runs.b) },
  }
  const meet = p.variant.meet
  return { ...p, stats: shapeStats(next, meet, stats.beat), ducked: total }
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
      if (plays * loopBars <= MAX_LOOP_BARS && plays <= MAX_LOOP_PLAYS) splits.push({ straight, loopBars, plays })
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
    const base = { gain: fix(automation.gain, 0), low: fix(automation.low, 0), mid: fix(automation.mid, 0), high: fix(automation.high, 0), filter: fix(automation.filter, -1) }
    // The reverb send and the stem lanes, where the transition has them (a reverb out; the editor's smart filters).
    const extra: Partial<DeckAutomation> = {}
    for (const key of ['reverb', 'drums', 'vocals', 'instrumental'] as const) {
      const list = automation[key]
      if (Array.isArray(list) && list.length > 0) extra[key] = fix(list, 0)
    }
    return { ...base, ...extra }
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
  return planSeveral(aMix, bMix, ids, style, opts, 1)[0].transition
}

/** A plan for the review app's comparison, with a short German description of what it does. */
export interface PlanVariant {
  transition: Transition
  label: string
}

/**
 * The best few valid plans for a pair that differ in kind (layout, length or where the songs meet; not just a finish),
 * best first, each with a short German label, e.g. "16 Takte Overlap · Bass in der Mitte · B ab 1:09".
 */
export function planVariants(
  aMix: TrackMix | null,
  bMix: TrackMix | null,
  ids: { from: string; to: string },
  style: MixStyle,
  opts: PlanOptions & { count?: number } = {},
): PlanVariant[] {
  return planSeveral(aMix, bMix, ids, style, opts, Math.max(1, Math.round(opts.count ?? 4)))
}

/**
 * The plans; a party pair no blend fits is planned again with B held under a low-pass as well (its scattered entry
 * bars unheard under A: the user's Spotify Rock That Body → Outside), which takes over only when it finds a blend.
 * Several variants (the review's comparison) show the best held one too, in the last place, where one fits.
 */
function planSeveral(
  aMix: TrackMix | null,
  bMix: TrackMix | null,
  ids: { from: string; to: string },
  style: MixStyle,
  opts: PlanOptions,
  count: number,
): PlanVariant[] {
  const forced = opts.preset && opts.preset !== 'auto' ? opts.preset : undefined
  if (forced === 'none') return planWith(aMix, bMix, ids, style, opts, count, false)
  return realTransitions(withHeld(), aMix, bMix, ids, style, opts, count)

  function withHeld(): PlanVariant[] {
    const plans = planWith(aMix, bMix, ids, style, opts, count, false)
    if (style !== 'party' || (forced && forced !== 'blend')) return plans
    const blends = (list: PlanVariant[]) => list.some((v) => v.transition.preset === 'blend')
    const hasBlend = blends(plans)
    if (hasBlend && count < 2) return plans
    const held = planWith(aMix, bMix, ids, style, opts, count, true)
    if (!hasBlend) {
      if (blends(held)) return held
      // Round 2: two songs singing nonstop (Bad Habits → Hero) blend with their voices touching for up to 1.5 bars, one
      // of them filtered, rather than echo out (rated 3 stars against "schlecht"). Labelled like a plain blend.
      if (opts.relaxVoices) return plans
      const relaxed = planWith(aMix, bMix, ids, style, { ...opts, relaxVoices: RELAX_DEFAULT_BARS }, count, true)
      return blends(relaxed) ? relaxed.map((v) => ({ ...v, label: v.label.replace(RELAX_LABEL, '') })) : plans
    }
    const extra = held.find((v) => heldPlans.has(v.transition))
    if (!extra) return plans
    return [...plans.slice(0, Math.min(plans.length, count - 1)), extra]
  }
}

/** Voices may touch this many bars in a party blend that otherwise wouldn't exist (see `planSeveral`). */
const RELAX_DEFAULT_BARS = 1.5
const RELAX_LABEL = 'Test: Gesang darf sich kurz berühren · '

/**
 * Back to back is never the automatic choice (round 2: rated "schlecht" on all four pairs that got it): a pair nothing
 * else fits gets the best of a reverb out, a fade or an echo out the rules allow, or else a short crossfade at A's end.
 * Back to back only when picked (`preset: 'none'`).
 */
function realTransitions(plans: PlanVariant[], aMix: TrackMix | null, bMix: TrackMix | null, ids: { from: string; to: string }, style: MixStyle, opts: PlanOptions, count: number): PlanVariant[] {
  const isNone = (v: PlanVariant) => v.transition.preset === 'none'
  if (!plans.some(isNone)) return plans
  const fallbacks: PresetId[] = style === 'party' ? ['reverbOut', 'fadeOut', 'echoOut'] : ['reverbOut', 'fadeOut', 'fadeIn', 'echoOut']
  const real: PlanVariant[] = plans.filter((v) => !isNone(v))
  // (Planned by party's rules, which may cut into a line at a price, where clean's would leave nothing.)
  for (const rules of style === 'clean' ? (['clean', 'party'] as const) : (['party'] as const)) {
    for (const preset of fallbacks) {
      if (real.length >= count) break
      const found = planWith(aMix, bMix, ids, rules, { ...opts, preset }, 1, false).find((v) => !isNone(v))
      if (found && !real.some((v) => v.label === found.label)) real.push({ ...found, transition: { ...found.transition, style } })
    }
    if (real.length > 0) break
  }
  if (real.length === 0) {
    const transition = endFade(prepareTrack(aMix), prepareTrack(bMix), ids, style)
    if (transition) real.push({ transition, label: labelOf(transition) })
  }
  return real.length > 0 ? real.slice(0, count) : plans
}

/**
 * The last resort instead of back to back: A plays on at full volume to its audible end (its lines whole), B fades in
 * under its last two beats under an opening low-pass, from a beat of A. Null without A's grid.
 */
function endFade(a: PreparedTrack | null, b: PreparedTrack | null, ids: { from: string; to: string }, style: MixStyle): Transition | null {
  if (!a || !b || a.beats.length === 0) return null
  const latest = a.end - 2 * a.period
  const aOut = [...a.beats].reverse().find((d) => d <= latest + 0.02)
  if (aOut === undefined || aOut < 0) return null
  const length = Math.min(a.duration - aOut, Math.max(2 * a.period, a.end - aOut))
  if (!(length > 0.5)) return null
  const bIn = Math.max(0, Math.min(b.downbeats[0] ?? 0, b.duration * 0.25))
  const transition = plain(ids, style, 'fadeIn', {
    aOut,
    bIn,
    length,
    a: { gain: [{ t: 0, v: 1 }, { t: Math.max(0, length - 0.05), v: 1 }, { t: length, v: 0 }], low: [], mid: [], high: [], filter: [] },
    // B under an opening low-pass (its beats muffled, they don't run against A's), its bass in as A ends.
    b: {
      gain: [{ t: 0, v: 0 }, { t: length, v: 1 }],
      low: [{ t: 0, v: 0 }, { t: Math.max(0, length - 0.05), v: 0 }, { t: length, v: 1 }],
      mid: [],
      high: [],
      filter: [{ t: 0, v: -0.6 }, { t: length, v: 0 }],
    },
    confidence: 0.4,
    tempo: { a: tempoOf(a), b: tempoOf(b) },
  })
  return finalizeTransition(transition, a.duration, b.duration)
}

function planWith(
  aMix: TrackMix | null,
  bMix: TrackMix | null,
  ids: { from: string; to: string },
  style: MixStyle,
  opts: PlanOptions,
  count: number,
  hold: boolean,
): PlanVariant[] {
  const single = (transition: Transition): PlanVariant[] => [{ transition, label: labelOf(transition) }]
  const a = prepareTrack(aMix)
  const b = prepareTrack(bMix)
  if (!a || !b || !a.grid || !b.grid) return single(safeCrossfade(a, b, ids, style))
  const tempoUsed = { a: tempoOf(a), b: tempoOf(b) }
  const trackA = a
  const trackB = b
  if (opts.preset === 'none') return single(finalizeTransition(backToBack(ids, style, a.duration, 0.9, tempoUsed), a.duration, b.duration))

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
  const words = wordPairs(a, b, style)
  const party = style === 'party'
  const placements: Placement[] = []
  const shapes = new Map<string, ShapeStats>()

  // Vocals estimated from the audio (no synced lyrics) count for less: they also catch leads and synths.
  // Assumed vocals (nothing measured: the voice-like body sections) count for little: they're often wrong (round 1,
  // Do I Wanna Know → Cro: "the assumed singing is very wrong here"; rounds 1 and 2, Titanium → Animals: the blends
  // that low-pass A's assumed-singing outro got 5 stars three times).
  const vocalTrust = (track: PreparedTrack) =>
    track.vocalsAssumed ? (party ? 0.2 : 0.25) : !track.vocalsKnown ? 0 : track.mix.vocalSource === 'lyrics' ? 1 : 0.6
  const trustA = vocalTrust(a)
  const trustB = vocalTrust(b)

  const shapeFor = (variant: Variant, beat: number) => {
    // Half time: B's bar spans two of A's, so the swap goes on an even bar of A.
    const rawSwap = variant.pre ?? variant.bars * variant.swapFraction
    // (A wordplay swap may sit on an 8th: its bar count is kept as given.)
    const exact = variant.volume === 'answer' || variant.volume === 'jumpcut'
    const swapBar = exact ? rawSwap : tempo.synced && tempo.multiple === 2 ? 2 * Math.round(rawSwap / 2) : Math.round(rawSwap)
    const key = `${variant.preset}:${variant.bars}:${variant.pre}:${swapBar}:${variant.preRollBars}:${variant.filter}:${variant.midSwap}:${variant.volume}:${variant.bassAt}:${variant.filterIn}:${variant.filterOut}:${variant.callback}:${variant.meet}:${beat.toFixed(5)}`
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
        callback: variant.callback,
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
    const bEnd = positionB(placed, stats.shape.length) ?? p.laneB.start
    const skipA = a.loudSeconds(reachA, a.end)
    const skipB = b.loudSeconds(b.start, p.laneB.start)
    let bound = variant.prior + jitter(`${ids.from}>${ids.to}:${variant.preset}:${variant.preRollBars}:${variant.bars}:${variant.midSwap}`)
    // A drop swap lands on B's drop (or chorus): the user wants more of them where they fit.
    if (variant.preset === 'blend' && variant.volume === 'overlap' && variant.bars === (variant.pre ?? 0))
      bound += p.pb.drop ? DROP_SWAP_BONUS : p.pb.chorus ? DROP_SWAP_BONUS / 2 : -10
    // Loops only when needed to fit: starting the blend earlier is better (the user on Titanium → Animals).
    bound += p.pa.bonus + p.pb.bonus - 0.08 * p.loops
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
      // Clean plays A out; B may be entered later (its intro skipped) where it keeps the energy up.
      bound -= 0.03 * skipA + 0.004 * skipB
    }
    const energyB = b.energyBetween(bEnd, bEnd + 8)
    if (party && variant.preset === 'dropSwap' && energyB < 0.6) bound -= 0.3
    // Energy across the handover: B in the bars after A is gone against A in the bars before the swap (where A still
    // plays in full), in dB of absolute level. A falloff costs, a big one rules the placement out; party likes a rise.
    // Leave A while it still carries energy (round 1: Titanium → Animals three times "don't wait until the song has
    // lost all its energy"; Right Round → Beauty And A Beat's echo out from 2:33 rated 5, from 3:03 rated 2).
    // (measured where the transition starts taking A away: its first 2 bars)
    const exitEnergy = a.energyBetween(p.laneA.start, p.laneA.start + 8 * a.period)
    const bodyEnergy = a.energyBetween(a.introEnd, a.outroStart > a.introEnd ? a.outroStart : a.end)
    if (bodyEnergy > 0.05) bound += 0.4 * Math.min(0.3, Math.max(-1, exitEnergy / bodyEnergy - 1))
    const drop = handoverDrop(placed, a, b)
    const allowed = party ? 1.5 : 3
    if (drop > allowed) bound -= 0.15 * (drop - allowed) + (drop > allowed + 4 ? 2 : 0)
    if (party) bound += 0.02 * Math.min(3, Math.max(0, -drop))
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
    bound -= party ? 0.02 * sungA + 0.01 * sungB : 0.3 * sungA + 0.01 * sungB
    if (!tempo.synced && NEEDS_BEATMATCH.has(variant.preset)) bound -= 0.2 * Math.min(1, stats.together / (4 * stats.beat))
    // Clean never cuts A's lines (`sung` rules that out); B entered at a later section skips its earlier lines whole.
    return { bound, sung: party ? sungA + sungB : sungA }
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
      if (variant.volume === 'tail') {
        // A's last `bars` bars up to its audible end, where it fades by itself; B from one of its entry spots on.
        if (!fadesOut(a) || tailBars.length <= variant.bars) continue
        const last = tailBars.length - 1
        const startA = tailBars[last - variant.bars]
        const beat = (tailBars[last] - startA) / (4 * variant.bars)
        const stats = shapeFor(variant, beat)
        const length = stats.shape.length
        for (const pb of ins) {
          const end = shiftBars(b, pb.t, variant.bars / tempo.multiple)
          if (!Number.isFinite(end) || !onGrid(b, pb.t)) continue
          const rate = (end - pb.t) / length
          if (!rateOk(rate)) continue
          const base = { stats, variant, laneA: { start: startA, path: [] }, laneB: { start: pb.t, path: [] }, bStart: PHASE_SLACK, rate, beatmatched: true, clarity: NaN, loops: 0, slack: PHASE_SLACK, pa: { t: startA, bonus: 0, drop: false, chorus: false }, pb }
          placements.push({ ...base, ...scoreBound(base) })
        }
        continue
      }
      if (variant.volume === 'answer' || variant.volume === 'jumpcut') {
        // Wordplay: A's bar right after its line and B's bar right before its answering line meet on the swap; straight
        // material, `pre` bars before and `post` after it on both decks (bars, not phrases: lines don't keep to them).
        for (const { pa, pb, title, onWord } of words) {
          if (variant.volume === 'jumpcut' && !title) continue
          // On a timed word the swap is the beat the words start on (any beat, counted in beats); else the bars.
          const grid = (track: PreparedTrack) => (onWord ? track.beats : track.downbeats)
          const unit = onWord ? 4 : 1
          // (an 8th between beats keeps its offset from the beat before it)
          // Both lanes start on a beat (B's entry is never off the beat); an 8th between beats adds half a beat before
          // the swap, which then sits on the 8th itself.
          const span = (track: PreparedTrack, t: number, before: number, after: number) => {
            const list = grid(track)
            const i = floorIndex(list, t + 0.01)
            const from = list[i - before]
            const to = list[i + after]
            return i < 0 || from === undefined || to === undefined ? null : { start: from, end: to + (t - list[i]), half: t - list[i] > 0.05 }
          }
          const sa = span(a, pa.t, pre * unit, post * unit)
          const sb = span(b, pb.t, preB * unit, postB * unit)
          if (!sa || !sb || sa.half !== sb.half) continue
          const { start: startA, end: endA } = sa
          const { start: startB, end: endB } = sb
          const extra = sa.half ? 0.125 : 0
          const job = extra > 0 ? { ...variant, bars: variant.bars + extra, pre: pre + extra } : variant
          const stats = shapeFor(job, (endA - startA) / (4 * job.bars))
          const length = stats.shape.length
          const rate = (endB - startB) / length
          if (!rateOk(rate)) continue
          const base = { stats, variant: job, laneA: { start: startA, path: [] }, laneB: { start: startB, path: [] }, bStart: PHASE_SLACK, rate, beatmatched: true, clarity: NaN, loops: 0, slack: PHASE_SLACK, pa, pb }
          placements.push({ ...base, ...scoreBound(base) })
        }
        continue
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
      if (!party && variant.volume === 'overlap' && (pre === 0 || pre === 4 || pre === 8) && tailBars.length > 0) {
        const lastBar = tailBars.length - 1
        for (const t of a.phraseGrid) {
          const i = floorIndex(a.downbeats, t + 0.05)
          const after = lastBar - i
          if (i < 0 || after < 2 || after > 16 || pre + after > maxBars || (after === post && tailBars[lastBar] <= a.end)) continue
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
    // Clean never muffles a sung line: A keeps its mids, highs and an open filter until its last line in the blend has
    // ended; the EQ-out or filter happens after it (squeezed into what's left).
    if (!party && placement.variant.preset === 'blend') {
      const kept = keepLineClear(placement, a)
      if (!kept) return null
      placement = kept
    }
    const isMashup = placement.variant.volume === 'mashup'
    if (isMashup && !mashupFits(placement, a, b, harmony)) return null
    if (placement.variant.preset === 'reverbOut' && !reverbFits(placement, a, b)) return null
    // A party wordplay hands over to B at full energy (round 1: How Deep Is Your Love → Wake Me Up, "B had no drop":
    // B at 66–78 % of its body there). The handover may drop by 3 dB, as in a clean set: the user's own Heartless jump
    // cut (B's "heartless" at 0:58) drops 1.6 dB.
    const wordplay = placement.variant.volume === 'answer' || placement.variant.volume === 'jumpcut'
    if (party && wordplay) {
      const atB = positionB(placement, placement.stats.shape.swap) ?? placement.laneB.start
      const bodyB = b.energyBetween(b.introEnd, b.outroStart > b.introEnd ? b.outroStart : b.end)
      if (handoverDrop(placement, a, b) > 3 || b.energyBetween(atB, atB + 8 * b.period) < 0.85 * bodyB) return null
    }
    const dropSwap = placement.variant.volume === 'overlap' && placement.variant.bars === (placement.variant.pre ?? 0)
    const isTail = placement.variant.volume === 'tail'
    // A drop swap only where it genuinely fits (the user: "they can't always be done"): B lands on a real drop, A leaves
    // at its boundary, not inside a line, and the energy holds or rises.
    // (A cut inside a line only on a real drop, which masks it: the user's favourite Judas → Cannibal is one.)
    const cutsLine = !!spanAt(a.vocals, positionA(placement, placement.stats.shape.length) - 0.05)
    // ... and it rises by 5 dB at most (the user's favourite Judas → Cannibal: +3.2; a ballad's chorus isn't a drop).
    const dropRise = dropSwap ? handoverDrop(placement, a, b) : 0
    if (dropSwap && ((!placement.pb.drop && !placement.pb.chorus) || (cutsLine && !placement.pb.drop) || dropRise > 0.5 || dropRise < -5)) return null
    if (dropSwap && opts.avoid?.includes('dropSwap')) return null
    if (placement.variant.callback && opts.avoid?.includes('callback')) return null
    if ((placement.variant.volume === 'answer' || placement.variant.volume === 'jumpcut') && opts.avoid?.includes('wordplay')) return null
    if (placement.variant.volume === 'mashup' && opts.avoid?.includes('mashup')) return null
    if (placement.variant.callback && !callbackFits(placement, a)) return null
    // B held under its low-pass only for a B entered on scattered bars (where its accents mustn't be heard with A's), and
    // only where no other blend fits (see `planSeveral`): the user's blends open up together.
    if (placement.variant.filterIn === 'lpHold' && (!party || !heldUnclear(placement, b))) return null
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
      let clarity = audibleClarity(shifted, a, b)
      if (clarity < 0) return null
      let checked: Placement = shifted
      if (!Number.isNaN(clarity) && clarity < MIN_VERIFIABLE) {
        // Both decks in full: nothing may be ducked.
        if (isMashup) return null
        // A few risky bars: the deck they belong to has its accents ducked there, as a DJ would, so they aren't heard
        // over the other's; what's still heard on both must then pass.
        const ducked = duckRisky(shifted, a, b)
        if (!ducked) return null
        checked = ducked
        clarity = audibleClarity(checked, a, b)
        if (clarity < 0 || (!Number.isNaN(clarity) && clarity < MIN_VERIFIABLE)) return null
      }
      placement = { ...checked, clarity }
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
    // (Not on the wordplay cuts: their swap is the word, on whichever beat or 8th it starts.)
    if (placement.variant.preset === 'blend' && placement.variant.bassAt === 'middle' && placement.variant.volume !== 'jumpcut' && placement.variant.volume !== 'answer') {
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
      const full = placement.variant.volume === 'overlap' || placement.variant.volume === 'mashup'
      if (energy.over > (full ? MAX_OVER_DB_OVERLAP : MAX_OVER_DB) || energy.basses > 0) return null
      // A fade or echo that leaves a near-silent stretch longer than a bar (the user's ears: "the song stops") is out;
      // in a blend a hole only costs (the user liked Titanium → Animals with one).
      if (placement.variant.preset !== 'blend' && energy.hole > 4 * stats.beat) return null
      if (placement.variant.preset === 'blend') {
        energyTerm = 0.05 * Math.max(0, HOLE_DB - energy.mean)
        // A bar that sinks far below the loud level costs (Titanium → Animals with the bass handed over at the start: A's
        // bass gone under B's thin intro, the quietest bar at -13 dB against -10 dB at most for the blends the user
        // rated 4 and 5).
        energyTerm += 0.1 * Math.max(0, DIP_DB - energy.dip)
        // Busy parts (mids and highs up) take a filter, thin ones blend open; long blends suit thin parts, the short
        // seamless one dense parts.
        const filtered = placement.variant.filterIn || placement.variant.filterOut ? 1 : 0
        energyTerm -= 0.02 * (filtered ? energy.busy : 1 - energy.busy)
        if (placement.variant.bars >= 16) energyTerm += 0.04 * energy.busy
        if (placement.variant.volume === 'scurve') energyTerm += 0.3 * (1 - energy.busy)
        else if (placement.variant.bars <= 4) energyTerm += 0.04 * (1 - energy.busy)
      }
    }
    const relaxBars = party && opts.relaxVoices && placement.variant.preset === 'blend' ? (opts.relaxVoices === true ? 1 : opts.relaxVoices) : 0
    const relax = relaxBars > 0
    const { clash: voices, lostA, lostB } = vocalCost(placement, a, b, party)
    // B is never entered inside one of its lines (round 1: God's Plan → Hello cut "Hello" off "Hello from the other
    // side"); A leaving right after it began a new line sets up words that never come (Rock That Body → Outside: "I
    // wanna rock" starts, then fades) and costs.
    // (relaxVoices, test: allowed while B is filtered where it becomes audible. A wordplay enters B on its word, its
    // earlier words muted: exempt. A drop swap's pre-roll is a filtered tease under A: B is checked where it takes
    // over, on its drop.)
    const bFiltered = relax && Math.abs(valueAt(stats.shape.b.filter, stats.bHere, 0)) >= RELAX_FILTERED
    const bEnters = positionB(placement, dropSwap ? stats.shape.swap : stats.bHere) ?? placement.laneB.start
    if (!bFiltered && !wordplay && entersMidLine(b, bEnters)) return null
    const startedLine = lineStartedBefore(a, positionA(placement, stats.aGone), 2)
    // The short S-curve may let one voice end as the other starts (a quarter second at most, about where two voices are
    // heard as two); otherwise never voice over voice.
    // (relaxVoices, test: up to its bars of voices together.)
    if (voices > (relax ? relaxBars * 4 * stats.beat : placement.variant.volume === 'scurve' ? Math.min(0.25, stats.beat / 2) : 0.1)) return null
    // Clean never cuts A's lines: muffling one under a filter or EQ (no longer intelligible) counts as cutting it.
    if (!party && trustA * lostA > 0.5) return null
    // Any transition that falls off a cliff after A is gone (an EDM drop into a piano ballad) is out, the fallbacks too:
    // B is entered elsewhere, or another kind takes it (or none).
    if (stats.shape.length > 0 && handoverDrop(placement, a, b) > (party ? 1.5 : 3) + 6) return null
    // Nor may the music jump up: B, 3 s after A is gone, far louder than A in the 3 s before B came in (round 3, God's
    // Plan → Hello: -19 dB into -11 dB). A drop swap rises on its drop by design (5 dB at most, checked above).
    const rise = stats.shape.length > 0 && !dropSwap ? continuityRise(placement, a, b) : 0
    if (rise > MAX_RISE_DB) return null
    if (placement.variant.preset === 'blend') {
      // A only ever goes out and B only ever comes in (the user: "why is A brought back?"); B is in full before A's last
      // band goes ("B isn't ready to take over"), except on the wordplay cut, where B's answer masks A's end.
      if (!monotonic(stats.shape, placement.variant.callback === true)) return null
      // The wordplay cuts and the drop swap hand over on B's line or event, which masks A's end.
      // (A tail overlap is masked by A's own fade.)
      // (B held under its low-pass carries the kick and bass from the start and opens as A's accents end.)
      if (placement.variant.volume !== 'answer' && placement.variant.volume !== 'jumpcut' && !dropSwap && !isTail && placement.variant.filterIn !== 'lpHold' && !readyAtExit(stats)) return null
    }
    // Beats that drift apart flam audibly from about 25 ms on (and a stretch of the overlap may drift worse than the
    // middle): such a placement is out, a smaller drift costs a little. So is one whose match can't mostly be checked
    // against A's beats. Judged two bars at a time too.
    const drift = placement.beatmatched ? phaseError(placement, a, b, tempo.multiple) : { median: 0, p90: 0, checked: 1, worstWindow: 0, worstBar: 0, trend: 0 }
    if (
      drift.median > MAX_DRIFT ||
      drift.p90 > 2.5 * MAX_DRIFT ||
      drift.checked < 0.75 ||
      drift.worstWindow > MAX_WINDOW_DRIFT ||
      drift.worstBar > MAX_BAR_OFFSET ||
      drift.trend > MAX_TREND
    )
      return null
    // A swung groove against a straight one flams wherever both beats are loud: a little of that is a handover, more
    // costs (up to a 16-beat stretch, then the full price).
    let swingTerm = 0
    if (placement.beatmatched && Math.abs(swingOf(a.mix) - swingOf(b.mix)) > SWING_CLASH) {
      let loudBoth = 0
      for (let i = 0; i < stats.loudA.length; i++) if (i * stats.dt >= placement.bStart && stats.loudA[i] && stats.loudB[i]) loudBoth += stats.dt
      swingTerm = 0.5 * Math.min(1, Math.max(0, loudBoth - 4 * stats.beat) / (16 * stats.beat))
    }
    // Accents that wander against their own grid (accentSpread) flam in some bars of a long both-heard overlap whatever
    // the alignment: a cost growing with the spread and the time, not a veto (the user's ears accept some).
    let grooveTerm = 0
    const spread = Math.hypot(spreadOf(a.mix), spreadOf(b.mix))
    if (placement.beatmatched && spread > GROOVE_SPREAD) {
      let loudBoth = 0
      for (let i = 0; i < stats.loudA.length; i++) if (i * stats.dt >= placement.bStart && stats.loudA[i] && stats.loudB[i]) loudBoth += stats.dt
      grooveTerm = 0.4 * Math.min(1, (spread - GROOVE_SPREAD) / GROOVE_SPREAD) * Math.min(1, loudBoth / (16 * stats.beat))
    }
    // A parked on a looped 1–2-bar figure (a chant, a sampled hook) for most of a long overlap sounds sampled ("you're
    // basically sampling it"): the longer, the more it costs; a short A tail with B carrying the time doesn't.
    const parked = repeatedShare(a, positionA(placement, placement.bStart), positionA(placement, stats.aGone))
    const repeatTerm = parked >= 0.4 ? 0.3 * Math.min(1, Math.max(0, stats.aGone - placement.bStart - 8 * stats.beat) / (24 * stats.beat)) : 0
    const finish = placement.variant.preset === 'blend' ? placement.variant.prior - start.variant.prior - BEST_FINISH : 0
    const clarityTerm = (Number.isNaN(placement.clarity) ? 0.1 : 0.3 * Math.max(0, 1 - placement.clarity / MIN_CLARITY)) + 0.2 * (1 - entryClarity(placement, b))
    const duckTerm = (0.02 * (placement.ducked ?? 0)) / (4 * stats.beat)
    // Party wants a switch you can hear: B's event on A's boundary, or the bass changing deck.
    const quiet = party && placement.variant.preset === 'blend' && placement.variant.bassAt === 'none' && !placement.pb.drop && !placement.pb.chorus ? 0.15 : 0
    // B jumping up at the handover after being held thin ("B suddenly gets loud") costs.
    // (Not on the wordplay cuts, which switch at once by design.)
    const jump = wordplay ? 0 : Math.max(0, handoverJump(placement, b) - 4)
    const score = -quiet - 0.08 * jump - (startedLine ? 0.25 : 0) + placement.bound + finish - tonalTerm - energyTerm - swingTerm - grooveTerm - repeatTerm - duckTerm - clarityTerm - lostWeight * (trustA * Math.min(8, lostA) + trustB * Math.min(8, lostB)) - drift.median
    return { placement, score }
  }
  // The best `count` judged plans that differ in kind (see `kindOf`); `best` is the last one kept, the bar to beat.
  const kept: Array<{ placement: Placement; score: number }> = []
  // The bar a candidate has to beat: the last kept once there are `count`.
  const bar = () => (kept.length >= count ? kept[kept.length - 1] : null)
  // Variants show more than one technique: at most half of them (and never all but one) drop swaps, so a pair whose
  // drop swaps lead still shows its best blend (round 2: Feel So Close → Coming Back's rated blend had gone).
  const maxSwaps = count >= 3 ? Math.floor(count / 2) : count
  const isSwap = (p: Placement) => p.variant.volume === 'overlap' && p.variant.bars === (p.variant.pre ?? 0)
  const keep = (judged: { placement: Placement; score: number }) => {
    const kind = kindOf(judged.placement)
    const same = kept.findIndex((k) => kindOf(k.placement) === kind)
    if (same >= 0) {
      if (kept[same].score >= judged.score) return
      kept.splice(same, 1)
    }
    if (isSwap(judged.placement)) {
      const swaps = kept.filter((k) => isSwap(k.placement))
      if (swaps.length >= maxSwaps) {
        const worst = swaps[swaps.length - 1]
        if (worst.score >= judged.score) return
        kept.splice(kept.indexOf(worst), 1)
      }
    }
    kept.push(judged)
    kept.sort((x, y) => y.score - x.score)
    if (kept.length > count) kept.length = count
  }
  let judgedCount = 0
  for (const placement of placements) {
    const best = bar()
    if (best && placement.bound <= best.score) break
    // A budget for the sampled checks (a playlist of hundreds is planned in one go): once it's spent, the best found
    // so far stands; without one yet, the search goes on.
    if (kept.length > 0 && judgedCount >= JUDGE_BUDGET * count) break
    // Clean style never skips a sung line: such a placement is out.
    if (!party && placement.sung > 0.5) continue
    // Far more risky bars heard on both decks than any finish could duck: none of its finishes will pass.
    if (placement.beatmatched && riskyTime(placement, a, b) > 2 * MAX_DUCK_BARS * 4 * placement.stats.beat) continue
    // A blend's finishes, each sampled only when it could still beat the best.
    const tries = placement.variant.preset === 'blend' ? blendFinishes(placement.variant, clash, hold) : [placement.variant]
    for (const variant of tries) {
      const best = bar()
      if (best && placement.bound + variant.prior - placement.variant.prior - BEST_FINISH <= best.score) continue
      const candidate = variant === placement.variant ? placement : { ...placement, variant, stats: shapeFor(variant, placement.stats.beat) }
      if (candidate.stats.basses > 0.001 && candidate.variant.bassAt !== 'none') continue
      judgedCount++
      const judged = judge(candidate)
      if (judged) keep(judged)
    }
  }
  // Back to back is always clean: when nothing fits (odd phrase data, songs too short for any overlap, or in clean
  // style a song that sings into its last seconds, so every overlap would cut a line).
  if (kept.length === 0) return single(finalizeTransition(backToBack(ids, style, a.duration, 0.5, tempoUsed), a.duration, b.duration))
  return kept.map(({ placement }) => {
    const transition = build(placement)
    const v = placement.variant
    const technique: Technique | undefined =
      v.volume === 'overlap' && v.bars === (v.pre ?? 0)
        ? 'dropSwap'
        : v.callback
          ? 'callback'
          : v.volume === 'answer' || v.volume === 'jumpcut'
            ? 'wordplay'
            : v.volume === 'mashup'
              ? 'mashup'
              : undefined
    if (technique) techniques.set(transition, technique)
    if (v.filterIn === 'lpHold') heldPlans.add(transition)
    const label = labelOf(transition, placement)
    const relaxed = opts.relaxVoices && style === 'party' && transition.preset === 'blend'
    return { transition, label: relaxed ? `Test: Gesang darf sich kurz berühren · ${label}` : label }
  })

  function build(placement: Placement): Transition {
  // The louder song comes down by the loudness difference while both play (both analyses must have measured it).
  const louder = Number.isFinite(trackA.mix.loudness) && Number.isFinite(trackB.mix.loudness) ? trackA.mix.loudness - trackB.mix.loudness : 0
  // Blends keep both decks at their volume (loudness comes from the parts chosen and their EQ, checked above).
  const shape = placement.variant.preset === 'blend' ? placement.stats.shape : matchLevels(placement.stats.shape, placement.stats.beat, louder)
  let confidence = 0.9
  if (tempo.synced && shape.length > 0) confidence *= 0.55 + 0.45 * minConfidence
  else confidence *= 0.6 + 0.3 * minConfidence
  if (placement.stats.tonal > 4 * placement.stats.beat) confidence *= 0.7 + 0.3 * harmony
  if (!trackA.vocalsKnown || !trackB.vocalsKnown) confidence *= 0.85
  if (!tempo.synced && NEEDS_BEATMATCH.has(shape.preset)) confidence *= 0.6
  if (placement.beatmatched) confidence *= Number.isNaN(placement.clarity) ? 0.8 : 0.7 + 0.3 * placement.clarity
  confidence *= 1 - 0.03 * placement.loops
  return finalizeTransition(toTransition(placement, shape, trackA, trackB, ids, style, confidence, tempoUsed), trackA.duration, trackB.duration)
  }
}

/** What makes two plans different in kind: the layout and length and where the songs meet (to 10 s), not the finish. */
function kindOf(p: Placement) {
  const v = p.variant
  return `${v.preset}:${v.volume ?? ''}:${v.bars}:${Math.round(p.laneA.start / 10)}:${Math.round(p.laneB.start / 10)}`
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** A short German description of a plan, as the review app shows it. */
function labelOf(t: Transition, p?: Placement): string {
  if (t.length <= 0) return 'Kein Übergang (nacheinander)'
  const names: Partial<Record<PresetId, string>> = { echoOut: 'Echo-Ausklang', reverbOut: 'Hall-Ausklang', fadeOut: 'Ausblende', fadeIn: 'Einblende', crossfade: 'Überblendung' }
  if (t.preset !== 'blend') return `${names[t.preset] ?? t.preset} · A ab ${clock(t.aOut)} · B ab ${clock(t.bIn)}`
  const v = p?.variant
  const bars = v ? v.bars : Math.round(((t.length - t.bAt) * t.tempo.a) / 240)
  const kind =
    v?.volume === 'tail'
      ? 'Überlappung im Ausklang'
      : v?.volume === 'jumpcut'
      ? 'Jump-Cut (Wortspiel)'
      : v?.volume === 'answer'
      ? 'Wortspiel'
      : v?.volume === 'overlap' && v.bars === (v.pre ?? 0)
      ? 'Drop-Swap'
      : v?.volume === 'mashup'
        ? 'Mashup'
        : v?.volume === 'scurve'
          ? 'S-Kurve'
          : v?.volume === 'fade'
            ? 'B blendet ein'
            : v?.callback
              ? 'Callback'
              : 'Overlap'
  const bass = v?.bassAt === 'none' ? 'ohne Bass-Wechsel' : v?.bassAt === 'start' ? 'Bass am Anfang' : 'Bass in der Mitte'
  const into = v?.filterIn === 'lpHold' ? 'B unter Tiefpass gehalten' : ''
  const out = v?.filterOut === 'eq' ? 'A per EQ raus' : v?.filterOut === 'hp' ? 'Hochpass raus' : v?.filterOut === 'lp' ? 'Tiefpass raus' : ''
  return [`${bars} Takte ${kind}`, bass, into, out, `A ab ${clock(t.aOut)}`, `B ab ${clock(t.bIn)}`].filter(Boolean).join(' · ')
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
    ...(deck.reverb && deck.reverb.length > 0 ? { reverb: moveKeys(deck.reverb) } : {}),
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
  return leadIns(
    {
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
    },
    b,
    a,
  )
}

/** The transition begun `pad` seconds earlier: A plays on for that long before (at its first rate), everything else later. */
function padStart(tr: Transition, pad: number): Transition {
  const later = (list: Keyframe[]) => list.map((k) => ({ ...k, t: k.t + pad }))
  const deck = (d: DeckAutomation): DeckAutomation => ({
    gain: later(d.gain),
    low: later(d.low),
    mid: later(d.mid),
    high: later(d.high),
    filter: later(d.filter),
    ...(d.reverb && d.reverb.length > 0 ? { reverb: later(d.reverb) } : {}),
  })
  const rateA0 = tr.rateA.length > 0 ? tr.rateA[0].v : 1
  const aOut = tr.aOut - pad * rateA0
  if (aOut < 0) return tr
  const pathA = tr.pathA.length > 0 ? [{ from: aOut, to: tr.aOut, repeat: 1 }, ...tr.pathA] : []
  return {
    ...tr,
    aOut,
    pathA,
    bAt: tr.bAt + pad,
    length: tr.length + pad,
    rateA: tr.rateA.length > 0 ? [{ t: 0, v: rateA0 }, ...later(tr.rateA)] : [],
    rateB: later(tr.rateB),
    a: deck(tr.a),
    b: deck(tr.b),
    effects: tr.effects.map((e) => ({ ...e, at: e.at + pad })),
  }
}

/** How far before the attack a loop jumps (its stretch moved earlier by this, its length kept). */
const JOIN_LEAD = 0.02
/** How far before its first attack B starts playing (and fading in), when it would start on or just after one. */
const START_LEAD = 0.04

/**
 * Keeps attacks whole where a deck starts or jumps: a loop's stretch moves JOIN_LEAD earlier (same length, so the
 * beat runs on as before; the jump lands just before the loop's first attack instead of on it), and B, when it would
 * start on or just after one of its beats, starts START_LEAD before that beat, its fade-in and EQ start moved along
 * (its bass stays where it meets A's).
 */
function leadIns(original: Transition, b: PreparedTrack, a?: PreparedTrack): Transition {
  // B must never start after its beat: when it would and the transition starts too late to begin B earlier (B right
  // at its start, no glide before it), the transition begins earlier, A playing on for that much more before.
  let tr = original
  if (tr.length > 0) {
    const i = floorIndex(b.beats, tr.bIn + 0.1)
    const beat = i >= 0 ? b.beats[i] : NaN
    const shift = tr.bIn - (beat - START_LEAD)
    const rate = tr.rateB.length > 0 ? tr.rateB[0].v : 1
    // (Only where B is heard from its lane's start on: an echo out's B stays silent until its phrase meets A.)
    const heardAtStart = valueAt(tr.b.gain, tr.bAt + 2 * RAMP, 1) > 0.001
    if (heardAtStart && Number.isFinite(beat) && shift > 0 && shift <= 0.1 + START_LEAD && tr.bIn - shift >= 0 && tr.bAt - shift / rate < 0) {
      // Back to A's downbeat before (so the transition still starts on one of A's).
      const need = shift / rate - tr.bAt + 0.001
      const rateA0 = tr.rateA.length > 0 ? tr.rateA[0].v : 1
      const k = a ? floorIndex(a.downbeats, tr.aOut - need * rateA0 + 1e-6) : -1
      const pad = a && k >= 0 ? (tr.aOut - a.downbeats[k]) / rateA0 : need
      tr = padStart(tr, pad)
    }
  }
  const lead = (path: DeckSegment[]): DeckSegment[] => {
    if (!path.some((segment) => segment.repeat > 1)) return path
    const out: DeckSegment[] = []
    path.forEach((segment, i) => {
      if (segment.to - segment.from <= 4 * JOIN_LEAD) {
        out.push(segment)
        return
      }
      if (i === 0) {
        // The deck's start stays where it is; only the repeats jump to the earlier stretch.
        out.push({ from: segment.from, to: segment.to - JOIN_LEAD, repeat: 1 })
        if (segment.repeat > 1) out.push({ from: segment.from - JOIN_LEAD, to: segment.to - JOIN_LEAD, repeat: segment.repeat - 1 })
      } else out.push({ from: segment.from - JOIN_LEAD, to: segment.to - JOIN_LEAD, repeat: segment.repeat })
    })
    return out
  }
  let pathA = lead(tr.pathA)
  let pathB = lead(tr.pathB)
  let { bAt, bIn, rateB } = tr
  // When B's first downbeat sounds (B's lane may start a little off it after the phase fit).
  const firstRate = tr.rateB.length > 0 ? tr.rateB[0].v : 1
  const nearDownbeat = nearest(b.downbeats, tr.bIn)
  const downbeat = Math.abs(nearDownbeat - tr.bIn) < 0.1 ? tr.bAt + (nearDownbeat - tr.bIn) / firstRate : tr.bAt
  let automationA = tr.a
  let automation = tr.b
  if (tr.length > 0) {
    const i = floorIndex(b.beats, bIn + 0.1)
    const beat = i >= 0 ? b.beats[i] : NaN
    const shift = bIn - (beat - START_LEAD)
    const rate = rateB.length > 0 ? rateB[0].v : 1
    if (Number.isFinite(beat) && shift > 0 && shift <= 0.1 + START_LEAD && bIn - shift >= 0 && bAt - shift / rate >= 0) {
      const earlier = shift / rate
      const from = bAt
      bIn -= shift
      bAt -= earlier
      if (pathB.length > 0) pathB = [{ ...pathB[0], from: bIn }, ...pathB.slice(1)]
      rateB = rateB.map((k, n) => (n === 0 ? { ...k, t: bAt } : k))
      const move = (list: Keyframe[]) => list.map((k) => (k.t <= from + 2 * RAMP + 1e-6 ? { ...k, t: Math.max(0, k.t - earlier) } : k))
      automation = { ...automation, gain: move(automation.gain), mid: move(automation.mid), high: move(automation.high), filter: move(automation.filter) }
    }
  }
  pathA = pathA.map((s) => ({ ...s, from: round(s.from), to: round(s.to) }))
  pathB = pathB.map((s) => ({ ...s, from: round(s.from), to: round(s.to) }))
  // A bass change at B's entry lands on B's first downbeat (where B's lane was placed), not a ramp or two after it: A's
  // low is gone and B's is up exactly there (they cross over the ramp before it).
  if (tr.length > 0) {
    // The step (a jump between 0 and 1 within a ramp) nearest B's entry, and how far it lands from the downbeat.
    const window = (k: Keyframe) => k.t >= tr.bAt - 3 * RAMP && k.t <= tr.bAt + 4 * RAMP
    const off = (list: Keyframe[], rising: boolean) => {
      const step = list.find((k, n) => n > 0 && window(k) && (rising ? k.v >= 0.99 && list[n - 1].v <= 0.01 : k.v <= 0.01 && list[n - 1].v >= 0.99))
      return step ? step.t - downbeat : 0
    }
    const shiftB = off(automation.low, true)
    const shiftA = off(automationA.low, false)
    const move = (list: Keyframe[], by: number) => list.map((k) => (window(k) ? { ...k, t: Math.max(0, k.t - by) } : k))
    if (Math.abs(shiftB) > 1e-4) automation = { ...automation, low: move(automation.low, shiftB) }
    if (Math.abs(shiftA) > 1e-4) automationA = { ...automationA, low: move(automationA.low, shiftA) }
  }
  return { ...tr, pathA, pathB, bAt, bIn, rateB, a: automationA, b: automation }
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
      if (sampled.voiceB[i] <= VOICE_HEARD || tb === null || !spanAt(b.vocals, tb)) continue
      const direct = sampled.voiceA[i] > VOICE_HEARD && spanAt(a.vocals, at(t))
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

/**
 * The planner's thresholds and helpers the editor's live checks and suggestions (editor-checks.ts) use, so both judge a
 * transition the same way. Read-only; nothing here plans.
 */
export const plannerRules = {
  VOICE_HEARD,
  ECHO_HEARD,
  TONAL_HEARD,
  KEY_CLASH,
  BEAT_HEARD,
  KICK_HEARD,
  MIN_VERIFIABLE,
  SCATTERED,
  ACCENT_FAINT,
  MAX_RISE_DB,
  DEFAULT_TEMPO,
  filterBands,
  outAnchors,
  inAnchors,
}
