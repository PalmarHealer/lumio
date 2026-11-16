import { artistIndex, genreIndex, genreMix, madeForYou, type ArtistIndex, type MixContext } from './made-for-you.ts'
import type { SoundData } from './mix-sound.ts'
import type { Track, UserData } from './music-catalog.ts'
import { slugOf } from './mood-mixes.ts'
import type { TasteModel } from './taste-model.ts'

/**
 * The home page's official playlists (made by the platform, shown under the instance's name), built here from every
 * song of the music libraries and the listener's taste model: the made-for-you mixes (see made-for-you.ts), the moods
 * and tags (mood-mixes.ts), the newest songs, their most played, "Best of" artists and Last.fm's charts. The app gets
 * them ready to show; it used to build them itself from the first 5000 songs, which was slow and missed most of a big
 * library.
 */
export type Locale = 'de' | 'en'

/** Last.fm through the server's relay (null: no key, or it failed). */
export type Lastfm = (params: Record<string, string>) => Promise<unknown>

export type PlaylistKind = 'new' | 'top' | 'month' | 'rediscover' | 'genre' | 'decade' | 'artist' | 'chart' | 'radio' | 'daylist' | 'daily' | 'discover' | 'radar' | 'phase' | 'mood' | 'tag'

export interface MixPlaylist {
  slug: string
  title: string
  description: string
  tracks: Track[]
  /** "Best of …", the Daily Mixes and radios show an artist's photo on their cover. */
  artist?: { Id: string; Name?: string; Type: 'MusicArtist'; Genres?: string[] }
  kind: PlaylistKind
  /** Made for whoever opens it (shown as "For <name>"). */
  personal?: boolean
  /** A column beside the songs (plays, listeners), by track id. */
  extras?: Record<string, string>
  extraLabel?: string
}

const SIZE = 30
const MIN_ARTIST = 5
const PERSONAL_SIZE = 100
/** Charts with fewer of their songs in the library are left out. */
const MIN_CHART = 5
/** "Best of" playlists on the home page (a big library has thousands of artists with five songs); others on request. */
const MAX_ARTIST_LISTS = 20

export const officialMessages = {
  de: {
    newTitle: 'Neu in Listen',
    newDescription: 'Die neuesten Songs in der Bibliothek.',
    topTitle: 'Deine Dauerbrenner',
    topDescription: 'Die Songs, die du am häufigsten gehört hast.',
    plays: (n: string) => `${n} Wiedergaben`,
    playsLabel: 'Wiedergaben',
    chartTitle: (place: string) => `Charts ${place}`,
    chartDescription: (place: string) => `Die meistgehörten Songs – ${place} (Last.fm), soweit sie in der Bibliothek sind. Jeden Tag neu.`,
    world: 'Weltweit',
    listeners: (n: string) => `${n} Hörer*innen`,
    listenersLabel: 'Hörer*innen',
    artistTitle: (name: string) => `Best of ${name}`,
    artistDescription: (name: string) => `${name}: die wichtigsten Songs an einem Ort.`,
  },
  en: {
    newTitle: 'New in Listen',
    newDescription: 'The newest songs in the library.',
    topTitle: 'Your evergreens',
    topDescription: 'The songs you played most.',
    plays: (n: string) => `${n} plays`,
    playsLabel: 'Plays',
    chartTitle: (place: string) => `Charts ${place}`,
    chartDescription: (place: string) => `The most played songs – ${place} (Last.fm), as far as the library has them. New every day.`,
    world: 'Global',
    listeners: (n: string) => `${n} listeners`,
    listenersLabel: 'Listeners',
    artistTitle: (name: string) => `Best of ${name}`,
    artistDescription: (name: string) => `${name}: the essential songs in one place.`,
  },
}

const localeTag = (locale: Locale) => (locale === 'de' ? 'de-DE' : 'en-US')

const looseNames = new Map<string, string>()

/** A name as compared loosely: case, accents, "feat." parts and punctuation don't matter (remembered: it is slow). */
export function looseName(value: string) {
  let loose = looseNames.get(value)
  if (loose === undefined) {
    loose = value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s*[([].*?(feat|ft|with|remaster|version|edit).*?[)\]]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
    if (looseNames.size > 300_000) looseNames.clear()
    looseNames.set(value, loose)
  }
  return loose
}

/** What a listener's playlists are built from (kept a while per listener, see home-worker.ts). */
export interface Listener {
  userId: string
  tracks: Track[]
  byId: Map<string, Track>
  userData: (track: Track) => UserData | undefined
  counts: (track: Track) => boolean
  model: TasteModel
  sound: SoundData
  index: ArtistIndex
  byGenre: Map<string, Track[]>
  /** When a song came into the library (ms). */
  added: (track: Track) => number
}

