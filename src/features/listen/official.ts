import { BaseItemKind, ItemFields, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { useCategories } from '@/features/library/categories'
import { defineMessages, getLocale, getLocaleTag, messagesFor } from '@/lib/i18n'
import { fetchChartTracks, fetchSimilarArtists, homeChartCountry, sameName } from './external'
import { localDate, madeForYou } from './mixes'
import { useLumioFetch } from '@/features/social/social'
import { fetchSound } from './sound'
import { useRadioPlaylist } from './radio'
import { useTasteFilter } from './taste'
import { buildTasteModel, fetchTasteSignals, fetchTasteSittings, slotOf, type TasteModel } from './taste-model'

/**
 * Official playlists: made by the platform (shown under the instance's name and logo, like Spotify's own playlists),
 * built from the music library itself and the listener's taste (see mixes.ts for the made-for-you ones and how often
 * each is made anew).
 */
export interface OfficialPlaylist {
  slug: string
  title: string
  description: string
  tracks: BaseItemDto[]
  /** "This is …" playlists show the artist's photo on their cover. */
  artist?: BaseItemDto
  kind: 'new' | 'top' | 'month' | 'rediscover' | 'genre' | 'decade' | 'artist' | 'chart' | 'radio' | 'daylist' | 'daily' | 'discover' | 'radar' | 'phase' | 'mood' | 'tag'
  /**
   * Made for whoever opens it: the same address shows everyone their own songs (their top songs), as Spotify's "Your
   * top songs" do. Shown as "For <name>".
   */
  personal?: boolean
  /** A column beside the songs (plays, listeners), by track id. */
  extras?: Record<string, string>
  /** That column's heading. */
  extraLabel?: string
}

const SIZE = 30
const MIN_ARTIST = 5

export const officialMessages = defineMessages({
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
})

export function seeded(seed: string) {
  let state = 0
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A shuffle that leans towards what weighs more (the user's taste), yet stays a mix: each entry draws a random key
 * scaled by its weight (Efraimidis–Spirakis), the same for the same seed.
 */
export function weightedShuffle<T>(items: T[], weight: (item: T) => number, seed: string) {
  const random = seeded(seed)
  return items
    .map((item) => ({ item, key: random() ** (1 / (1 + weight(item))) }))
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.item)
}

/**
 * The official playlists, built from every track of the music libraries (with what the generators need: genres,
 * plays, dates). Built in the query, so a page shows the same mixes until the data is refreshed.
 */
export function useOfficialPlaylists() {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  // Ready from the first render (the shared connection is set a moment later).
  const lumioFetch = useLumioFetch()
  const get = (path: string) => lumioFetch(path)
  const { categories, isLoading: categoriesLoading } = useCategories('listen')
  const views = categories.find((category) => category.id === 'music')?.views ?? []
  // The personal mixes follow the taste profile (what is left out of it doesn't count).
  const taste = useTasteFilter()
  // Made anew when the day part turns over (the daylist), so a page left open switches too.
  const period = useMixPeriod()
  const query = useQuery({
    queryKey: ['official-playlists', session.userId, views.map((view) => view.Id), getLocale(), taste.key, period],
    enabled: views.length > 0 && taste.ready,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<OfficialPlaylist[]> => {
      const [lists, signals, sound, sittings] = await Promise.all([
        Promise.all(
          views.map(
            async (view) =>
              (
                await getLibraryApi(api).getItems({
                  userId: session.userId,
                  parentId: view.Id!,
                  recursive: true,
                  includeItemTypes: [BaseItemKind.Audio],
                  fields: [ItemFields.Genres, ItemFields.DateCreated, ItemFields.PrimaryImageAspectRatio],
                  limit: 5000,
                })
              ).data.Items ?? [],
          ),
        ),
        fetchTasteSignals(queryClient, session.userId, get),
        fetchSound(queryClient, get),
        fetchTasteSittings(queryClient, session.userId, get),
      ])
      const tracks = lists.flat()
      const now = Date.now()
      const t = messagesFor(officialMessages)
      // Last.fm's similar artists to the listener's favourites point the discoveries outward (a failure: without).
      const first = buildTasteModel(tracks, signals, taste.counts, now, undefined, sittings)
      const similar = await similarToFavourites(tracks, first).catch(() => new Set<string>())
      const model = similar.size ? buildTasteModel(tracks, signals, taste.counts, now, similar, sittings) : first
      const mixes = await madeForYou({ tracks, model, now, userId: session.userId }, sound, seeded)
      const playlists = buildPlaylists(tracks, t, taste.counts)
      // The charts come from Last.fm; a failure just leaves them out.
      const [code, country] = homeChartCountry()
      const charts: Array<OfficialPlaylist | null> = await Promise.all([
        chartPlaylist(tracks, t, `chart-${code.toLowerCase()}`, new Intl.DisplayNames([getLocaleTag()], { type: 'region' }).of(code) ?? country, country),
        chartPlaylist(tracks, t, 'chart-world', t.world),
      ]).catch(() => [])
      const [newest, ...rest] = playlists
      return [...mixes.forYou, ...rest.filter((playlist) => playlist.kind === 'top'), ...(newest ? [newest] : []), ...mixes.moods, ...mixes.mixes, ...mixes.tags, ...rest.filter((playlist) => playlist.kind !== 'top'), ...charts.filter((playlist): playlist is OfficialPlaylist => !!playlist)]
    },
  })
  // Still loading while the libraries aren't known yet (the query waits for them), not only while it runs.
  return { playlists: query.data ?? [], isLoading: categoriesLoading || (views.length > 0 && query.isPending) }
}

/** Today's date and day part (see slotOf), checked every minute. */
function useMixPeriod() {
  const current = () => `${localDate(Date.now())}:${slotOf(new Date()).part}`
  const [period, setPeriod] = useState(current)
  useEffect(() => {
    const timer = window.setInterval(() => setPeriod(current()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return period
}

/** The library's artists Last.fm calls similar to the listener's five favourites (who aren't favourites themselves). */
async function similarToFavourites(tracks: BaseItemDto[], model: TasteModel) {
  const names = new Map<string, string>()
  for (const track of tracks) for (const artist of [...(track.ArtistItems ?? []), ...(track.AlbumArtists ?? [])]) if (artist.Id && artist.Name) names.set(artist.Id, artist.Name)
  const favourites = [...new Set([...model.phaseArtists.slice(0, 2), ...[...names.keys()].sort((a, b) => model.artist(b) - model.artist(a)).slice(0, 5)])].filter((id) => model.artist(id) > 0)
  const similarNames = (await Promise.all(favourites.map((id) => fetchSimilarArtists(names.get(id)!).catch(() => [] as string[])))).flat()
  const result = new Set<string>()
  for (const [id, name] of names) if (model.artist(id) < 0.3 && similarNames.some((other) => sameName(other, name))) result.add(id)
  return result
}

/** One official playlist by its address: from the built list, or an artist's radio (built on its own). */
export function useOfficialPlaylist(slug: string): { playlist: OfficialPlaylist | undefined; isLoading: boolean } {
  const all = useOfficialPlaylists()
  const radioId = slug.startsWith('radio-') ? slug.slice('radio-'.length) : undefined
  const radio = useRadioPlaylist(radioId)
  if (radioId) return radio
  return { playlist: all.playlists.find((entry) => entry.slug === slug), isLoading: all.isLoading }
}

/** How long the personal top list gets. */
const PERSONAL_SIZE = 100
/** Charts with fewer of their songs in the library are left out. */
const MIN_CHART = 5

/**
 * A chart (Last.fm's most played songs, worldwide or in one country) as far as the library has its songs, in chart
 * order, with each song's listeners beside it.
 */
async function chartPlaylist(tracks: BaseItemDto[], t: (typeof officialMessages)['de'], slug: string, place: string, country?: string): Promise<OfficialPlaylist | null> {
  const chart = await fetchChartTracks(country)
  const number = new Intl.NumberFormat(getLocaleTag())
  const matched: BaseItemDto[] = []
  const extras: Record<string, string> = {}
  for (const entry of chart) {
    const track = tracks.find(
      (candidate) => sameName(candidate.Name, entry.name) && [...(candidate.Artists ?? []), candidate.AlbumArtist].some((artist) => sameName(artist, entry.artist)),
    )
    if (!track?.Id || extras[track.Id]) continue
    matched.push(track)
    extras[track.Id] = t.listeners(number.format(entry.listeners))
    if (matched.length === 50) break
  }
  if (matched.length < MIN_CHART) return null
  return { slug, kind: 'chart', title: t.chartTitle(place), description: t.chartDescription(place), tracks: matched, extras, extraLabel: t.listenersLabel }
}

/**
 * The playlists that aren't made for the listener: the newest songs, the most played ever (personal, but a plain list)
 * and "Best of" each artist with enough songs. `counts` says which tracks count for the user's taste.
 */
function buildPlaylists(tracks: BaseItemDto[], t: (typeof officialMessages)['de'], counts: (track: BaseItemDto) => boolean): OfficialPlaylist[] {
  const playlists: OfficialPlaylist[] = []
  if (!tracks.length) return playlists
  const newest = [...tracks].sort((a, b) => Date.parse(b.DateCreated ?? '') - Date.parse(a.DateCreated ?? '')).slice(0, SIZE)
  playlists.push({ slug: 'new', kind: 'new', title: t.newTitle, description: t.newDescription, tracks: newest })

  const played = tracks.filter((track) => (track.UserData?.PlayCount ?? 0) > 0 && counts(track))
  const number = new Intl.NumberFormat(getLocaleTag())
  const playsOf = (list: BaseItemDto[]) => Object.fromEntries(list.map((track) => [track.Id!, t.plays(number.format(track.UserData?.PlayCount ?? 0))]))
  if (played.length >= MIN_ARTIST) {
    const top = [...played].sort((a, b) => (b.UserData?.PlayCount ?? 0) - (a.UserData?.PlayCount ?? 0)).slice(0, PERSONAL_SIZE)
    playlists.push({ slug: 'top', kind: 'top', personal: true, title: t.topTitle, description: t.topDescription, tracks: top, extras: playsOf(top), extraLabel: t.playsLabel })
  }

  // "This is …" for artists with enough songs: their most played first, then in album order.
  const byArtist = new Map<string, { artist: BaseItemDto; list: BaseItemDto[] }>()
  for (const track of tracks) {
    const artist = track.AlbumArtists?.[0] ?? track.ArtistItems?.[0]
    if (!artist?.Id) continue
    const entry = byArtist.get(artist.Id) ?? { artist: { Id: artist.Id, Name: artist.Name, Type: 'MusicArtist' }, list: [] }
    entry.list.push(track)
    byArtist.set(artist.Id, entry)
  }
  for (const { artist, list } of [...byArtist.values()].sort((a, b) => b.list.length - a.list.length)) {
    if (list.length < MIN_ARTIST) continue
    playlists.push({
      slug: `artist-${artist.Id}`,
      kind: 'artist',
      artist,
      title: t.artistTitle(artist.Name ?? ''),
      description: t.artistDescription(artist.Name ?? ''),
      tracks: [...list].sort((a, b) => (b.UserData?.PlayCount ?? 0) - (a.UserData?.PlayCount ?? 0)).slice(0, SIZE),
    })
  }
  return playlists
}
