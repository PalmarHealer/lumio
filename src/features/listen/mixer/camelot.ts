/**
 * Keys on the Camelot wheel, for harmonic mixing. The wheel puts the 24 keys on 12 "hours": the number walks the circle
 * of fifths, the letter tells minor (A) from major (B). Neighbours on the wheel share all but one note, so they blend:
 * - the same code, one hour up or down, or the other letter on the same hour (relative major/minor) mix cleanly;
 * - two hours up is the classic "energy boost" (audible, usually fine for a short overlap), two down a little less so;
 * - one hour across letters (8A → 9B) works for short blends; anything else clashes when both decks sound together.
 *
 * How clear the analysis found the key (`keyClarity`) matters as much as the key itself: a song whose key the analysis
 * isn't sure of (drums only, atonal, a key change) scores neutral, so it isn't pushed away from anything nor treated
 * as a perfect match.
 */

export interface Camelot {
  /** 1–12, the hour on the wheel. */
  number: number
  /** A = minor, B = major. */
  letter: 'A' | 'B'
}

export interface KeyInfo {
  /** Pitch class 0–11 (0 = C). */
  key: number
  minor: boolean
  /** 0–1; missing counts as clear. */
  keyClarity?: number
}

export type HarmonicRelation = 'same' | 'adjacent' | 'relative' | 'diagonal' | 'boost' | 'lower' | 'clash'

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

/** How well each relation blends when both decks sound together (1 = perfectly). */
const RELATION_SCORE: Record<HarmonicRelation, number> = {
  same: 1,
  adjacent: 0.9,
  relative: 0.85,
  diagonal: 0.6,
  boost: 0.55,
  lower: 0.45,
  clash: 0.1,
}

/** What an unclear key scores: neither a match nor a clash. */
export const NEUTRAL_HARMONY = 0.6

const validKey = (key: number) => Number.isInteger(key) && key >= 0 && key <= 11

/** The Camelot code of a key, or null when the key isn't a pitch class. C major is 8B, A minor 8A. */
export function toCamelot(key: number, minor: boolean): Camelot | null {
  if (!validKey(key)) return null
  // Major keys walk the circle of fifths from C = 8; a minor key sits on the hour of its relative major (3 semitones up).
  const major = minor ? (key + 3) % 12 : key
  return { number: ((7 * major + 7) % 12) + 1, letter: minor ? 'A' : 'B' }
}

/** "8A", or '' for an unknown key. */
export function camelotLabel(key: number, minor: boolean): string {
  const code = toCamelot(key, minor)
  return code ? `${code.number}${code.letter}` : ''
}

/** Reads "8A" / "12b" back into a key, or null. */
export function fromCamelot(label: string): { key: number; minor: boolean } | null {
  const match = /^\s*(\d{1,2})\s*([ab])\s*$/i.exec(label)
  if (!match) return null
  const number = Number(match[1])
  const minor = match[2].toUpperCase() === 'A'
  for (let key = 0; key < 12; key++) {
    if (toCamelot(key, minor)?.number === number) return { key, minor }
  }
  return null
}

/** "A minor", "E♭ major", or '' for an unknown key. */
export function keyName(key: number, minor: boolean): string {
  return validKey(key) ? `${NAMES[key]} ${minor ? 'minor' : 'major'}` : ''
}

/** How B's key relates to A's on the wheel (direction matters only for the two-hour step). */
export function harmonicRelation(a: Camelot, b: Camelot): HarmonicRelation {
  const up = (((b.number - a.number) % 12) + 12) % 12
  if (a.letter === b.letter) {
    if (up === 0) return 'same'
    if (up === 1 || up === 11) return 'adjacent'
    if (up === 2) return 'boost'
    if (up === 10) return 'lower'
    return 'clash'
  }
  if (up === 0) return 'relative'
  if (up === 1 || up === 11) return 'diagonal'
  return 'clash'
}

/** 0–1 weight of the key comparison: none below a clarity of 0.2, full from 0.6. */
function clarityWeight(clarity: number) {
  if (!Number.isFinite(clarity)) return 0
  const x = Math.min(1, Math.max(0, (clarity - 0.2) / 0.4))
  return x * x * (3 - 2 * x)
}

/**
 * How well B's key follows A's (0–1). The less clear either key is, the closer the score moves to the neutral 0.6,
 * so an unsure analysis neither rewards nor punishes a pairing.
 */
export function harmonicScore(a: KeyInfo, b: KeyInfo): number {
  const ca = toCamelot(a.key, a.minor)
  const cb = toCamelot(b.key, b.minor)
  if (!ca || !cb) return NEUTRAL_HARMONY
  const raw = RELATION_SCORE[harmonicRelation(ca, cb)]
  const weight = clarityWeight(Math.min(a.keyClarity ?? 1, b.keyClarity ?? 1))
  return NEUTRAL_HARMONY + (raw - NEUTRAL_HARMONY) * weight
}
