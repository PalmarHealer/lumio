import type { Api } from '@jellyfin/sdk'
import { BaseItemKind, ItemFields, ItemFilter, ItemSortBy, MediaType, SortOrder, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getArtistApi } from '@jellyfin/sdk/lib/utils/api/artist-api'
import { getGenreApi } from '@jellyfin/sdk/lib/utils/api/genre-api'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getShowApi } from '@jellyfin/sdk/lib/utils/api/show-api'
import { getUserDataApi } from '@jellyfin/sdk/lib/utils/api/user-data-api'
import { keepPreviousData, queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import type { AppMode } from '@/lib/app-mode'
import { trackIndex } from '@/lib/unscanned'

const PAGE_SIZE = 60

export const itemOptions = (api: Api, userId: string, itemId: string) =>
  queryOptions({
    queryKey: ['item', userId, itemId],
    queryFn: async () => (await getLibraryApi(api).getItem({ itemId, userId })).data,
  })

export function useItem(itemId: string, enabled = true) {
  const { api, session } = useAuthedSession()
  return useQuery({ ...itemOptions(api, session.userId, itemId), enabled })
}

export function useSeasons(seriesId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['seasons', session.userId, seriesId],
    enabled: !!seriesId,
    queryFn: async () => (await getShowApi(api).getSeasons({ seriesId: seriesId!, userId: session.userId })).data.Items ?? [],
  })
}

export function useEpisodes(seriesId: string | undefined, seasonId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['episodes', session.userId, seriesId, seasonId],
    enabled: !!seriesId && !!seasonId,
    queryFn: async () =>
      (
        await getShowApi(api).getEpisodes({
          seriesId: seriesId!,
          seasonId,
          userId: session.userId,
          // Streams too: the audio languages a download can be made in.
          fields: [ItemFields.Overview, ItemFields.PrimaryImageAspectRatio, ItemFields.MediaStreams],
        })
      ).data.Items ?? [],
  })
}

/** Which episode "play" should start for a series: the one in progress, else next up, else the very first. */
export const seriesPlayTargetOptions = (api: Api, userId: string, seriesId: string) =>
  queryOptions({
    queryKey: ['series-play-target', userId, seriesId],
    queryFn: async () => {
      const resume = (await getLibraryApi(api).getResumeItems({ userId, parentId: seriesId, limit: 1, mediaTypes: ['Video'] })).data.Items?.[0]
      if (resume) return resume
      const next = (await getShowApi(api).getNextUp({ userId, seriesId, limit: 1 })).data.Items?.[0]
      if (next) return next
      const first = await getLibraryApi(api).getItems({
        userId,
        parentId: seriesId,
        recursive: true,
        includeItemTypes: [BaseItemKind.Episode],
        sortBy: [ItemSortBy.ParentIndexNumber, ItemSortBy.IndexNumber],
        limit: 1,
      })
      return first.data.Items?.[0] ?? null
    },
  })

export function useSeriesPlayTarget(seriesId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({ ...seriesPlayTargetOptions(api, session.userId, seriesId ?? ''), enabled: !!seriesId })
}

const TYPES_BY_COLLECTION: Record<string, BaseItemKind[]> = {
  movies: [BaseItemKind.Movie],
  tvshows: [BaseItemKind.Series],
  boxsets: [BaseItemKind.BoxSet],
  music: [BaseItemKind.MusicAlbum],
  homevideos: [BaseItemKind.Video, BaseItemKind.Photo],
  books: [BaseItemKind.Book, BaseItemKind.AudioBook],
  musicvideos: [BaseItemKind.MusicVideo],
  playlists: [BaseItemKind.Playlist],
}

// Mixed and unknown library types: top-level media only, never seasons/episodes/tracks.
const FALLBACK_TYPES = [
  BaseItemKind.Movie,
  BaseItemKind.Series,
  BaseItemKind.BoxSet,
  BaseItemKind.MusicAlbum,
  BaseItemKind.Book,
  BaseItemKind.AudioBook,
  BaseItemKind.Video,
  BaseItemKind.Playlist,
]

const libraryTypes = (collectionType: string | undefined) => (collectionType && TYPES_BY_COLLECTION[collectionType]) || FALLBACK_TYPES

