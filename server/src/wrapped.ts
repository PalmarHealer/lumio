import type { Store, WrappedRow } from './store.ts'

/**
 * Wrapped: someone's year in listening, from their plays (Lumio's own and those imported from another service), as
 * Spotify sums it up. Days, hours and the year's edges are the person's own (their time zone). A year is ready once it
 * is over, the running one from 12 December on (as Spotify's comes out in early December).
 */
export interface Wrapped {
  year: number
  minutes: number
  /** Songs played for at least 30 seconds (Spotify's measure of a stream). */
  plays: number
  tracks: number
  artists: number
  /** The year before's minutes, when there were any. */
  previousMinutes: number | null
  /** The month each was heard most in (0 = January), their minutes in each month, and how many of their songs. */
  topArtists: Array<{ name: string; minutes: number; plays: number; peakMonth: number; months: number[]; tracks: number }>
  topTracks: WrappedTrack[]
  /** Up to 100 songs from the library, most played first (for a playlist of the year). */
  playlistKeys: string[]
  /** `sampleKey`: one of the album's songs (for a cover when the library doesn't have the album); `tracks`: how many of its songs. */
  topAlbums: Array<{ key: string; name: string | null; artist: string | null; sampleKey: string; minutes: number; plays: number; months: number[]; tracks: number }>
  topPodcasts: Array<{ name: string; minutes: number }>
  /** All podcast minutes (not only the top shows'). */
  podcastMinutes: number
  /**
   * Audio dramas and audiobooks (heard as songs, but told apart by their chapters): by series or author, with how many
   * of its episodes or books, the one heard most and one of its chapters (for a cover). Not in the songs, artists, albums.
   */
  topSpoken: Array<{ name: string; minutes: number; episodes: number; episode: string | null; sampleKey: string; contextId: string | null }>
  spokenMinutes: number
  /** Minutes per month (January first), hour of the day and weekday (Monday first). */
  months: number[]
  hours: number[]
  weekdays: number[]
  topDay: { date: string; minutes: number } | null
  firstTrack: (WrappedTrack & { at: number }) | null
  /** The song played most often on a single day. */
  onRepeat: (WrappedTrack & { date: string }) | null
  /** Artists heard for the first time this year, and the one heard most of them. */
  newArtists: { count: number; top: { name: string; minutes: number } | null }
  /** Minutes from each source: Lumio itself, or an imported service (by name). */
  sources: Record<string, number>
  /** Minutes on each day of the year (1 January first). */
  daily: number[]
  /** Days with any music. */
  activeDays: number
  /** The longest run of days in a row with music. */
  streak: { days: number; from: string; to: string } | null
  /** The share of the time between midnight and 4 in the morning (0..1). */
  lateNight: number
  /** The share of streams that were a song heard before that year (0..1; high: a creature of habit). */
  repeatShare: number
  /** The song come back to on the most different days. */
  comfort: (WrappedTrack & { days: number }) | null
}

export interface WrappedTrack {
  key: string
  title: string
  artist: string | null
  album: string | null
  contextId: string | null
  minutes: number
  plays: number
  /** Minutes in each month (January first). */
  months: number[]
}

/** A stream counts from 30 seconds on. */
const STREAM_SECONDS = 30
const DAY = 24 * 60 * 60_000

/** The day Wrapped of the running year comes out (month 0-based, day). */
const RELEASE = { month: 11, day: 12 }

/** Whether the year's Wrapped may be shown on `now` (in the person's time zone). */
export function wrappedReady(year: number, now: Date, timeZone: string) {
  const today = partsIn(now.getTime(), timeZone)
  return year < today.year || (year === today.year && (today.month > RELEASE.month || (today.month === RELEASE.month && today.day >= RELEASE.day)))
}

