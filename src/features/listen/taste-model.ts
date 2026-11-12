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
 * - Skips: a song skipped in its first 30 seconds again and again sinks (smoothed, so one skip says little; how early
 *   in those 30 seconds makes no difference to whether it gets played again). Skipping on later takes nothing away, and
 *   going back to a song counts half a play more (the server's weights).
 * - Fatigue: what played in the last hours steps back a little (people replay a song soonest right after hearing it, so
 *   only a little).
 * - Times: how much each artist is heard in each slot of the week, so a time of day has its artists, not just its songs.
 * - Together: artists heard in the same sittings belong together, whatever their genres say.
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
  /** Each sitting's distinct songs over the last half year, as places in `keys` (missing from an older server). */
  sessions?: { keys: string[]; lists: number[][] }
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
  /** How much an artist is heard in a slot of the week, and how much is heard in it altogether. */
  artistSlot: (id: string, slot: number) => number
  slotTotal: (slot: number) => number
  /** How much two artists are heard in the same sittings, 0–1 (0 without enough sittings of both). */
  together: (a: string, b: string) => number
  /** Whether the log's sittings were there (otherwise `together` is 0 for everyone). */
  heardTogether: boolean
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

  // What played lately steps back, gently: a year of listening showed a song is most likely played again right after it
  // was heard, so a strong step back takes out exactly what the listener wants (measured: a third of the hits).
  const fatigue = (last: number) => {
    if (!last) return 1
    const age = now - last
    return age < 3 * HOUR ? 0.5 : age < DAY ? 0.8 : 1
  }

  // When each artist is heard (the slots of the week), from their songs that count.
  const artistSlots = new Map<string, number[]>()
  const slotTotals = new Array<number>(12).fill(0)
  // Which artists a song in the log stands for (for the sittings).
  const artistsByTrack = new Map<string, string[]>()
  for (const track of tracks) {
    const id = keyOf(track)
    if (!entries.get(id)?.counts) continue
    const artists = artistIdsOf(track)
    artistsByTrack.set(id, artists)
    const slots = signals?.tracks[id]?.d
    if (!slots) continue
    for (let slot = 0; slot < 12; slot++) {
      const plays = slots[slot] ?? 0
      if (!plays) continue
      slotTotals[slot]! += plays
      for (const artist of artists) {
        const list = artistSlots.get(artist) ?? new Array<number>(12).fill(0)
        list[slot]! += plays
        artistSlots.set(artist, list)
      }
    }
  }

  // Artists heard in the same sittings (made when first asked for: not every mix needs it).
  let sittings: { count: Map<string, number>; pairs: Map<string, number> } | undefined
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const sittingsOf = () => {
    if (sittings) return sittings
    const count = new Map<string, number>()
    const pairs = new Map<string, number>()
    const keys = signals?.sessions?.keys ?? []
    for (const list of signals?.sessions?.lists ?? []) {
      const artists = [...new Set(list.flatMap((at) => artistsByTrack.get(keys[at] ?? '') ?? []))]
      if (artists.length < 2) continue
      for (const artist of artists) add(count, artist, 1)
      for (let i = 0; i < artists.length; i++) for (let j = i + 1; j < artists.length; j++) add(pairs, pairKey(artists[i]!, artists[j]!), 1)
    }
    return (sittings = { count, pairs })
  }
  /** Fewer sittings than this say too little about who an artist is heard with. */
  const MIN_SITTINGS = 3

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
    artistSlot: (id, slot) => artistSlots.get(id)?.[slot] ?? 0,
    slotTotal: (slot) => slotTotals[slot] ?? 0,
    together: (a, b) => {
      if (a === b) return 1
      const { count, pairs } = sittingsOf()
      const mine = count.get(a) ?? 0
      const theirs = count.get(b) ?? 0
      if (mine < MIN_SITTINGS || theirs < MIN_SITTINGS) return 0
      return (pairs.get(pairKey(a, b)) ?? 0) / Math.sqrt(mine * theirs)
    },
    heardTogether: !!signals?.sessions?.lists.length,
    artist,
    genre,
    phaseArtists,
    phaseGenres,
    detailed: !!signals,
  }
}