/**
 * Playlists belong to the app of their media: music playlists to Listen (its library), video playlists to Watch. So
 * Jellyfin's "Playlists" library in Watch only lists the video ones.
 */
const libraryMediaTypes = (collectionType: string | undefined) => (collectionType === 'playlists' ? [MediaType.Video] : undefined)

/** Whether a playlist belongs to Watch (videos) rather than Listen (music, or still empty). */
export const isVideoPlaylist = (item: BaseItemDto) => item.Type === 'Playlist' && item.MediaType === 'Video'

export type LibrarySort = 'name' | 'artist' | 'added' | 'released' | 'plays' | 'rating' | 'critics' | 'runtime' | 'random'
export type LibraryFilter = 'unplayed' | 'played' | 'favorite'

/** How a library is sorted and narrowed down; kept in the URL by the library page. */
export interface LibraryQuery {
  sort: LibrarySort
  descending: boolean
  genreIds: string[]
  filters: LibraryFilter[]
  search: string
}

const SORT_FIELDS: Record<LibrarySort, ItemSortBy[]> = {
  name: [ItemSortBy.SortName],
  artist: [ItemSortBy.AlbumArtist, ItemSortBy.SortName],
  plays: [ItemSortBy.PlayCount, ItemSortBy.SortName],
  added: [ItemSortBy.DateCreated, ItemSortBy.SortName],
  released: [ItemSortBy.PremiereDate, ItemSortBy.ProductionYear, ItemSortBy.SortName],
  rating: [ItemSortBy.CommunityRating, ItemSortBy.SortName],
  critics: [ItemSortBy.CriticRating, ItemSortBy.SortName],
  runtime: [ItemSortBy.Runtime, ItemSortBy.SortName],
  random: [ItemSortBy.Random],
}

/**
 * `collectionType` is the library's type, used to request the right item types. The query waits until the library
 * itself has loaded (`ready`): mixed libraries have no type at all and use the fallback list.
 */
export function useLibrary(parentId: string, collectionType: string | undefined, ready: boolean, query: LibraryQuery) {
  const { api, session } = useAuthedSession()
  // "Gesehen" and "Ungesehen" together mean everything, so neither narrows anything.
  const played = query.filters.includes('played')
  const unplayed = query.filters.includes('unplayed')
  return useInfiniteQuery({
    queryKey: ['library', session.userId, parentId, collectionType, query],
    enabled: ready,
    initialPageParam: 0,
    // Changing a filter keeps the old grid until the new one arrives instead of flashing placeholders.
    placeholderData: keepPreviousData,
    // A random order is drawn once; refetching it would shuffle the grid under the user.
    staleTime: query.sort === 'random' ? Infinity : undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await getLibraryApi(api).getItems({
        userId: session.userId,
        parentId,
        recursive: true,
        includeItemTypes: libraryTypes(collectionType),
        mediaTypes: libraryMediaTypes(collectionType),
        sortBy: SORT_FIELDS[query.sort],
        sortOrder: [query.descending ? SortOrder.Descending : SortOrder.Ascending],
        genreIds: query.genreIds.length ? query.genreIds : undefined,
        isPlayed: played === unplayed ? undefined : played,
        isFavorite: query.filters.includes('favorite') || undefined,
        searchTerm: query.search || undefined,
        fields: [ItemFields.PrimaryImageAspectRatio],
        startIndex: pageParam,
        limit: PAGE_SIZE,
      })
      return pageOf(data, pageParam)
    },
    getNextPageParam: (last) => (last.items.length > 0 && last.next < last.total ? last.next : undefined),
  })
}

/**
 * The same title in several libraries (e.g. a series in a German and an English library) shows up once: matched by
 * its provider ids (TVDB, TMDB, IMDb), the copy from the library listed first wins.
 */
export function titleKey(item: BaseItemDto): string | undefined {
  const ids = item.ProviderIds ?? {}
  const id = ids.Tvdb ?? ids.Tmdb ?? ids.Imdb
  return id ? `${item.Type}:${id}` : undefined
}

const byNumber = (value: number | null | undefined) => (value == null ? undefined : value)
const byDate = (value: string | null | undefined) => (value ? Date.parse(value) : undefined)

