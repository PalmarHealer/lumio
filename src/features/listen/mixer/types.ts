/**
 * Mixer (DJ) mode: the shapes shared by the server's whole-track analysis (server/src/mix-analysis.ts keeps an
 * identical copy of `TrackMix`, the server can't import from src/), the transition planner, the Web Audio engine and
 * the UI. Everything in src/features/listen/mixer/ except the React/UI files imports only relatively and touches no DOM
 * at load time, so node can run it for tests (`node --experimental-strip-types`).
 *
 * Times are seconds into the track unless said otherwise.
 */

/** Raised when the analysis changes, so songs are analysed again. */
export const MIX_VERSION = 4

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
  /** Beat times (seconds, 3 decimals), following the music (not a rigid grid), on the audible attacks. */
  beats: number[]
  /** The beats that start a bar (a subset of `beats`). */
  downbeats: number[]
  /** Phrase starts: downbeats where an 8-bar (sometimes 4/16) phrase begins, usually where sections change. */
  phrases: number[]
  /**
   * Per phrase (same index as `phrases`, each up to the next phrase or the end): how safely its beats can be laid over
   * another song's (0–1, the share of beats that aren't flam material). A beat is flam material where a clear attack
   * lies near the grid (within 50 ms) but not on it (more than 12 ms off: a grid beside its attacks, a doubled or
   * wandering attack) in the broadband or the snare/clap/hat attacks (averaged over the 2 bars around it); attacks on
   * the grid, no clear attacks (pads, silence) and stabs well off the beat are clear. The kick is measured apart
   * (`barKickClarity`).
   */
  phraseClarity: number[]
  /**
   * Per bar (same index as `downbeats`, each up to the next downbeat or the end): the same measure for that bar's beats
   * alone. Lets a beatmatch use the clear bars of a phrase that is unclear elsewhere. Empty in analyses made before it.
   */
  barClarity: number[]
  /**
   * Per bar (same index as `downbeats`): the same measure for the kick alone (40–150 Hz, against `kickOffset`): low
   * where a kick attack lies within 50 ms of where the song's kicks sit but more than 12 ms from it (doubled or
   * scattered). Two decks' kicks flam there unless one deck's lows are down. Empty in analyses made before it.
   */
  barKickClarity: number[]
  /**
   * Per phrase (same index as `phrases`): what it plays harmonically, as 12 values (pitch classes from C, 0–1, the
   * strongest 1). Taken from the melody's range (C3–C6) with short transients (drums) held out, so phrases with similar
   * melodies and chords have similar profiles (cosine). Empty in analyses made before it.
   */
  phraseChroma: number[][]
  /**
   * Seconds the song's kick attacks lie behind its beat grid (the grid follows the broadband and snare/clap attacks;
   * a kick's low rise peaks later by a song-specific amount): the median over the 2-bar stretches with one clear kick
   * attack. 0 when unknown (fewer than 4 such stretches) and in analyses made before it.
   */
  kickOffset: number
  /**
   * Seconds the song's snare/clap/hat attacks (1.5–5 kHz) lie behind its beat grid: the median over the 2-bar stretches
   * with one clear accent attack. 0 when unknown (fewer than 4 such stretches) and in analyses made before it.
   */
  accentOffset: number
  /**
   * Where the off-beat 16ths fall, as a share of the beat between two 8ths (0.5 = straight, about 0.6–0.67 = swung): a
   * swung and a straight groove can't both be loud without flamming. 0.5 when unknown and in analyses made before it.
   */
  swing: number
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
  /**
   * Stretches with singing, padded for safety ("never two vocals at once" may rely on them): synced lyrics give only
   * line starts, and their timing may be off. Lyrics kept where they were timed (offset 0) are padded by one beat (at
   * least 0.5 s) each side; lyrics the analysis had to move (another version) by 2 s each side, the measured placement
   * error. A line's end isn't known: it ends 0.15 s before the next line, at most as long as its words take (about 3 a
   * second, at least 1.5 s) and at most 1.25 times the song's median line distance (2–8 s); stretches that touch after
   * padding are merged.
   */
  vocals: Array<{ start: number; end: number }>
  /**
   * Where `vocals` came from: synced lyrics aligned to the audio; `unplaced` when the song has lyrics but they couldn't
   * be placed on this recording (another version, or a check that failed: `vocals` is empty although someone sings,
   * where is unknown); an estimate from the audio; or nothing found (no lyrics: maybe instrumental).
   */
  vocalSource: 'lyrics' | 'unplaced' | 'audio' | 'none'
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
  | 'blend'
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
 * automation should end neutral: after `length` the player glides B to neutral within 50 ms anyway. Keyframe times
 * are transition time (t), whatever the decks' paths and rates do.
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
  /**
   * Reverb send, 0–1 (0 = dry): the deck's sound after its gain feeds a hall whose tail rings on after the deck is cut,
   * e.g. rising over A's last bars so A dissolves into B. Missing or empty = no reverb (transitions made before it).
   */
  reverb?: Keyframe[]
}

export type TransitionEffect =
  /** Echo on a deck from `at` on (seconds from the transition's start): delay of `beats` beats, feedback 0–1. */
  | { kind: 'echo'; deck: 'a' | 'b'; at: number; beats: number; feedback: number }
  /** Deck A slows to a stop ("brake") from `at` over `length` seconds. */
  | { kind: 'brake'; deck: 'a'; at: number; length: number }

/**
 * A stretch of a track (seconds) a deck plays from `from` to `to`, `repeat` times in a row (more than once = a loop:
 * the stretch should be whole bars, so the beat runs on seamlessly).
 */
export interface DeckSegment {
  from: number
  to: number
  repeat: number
}

/**
 * A transition from track A to track B, on one clock: transition time t, 0 at its start. At t = 0 A is at `aOut`; at
 * t = `bAt` B starts at `bIn`; at t = `length` A is gone and B plays on. Each deck follows its `path` (loops let a
 * transition take its time without either song running into singing or a drop) at its `rate` curve, pitch kept.
 * A party transition may skip B's intro and cut A's outro; skipped parts still count as played.
 */
export interface Transition {
  v: 2
  from: string
  to: string
  style: MixStyle
  preset: PresetId
  /** A's track position at t = 0. */
  aOut: number
  /** When B starts (transition time, ≥ 0) and where in its track. */
  bAt: number
  bIn: number
  /** When A is gone (transition time). */
  length: number
  /**
   * The stretches each deck plays from its start, in order (A's first one starts at `aOut`, B's at `bIn`); after the
   * last one the deck plays straight on. Empty = straight through.
   */
  pathA: DeckSegment[]
  pathB: DeckSegment[]
  /**
   * Playback rate over transition time per deck (keyframes, linear between, holding outside; pitch kept). Beatmatching
   * meets in the middle: A glides to the meeting tempo before B comes in, B starts at it and glides back to 1 after A is
   * gone (its last keyframe is 1 and may lie after `length`). Empty = 1.
   */
  rateA: Keyframe[]
  rateB: Keyframe[]
  /**
   * Both songs' tempo (BPM) as planned with: echo delays are counted in beats. 120 when a song's tempo is unknown.
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
