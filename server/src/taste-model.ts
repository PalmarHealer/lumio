import type { Track, UserData } from './music-catalog.ts'
import type { TasteSignals, TasteSittings } from './taste.ts'
import { partsIn } from './wrapped.ts'

/**
 * The taste model the mixes and radios are built from: how much the listener loves each song, now and over the long
 * run, and how much a song they never played is likely to suit them.
 * - Long run and "now": Lumio's play log (see taste.ts) fades plays with a half-life of half a year and of two weeks;
 *   without it, Jellyfin's play count and last played date stand in.
 * - A phase: artists and genres taking a much bigger share of the last weeks than of the long run get a boost
 *   everywhere, so a new obsession shows up in the mixes within days.
 * - Skips: a song skipped in its first 30 seconds again and again sinks (smoothed, so one skip says little; how early
 *   in those 30 seconds makes no difference to whether it gets played again). Skipping on later takes nothing away, and
 *   going back to a song counts half a play more (the signals' weights).
 * - Fatigue: what played in the last hours steps back a little (people replay a song soonest right after hearing it, so
 *   only a little).
 * - Times: how much each artist is heard in each slot of the week, so a time of day has its artists, not just its songs.
 * - Together: artists heard in the same sittings belong together, whatever their genres say.
 * - Discovery: unplayed songs are scored by how much their artists and genres are loved, Last.fm's similar artists and
 *   what other listeners who love the same artists love (see community.ts), so the new songs in a mix are near the
 *   listener's taste, not random.
 */

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/** The parts of the day (as the signals count them): early morning, morning, afternoon, evening, night, late night. */
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
 * Where a moment sits in the listener's week: its day part, the weekday it belongs to (late night still counts to the
 * day before, 0 = Monday), whether that feels like the weekend (Friday night on) and the slot (0–11) in a song's `d`.
 */
export function slotOf(at: number, timeZone: string) {
  const parts = partsIn(at, timeZone)
  const part = dayPartOf(parts.hour)
  const weekday = parts.hour < 5 ? (parts.weekday + 6) % 7 : parts.weekday
  const weekend = weekday >= 5 || (weekday === 4 && part >= 4)
  return { part, weekday, weekend, slot: (weekend ? 6 : 0) + part, hour: parts.hour }
}

const dateFormats = new Map<string, Intl.DateTimeFormat>()

/** A date in the listener's time zone, as 2026-11-10. */
export function localDate(at: number, timeZone: string) {
  let format = dateFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('sv', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dateFormats.set(timeZone, format)
  }
  return format.format(at)
}

/** The date of the last given weekday (0 = Monday) on or before a moment: a week that turns over on that day. */
export function weekOf(at: number, startDay: number, timeZone: string) {
  const weekday = partsIn(at, timeZone).weekday
  return localDate(at - ((weekday - startDay + 7) % 7) * DAY, timeZone)
}