/** Sort keys for merging libraries in the browser; the same orders the server applies to a single library. */
const SORT_KEYS: Record<Exclude<LibrarySort, 'random'>, (item: BaseItemDto) => number | string | undefined> = {
  name: (item) => (item.SortName ?? item.Name ?? '').toLocaleLowerCase(),
  artist: (item) => (item.AlbumArtist ?? '').toLocaleLowerCase(),
  plays: (item) => byNumber(item.UserData?.PlayCount),
  added: (item) => byDate(item.DateCreated),
  released: (item) => byDate(item.PremiereDate) ?? (item.ProductionYear ? Date.UTC(item.ProductionYear, 0) : undefined),
  rating: (item) => byNumber(item.CommunityRating),
  critics: (item) => byNumber(item.CriticRating),
  runtime: (item) => byNumber(item.RunTimeTicks),
}

function sortItems(items: BaseItemDto[], sort: LibrarySort, descending: boolean) {
  if (sort === 'random') {
    const shuffled = [...items]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    return shuffled
  }
  const key = SORT_KEYS[sort]
  const name = SORT_KEYS.name
  return [...items].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    // Titles without the value go last either way, like on the server.
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1
    } else if (left !== right) {
      const order = typeof left === 'string' ? left.localeCompare(right as string) : left - (right as number)
      return descending ? -order : order
    }
    return (name(a) as string).localeCompare(name(b) as string)
  })
}

/**
 * Several libraries as one list (a navigation category): each library is fetched whole with the same filters, then
 * duplicates are dropped and the result is sorted here. Fine for the size of a home library; a single library still
 * goes through the paged `useLibrary`.
 */
export function useMergedLibraries(views: BaseItemDto[], query: LibraryQuery, enabled = true) {
  const { api, session } = useAuthedSession()
  const played = query.filters.includes('played')
  const unplayed = query.filters.includes('unplayed')
  const ids = views.map((view) => view.Id!)
  return useQuery({
    queryKey: ['merged-libraries', session.userId, ids, query],
    enabled: enabled && views.length > 0,
    placeholderData: keepPreviousData,
    staleTime: query.sort === 'random' ? Infinity : undefined,
    queryFn: async () => {
      const lists = await Promise.all(
        views.map(
          async (view) =>
            (
              await getLibraryApi(api).getItems({
                userId: session.userId,
                parentId: view.Id!,
                recursive: true,
                includeItemTypes: libraryTypes(view.CollectionType ?? undefined),
                sortBy: [ItemSortBy.SortName],
                genreIds: query.genreIds.length ? query.genreIds : undefined,
                isPlayed: played === unplayed ? undefined : played,
                isFavorite: query.filters.includes('favorite') || undefined,
                searchTerm: query.search || undefined,
                fields: [ItemFields.PrimaryImageAspectRatio, ItemFields.ProviderIds, ItemFields.DateCreated, ItemFields.SortName],
              })
            ).data.Items ?? [],
        ),
      )
      const seen = new Set<string>()
      const items = lists.flat().filter((item) => {
        const key = titleKey(item)
        if (!key) return true
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return sortItems(items, query.sort, query.descending)
    },
  })
}

/** Genres of several libraries together (genres are server-wide items, so they merge by id). */
export function useMergedGenres(views: BaseItemDto[], enabled = true) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['merged-genres', session.userId, views.map((view) => view.Id)],
    enabled: enabled && views.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const lists = await Promise.all(
        views.map(
          async (view) =>
            (
              await getGenreApi(api).getGenres({
                userId: session.userId,
                parentId: view.Id!,
                includeItemTypes: libraryTypes(view.CollectionType ?? undefined),
                sortBy: [ItemSortBy.SortName],
                enableImages: false,
                enableTotalRecordCount: false,
              })
            ).data.Items ?? [],
        ),
      )
      const byId = new Map(lists.flat().map((genre) => [genre.Id, genre]))
      return [...byId.values()].sort((a, b) => (a.Name ?? '').localeCompare(b.Name ?? ''))
    },
  })
}

