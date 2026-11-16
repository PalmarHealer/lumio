import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getUserViewApi } from '@jellyfin/sdk/lib/utils/api/user-view-api'
import type { Api } from '@jellyfin/sdk'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { categoryOf, useCategories } from '@/features/library/categories'
import { useItem } from '@/features/items/queries'
import { useLumioFetch, type LumioFetch } from '@/features/social/social'
import { getLocale } from '@/lib/i18n'
import { ownKey } from '@/lib/services'

/**
 * Official playlists: made by the platform (shown under the instance's name and logo, like Spotify's own playlists).
 * The Lumio server builds them from every song of the music libraries and the listener's taste (server/src/
 * home-playlists.ts): the made-for-you mixes, moods, tags, the newest songs, the most played, "Best of" artists, charts
 * and the artists' radios. The app only shows them.
 */
export interface OfficialPlaylist {
  slug: string
  title: string
  description: string
  tracks: BaseItemDto[]
  /** "This is …" playlists, the Daily Mixes and radios show an artist's photo on their cover. */
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

/**
 * The server's answer, packed (server/src/wire.ts): each playlist's songs by id, each song once, and what repeats from
 * song to song (server id, kind, albums, artist names) in tables.
 */
interface Wire {
  at: number
  serverId?: string
  artists: Record<string, string>
  albums: Record<string, [string | null, string | null, string | null]>
  playlists: Array<Omit<OfficialPlaylist, 'tracks'> & { tracks: string[] }>
  tracks: Record<string, BaseItemDto & { a?: string[]; b?: string[] }>
}

/** While the server first reads a big library (minutes): how far it is. */
export interface Preparing {
  read: number
  total: number
}

interface Built {
  playlists: OfficialPlaylist[]
  preparing?: Preparing
}

/** The songs as Jellyfin's items again. */
export function unpackTracks(wire: Pick<Wire, 'serverId' | 'artists' | 'albums' | 'tracks'>): Map<string, BaseItemDto> {
  const result = new Map<string, BaseItemDto>()
  const refs = (ids: string[] | undefined) => ids?.map((id) => ({ Id: id, Name: wire.artists[id] ?? '' }))
  for (const [id, packed] of Object.entries(wire.tracks)) {
    const { a, b, ...rest } = packed
    const album = rest.AlbumId ? wire.albums[rest.AlbumId] : undefined
    const ArtistItems = refs(a) ?? []
    result.set(id, {
      ServerId: wire.serverId,
      Type: 'Audio',
      MediaType: 'Audio',
      IsFolder: false,
      HasLyrics: false,
      ...(album ? { Album: album[0], AlbumPrimaryImageTag: album[1], AlbumArtist: album[2] } : {}),
      ArtistItems,
      AlbumArtists: refs(b) ?? [],
      Artists: ArtistItems.map((artist) => artist.Name),
      ...rest,
    })
  }
  return result
}

function unwire(wire: Wire): OfficialPlaylist[] {
  const tracks = unpackTracks(wire)
  return wire.playlists.map((playlist) => ({ ...playlist, tracks: playlist.tracks.map((id) => tracks.get(id)).filter((track): track is BaseItemDto => !!track) }))
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** What the server builds for: the music libraries, the listener's clock and language (and the app's Last.fm key). */
function mixQuery(libraries: string[]) {
  const key = ownKey('lastfm')
  return new URLSearchParams({ libraries: libraries.join(','), tz: timeZone(), locale: getLocale(), ...(key ? { lastfmKey: key } : {}) })
}

async function fetchBuilt(fetcher: LumioFetch, path: string, libraries: string[]): Promise<Built | null> {
  const response = await fetcher(`${path}?${mixQuery(libraries)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Lumio server ${response.status}`)
  const data = (await response.json()) as Wire | ({ preparing: true } & Preparing)
  if ('preparing' in data) return { playlists: [], preparing: { read: data.read, total: data.total } }
  return { playlists: unwire(data) }
}

/** While the library is being read the first time, the server is asked again this often. */
const PREPARING_POLL_MS = 4000

/** The music libraries' ids (the music category), for the server. */
function useMusicLibraries() {
  const { categories, isLoading } = useCategories('listen')
  return { libraries: (categories.find((category) => category.id === 'music')?.views ?? []).map((view) => view.Id!).filter(Boolean), isLoading }
}

/** The music libraries' ids outside React (the player's autoplay). */
export async function musicLibraries(api: Api, userId: string, queryClient: QueryClient) {
  const views = await queryClient.fetchQuery({
    queryKey: ['views', userId],
    queryFn: async () => (await getUserViewApi(api).getUserViews({ userId })).data.Items ?? [],
  })
  return views.filter((view) => categoryOf(view) === 'music').map((view) => view.Id!).filter(Boolean)
}

/**
 * The home page's official playlists, as the server built them for this day part (asked again when it turns over, so
 * a page left open switches too). While the server reads a big library for the first time, `preparing` says how far.
 */
export function useOfficialPlaylists() {
  const { session } = useAuthedSession()
  const lumioFetch = useLumioFetch()
  const { libraries, isLoading: librariesLoading } = useMusicLibraries()
  const period = useMixPeriod()
  const query = useQuery({
    queryKey: ['home-mixes', session.userId, libraries, getLocale(), period],
    enabled: libraries.length > 0,
    staleTime: 30 * 60_000,
    queryFn: async () => (await fetchBuilt(lumioFetch, '/me/mixes', libraries)) ?? { playlists: [] },
    refetchInterval: (current) => (current.state.data?.preparing ? PREPARING_POLL_MS : false),
  })
  const preparing = query.data?.preparing
  // Still loading while the libraries aren't known yet (the query waits for them), not only while it runs.
  return { playlists: query.data?.playlists ?? [], preparing, isLoading: librariesLoading || (libraries.length > 0 && (query.isPending || !!preparing)) }
}

/** Today's date and day part (as the server's mixes turn over), checked every minute. */
function useMixPeriod() {
  const current = () => {
    const now = new Date()
    const hour = now.getHours()
    const part = hour >= 1 && hour < 5 ? 5 : hour >= 21 || hour < 1 ? 4 : hour >= 17 ? 3 : hour >= 12 ? 2 : hour >= 9 ? 1 : 0
    return `${now.toLocaleDateString('sv')}:${part}`
  }
  const [period, setPeriod] = useState(current)
  useEffect(() => {
    const timer = window.setInterval(() => setPeriod(current()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return period
}

/** One official playlist by its address and the query that loads it on its own (a radio, or one the home page doesn't list). */
export function officialPlaylistQuery(fetcher: LumioFetch, userId: string, libraries: string[], slug: string) {
  return {
    queryKey: ['home-mix', userId, libraries, slug, getLocale(), new Date().toLocaleDateString('sv')],
    staleTime: 30 * 60_000,
    queryFn: async () => (await fetchBuilt(fetcher, `/me/mixes/${slug}`, libraries)) ?? { playlists: [] },
    refetchInterval: (current: { state: { data?: Built } }) => (current.state.data?.preparing ? PREPARING_POLL_MS : false),
  }
}

/** One official playlist by its address: from the home page's, or built on its own (a radio, an unlisted "Best of"). */
export function useOfficialPlaylist(slug: string): { playlist: OfficialPlaylist | undefined; isLoading: boolean } {
  const { session } = useAuthedSession()
  const lumioFetch = useLumioFetch()
  const all = useOfficialPlaylists()
  const { libraries } = useMusicLibraries()
  const radioId = slug.startsWith('radio-') ? slug.slice('radio-'.length) : undefined
  // A radio shows the artist as the app knows them (their photo on the cover).
  const artist = useItem(radioId ?? '', !!radioId).data
  const listed = radioId ? undefined : all.playlists.find((entry) => entry.slug === slug)
  const own = useQuery({
    ...officialPlaylistQuery(lumioFetch, session.userId, libraries, slug),
    enabled: !!slug && libraries.length > 0 && (!!radioId || (!all.isLoading && !listed)),
  })
  if (!slug) return { playlist: undefined, isLoading: false }
  if (listed) return { playlist: listed, isLoading: false }
  const found = own.data?.playlists[0]
  const playlist = found && radioId && artist ? { ...found, artist } : found
  return { playlist, isLoading: (!radioId && all.isLoading) || own.isPending || !!own.data?.preparing }
}
