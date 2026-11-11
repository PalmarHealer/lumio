/**
 * Mixer (DJ) mode: the shapes shared by the server's whole-track analysis (server/src/mix-analysis.ts keeps an
 * identical copy of `TrackMix`, the server can't import from src/), the transition planner, the Web Audio engine and
 * the UI. Everything in src/features/listen/mixer/ except the React/UI files imports only relatively and touches no DOM
 * at load time, so node can run it for tests (`node --experimental-strip-types`).
 *
 * Times are seconds into the track unless said otherwise.
 */

/** Raised when the analysis changes, so songs are analysed again. */
export const MIX_VERSION = 1

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'drop' | 'build' | 'break' | 'outro' | 'other'

export interface MixSection {
  start: number
  end: number
  kind: SectionKind
  /** Sections that sound alike (self-similarity) share a group number; repeated groups hint the chorus. */
  group: number
  /** Mean energy of the section (0–1, relative to the track's loudest). */
  energy: number
}

/** What the Lumio server measured over a whole song, for planning and drawing transitions. */
export interface TrackMix {
  v: number
  /** Length of the analysed audio. */
  duration: number
  /** Global tempo (60–200 BPM) and how sure the analysis is of it and of the beat grid (0–1). */
  bpm: number
  bpmConfidence: number
  /** Beat times (seconds, 3 decimals), following the music (not a rigid grid). */
  beats: number[]
  /** The beats that start a bar (a subset of `beats`). */
  downbeats: number[]
  /** Phrase starts: downbeats where an 8-bar (sometimes 4/16) phrase begins, usually where sections change. */
  phrases: number[]
  /** Key as pitch class 0–11 (0 = C), major/minor, and how clear (0–1). */
  key: number
  minor: boolean
  keyClarity: number
  /** Whole-track RMS loudness in dBFS. */
  loudness: number
  /** Frames per second of the curves below (10). */
  frameRate: number
  /** Overall energy per frame (0–1, relative to the track's loudest frame). */
  energy: number[]
  /** Band energy per frame (0–1 each, relative to the band's loudest): low < 200 Hz, mid 200–2000 Hz, high > 2000 Hz. */
  bands: { low: number[]; mid: number[]; high: number[] }
  /** The song's structure, in order, covering the whole track. */
  sections: MixSection[]
  /** Drop moments (a phrase start where bass and energy jump after a build-up). */
  drops: number[]
  /** Stretches with singing. */
  vocals: Array<{ start: number; end: number }>
  /** Where `vocals` came from: synced lyrics aligned to the audio, an estimate from the audio, or nothing found. */
  vocalSource: 'lyrics' | 'audio' | 'none'
  /** First phrase where the song is fully "in" (beat and bass), and where it starts to wind down after its last chorus/drop. */
  introEnd: number
  outroStart: number
  /** Good moments to bring this song in / take it out (phrase starts, best first). */
  cuesIn: number[]
  cuesOut: number[]
}

export type MixStyle = 'clean' | 'party'

export type PresetId =
  | 'auto'
  | 'crossfade'
  | 'fadeOut'
  | 'fadeIn'
  | 'bassSwap'
  | 'filterBuild'
  | 'echoOut'
  | 'dropSwap'
  | 'hardCut'
  | 'brake'
  | 'none'

/** One point of an automation curve: seconds from the transition's start, and a value (see `DeckAutomation`). */
export interface Keyframe {
  t: number
  v: number
}

/**
 * How one deck sounds during a transition. Between keyframes values move linearly; before the first and after the last
 * they hold. An empty list means "unchanged" (1 for gain and the bands, 0 for the filter). Gain and band values are
 * amplitude factors moved linearly (0.5 = -6 dB), so a perceptual shape (equal power) needs extra keyframes. B's
 * automation should end neutral: after `length` the player glides B to neutral within 50 ms anyway.
 */
export interface DeckAutomation {
  /** Volume, 0–1. */
  gain: Keyframe[]
  /** 3-band EQ, linear 0–1 per band (1 = flat, 0 = killed). */
  low: Keyframe[]
  mid: Keyframe[]
  high: Keyframe[]
  /** One-knob filter, -1–1: 0 open, towards -1 a low-pass closes, towards 1 a high-pass rises. */
  filter: Keyframe[]
}

export type TransitionEffect =
  /** Echo on a deck from `at` on (seconds from the transition's start): delay of `beats` beats, feedback 0–1. */
  | { kind: 'echo'; deck: 'a' | 'b'; at: number; beats: number; feedback: number }
  /** Deck A slows to a stop ("brake") from `at` over `length` seconds. */
  | { kind: 'brake'; deck: 'a'; at: number; length: number }

/**
 * A transition from track A to track B. At A's `aOut` B starts at its `bIn`; for `length` seconds both play and the
 * automation applies; after that A is gone and B plays on. A party transition skips B's intro (bIn > 0) and cuts A's
 * outro (aOut + length < A's duration). Skipped parts still count as played.
 */
export interface Transition {
  v: 1
  from: string
  to: string
  style: MixStyle
  preset: PresetId
  aOut: number
  bIn: number
  length: number
  /** B's playback rate while the decks overlap (beatmatching, pitch kept); eases back to 1 over the 8 bars after. */
  rate: number
  /**
   * Both songs' tempo (BPM) as planned with: echo delays are counted in beats and B's rate eases back over 8 of its
   * bars. 120 when a song's tempo is unknown.
   */
  tempo: { a: number; b: number }
  a: DeckAutomation
  b: DeckAutomation
  effects: TransitionEffect[]
  /** Set by the editor: a hand-made transition, which "sort & build" warns before replacing. */
  custom: boolean
  /** How sure the planner is that this sounds right (0–1); low when the analysis was unsure. */
  confidence: number
}

/** A playlist's mixer settings, kept on the Lumio server (`/music/mixer/<playlistId>`). */
export interface PlaylistMixer {
  on: boolean
  style: MixStyle
  /** Transitions by pair key (`pairKey(from, to)`); pairs without one get an automatic transition. */
  transitions: Record<string, Transition>
  updated: number
}

export const pairKey = (from: string, to: string) => `${from}>${to}`