/**
 * Other copies of a title in the user's libraries (same provider ids), e.g. the English version of a series kept in
 * its own library; the detail page offers them as a switch.
 */
export function useOtherVersions(item: BaseItemDto | undefined, views: BaseItemDto[]) {
  const { api, session } = useAuthedSession()
  const key = item && (item.Type === 'Series' || item.Type === 'Movie') ? titleKey(item) : undefined
  const candidates = views.filter((view) => view.CollectionType === (item?.Type === 'Series' ? 'tvshows' : 'movies'))
  return useQuery({
    queryKey: ['other-versions', session.userId, item?.Id, candidates.map((view) => view.Id)],
    enabled: !!key && candidates.length > 1,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const found = await Promise.all(
        candidates.map(async (view) => {
          const items =
            (
              await getLibraryApi(api).getItems({
                userId: session.userId,
                parentId: view.Id!,
                recursive: true,
                includeItemTypes: [item!.Type as BaseItemKind],
                fields: [ItemFields.ProviderIds],
                enableImages: false,
              })
            ).data.Items ?? []
          return items.filter((other) => titleKey(other) === key).map((other) => ({ item: other, library: view }))
        }),
      )
      return found.flat()
    },
  })
}

/** Genres that occur in a library, for its filter chips. */
export function useLibraryGenres(parentId: string, collectionType: string | undefined, ready: boolean) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['library-genres', session.userId, parentId, collectionType],
    enabled: ready,
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (
        await getGenreApi(api).getGenres({
          userId: session.userId,
          parentId,
          includeItemTypes: libraryTypes(collectionType),
          sortBy: [ItemSortBy.SortName],
          enableImages: false,
          enableTotalRecordCount: false,
        })
      ).data.Items ?? [],
  })
}

function pageOf(data: { Items?: BaseItemDto[] | null; TotalRecordCount?: number | null }, start: number) {
  const items = data.Items ?? []
  return { items, next: start + items.length, total: data.TotalRecordCount ?? 0 }
}

/** An item's parents up to its library (user view). */
export const ancestorsOptions = (api: Api, userId: string, itemId: string) =>
  queryOptions({
    queryKey: ['ancestors', userId, itemId],
    staleTime: 10 * 60_000,
    queryFn: async () => (await getLibraryApi(api).getAncestors({ itemId, userId })).data,
  })

/** The library (user view) an item lives in, so the navbar can keep its category highlighted. */
export function useAncestors(itemId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({ ...ancestorsOptions(api, session.userId, itemId ?? ''), enabled: !!itemId })
}

/** Tracks/chapters of an album or audiobook, in playing order. */
export const albumTracksOptions = (api: Api, userId: string, albumId: string) =>
  queryOptions({
    queryKey: ['tracks', userId, albumId],
    queryFn: async () => {
      const items =
        (
          await getLibraryApi(api).getItems({
            userId,
            parentId: albumId,
            includeItemTypes: [BaseItemKind.Audio],
            sortBy: [ItemSortBy.ParentIndexNumber, ItemSortBy.IndexNumber, ItemSortBy.SortName],
            fields: [ItemFields.PrimaryImageAspectRatio],
          })
        ).data.Items ?? []
      // Files the scan hasn't probed yet have no number and would come first; their file name has one.
      return items.toSorted((a, b) => (a.ParentIndexNumber ?? 1) - (b.ParentIndexNumber ?? 1) || (trackIndex(a) ?? Infinity) - (trackIndex(b) ?? Infinity))
    },
  })

/**
 * An artist's albums, newest first: the ones they are the album artist of, then those they only appear on (features,
 * compilations), each list without the other's albums.
 */
export function useArtistAlbums(artistId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['artist-albums', session.userId, artistId],
    enabled: !!artistId,
    queryFn: async () => {
      const request = (by: 'albumArtistIds' | 'contributingArtistIds') =>
        getLibraryApi(api).getItems({
          userId: session.userId,
          recursive: true,
          includeItemTypes: [BaseItemKind.MusicAlbum],
          [by]: [artistId!],
          sortBy: [ItemSortBy.PremiereDate, ItemSortBy.ProductionYear, ItemSortBy.SortName],
          sortOrder: [SortOrder.Descending],
          fields: [ItemFields.PrimaryImageAspectRatio, ItemFields.ChildCount],
        })
      const [own, appearsOn] = await Promise.all([request('albumArtistIds'), request('contributingArtistIds')])
      const albums = own.data.Items ?? []
      const ids = new Set(albums.map((album) => album.Id))
      return { albums, appearsOn: (appearsOn.data.Items ?? []).filter((album) => !ids.has(album.Id)) }
    },
  })
}