export interface TasteModel {
  /** How much the listener loves a song they know (0 when it doesn't count for their taste); fatigue included. */
  love: (track: Track) => number
  /** How likely an unplayed (or barely played) song suits them. */
  novelty: (track: Track) => number
  /** Whether they have really heard it (counted plays or a heart). */
  known: (track: Track) => boolean
  /** Long-run love without "now" and fatigue (for Repeat Rewind). */
  longRun: (track: Track) => number
  /** "Now" plays (fading over two weeks). */
  now: (track: Track) => number
  /** Plays in the last 30 days. */
  month: (track: Track) => number
  /** When it was last played (ms, 0: never). */
  lastPlayed: (track: Track) => number
  /** How often it was heard in a slot of the week (see slotOf), fading over three months. */
  slot: (track: Track, slot: number) => number
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

const artistIds = new WeakMap<Track, string[]>()

/** The ids of a song's artists (its own and the album's); remembered per song (asked for again and again). */
export function artistIdsOf(track: Track) {
  let ids = artistIds.get(track)
  if (!ids) {
    ids = [...new Set([...(track.ArtistItems ?? []), ...(track.AlbumArtists ?? [])].map((artist) => artist.Id).filter((id): id is string => !!id))]
    artistIds.set(track, ids)
  }
  return ids
}

/** A song's credited artists (ids where Jellyfin has them), as the app shows them. */
export function artistsOf(track: Track): Array<{ id?: string; name: string }> {
  if (track.ArtistItems?.length) return track.ArtistItems.map((artist) => ({ id: artist.Id, name: artist.Name ?? '' }))
  return (track.Artists ?? []).filter(Boolean).map((name) => ({ name }))
}

export interface ModelInput {
  tracks: Track[]
  userData: (track: Track) => UserData | undefined
  signals: TasteSignals | null
  /** Which songs count for the taste profile. */
  counts: (track: Track) => boolean
  now: number
  /** Library artists Last.fm calls similar to the listener's favourites. */
  similar?: ReadonlySet<string>
  /** Library artists other listeners with the same favourites love (0–1, see community.ts). */
  community?: ReadonlyMap<string, number>
  sittings?: TasteSittings | null
}

export function buildTasteModel(input: ModelInput): TasteModel {
  const { tracks, userData, signals, counts, now, similar = new Set(), community = new Map(), sittings: sittingsData = null } = input
  const entries = new Map<string, { long: number; short: number; month: number; last: number; skip: number; fav: boolean; counts: boolean; known: boolean }>()
  for (const track of tracks) {
    const signal = signals?.tracks[track.Id]
    const data = userData(track)
    const plays = data?.PlayCount ?? 0
    const fav = !!data?.IsFavorite
    // Most of a big library was never played: nothing to work out for those but whether they count.
    if (!signal && !plays && !fav) {
      entries.set(track.Id, { long: 0, short: 0, month: 0, last: 0, skip: 1, fav: false, counts: counts(track), known: false })
      continue
    }
    const last = Math.max(signal?.t ?? 0, Date.parse(data?.LastPlayedDate ?? '') || 0)
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
    entries.set(track.Id, { long, short, month, last, skip, fav, counts: counts(track), known: fav || plays > 0 || (signal?.p ?? 0) >= 1 })
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
    const entry = entries.get(track.Id)
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
    let max = 1e-9
    for (const value of map.values()) if (value > max) max = value
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
  const inPhase = (track: Track) => artistIdsOf(track).some((id) => phaseArtistSet.has(id)) || (track.Genres ?? []).some((name) => phaseGenreSet.has(name))
  const maxOf = (values: number[]) => values.reduce((max, value) => (value > max ? value : max), 0)
  const artistOf = (track: Track) => maxOf(artistIdsOf(track).map(artist))
  const genreOf = (track: Track) => maxOf((track.Genres ?? []).map(genre))
  const communityOf = (track: Track) => maxOf(artistIdsOf(track).map((id) => community.get(id) ?? 0))

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
  const byId = new Map<string, Track>()
  for (const track of tracks) byId.set(track.Id, track)
  for (const [id, signal] of Object.entries(signals?.tracks ?? {})) {
    const track = byId.get(id)
    if (!track || !entries.get(id)?.counts) continue
    const artists = artistIdsOf(track)
    for (let slot = 0; slot < 12; slot++) {
      const plays = signal.d[slot] ?? 0
      if (!plays) continue
      slotTotals[slot]! += plays
      for (const id of artists) {
        const list = artistSlots.get(id) ?? new Array<number>(12).fill(0)
        list[slot]! += plays
        artistSlots.set(id, list)
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
    const keys = sittingsData?.keys ?? []
    for (const list of sittingsData?.lists ?? []) {
      const artists = [
        ...new Set(
          list.flatMap((at) => {
            const track = byId.get(keys[at] ?? '')
            return track && entries.get(track.Id)?.counts ? artistIdsOf(track) : []
          }),
        ),
      ]
      if (artists.length < 2) continue
      for (const id of artists) add(count, id, 1)
      for (let i = 0; i < artists.length; i++) for (let j = i + 1; j < artists.length; j++) add(pairs, pairKey(artists[i]!, artists[j]!), 1)
    }
    return (sittings = { count, pairs })
  }
  /** Fewer sittings than this say too little about who an artist is heard with. */
  const MIN_SITTINGS = 3

  return {
    love: (track) => {
      const entry = entries.get(track.Id)
      if (!entry?.counts) return 0
      const own = Math.log2(1 + entry.long * 2) + 1.6 * Math.log2(1 + entry.short * 3) + (entry.fav ? 2 : 0)
      return (0.3 + own + 1.2 * artistOf(track) + 0.5 * genreOf(track) + (inPhase(track) ? 1.5 : 0)) * entry.skip * fatigue(entry.last)
    },
    novelty: (track) => {
      const entry = entries.get(track.Id)
      if (!entry?.counts) return 0
      const similarArtist = artistIdsOf(track).some((id) => similar.has(id)) ? 1 : 0
      return (0.15 + 2 * artistOf(track) + 1.2 * genreOf(track) + similarArtist + 1.2 * communityOf(track) + (inPhase(track) ? 1 : 0)) * entry.skip * fatigue(entry.last)
    },
    known: (track) => !!entries.get(track.Id)?.known,
    longRun: (track) => {
      const entry = entries.get(track.Id)
      return entry?.counts ? (entry.long + (entry.fav ? 1.5 : 0)) * entry.skip : 0
    },
    now: (track) => entries.get(track.Id)?.short ?? 0,
    month: (track) => entries.get(track.Id)?.month ?? 0,
    lastPlayed: (track) => entries.get(track.Id)?.last ?? 0,
    slot: (track, slot) => signals?.tracks[track.Id]?.d[slot] ?? 0,
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
    heardTogether: !!sittingsData?.lists.length,
    artist,
    genre,
    phaseArtists,
    phaseGenres,
    detailed: !!signals,
  }
}