/** The listener's library artists Last.fm calls similar to their five favourites (who aren't favourites themselves). */
export async function similarToFavourites(listener: Pick<Listener, 'index'>, model: TasteModel, lastfm: Lastfm | null) {
  const result = new Set<string>()
  if (!lastfm) return result
  const favourites = [
    ...new Set([
      ...model.phaseArtists.slice(0, 2),
      ...[...listener.index.keys()]
        .filter((id) => model.artist(id) > 0)
        .sort((a, b) => model.artist(b) - model.artist(a))
        .slice(0, 5),
    ]),
  ].filter((id) => model.artist(id) > 0 && listener.index.has(id))
  const similarNames = (await Promise.all(favourites.map((id) => similarArtistNames(lastfm, listener.index.get(id)!.name).catch(() => [] as string[])))).flat()
  const wanted = new Set(similarNames.map(looseName))
  for (const [id, entry] of listener.index) if (model.artist(id) < 0.3 && entry.name && wanted.has(looseName(entry.name))) result.add(id)
  return result
}

/** Names of artists similar to one (Last.fm), most similar first. */
export async function similarArtistNames(lastfm: Lastfm, name: string): Promise<string[]> {
  type Response = { similarartists?: { artist?: Array<{ name: string }> } }
  const data = (await lastfm({ method: 'artist.getsimilar', artist: name, limit: '30' })) as Response | null
  return (data?.similarartists?.artist ?? []).map((artist) => artist.name)
}

// ---- charts (Last.fm) ----

const CHART_COUNTRIES: Record<Locale, [code: string, name: string]> = { de: ['DE', 'Germany'], en: ['US', 'United States'] }

async function chartTracks(lastfm: Lastfm, country?: string) {
  type Response = { tracks?: { track?: Array<{ name: string; artist: { name: string }; listeners?: string }> } }
  const data = (await lastfm(country ? { method: 'geo.gettoptracks', country, limit: '200' } : { method: 'chart.gettoptracks', limit: '200' })) as Response | null
  return (data?.tracks?.track ?? []).map((track) => ({ name: track.name, artist: track.artist.name, listeners: Number(track.listeners ?? 0) }))
}

/** The library's songs by loose title, made once per catalog (charts look songs up by title and artist). */
const titleIndexes = new WeakMap<Track[], Map<string, Track[]>>()
function titleIndex(tracks: Track[]) {
  let index = titleIndexes.get(tracks)
  if (!index) {
    index = new Map()
    for (const track of tracks) {
      if (!track.Name) continue
      const key = looseName(track.Name)
      const list = index.get(key)
      if (list) list.push(track)
      else index.set(key, [track])
    }
    titleIndexes.set(tracks, index)
  }
  return index
}

/** A chart (Last.fm's most played songs, worldwide or in one country) as far as the library has its songs, in chart order. */
async function chartPlaylist(tracks: Track[], lastfm: Lastfm, locale: Locale, slug: string, place: string, country?: string): Promise<MixPlaylist | null> {
  const t = officialMessages[locale]
  const chart = await chartTracks(lastfm, country)
  const number = new Intl.NumberFormat(localeTag(locale))
  const byTitle = titleIndex(tracks)
  const matched: Track[] = []
  const extras: Record<string, string> = {}
  for (const entry of chart) {
    const artist = looseName(entry.artist)
    const track = byTitle.get(looseName(entry.name))?.find((candidate) => [...(candidate.Artists ?? []), candidate.AlbumArtist].some((name) => !!name && looseName(name) === artist))
    if (!track || extras[track.Id]) continue
    matched.push(track)
    extras[track.Id] = t.listeners(number.format(entry.listeners))
    if (matched.length === 50) break
  }
  if (matched.length < MIN_CHART) return null
  return { slug, kind: 'chart', title: t.chartTitle(place), description: t.chartDescription(place), tracks: matched, extras, extraLabel: t.listenersLabel }
}

// ---- the newest, the most played, "Best of" ----

/** An artist's "Best of": their most played songs (by the listener), then in album order. */
export function artistPlaylist(listener: Listener, locale: Locale, artistId: string): MixPlaylist | null {
  const entry = listener.index.get(artistId)
  if (!entry) return null
  // Their own songs (as the album's or the song's first artist), not every guest feature.
  const own = entry.tracks.filter((track) => (track.AlbumArtists?.[0] ?? track.ArtistItems?.[0])?.Id === artistId)
  if (own.length < MIN_ARTIST) return null
  const t = officialMessages[locale]
  const plays = (track: Track) => listener.userData(track)?.PlayCount ?? 0
  return {
    slug: `artist-${artistId}`,
    kind: 'artist',
    artist: { Id: artistId, Name: entry.name, Type: 'MusicArtist' },
    title: t.artistTitle(entry.name),
    description: t.artistDescription(entry.name),
    tracks: [...own].sort((a, b) => plays(b) - plays(a)).slice(0, SIZE),
  }
}

