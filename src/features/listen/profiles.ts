import { BaseItemKind, ItemFields, ItemFilter, ItemSortBy, SortOrder, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api'
import { getUserApi } from '@jellyfin/sdk/lib/utils/api/user-api'
import { useQuery } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { usePlaylists } from './playlists'
import { useTasteFilter } from './taste'

/**
 * Profiles in Listen: the people on this server and the public playlists they made. Jellyfin only lets admins list
 * all users and doesn't expose a playlist's owner, so playlists are matched to people through their editors (Lumio
 * adds a playlist's creator there, see `usePlaylistActions`). A user whose details can't be read shows without them.
 */
export function useProfile(userId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['profile', userId],
    enabled: !!userId,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      try {
        return (await getUserApi(api).getUserById({ userId: userId! })).data
      } catch {
        // Not allowed to read other users (not an admin): only the id is known.
        return userId === session.userId ? { Id: userId, Name: session.userName } : { Id: userId }
      }
    },
  })
}

/** Everyone on the server, for admins; others can't list users and get an empty list. */
export function useProfiles() {
  const { api } = useAuthedSession()
  return useQuery({
    queryKey: ['profiles'],
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      try {
        return (await getUserApi(api).getUsers({ isDisabled: false })).data
      } catch {
        return []
      }
    },
  })
}

export interface PlaylistInfo {
  playlist: BaseItemDto
  isPublic: boolean
  /** Users who may edit it, the creator among them. */
  editors: string[]
}

/** Every visible playlist with whether it is public and who edits it. */
export function usePlaylistInfos() {
  const { api, session } = useAuthedSession()
  const playlists = usePlaylists()
  const ids = (playlists.data ?? []).map((playlist) => playlist.Id!)
  return useQuery({
    queryKey: ['playlist-infos', session.userId, ids],
    enabled: !!playlists.data,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PlaylistInfo[]> => {
      const api_ = getPlaylistApi(api)
      return Promise.all(
        (playlists.data ?? []).map(async (playlist) => {
          const [access, users] = await Promise.all([
            api_.getPlaylist({ playlistId: playlist.Id! }).then((response) => response.data).catch(() => null),
            api_.getPlaylistUsers({ playlistId: playlist.Id! }).then((response) => response.data).catch(() => []),
          ])
          const editors = users.filter((user) => user.CanEdit && user.UserId).map((user) => user.UserId!)
          // Playlists the current user may delete are theirs, even if made elsewhere (without the editor entry).
          if (playlist.CanDelete && !editors.includes(session.userId)) editors.unshift(session.userId)
          return { playlist, isPublic: !!access?.OpenAccess, editors }
        }),
      )
    },
  })
}

/** Playlists the user may add songs to: their own, and shared ones where they are an editor. */
export function useEditablePlaylists() {
  const { session } = useAuthedSession()
  const playlists = usePlaylists()
  const infos = usePlaylistInfos()
  return (playlists.data ?? []).filter(
    (playlist) => playlist.CanDelete !== false || !!infos.data?.find((info) => info.playlist.Id === playlist.Id)?.editors.includes(session.userId),
  )
}

/** The playlists on someone's profile: public ones they edit (all of their own on the user's own profile). */
export function useProfilePlaylists(userId: string | undefined) {
  const { session } = useAuthedSession()
  const infos = usePlaylistInfos()
  const own = userId === session.userId
  return {
    playlists: (infos.data ?? []).filter((info) => !!userId && info.editors.includes(userId) && (info.isPublic || own)),
    isLoading: infos.isLoading,
  }
}

/** Who made a playlist, as far as can be told. */
export function usePlaylistOwner(playlistId: string | undefined) {
  const infos = usePlaylistInfos()
  return infos.data?.find((info) => info.playlist.Id === playlistId)?.editors[0]
}

/** How far back "this month" reaches for the top artists. */
const MONTH_MS = 30 * 24 * 60 * 60_000

/**
 * The user's own listening: their top artists of the last 30 days (by how many of their songs they played, the most
 * played counting a little more) and the artists they listened to most recently. Only for the user themselves.
 */
export function useListeningStats() {
  const { api, session } = useAuthedSession()
  // What is left out of the taste profile doesn't make anyone a top artist (from the next regular build on).
  const taste = useTasteFilter()
  return useQuery({
    queryKey: ['listening-stats', session.userId],
    enabled: taste.ready,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const library = getLibraryApi(api)
      const played =
        (
          await library.getItems({
            userId: session.userId,
            recursive: true,
            includeItemTypes: [BaseItemKind.Audio],
            filters: [ItemFilter.IsPlayed],
            sortBy: [ItemSortBy.DatePlayed],
            sortOrder: [SortOrder.Descending],
            enableImages: false,
            limit: 600,
          })
        ).data.Items ?? []
      const artistOf = (track: BaseItemDto) => track.AlbumArtists?.[0] ?? track.ArtistItems?.[0]
      const since = Date.now() - MONTH_MS
      const scores = new Map<string, number>()
      const recent: string[] = []
      for (const track of played) {
        if (!taste.counts(track)) continue
        const artist = artistOf(track)?.Id
        if (!artist) continue
        if (!recent.includes(artist)) recent.push(artist)
        if (Date.parse(track.UserData?.LastPlayedDate ?? '') >= since) {
          scores.set(artist, (scores.get(artist) ?? 0) + 1 + Math.min(4, Math.log2(1 + (track.UserData?.PlayCount ?? 1))))
        }
      }
      const top = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id)
      const ids = [...new Set([...top, ...recent.slice(0, 12)])]
      const artists = ids.length
        ? ((await library.getItems({ userId: session.userId, ids, fields: [ItemFields.PrimaryImageAspectRatio] })).data.Items ?? [])
        : []
      const byId = new Map(artists.map((artist) => [artist.Id, artist]))
      const pick = (list: string[]) => list.map((id) => byId.get(id)).filter((artist): artist is BaseItemDto => !!artist)
      return { topArtists: pick(top), recentArtists: pick(recent.slice(0, 12)) }
    },
  })
}
