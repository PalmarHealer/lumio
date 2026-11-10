import type { Store } from './store.ts'
import { partsIn } from './wrapped.ts'

/**
 * Someone's listening, boiled down per song for the mixes the app builds (daylist, daily mixes, radios): how much they
 * play it now and over the long run, how often they skip it, and at which times of the day and week. Lumio's own plays
 * and imported ones (Spotify) count alike; only songs in the library (a Jellyfin id) are kept.
 */
export interface TasteSignals {
  /** When the numbers were made (the decays are relative to it). */
  at: number
  /** The time zone the day parts are in. */
  timeZone: string
  tracks: Record<string, TrackSignals>
}

export interface TrackSignals {
  /** Plays that count (30 s or more, or to the end); a song skipped late counts half. */
  p: number
  /** Plays in the last 30 days. */
  m: number
  /** "Now": plays fading with a half-life of two weeks (a phase shows up here first). */
  s: number
  /** The long run: plays fading with a half-life of half a year. */
  l: number
  /** Skipped within the first 30 seconds. */
  k: number
  /** Last time it played at all (ms), skipped or not. */
  t: number
  /**
   * When it is heard, fading with a half-life of three months: 12 numbers, the six day parts (see dayPartOf) of a
   * weekday, then those of a weekend day.
   */
  d: number[]
}

/** The six parts of the day (from 5, 9, 12, 17, 21 and 1 o'clock): early morning, morning, afternoon, evening, night, late night. */
export function dayPartOf(hour: number) {
  if (hour >= 1 && hour < 5) return 5
  if (hour >= 21 || hour < 1) return 4
  if (hour >= 17) return 3
  if (hour >= 12) return 2
  if (hour >= 9) return 1
  return 0
}

const DAY = 24 * 60 * 60_000
const SHORT_HALF_LIFE = 14 * DAY
const LONG_HALF_LIFE = 182 * DAY
const SLOT_HALF_LIFE = 91 * DAY
/** Older plays say too little to be worth reading. */
const HORIZON = 3 * 365 * DAY
const JELLYFIN_ID = /^[0-9a-f]{32}$/i

export function tasteSignals(store: Store, userId: string, timeZone: string, now = Date.now()): TasteSignals {
  const tracks: Record<string, TrackSignals> = {}
  for (const play of store.tasteRows(userId, now - HORIZON)) {
    if (!JELLYFIN_ID.test(play.key)) continue
    const entry = (tracks[play.key] ??= { p: 0, m: 0, s: 0, l: 0, k: 0, t: 0, d: new Array(12).fill(0) })
    entry.t = Math.max(entry.t, play.startedAt)
    // A skip is leaving a song early for another one; stopping the music (closing the app) says nothing about it.
    if (play.seconds < 30 && play.reasonEnd !== 'trackdone') {
      if (play.reasonEnd === 'fwdbtn') entry.k++
      continue
    }
    const weight = play.reasonEnd === 'fwdbtn' ? 0.5 : 1
    const age = Math.max(0, now - play.startedAt)
    entry.p += weight
    if (age < 30 * DAY) entry.m += weight
    entry.s += weight * 0.5 ** (age / SHORT_HALF_LIFE)
    entry.l += weight * 0.5 ** (age / LONG_HALF_LIFE)
    const parts = partsIn(play.startedAt, timeZone)
    // Late night belongs to the day before it (Friday night goes on after midnight).
    const weekday = parts.hour < 5 ? (parts.weekday + 6) % 7 : parts.weekday
    // Friday and Saturday nights feel like the weekend.
    const part = dayPartOf(parts.hour)
    const weekend = weekday >= 5 || (weekday === 4 && part >= 4)
    entry.d[(weekend ? 6 : 0) + part]! += weight * 0.5 ** (age / SLOT_HALF_LIFE)
  }
  const round = (value: number) => Math.round(value * 1000) / 1000
  for (const entry of Object.values(tracks)) {
    entry.p = round(entry.p)
    entry.m = round(entry.m)
    entry.s = round(entry.s)
    entry.l = round(entry.l)
    entry.d = entry.d.map(round)
  }
  return { at: now, timeZone, tracks }
}