function basicPlaylists(listener: Listener, locale: Locale): MixPlaylist[] {
  const { tracks, userData, counts, model } = listener
  const t = officialMessages[locale]
  const playlists: MixPlaylist[] = []
  if (!tracks.length) return playlists
  const newest = [...tracks].sort((a, b) => listener.added(b) - listener.added(a)).slice(0, SIZE)
  playlists.push({ slug: 'new', kind: 'new', title: t.newTitle, description: t.newDescription, tracks: newest })

  const playsOf = (track: Track) => userData(track)?.PlayCount ?? 0
  const played = tracks.filter((track) => playsOf(track) > 0 && counts(track))
  const number = new Intl.NumberFormat(localeTag(locale))
  if (played.length >= MIN_ARTIST) {
    const top = [...played].sort((a, b) => playsOf(b) - playsOf(a)).slice(0, PERSONAL_SIZE)
    const extras = Object.fromEntries(top.map((track) => [track.Id, t.plays(number.format(playsOf(track)))]))
    playlists.push({ slug: 'top', kind: 'top', personal: true, title: t.topTitle, description: t.topDescription, tracks: top, extras, extraLabel: t.playsLabel })
  }

  // "Best of" the artists the listener loves most, then those with the most songs.
  const leads = new Map<string, number>()
  for (const track of tracks) {
    const id = (track.AlbumArtists?.[0] ?? track.ArtistItems?.[0])?.Id
    if (id) leads.set(id, (leads.get(id) ?? 0) + 1)
  }
  const artists = [...leads]
    .filter(([, songs]) => songs >= MIN_ARTIST)
    .map(([id, songs]) => ({ id, songs, love: model.artist(id) }))
    .sort((a, b) => b.love - a.love || b.songs - a.songs)
  for (const { id } of artists) {
    if (playlists.filter((playlist) => playlist.kind === 'artist').length >= MAX_ARTIST_LISTS) break
    const playlist = artistPlaylist(listener, locale, id)
    if (playlist) playlists.push(playlist)
  }
  return playlists
}

/** All of the home page's official playlists, in the order it shows them. */
export async function homePlaylists(listener: Listener, context: Omit<MixContext, 'tracks' | 'model'>): Promise<MixPlaylist[]> {
  const { locale, lastfm } = context
  const mixes = await madeForYou({ ...context, tracks: listener.tracks, model: listener.model }, listener.sound, listener.index, listener.byGenre, listener.added)
  const playlists = basicPlaylists(listener, locale)
  const t = officialMessages[locale]
  const [code, country] = CHART_COUNTRIES[locale]
  const charts: Array<MixPlaylist | null> = lastfm
    ? await Promise.all([
        chartPlaylist(listener.tracks, lastfm, locale, `chart-${code.toLowerCase()}`, new Intl.DisplayNames([localeTag(locale)], { type: 'region' }).of(code) ?? country, country),
        chartPlaylist(listener.tracks, lastfm, locale, 'chart-world', t.world),
      ]).catch(() => [])
    : []
  const [newest, ...rest] = playlists
  return [
    ...mixes.forYou,
    ...rest.filter((playlist) => playlist.kind === 'top'),
    ...(newest ? [newest] : []),
    ...mixes.moods,
    ...mixes.mixes,
    ...mixes.tags,
    ...rest.filter((playlist) => playlist.kind !== 'top'),
    ...charts.filter((playlist): playlist is MixPlaylist => !!playlist),
  ]
}

/** One playlist the home page doesn't list (an artist's "Best of", a smaller genre's mix), built when asked for. */
export function playlistBySlug(listener: Listener, context: Omit<MixContext, 'tracks' | 'model'>, slug: string): MixPlaylist | null {
  if (slug.startsWith('artist-')) return artistPlaylist(listener, context.locale, slug.slice('artist-'.length))
  if (slug.startsWith('genre-')) {
    for (const [genre, list] of listener.byGenre) {
      if (`genre-${slugOf(genre)}` === slug) return genreMix({ ...context, tracks: listener.tracks, model: listener.model }, genre, list)
    }
  }
  return null
}

export { artistIndex, genreIndex }
