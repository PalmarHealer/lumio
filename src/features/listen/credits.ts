import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getArtistApi } from '@jellyfin/sdk/lib/utils/api/artist-api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { lumioSend } from '@/features/social/social'
import { externalOf } from '@/lib/external-items'
import { ticksToSeconds } from '@/lib/format'
import { artistsOf } from '@/lib/item-links'
import { sameName } from './external'
import { useLumioConfig } from '@/features/admin/branding'
import { useLibraryArtistsNamed } from '@/features/items/queries'

const HOUR = 60 * 60_000

export interface CreditedArtist {
  name: string
  /** The artist in this library, when there is one. */
  id?: string
}

/**
 * A track's credits from MusicBrainz, as the Lumio server looked them up (once per track, for everyone; an admin can
 * look up the whole library at once): everyone on the recording, who wrote, produced and mixed it, label, publisher.
 */
export interface TrackCredits {
  recording: string
  artists: string[]
  writers: string[]
  composers: string[]
  lyricists: string[]
  producers: string[]
  mixers: string[]
  engineers: string[]
  publishers: string[]
  labels: string[]
  isrc?: string
}

// ---- stored credits, asked for together: a list of fifty tracks is one request ----

/** Not looked up yet (as opposed to null: looked up, nothing found). */
const UNKNOWN = 'unknown'
type Stored = TrackCredits | null | typeof UNKNOWN

let waiting = new Map<string, Array<{ resolve: (value: Stored) => void; reject: (error: Error) => void }>>()
let timer: number | undefined

function flush() {
  const batch = waiting
  waiting = new Map()
  timer = undefined
  const ids = [...batch.keys()]
  for (let start = 0; start < ids.length; start += 300) {
    const chunk = ids.slice(start, start + 300)
    void lumioSend('POST', '/credits', { ids: chunk })
      .then(async (response) => {
        // No connection yet (right after loading) or the server failed: the queries ask again shortly.
        if (!response?.ok) throw new Error('Lumio server unavailable')
        return (await response.json()) as Record<string, TrackCredits | null>
      })
      .then(
        (known) => {
          for (const id of chunk) for (const { resolve } of batch.get(id) ?? []) resolve(id in known ? known[id]! : UNKNOWN)
        },
        (error: Error) => {
          for (const id of chunk) for (const { reject } of batch.get(id) ?? []) reject(error)
        },
      )
  }
}

function storedCredits(id: string): Promise<Stored> {
  return new Promise((resolve, reject) => {
    waiting.set(id, [...(waiting.get(id) ?? []), { resolve, reject }])
    timer ??= window.setTimeout(flush, 20)
  })
}

const isTrack = (track: BaseItemDto | undefined): track is BaseItemDto => !!track?.Id && track.Type === 'Audio' && !externalOf(track)

/**
 * A track's credits as the server has them; with `lookup`, the server looks them up now when it hasn't yet (for the
 * track that plays and the song info, not for every row of a list).
 */
export function useTrackCredits(track: BaseItemDto | undefined, lookup = false): TrackCredits | null | undefined {
  const client = useQueryClient()
  // What an admin left out of the metadata (audio plays, say) isn't looked up while it plays either.
  const config = useLumioConfig().data
  const excluded =
    !!track &&
    ([...(track.Artists ?? []), track.AlbumArtist].some((name) => config?.metadataExcludedArtists?.some((entry) => sameName(entry, name))) ||
      (track.Genres ?? []).some((genre) => config?.metadataExcludedGenres?.some((entry) => sameName(entry, genre))))
  const id = isTrack(track) ? track.Id! : undefined
  const stored = useQuery({
    queryKey: ['track-credits', id],
    enabled: !!id,
    // Found (or not found) is kept; "not looked up yet" is asked again soon (a run may be filling it in).
    staleTime: (query) => (query.state.data === UNKNOWN ? 60_000 : 6 * HOUR),
    gcTime: 6 * HOUR,
    queryFn: () => storedCredits(id!),
  })
  const artist = track ? artistsOf(track)[0]?.name : undefined
  const looked = useQuery({
    queryKey: ['track-credits-lookup', id],
    enabled: lookup && !excluded && !!id && !!artist && stored.data === UNKNOWN,
    staleTime: 6 * HOUR,
    retry: false,
    queryFn: async () => {
      const response = await lumioSend('POST', '/credits/lookup', {
        id,
        title: track!.Name,
        artist,
        album: track!.Album ?? undefined,
        albumId: track!.AlbumId ?? undefined,
        seconds: track!.RunTimeTicks ? ticksToSeconds(track!.RunTimeTicks) : undefined,
      })
      if (!response?.ok) throw new Error('No credits')
      const { credits } = (await response.json()) as { credits: TrackCredits | null }
      // Every list showing this track has them now too.
      client.setQueryData(['track-credits', id], credits)
      return credits
    },
  })
  const data = stored.data === UNKNOWN ? looked.data : stored.data
  return data
}

// ---- names to the library's artists ----

/** Where an artist's name leads: their page in the library, or the guest page for those it has none for. */
export const artistHref = (artist: CreditedArtist) => (artist.id ? `/listen/artist/${artist.id}` : `/listen/guest/${encodeURIComponent(artist.name)}`)

const normalize = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** Every artist in the library by name, to link the names in credits to their pages. */
export function useArtistDirectory() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['artist-directory', session.userId],
    staleTime: HOUR,
    gcTime: 6 * HOUR,
    queryFn: async () => {
      const items = (await getArtistApi(api).getArtists({ userId: session.userId, enableImages: false, enableUserData: false, enableTotalRecordCount: false })).data.Items ?? []
      return new Map(items.filter((item) => item.Name && item.Id).map((item) => [normalize(item.Name!), { id: item.Id!, name: item.Name! }]))
    },
  })
}

/**
 * Finds these names among the library's artists, each looked up on its own (cached): the whole directory is megabytes
 * in a big library, and every page with a player needed it. Names not passed in come back unlinked.
 */
export function useArtistLookup(names: string[]): (name: string) => CreditedArtist {
  const unique = [...new Set(names.filter((name) => name.trim()))]
  const found = useLibraryArtistsNamed(unique).data
  return (name) => {
    const artist = found.find((entry) => entry.Name && normalize(entry.Name) === normalize(name))
    return artist?.Id ? { id: artist.Id, name: artist.Name! } : { name }
  }
}

/**
 * A track's artists: Jellyfin's (from the file's tags), then whoever else MusicBrainz names on the recording (featured
 * artists the tags leave out), linked to the library's artist where there is one.
 */
export function useTrackArtists(track: BaseItemDto | undefined, lookup = false): CreditedArtist[] {
  const credits = useTrackCredits(track, lookup)
  const own = track ? artistsOf(track) : []
  const extraNames = (credits?.artists ?? []).filter((name) => !own.some((entry) => sameName(entry.name, name)))
  const find = useArtistLookup([...own.filter((artist) => !artist.id).map((artist) => artist.name), ...extraNames])
  const extra = extraNames.map(find)
  return [...own.map((artist) => (artist.id ? artist : find(artist.name))), ...extra]
}