/** The time zone asked for, when it is a real one; else UTC. */
export function validTimeZone(name: string | null) {
  if (!name) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return name
  } catch {
    return 'UTC'
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** A moment's year, month (0-based), day, hour and weekday (0 = Monday) in a time zone. */
export function partsIn(at: number, timeZone: string) {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', weekday: 'short', hourCycle: 'h23' })
    formatters.set(timeZone, format)
  }
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(at)) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday ?? 'Mon'),
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The main artist of a play: named by newer plays, else the first of its artists. */
function artistOf(row: { artist: string | null; subtitle: string | null }) {
  return (row.artist ?? row.subtitle?.split(', ')[0] ?? '').trim() || null
}

const nameKey = (name: string) => name.toLocaleLowerCase('en').normalize('NFKC').trim()

/** Adds to a tally kept under a key, remembering the first value seen for it. */
function tally<T extends { minutes: number; plays: number }>(map: Map<string, T>, key: string, make: () => T, seconds: number) {
  let entry = map.get(key)
  if (!entry) map.set(key, (entry = make()))
  entry.minutes += seconds / 60
  if (seconds >= STREAM_SECONDS) entry.plays += 1
  return entry
}

/** Plays within the year in the time zone (the query takes a little more on both sides), audio dramas told apart. */
function rowsOfYear(store: Store, userId: string, year: number, timeZone: string) {
  const from = Date.UTC(year, 0, 1) - DAY
  const to = Date.UTC(year + 1, 0, 1) + DAY
  return spokenApart(store.wrappedRows(userId, from, to).filter((row) => partsIn(row.startedAt, timeZone).year === year))
}

/** A chapter's title: "Teil 03", "Track 12 - …", "…, Kapitel 6", "Chapter 4". */
const CHAPTER = /(?:^|[\s,:(\-–])(?:teil|track|kapitel|chapter|part|capítulo|chapitre)\s*\d+/i
/** Said by the album's name: "Hörspiel", "Hörbuch", "ungekürzt", "Audiobook". */
const SPOKEN_ALBUM = /h(?:ö|oe)rspiel|h(?:ö|oe)rbuch|ungek(?:ü|ue)rzt|audiobook|audio drama/i
/** An episode's album name: "06: Abenteuer auf dem Mars", "071/Die verschwundene Seglerin", "Folge 12: …". */
const EPISODE_ALBUM = /^(?:folge\s*)?\d{1,3}\s*[:/]|\bfolge\s*\d+/i

const albumKeyOf = (row: WrappedRow, artist: string | null) => row.contextId ?? (row.album ? `name:${nameKey(row.album)}|${nameKey(artist ?? '')}` : null)

/**
 * Audio dramas and audiobooks come as songs (an album of chapters, from Spotify and from a library alike); they are
 * marked `spoken` here so they count as what they are and not as the year's songs, artists and albums. An album is one
 * when its name says so, at least three of its titles heard in the year are chapters (a song called "Part 2" stays a
 * song), or it is named as an episode and three of its titles were heard; a play without an album, when its title
 * starts as a chapter does.
 */
function spokenApart(rows: WrappedRow[]): WrappedRow[] {
  const chapters = new Map<string, Set<string>>()
  const titles = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, title: string) => {
    const seen = map.get(key)
    if (seen) seen.add(title)
    else map.set(key, new Set([title]))
  }
  for (const row of rows) {
    const album = row.kind === 'audio' ? albumKeyOf(row, artistOf(row)) : null
    if (!album) continue
    add(titles, album, row.title)
    if (CHAPTER.test(row.title)) add(chapters, album, row.title)
  }
  return rows.map((row) => {
    if (row.kind !== 'audio') return row
    const album = albumKeyOf(row, artistOf(row))
    const spoken = album
      ? (chapters.get(album)?.size ?? 0) >= 3 || SPOKEN_ALBUM.test(row.album ?? '') || (EPISODE_ALBUM.test(row.album ?? '') && (titles.get(album)?.size ?? 0) >= 3)
      : /^(?:teil|track|kapitel|chapter)\s*\d+/i.test(row.title)
    return spoken ? { ...row, kind: 'spoken' } : row
  })
}

/**
 * The years with a Wrapped to show: songs were played then (a year of podcasts only has none), and it is out. Its
 * edges are the person's: a year whose songs all fall on the far side of midnight in their zone is left out too.
 */
