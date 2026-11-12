import type { Store } from './store.ts'
import { partsIn } from './wrapped.ts'

/**
 * Someone's listening, boiled down per song for the mixes the app builds (daylist, daily mixes, radios): how much they
 * play it now and over the long run, how often they skip it, and at which times of the day and week; and which songs
 * they hear in one sitting. Lumio's own plays and imported ones (Spotify) count alike; only songs in the library (a
 * Jellyfin id) are kept.
 */
export interface TasteSignals {
  /** When the numbers were made (the decays are relative to it). */
  at: number
  /** The time zone the day parts are in. */
  timeZone: string
  tracks: Record<string, TrackSignals>
  /**
   * What they played from lately (the player's source keys, e.g. `playlist:<id>`): minutes listened, fading with a
   * half-life of a week, and the last time (ms). For the home grid's "heavy rotation".
   */
  sources: Record<string, { w: number; t: number }>
  /**
   * What was heard in one sitting over the last half year (a pause of half an hour starts a new one): each sitting's
   * distinct songs, as places in `keys`. Artists heard together belong together (the Daily Mixes group by it).
   */
  sessions: { keys: string[]; lists: number[][] }
}

export interface TrackSignals {
  /**
   * Plays that count (30 s or more, or to the end). Skipping on after 30 s takes nothing away (songs left late are
   * played again more often than those heard out); going back to a song counts half a play more, unless it was
   * only passed on the way further back (under 30 s, or left by going back again).
   */
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
const SOURCE_HALF_LIFE = 7 * DAY
const SOURCE_HORIZON = 60 * DAY
/** Older plays say too little to be worth reading. */
const HORIZON = 3 * 365 * DAY
/** Going back to a song (and hearing it) says more than letting it come up. */
const BACK_WEIGHT = 1.5
const SESSION_HORIZON = 182 * DAY
const SESSION_GAP = 30 * 60_000
/** A sitting's songs beyond this say little more about what belongs together. */
const SESSION_MAX = 80
const JELLYFIN_ID = /^[0-9a-f]{32}$/i

export function tasteSignals(store: Store, userId: string, timeZone: string, now = Date.now()): TasteSignals {
  const tracks: Record<string, TrackSignals> = {}
  const keys = new Map<string, number>()
  const lists: number[][] = []
  let sitting = new Set<number>()
  let sittingEnd = 0
  const closeSitting = () => {
    if (sitting.size >= 2) lists.push([...sitting])
    sitting = new Set()
  }
  for (const play of store.tasteRows(userId, now - HORIZON)) {
    if (!JELLYFIN_ID.test(play.key)) continue
    if (play.startedAt >= now - SESSION_HORIZON) {
      if (play.startedAt - sittingEnd > SESSION_GAP) closeSitting()
      sittingEnd = Math.max(sittingEnd, play.startedAt + play.seconds * 1000)
      if (play.seconds >= 30 && sitting.size < SESSION_MAX) {
        if (!keys.has(play.key)) keys.set(play.key, keys.size)
        sitting.add(keys.get(play.key)!)
      }
    }
    const entry = (tracks[play.key] ??= { p: 0, m: 0, s: 0, l: 0, k: 0, t: 0, d: new Array(12).fill(0) })
    entry.t = Math.max(entry.t, play.startedAt)
    // A skip is leaving a song early for another one; stopping the music (closing the app) says nothing about it.
    if (play.seconds < 30 && play.reasonEnd !== 'trackdone') {
      if (play.reasonEnd === 'fwdbtn') entry.k++
      continue
    }
    // Going back to a song and staying with it; one only passed on the way further back says nothing.
    const weight = play.reasonStart === 'backbtn' && play.reasonEnd !== 'backbtn' ? BACK_WEIGHT : 1
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
  const sources: Record<string, { w: number; t: number }> = {}
  for (const play of store.sourceRows(userId, now - SOURCE_HORIZON)) {
    const entry = (sources[play.source] ??= { w: 0, t: 0 })
    entry.w += (play.seconds / 60) * 0.5 ** (Math.max(0, now - play.startedAt) / SOURCE_HALF_LIFE)
    entry.t = Math.max(entry.t, play.startedAt)
  }
  for (const entry of Object.values(sources)) entry.w = round(entry.w)
  closeSitting()
  return { at: now, timeZone, tracks, sources, sessions: { keys: [...keys.keys()], lists } }
}
