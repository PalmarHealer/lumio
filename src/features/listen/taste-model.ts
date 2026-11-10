import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import type { QueryClient } from '@tanstack/react-query'
import { lumioGet } from '@/features/social/social'
import { artistsOf } from '@/lib/item-links'

/**
 * The taste model the mixes and radios are built from: how much the listener loves each song, now and over the long
 * run, and how much a song they never played is likely to suit them.
 * - Long run and "now": Lumio's play log (GET /me/taste) fades plays with a half-life of half a year and of two weeks;
 *   without it, Jellyfin's play count and last played date stand in.
 * - A phase: artists and genres taking a much bigger share of the last weeks than of the long run get a boost
 *   everywhere, so a new obsession shows up in the mixes within days.
 * - Skips: a song skipped in its first 30 seconds again and again sinks (smoothed, so one skip says little).
 * - Fatigue: what played in the last hours or days steps back for a while.
 * - Discovery: unplayed songs are scored by how much their artists and genres are loved (and Last.fm's similar artists),
 *   so the new songs in a mix are near the listener's taste, not random.
 */
export interface TrackSignals {
  p: number
  m: number
  s: number
  l: number
  k: number
  t: number
  d: number[]
}

export interface TasteSignals {
  at: number
  timeZone: string
  tracks: Record<string, TrackSignals>
  /** What was played from lately (source keys): minutes, fading with a half-life of a week, and the last time. */
  sources?: Record<string, { w: number; t: number }>
}

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

export function timeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** A GET to the Lumio server (null: no connection yet). */
export type LumioGet = (path: string) => Promise<Response | null>

/**
 * The play log's numbers, shared by the mixes and the radios; null when the server doesn't answer. Without a connection
 * yet it fails instead (not kept), so the next build asks again.
 */
export function tasteSignalsQuery(userId: string, get: LumioGet = lumioGet) {
  return {
    queryKey: ['taste-signals', userId, timeZone()],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<TasteSignals | null> => {
      const response = await get(`/me/taste?tz=${encodeURIComponent(timeZone())}`).catch(() => undefined)
      if (response === null) throw new Error('Not connected')
      return response?.ok ? ((await response.json()) as TasteSignals) : null
    },
  }
}

export function fetchTasteSignals(queryClient: QueryClient, userId: string, get?: LumioGet) {
  return queryClient.fetchQuery(tasteSignalsQuery(userId, get)).catch(() => null)
}

/** The parts of the day (as the server counts them): early morning, morning, afternoon, evening, night, late night. */
export type DayPart = 0 | 1 | 2 | 3 | 4 | 5

export function dayPartOf(hour: number): DayPart {
  if (hour >= 1 && hour < 5) return 5
  if (hour >= 21 || hour < 1) return 4
  if (hour >= 17) return 3
  if (hour >= 12) return 2
  if (hour >= 9) return 1
  return 0
}

/**
 * Where a moment sits in the week: its day part, the weekday it belongs to (late night still counts to the day before,
 * 0 = Monday), whether that feels like the weekend (Friday night on) and the slot (0–11) in a song's `d`.
 */
export function slotOf(date: Date) {
  const hour = date.getHours()
  const part = dayPartOf(hour)
  const weekday = ((hour < 5 ? date.getDay() - 1 : date.getDay()) + 6) % 7
  const weekend = weekday >= 5 || (weekday === 4 && part >= 4)
  return { part, weekday, weekend, slot: (weekend ? 6 : 0) + part }
}

export interface TasteModel {
  /** How much the listener loves a song they know (0 when it doesn't count for their taste); fatigue included. */
  love: (track: BaseItemDto) => number
  /** How likely an unplayed (or barely played) song suits them. */
  novelty: (track: BaseItemDto) => number
  /** Whether they have really heard it (counted plays or a heart). */
  known: (track: BaseItemDto) => boolean
  /** Long-run love without "now" and fatigue (for Repeat Rewind). */
  longRun: (track: BaseItemDto) => number
  /** "Now" plays (fading over two weeks). */
  now: (track: BaseItemDto) => number
  /** Plays in the last 30 days. */
  month: (track: BaseItemDto) => number
  /** When it was last played (ms, 0: never). */
  lastPlayed: (track: BaseItemDto) => number
  /** How often it was heard in a slot of the week (see slotOf), fading over three months. */
  slot: (track: BaseItemDto, slot: number) => number
  /** An artist's and a genre's share of the listener's love, 0–1 (the most loved is 1). */
  artist: (id: string) => number
  genre: (name: string) => number
  /** Artists and genres in a phase now (their share of the last weeks far above the long run's), strongest first. */
  phaseArtists: string[]
  phaseGenres: string[]
  /** Whether the play log was there (otherwise Jellyfin's counts stood in). */
  detailed: boolean
}

const keyOf = (track: BaseItemDto) => track.Id ?? ''

/** The ids of a song's artists (its own and the album's). */
export function artistIdsOf(track: BaseItemDto) {
  return [...new Set([...artistsOf(track), ...(track.AlbumArtists ?? []).map((artist) => ({ id: artist.Id ?? undefined }))].map((artist) => artist.id).filter((id): id is string => !!id))]
}

/**
 * Builds the model from the library's songs (with UserData and genres) and the play log. `counts` says which songs
 * count for the taste profile; `similar` are library artists Last.fm calls similar to the listener's favourites.
 */