/** The album artists of some music libraries, for the artists row of the music category. */
/** The artists most recently added to these libraries, newest first. */
export function useNewestArtists(views: BaseItemDto[], enabled = true) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['newest-artists', session.userId, views.map((view) => view.Id)],
    enabled: enabled && views.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const lists = await Promise.all(
        views.map(
          async (view) =>
            (
              await getArtistApi(api).getAlbumArtists({
                userId: session.userId,
                parentId: view.Id!,
                sortBy: [ItemSortBy.DateCreated],
                sortOrder: [SortOrder.Descending],
                fields: [ItemFields.PrimaryImageAspectRatio, ItemFields.DateCreated],
                limit: 20,
              })
            ).data.Items ?? [],
        ),
      )
      const byId = new Map(lists.flat().map((artist) => [artist.Id, artist]))
      return [...byId.values()].sort((a, b) => Date.parse(b.DateCreated ?? '') - Date.parse(a.DateCreated ?? '')).slice(0, 20)
    },
  })
}

export function useLibraryArtists(views: BaseItemDto[], enabled = true) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['library-artists', session.userId, views.map((view) => view.Id)],
    enabled: enabled && views.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const lists = await Promise.all(
        views.map(
          async (view) =>
            (
              await getArtistApi(api).getAlbumArtists({
                userId: session.userId,
                parentId: view.Id!,
                sortBy: [ItemSortBy.SortName],
                fields: [ItemFields.PrimaryImageAspectRatio],
              })
            ).data.Items ?? [],
        ),
      )
      const byId = new Map(lists.flat().map((artist) => [artist.Id, artist]))
      return [...byId.values()].sort((a, b) => (a.SortName ?? a.Name ?? '').localeCompare(b.SortName ?? b.Name ?? ''))
    },
  })
}

export function useAlbumTracks(albumId: string | undefined | null, enabled = true) {
  const { api, session } = useAuthedSession()
  return useQuery({ ...albumTracksOptions(api, session.userId, albumId ?? ''), enabled: !!albumId && enabled })
}

/** The item that follows `item` in its season/album, for "next" and autoplay. */
export function useNextItem(item: BaseItemDto | undefined) {
  const { api, session } = useAuthedSession()
  const isEpisode = item?.Type === 'Episode' && !!item.SeriesId
  const isTrack = item?.Type === 'Audio' && !!item.ParentId
  const tracks = useAlbumTracks(item?.ParentId, isTrack)
  const episodes = useQuery({
    queryKey: ['next-episode', session.userId, item?.Id],
    enabled: isEpisode,
    queryFn: async () =>
      (await getShowApi(api).getEpisodes({ seriesId: item!.SeriesId!, userId: session.userId, startItemId: item!.Id, limit: 2 })).data.Items?.[1] ?? null,
  })
  if (isTrack) {
    const list = tracks.data ?? []
    return list[list.findIndex((track) => track.Id === item!.Id) + 1] ?? null
  }
  return episodes.data ?? null
}

/** What the watchlist holds: Watch's own kinds. Saved albums belong to Listen's library, not here. */
const BROWSE_TYPES = [BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.BoxSet, BaseItemKind.Book]

export function useFavorites(limit?: number) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['favorites', session.userId, limit],
    queryFn: async () =>
      (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          recursive: true,
          filters: [ItemFilter.IsFavorite],
          includeItemTypes: BROWSE_TYPES,
          sortBy: [ItemSortBy.DateCreated],
          sortOrder: [SortOrder.Descending],
          fields: [ItemFields.PrimaryImageAspectRatio],
          limit,
        })
      ).data.Items ?? [],
  })
}