export function wrappedYears(store: Store, userId: string, now: Date, timeZone: string) {
  return store
    .listeningYears(userId)
    .filter((year) => wrappedReady(year, now, timeZone) && enoughFor(rowsOfYear(store, userId, year, timeZone)))
    .sort((a, b) => b - a)
}

/**
 * Enough music in a year for a Wrapped: a few dozen streams or an hour. Fewer is no year in music (a handful of plays
 * stamped with a wrong date by a device's clock, say).
 */
function enoughFor(rows: WrappedRow[]) {
  const songs = rows.filter((row) => row.kind === 'audio')
  return songs.filter((row) => row.seconds >= STREAM_SECONDS).length >= 30 || songs.reduce((sum, row) => sum + row.seconds, 0) >= 3600
}

export function wrappedFor(store: Store, userId: string, year: number, timeZone: string): Wrapped | null {
  const rows = rowsOfYear(store, userId, year, timeZone)
  const songs = rows.filter((row) => row.kind === 'audio')
  if (!songs.length || !enoughFor(rows)) return null

  const artists = new Map<string, { name: string; minutes: number; plays: number; months: number[]; songs: Set<string> }>()
  const tracks = new Map<string, WrappedTrack>()
  const albums = new Map<string, { key: string; name: string | null; artist: string | null; sampleKey: string; minutes: number; plays: number; months: number[]; songs: Set<string> }>()
  const podcasts = new Map<string, { name: string; minutes: number; plays: number }>()
  const spoken = new Map<string, { name: string; minutes: number; plays: number; episodes: Map<string, { name: string | null; minutes: number }>; sampleKey: string; contextId: string | null }>()
  let spokenSeconds = 0
  const days = new Map<string, number>()
  const repeats = new Map<string, number>()
  const trackDays = new Map<string, Set<string>>()
  const daily = Array<number>(daysIn(year)).fill(0)
  let lateNight = 0
  const months = Array<number>(12).fill(0)
  const hours = Array<number>(24).fill(0)
  const weekdays = Array<number>(7).fill(0)
  const sources: Record<string, number> = {}
  let seconds = 0
  let plays = 0
  let podcastSeconds = 0

  for (const row of rows) {
    const at = partsIn(row.startedAt, timeZone)
    const date = `${at.year}-${pad(at.month + 1)}-${pad(at.day)}`
    const minutes = row.seconds / 60
    seconds += row.seconds
    months[at.month]! += minutes
    hours[at.hour]! += minutes
    weekdays[at.weekday]! += minutes
    days.set(date, (days.get(date) ?? 0) + minutes)
    daily[dayOfYear(at)]! += minutes
    if (at.hour < 4) lateNight += minutes
    const source = row.imported ? 'spotify' : 'lumio'
    sources[source] = (sources[source] ?? 0) + minutes
    if (row.kind === 'podcast') {
      podcastSeconds += row.seconds
      const name = row.subtitle?.trim() || row.title
      tally(podcasts, nameKey(name), () => ({ name, minutes: 0, plays: 0 }), row.seconds)
      continue
    }
    if (row.kind === 'spoken') {
      spokenSeconds += row.seconds
      // By series or author (the album artist); each album an episode or book.
      const name = artistOf(row) ?? row.album ?? row.title
      const series = tally(spoken, nameKey(name), () => ({ name, minutes: 0, plays: 0, episodes: new Map(), sampleKey: row.key, contextId: row.contextId }), row.seconds)
      const episodeKey = albumKeyOf(row, artistOf(row)) ?? row.title
      const episode = series.episodes.get(episodeKey) ?? { name: row.album, minutes: 0 }
      episode.minutes += minutes
      series.episodes.set(episodeKey, episode)
      if (series.sampleKey.startsWith('spotify:') && !row.key.startsWith('spotify:')) Object.assign(series, { sampleKey: row.key, contextId: row.contextId })
      continue
    }
    if (row.seconds >= STREAM_SECONDS) plays += 1
    const artist = artistOf(row)
    // The same song from Lumio and from the imported history is one (the import points to the library's song when it
    // found it); else songs are told apart by title and artist.
    const trackKey = row.key.startsWith('spotify:') ? `name:${nameKey(row.title)}|${nameKey(artist ?? '')}` : row.key
    if (artist) {
      const entry = tally(artists, nameKey(artist), () => ({ name: artist, minutes: 0, plays: 0, months: Array<number>(12).fill(0), songs: new Set<string>() }), row.seconds)
      entry.months[at.month]! += minutes
      entry.songs.add(trackKey)
    }
    const track = tally(tracks, trackKey, () => ({ key: row.key, title: row.title, artist, album: row.album, contextId: row.contextId, minutes: 0, plays: 0, months: Array<number>(12).fill(0) }), row.seconds)
    track.months[at.month]! += minutes
    if (!track.album && row.album) track.album = row.album
    if (!track.contextId && row.contextId) track.contextId = row.contextId
    // A library song wins over the imported name for the key (so it plays and has a cover).
    if (track.key.startsWith('spotify:') && !row.key.startsWith('spotify:')) track.key = row.key
    if (row.contextId || row.album) {
      const albumKey = row.contextId ?? `name:${nameKey(row.album!)}|${nameKey(artist ?? '')}`
      const album = tally(albums, albumKey, () => ({ key: albumKey, name: row.album, artist, sampleKey: row.key, minutes: 0, plays: 0, months: Array<number>(12).fill(0), songs: new Set<string>() }), row.seconds)
      album.months[at.month]! += minutes
      album.songs.add(trackKey)
      if (!album.name && row.album) album.name = row.album
      if (album.sampleKey.startsWith('spotify:') && !row.key.startsWith('spotify:')) album.sampleKey = row.key
    }
    if (row.seconds >= STREAM_SECONDS) {
      const repeatKey = `${date}|${trackKey}`
      repeats.set(repeatKey, (repeats.get(repeatKey) ?? 0) + 1)
      const seen = trackDays.get(trackKey)
      if (seen) seen.add(date)
      else trackDays.set(trackKey, new Set([date]))
    }
  }

  const byMinutes = <T extends { minutes: number }>(list: Iterable<T>) => [...list].sort((a, b) => b.minutes - a.minutes)
  const round = <T extends { minutes: number; months?: number[] }>(entry: T) => ({ ...entry, minutes: Math.round(entry.minutes), ...(entry.months && { months: entry.months.map(Math.round) }) })
  // Songs by streams (as Spotify ranks them), then by time.
  const rankedTracks = [...tracks.values()].sort((a, b) => b.plays - a.plays || b.minutes - a.minutes)

  let onRepeat: Wrapped['onRepeat'] = null
  let best = 1
  for (const [key, count] of repeats) {
    if (count <= best) continue
    best = count
    // The date (YYYY-MM-DD), then the song's key (which may hold "|" itself).
    const date = key.slice(0, 10)
    const track = tracks.get(key.slice(11))
    if (track) onRepeat = { ...round(track), plays: count, date }
  }

  const first = songs.find((row) => row.seconds >= STREAM_SECONDS) ?? songs[0]!
  const firstArtist = artistOf(first)
  const topDay = byMinutes([...days].map(([date, minutes]) => ({ date, minutes })))[0]

  // Discoveries: artists whose first play ever falls in this year.
  const yearStart = rows[0]!.startedAt
  const known = new Set<string>()
  for (const entry of store.firstPlaysByArtist(userId, yearStart)) {
    const name = artistOf(entry)
    if (name) known.add(nameKey(name))
  }
  const discovered = byMinutes([...artists].filter(([key]) => !known.has(key)).map(([, entry]) => entry))

  // The longest run of days with music.
  let streak: Wrapped['streak'] = null
  for (let start = 0, end = 0; start < daily.length; start = end + 1) {
    while (start < daily.length && !(daily[start]! > 0)) start++
    end = start
    while (end + 1 < daily.length && daily[end + 1]! > 0) end++
    if (start < daily.length && (!streak || end - start + 1 > streak.days)) streak = { days: end - start + 1, from: dateOfDay(year, start), to: dateOfDay(year, end) }
  }
  let comfort: Wrapped['comfort'] = null
  for (const [key, set] of trackDays) {
    const track = tracks.get(key)
    if (track && set.size > (comfort?.days ?? 1)) comfort = { ...round(track), days: set.size }
  }
  // Streams of songs heard in an earlier year (the library's songs and the imported ones alike, by their key).
  const knownSongs = new Set(store.songsBefore(userId, yearStart).map((row) => (row.key.startsWith('spotify:') ? `name:${nameKey(row.title)}|${nameKey(artistOf(row) ?? '')}` : row.key)))
  let repeatedStreams = 0
  for (const [key, track] of tracks) if (knownSongs.has(key)) repeatedStreams += track.plays

  const previous = rowsOfYear(store, userId, year - 1, timeZone)
  const previousSeconds = previous.reduce((sum, row) => sum + row.seconds, 0)

  return {
    year,
    minutes: Math.round(seconds / 60),
    plays,
    tracks: tracks.size,
    artists: artists.size,
    previousMinutes: previous.length ? Math.round(previousSeconds / 60) : null,
    topArtists: byMinutes(artists.values())
      .slice(0, 10)
      .map(({ name, minutes, plays, months: perMonth, songs }) => ({
        name,
        minutes: Math.round(minutes),
        plays,
        peakMonth: perMonth.indexOf(Math.max(...perMonth)),
        months: perMonth.map(Math.round),
        tracks: songs.size,
      })),
    topTracks: rankedTracks.slice(0, 10).map(round),
    playlistKeys: rankedTracks
      .filter((track) => !track.key.startsWith('spotify:'))
      .slice(0, 100)
      .map((track) => track.key),
    topAlbums: byMinutes(albums.values())
      .slice(0, 5)
      .map(({ key, name, artist, sampleKey, minutes, plays, months: perMonth, songs }) => ({ key, name, artist, sampleKey, minutes: Math.round(minutes), plays, months: perMonth.map(Math.round), tracks: songs.size })),
    topPodcasts: byMinutes(podcasts.values())
      .slice(0, 3)
      .map(({ name, minutes }) => ({ name, minutes: Math.round(minutes) })),
    podcastMinutes: Math.round(podcastSeconds / 60),
    topSpoken: byMinutes(spoken.values())
      .slice(0, 3)
      .map(({ name, minutes, episodes, sampleKey, contextId }) => ({
        name,
        minutes: Math.round(minutes),
        episodes: episodes.size,
        episode: byMinutes(episodes.values())[0]?.name ?? null,
        sampleKey,
        contextId,
      })),
    spokenMinutes: Math.round(spokenSeconds / 60),
    months: months.map(Math.round),
    hours: hours.map(Math.round),
    weekdays: weekdays.map(Math.round),
    topDay: topDay ? { date: topDay.date, minutes: Math.round(topDay.minutes) } : null,
    firstTrack: {
      key: first.key,
      title: first.title,
      artist: firstArtist,
      album: first.album,
      contextId: first.contextId,
      minutes: Math.round(first.seconds / 60),
      plays: 1,
      months: [],
      at: first.startedAt,
    },
    onRepeat,
    newArtists: { count: discovered.length, top: discovered[0] ? { name: discovered[0].name, minutes: Math.round(discovered[0].minutes) } : null },
    sources: Object.fromEntries(Object.entries(sources).map(([name, minutes]) => [name, Math.round(minutes)])),
    daily: daily.map(Math.round),
    activeDays: days.size,
    streak,
    lateNight: seconds ? lateNight / (seconds / 60) : 0,
    repeatShare: plays ? repeatedStreams / plays : 0,
    comfort,
  }
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const daysIn = (year: number) => (isLeap(year) ? 366 : 365)
/** 0 for 1 January. */
const dayOfYear = (at: { year: number; month: number; day: number }) => Math.round((Date.UTC(at.year, at.month, at.day) - Date.UTC(at.year, 0, 1)) / DAY)
const dateOfDay = (year: number, index: number) => new Date(Date.UTC(year, 0, 1) + index * DAY).toISOString().slice(0, 10)