export function buildTasteModel(
  tracks: BaseItemDto[],
  signals: TasteSignals | null,
  counts: (track: BaseItemDto) => boolean,
  now: number,
  similar: ReadonlySet<string> = new Set(),
): TasteModel {
  const entries = new Map<string, { long: number; short: number; month: number; last: number; skip: number; fav: boolean; counts: boolean; known: boolean }>()
  for (const track of tracks) {
    const id = keyOf(track)
    if (!id) continue
    const signal = signals?.tracks[id]
    const plays = track.UserData?.PlayCount ?? 0
    const fav = !!track.UserData?.IsFavorite
    const last = Math.max(signal?.t ?? 0, Date.parse(track.UserData?.LastPlayedDate ?? '') || 0)
    const age = last ? Math.max(0, now - last) : Infinity
    // Jellyfin's count covers plays from before the log (and other apps); faded by the last play, as a floor.
    const longFallback = plays * 0.5 ** (age / (182 * DAY))
    const shortFallback = Math.min(plays, 6) * 0.5 ** (age / (14 * DAY))
    const long = Math.max(signal?.l ?? 0, signal ? longFallback * 0.5 : longFallback)
    const short = signal ? signal.s : shortFallback
    const month = signal ? signal.m : age < 30 * DAY ? Math.min(plays, 5) : 0
    // Skips, smoothed (a prior of one in five): one skip says little, five in a row a lot.
    const skipRate = signal ? (signal.k + 1) / (signal.k + signal.p + 5) : 0.2
    const skip = Math.min(1, Math.max(0.15, 1 - 2.2 * Math.max(0, skipRate - 0.2)))
    entries.set(id, { long, short, month, last, skip, fav, counts: counts(track), known: fav || plays > 0 || (signal?.p ?? 0) >= 1 })
  }

  // Artists' and genres' love, long run and now.
  const artistLong = new Map<string, number>()
  const artistShort = new Map<string, number>()
  const genreLong = new Map<string, number>()
  const genreShort = new Map<string, number>()
  let totalLong = 0
  let totalShort = 0
  const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value)
  for (const track of tracks) {
    const entry = entries.get(keyOf(track))
    if (!entry?.counts || !entry.known) continue
    const long = entry.long + (entry.fav ? 1.5 : 0)
    totalLong += long
    totalShort += entry.short
    for (const artist of artistIdsOf(track)) {
      add(artistLong, artist, long)
      add(artistShort, artist, entry.short)
    }
    for (const genre of track.Genres ?? []) {
      add(genreLong, genre, long)
      add(genreShort, genre, entry.short)
    }
  }
  const normalized = (map: Map<string, number>) => {
    const max = Math.max(1e-9, ...map.values())
    return (key: string) => Math.log1p(map.get(key) ?? 0) / Math.log1p(max)
  }
  const artist = normalized(artistLong)
  const genre = normalized(genreLong)
  // A phase: at least 4 % of the last weeks, and more than twice the long-run share.
  const phase = (long: Map<string, number>, short: Map<string, number>) =>
    totalShort < 3
      ? []
      : [...short]
          .map(([key, value]) => ({ key, share: value / totalShort, ratio: value / totalShort / ((long.get(key) ?? 0) / Math.max(totalLong, 1e-9) + 0.01) }))
          .filter((entry) => entry.share >= 0.04 && entry.ratio >= 2)
          .sort((a, b) => b.share * b.ratio - a.share * a.ratio)
          .map((entry) => entry.key)
  const phaseArtists = phase(artistLong, artistShort)
  const phaseGenres = phase(genreLong, genreShort)
  const phaseArtistSet = new Set(phaseArtists.slice(0, 8))
  const phaseGenreSet = new Set(phaseGenres.slice(0, 4))
  const inPhase = (track: BaseItemDto) => artistIdsOf(track).some((id) => phaseArtistSet.has(id)) || (track.Genres ?? []).some((name) => phaseGenreSet.has(name))
  const artistOf = (track: BaseItemDto) => Math.max(0, ...artistIdsOf(track).map(artist))
  const genreOf = (track: BaseItemDto) => Math.max(0, ...(track.Genres ?? []).map(genre))

  // What played lately steps back: strongly for some hours, a little for a week.
  const fatigue = (last: number) => {
    if (!last) return 1
    const age = now - last
    return age < 6 * HOUR ? 0.15 : age < DAY ? 0.35 : age < 3 * DAY ? 0.65 : age < 7 * DAY ? 0.85 : 1
  }

  return {
    love: (track) => {
      const entry = entries.get(keyOf(track))
      if (!entry?.counts) return 0
      const own = Math.log2(1 + entry.long * 2) + 1.6 * Math.log2(1 + entry.short * 3) + (entry.fav ? 2 : 0)
      return (0.3 + own + 1.2 * artistOf(track) + 0.5 * genreOf(track) + (inPhase(track) ? 1.5 : 0)) * entry.skip * fatigue(entry.last)
    },
    novelty: (track) => {
      const entry = entries.get(keyOf(track))
      if (!entry?.counts) return 0
      const similarArtist = artistIdsOf(track).some((id) => similar.has(id)) ? 1 : 0
      return (0.15 + 2 * artistOf(track) + 1.2 * genreOf(track) + similarArtist + (inPhase(track) ? 1 : 0)) * entry.skip * fatigue(entry.last)
    },
    known: (track) => !!entries.get(keyOf(track))?.known,
    longRun: (track) => {
      const entry = entries.get(keyOf(track))
      return entry?.counts ? (entry.long + (entry.fav ? 1.5 : 0)) * entry.skip : 0
    },
    now: (track) => entries.get(keyOf(track))?.short ?? 0,
    month: (track) => entries.get(keyOf(track))?.month ?? 0,
    lastPlayed: (track) => entries.get(keyOf(track))?.last ?? 0,
    slot: (track, slot) => signals?.tracks[keyOf(track)]?.d[slot] ?? 0,
    artist,
    genre,
    phaseArtists,
    phaseGenres,
    detailed: !!signals,
  }
}