/** Favorites are the watchlist. Updates the cached item immediately and refreshes the lists. */
export function useSetFavorite(itemId: string) {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (favorite: boolean) => {
      const userData = getUserDataApi(api)
      if (favorite) await userData.markFavoriteItem({ itemId, userId: session.userId })
      else await userData.unmarkFavoriteItem({ itemId, userId: session.userId })
      return favorite
    },
    onSuccess: (favorite) => {
      queryClient.setQueryData<BaseItemDto>(['item', session.userId, itemId], (item) =>
        item ? { ...item, UserData: { ...item.UserData!, IsFavorite: favorite } } : item,
      )
      void queryClient.invalidateQueries({ queryKey: ['favorites'] })
      // Listen's library lists (liked songs, saved albums, followed artists) are favourites too.
      for (const key of ['liked-songs', 'saved-albums', 'followed-artists']) void queryClient.invalidateQueries({ queryKey: [key] })
    },
  })
}

/** What each app searches: Watch its films and series, Listen its music and audiobooks. */
const SEARCH_TYPES: Record<AppMode, BaseItemKind[]> = {
  watch: [BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.BoxSet, BaseItemKind.Book, BaseItemKind.Episode, BaseItemKind.Playlist],
  listen: [BaseItemKind.MusicArtist, BaseItemKind.MusicAlbum, BaseItemKind.Audio, BaseItemKind.AudioBook, BaseItemKind.Playlist],
}

export function useSearch(term: string, mode: AppMode = 'watch') {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['search', session.userId, term, mode],
    enabled: term.length > 0,
    placeholderData: (previous) => previous,
    queryFn: async () =>
      (
        (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          searchTerm: term,
          recursive: true,
          includeItemTypes: SEARCH_TYPES[mode],
          fields: [ItemFields.PrimaryImageAspectRatio],
          limit: 120,
        })
      ).data.Items ?? []
      ).filter((item) => item.Type !== 'Playlist' || isVideoPlaylist(item) === (mode === 'watch')),
  })
}

/** Everything a person (actor, director, ...) appears in. */
export function usePersonItems(personId: string) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['person-items', session.userId, personId],
    queryFn: async () =>
      (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          personIds: [personId],
          recursive: true,
          includeItemTypes: [BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Episode],
          sortBy: [ItemSortBy.PremiereDate],
          sortOrder: [SortOrder.Descending],
          fields: [ItemFields.PrimaryImageAspectRatio],
        })
      ).data.Items ?? [],
  })
}


/** Marks an item (or a whole series/season) as watched or unwatched and refreshes everything that shows it. */
export function useSetPlayed(itemId: string) {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (played: boolean) => {
      const userData = getUserDataApi(api)
      if (played) await userData.markPlayedItem({ itemId, userId: session.userId })
      else await userData.markUnplayedItem({ itemId, userId: session.userId })
      return played
    },
    onSuccess: () => {
      // Played state shows up in many lists (cards, episode rows, resume, history, search), so refetch broadly.
      for (const key of [
        'item',
        'episodes',
        'seasons',
        'tracks',
        'resume',
        'next-up',
        'next-episode',
        'latest',
        'library',
        'favorites',
        'history',
        'search',
        'person-items',
        'series-play-target',
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    },
  })
}

const HISTORY_PAGE_SIZE = 40

/** Everything the user has watched, newest first. */
/** What each app's history holds: Watch the films and episodes watched, Listen the songs and audiobooks heard. */
const HISTORY_TYPES: Record<AppMode, BaseItemKind[]> = {
  watch: [BaseItemKind.Movie, BaseItemKind.Episode, BaseItemKind.Video, BaseItemKind.MusicVideo],
  listen: [BaseItemKind.Audio, BaseItemKind.AudioBook],
}

export function useHistory(mode: AppMode) {
  const { api, session } = useAuthedSession()
  return useInfiniteQuery({
    queryKey: ['history', session.userId, mode],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data } = await getLibraryApi(api).getItems({
        userId: session.userId,
        recursive: true,
        filters: [ItemFilter.IsPlayed],
        includeItemTypes: HISTORY_TYPES[mode],
        sortBy: [ItemSortBy.DatePlayed],
        sortOrder: [SortOrder.Descending],
        fields: [ItemFields.PrimaryImageAspectRatio],
        startIndex: pageParam,
        limit: HISTORY_PAGE_SIZE,
      })
      return pageOf(data, pageParam)
    },
    getNextPageParam: (last) => (last.items.length > 0 && last.next < last.total ? last.next : undefined),
  })
}

