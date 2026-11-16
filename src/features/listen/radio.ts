import type { Api } from '@jellyfin/sdk'
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { useCategories } from '@/features/library/categories'
import { readLocalSettings } from '@/features/settings/local-settings'
import { lumioFetch, useLumioFetch } from '@/features/social/social'
import { externalOf } from '@/lib/external-items'
import { getLocale } from '@/lib/i18n'
import { artistsOf } from '@/lib/item-links'
import { ownKey } from '@/lib/services'
import { musicLibraries, officialPlaylistQuery, unpackTracks } from './official'
import { music, START } from './player/music-player'
import { countsForTaste, NO_EXCLUSIONS } from './taste'

/**
 * Radio, as Spotify's: an artist's songs mixed with songs of artists who make similar music, leaning towards what the
 * listener likes and with a third of songs they haven't heard yet. The Lumio server builds it (server/src/radio.ts)
 * from the whole library and the listener's taste model; each listener has their own radio of an artist, made anew
 * every day. Also what keeps music going when the queue runs out ("autoplay").
 */

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function radioQuery(libraries: string[]) {
  const key = ownKey('lastfm')
  return new URLSearchParams({ libraries: libraries.join(','), tz: timeZone(), locale: getLocale(), ...(key ? { lastfmKey: key } : {}) })
}

/** The library's artists most like one (for a radio's cover). */
export function useSimilarLibraryArtists(artist: BaseItemDto | undefined) {
  const { session } = useAuthedSession()
  const fetcher = useLumioFetch()
  const { categories } = useCategories('listen')
  const libraries = (categories.find((category) => category.id === 'music')?.views ?? []).map((view) => view.Id!).filter(Boolean)
  return useQuery({
    queryKey: ['radio-similar', session.userId, libraries, artist?.Id],
    enabled: !!artist?.Id && libraries.length > 0,
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<BaseItemDto[]> => {
      const response = await fetcher(`/me/radio/similar?${radioQuery(libraries)}&artist=${artist!.Id}`)
      // 202: the library is still being read for the first time.
      if (!response.ok || response.status === 202) return []
      return ((await response.json()) as Array<{ Id: string; Name: string }>).map((entry) => ({ Id: entry.Id, Name: entry.Name, Type: 'MusicArtist' }))
    },
  })
}

/** Plays an artist's radio as its page's play button does (today's, with the playlist's own shuffle setting). */
export function useArtistRadio() {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const fetcher = useLumioFetch()
  return async (artist: BaseItemDto) => {
    const libraries = await musicLibraries(api, session.userId, queryClient)
    const radio = await queryClient.fetchQuery(officialPlaylistQuery(fetcher, session.userId, libraries, `radio-${artist.Id}`))
    const tracks = radio.playlists[0]?.tracks ?? []
    if (tracks.length) music.play(tracks, START, { source: `official:radio-${artist.Id}` })
  }
}

/**
 * "Autoplay": when the queue runs out, more of what was just played, around the last song's artist (one that counts
 * for the taste profile), without repeating what the queue already had. Library tracks only (podcasts just end).
 */
export async function continuation(api: Api, userId: string, queryClient: QueryClient, played: BaseItemDto[]) {
  const exclusions = { ...NO_EXCLUSIONS, ...readLocalSettings(userId).tasteExclusions }
  const counts = (track: BaseItemDto) => countsForTaste(track, exclusions, new Set())
  const library = played.filter((track) => !externalOf(track))
  const last = [...library].reverse().find(counts) ?? library.at(-1)
  const artist = last && artistsOf(last)[0]
  if (!last || !artist?.id) return []
  const libraries = await musicLibraries(api, userId, queryClient)
  if (!libraries.length) return []
  const response = await lumioFetch(`/me/radio/continue?${radioQuery(libraries)}`, {
    method: 'POST',
    body: JSON.stringify({ artist: artist.id, exclude: played.map((track) => track.Id).filter(Boolean), seed: `${userId}:${Date.now()}` }),
  })
  if (!response.ok || response.status === 202) return []
  const data = (await response.json()) as Parameters<typeof unpackTracks>[0] & { playlists: Array<{ tracks: string[] }> }
  const tracks = unpackTracks(data)
  return (data.playlists[0]?.tracks ?? []).map((id) => tracks.get(id)).filter((track): track is BaseItemDto => !!track)
}