/**
 * Search inside the watch history. Episodes are named differently from their series, so besides matching item names this
 * also pulls the watched episodes of every series whose name matches.
 */
export function useHistorySearch(term: string, mode: AppMode) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['history', 'search', session.userId, term, mode],
    enabled: term.length > 0,
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const library = getLibraryApi(api)
      const played = {
        userId: session.userId,
        recursive: true,
        filters: [ItemFilter.IsPlayed],
        sortBy: [ItemSortBy.DatePlayed],
        sortOrder: [SortOrder.Descending],
        fields: [ItemFields.PrimaryImageAspectRatio],
        limit: 100,
      }
      const [byName, series] = await Promise.all([
        library.getItems({ ...played, searchTerm: term, includeItemTypes: HISTORY_TYPES[mode] }),
        // Watch: also the episodes of matching series. Listen: the songs of matching albums and artists come by name.
        mode === 'watch'
          ? library.getItems({ userId: session.userId, recursive: true, searchTerm: term, includeItemTypes: [BaseItemKind.Series], limit: 5 })
          : { data: { Items: [] as BaseItemDto[] } },
      ])
      const perSeries = await Promise.all(
        (series.data.Items ?? []).map((show) => library.getItems({ ...played, parentId: show.Id, includeItemTypes: [BaseItemKind.Episode] })),
      )
      const unique = new Map<string, BaseItemDto>()
      for (const item of [...(byName.data.Items ?? []), ...perSeries.flatMap((result) => result.data.Items ?? [])]) {
        if (item.Id) unique.set(item.Id, item)
      }
      const playedAt = (item: BaseItemDto) => (item.UserData?.LastPlayedDate ? Date.parse(item.UserData.LastPlayedDate) : 0)
      return [...unique.values()].sort((a, b) => playedAt(b) - playedAt(a))
    },
  })
}

const MAX_GUEST_STARS = 40

/** Guest stars across the whole series, most frequent first. They live on the episodes, not on the series itself. */
export function useSeriesGuestStars(seriesId: string) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['guest-stars', session.userId, seriesId],
    // Heavy call (people of every episode) whose answer rarely changes.
    staleTime: 60 * 60_000,
    gcTime: 2 * 60 * 60_000,
    queryFn: async () => {
      const { data } = await getLibraryApi(api).getItems({
        userId: session.userId,
        parentId: seriesId,
        recursive: true,
        includeItemTypes: [BaseItemKind.Episode],
        fields: [ItemFields.People],
        enableImages: false,
        enableUserData: false,
      })
      const byPerson = new Map<string, { person: NonNullable<BaseItemDto['People']>[number]; roles: Set<string>; episodes: number }>()
      for (const episode of data.Items ?? []) {
        // Someone listed twice in one episode (two roles) still appeared in one episode.
        const counted = new Set<string>()
        for (const person of episode.People ?? []) {
          if (person.Type !== 'GuestStar' || !person.Id) continue
          const entry = byPerson.get(person.Id) ?? { person, roles: new Set<string>(), episodes: 0 }
          if (person.Role) entry.roles.add(person.Role)
          if (!counted.has(person.Id)) entry.episodes += 1
          counted.add(person.Id)
          byPerson.set(person.Id, entry)
        }
      }
      return [...byPerson.values()]
        .sort((a, b) => b.episodes - a.episodes)
        .slice(0, MAX_GUEST_STARS)
        .map(({ person, roles, episodes }) => ({ person, roles: [...roles].slice(0, 2), episodes }))
    },
  })
}

/** Jellyfin's "more like this" for a title (genres, people, studios in common). */
export function useSimilarItems(itemId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['similar', session.userId, itemId],
    enabled: !!itemId,
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (await getLibraryApi(api).getSimilarItems({ itemId: itemId!, userId: session.userId, limit: 24, fields: [ItemFields.PrimaryImageAspectRatio] })).data
        .Items ?? [],
  })
}
