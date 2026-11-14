import type { Api } from '@jellyfin/sdk'
import { BaseItemKind, ItemFields, ItemFilter, ItemSortBy, MediaType, SortOrder, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getDisplayPreferenceApi } from '@jellyfin/sdk/lib/utils/api/display-preference-api'
import { getImageApi } from '@jellyfin/sdk/lib/utils/api/image-api'
import { getItemUpdateApi } from '@jellyfin/sdk/lib/utils/api/item-update-api'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAuthedSession } from '@/features/auth/session'
import { lumioSend } from '@/features/social/social'

const fields = [ItemFields.PrimaryImageAspectRatio, ItemFields.DateCreated]

/**
 * Marks a playlist whose cover was chosen by hand. Jellyfin also gives playlists a cover of its own (a collage made
 * once, when the playlist is created, and never redone as songs are added), so its image alone doesn't say whether
 * it should be shown; without the mark Lumio builds the cover from the first four albums itself.
 */
const CUSTOM_COVER_TAG = 'lumio-cover'

export const hasCustomCover = (playlist: BaseItemDto) => !!playlist.ImageTags?.Primary && !!playlist.Tags?.includes(CUSTOM_COVER_TAG)

/** A picture scaled down to a square-ish JPEG (covers needn't be bigger), as base64 for Jellyfin's upload. */
async function coverBase64(file: File, size = 640) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, size / Math.min(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  // Cropped to a centred square, as covers are shown.
  const side = Math.round(Math.min(bitmap.width, bitmap.height) * scale)
  canvas.width = side
  canvas.height = side
  const crop = Math.min(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side)
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1] ?? ''
}

/** Music playlists the user can see: their own and the ones shared with everyone. */
export function usePlaylists() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['playlists', session.userId],
    queryFn: async () =>
      (
        (
          await getLibraryApi(api).getItems({
            userId: session.userId,
            recursive: true,
            includeItemTypes: [BaseItemKind.Playlist],
            sortBy: [ItemSortBy.SortName],
            fields: [...fields, ItemFields.ChildCount, ItemFields.CanDelete, ItemFields.Tags],
          })
        ).data.Items ?? []
      ).filter((playlist) => !playlist.MediaType || playlist.MediaType === 'Audio'),
  })
}

export function usePlaylistTracks(playlistId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['playlist-tracks', session.userId, playlistId],
    enabled: !!playlistId,
    queryFn: async () =>
      (await getPlaylistApi(api).getPlaylistItems({ playlistId: playlistId!, userId: session.userId, fields })).data.Items ?? [],
  })
}

/** Whether a playlist is shared with everyone (and so shows up for other users). */
export function usePlaylistAccess(playlistId: string | undefined) {
  const { api } = useAuthedSession()
  return useQuery({
    queryKey: ['playlist-access', playlistId],
    enabled: !!playlistId,
    retry: false,
    queryFn: async () => (await getPlaylistApi(api).getPlaylist({ playlistId: playlistId! })).data,
  })
}

/** The user's liked songs (Jellyfin favourites among tracks), most recently liked first is not known; newest first. */
export function useLikedSongs() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['liked-songs', session.userId],
    queryFn: async () =>
      (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          recursive: true,
          includeItemTypes: [BaseItemKind.Audio],
          filters: [ItemFilter.IsFavorite],
          sortBy: [ItemSortBy.DateCreated],
          sortOrder: [SortOrder.Descending],
          fields,
        })
      ).data.Items ?? [],
  })
}

/** Albums the user saved (favourite albums). */
export function useSavedAlbums() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['saved-albums', session.userId],
    queryFn: async () =>
      (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          recursive: true,
          includeItemTypes: [BaseItemKind.MusicAlbum],
          filters: [ItemFilter.IsFavorite],
          sortBy: [ItemSortBy.SortName],
          fields,
        })
      ).data.Items ?? [],
  })
}

/** Artists the user follows (favourite artists). */
export function useFollowedArtists() {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['followed-artists', session.userId],
    queryFn: async () =>
      (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          recursive: true,
          includeItemTypes: [BaseItemKind.MusicArtist],
          filters: [ItemFilter.IsFavorite],
          sortBy: [ItemSortBy.SortName],
          fields,
        })
      ).data.Items ?? [],
  })
}

export function usePlaylistActions() {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const refresh = (playlistId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['playlists'] })
    if (playlistId) {
      void queryClient.invalidateQueries({ queryKey: ['playlist-tracks', session.userId, playlistId] })
      void queryClient.invalidateQueries({ queryKey: ['playlist-access', playlistId] })
      void queryClient.invalidateQueries({ queryKey: ['item', session.userId, playlistId] })
    }
  }
  const playlists = getPlaylistApi(api)
  /**
   * Jellyfin doesn't tell other users who owns a playlist. Lumio lists the creator among its editors, which anyone
   * who can see the playlist can read, so public playlists show up on their creator's profile.
   */
  const markOwner = (playlistId: string) =>
    playlists.updatePlaylistUser({ playlistId, userId: session.userId, updatePlaylistUserDto: { CanEdit: true } }).catch(() => undefined)
  /** Tells the Lumio server who added these songs (Jellyfin doesn't keep it); shared playlists show it. */
  const recordAdds = async (playlistId: string, ids: string[]) => {
    for (let start = 0; start < ids.length; start += 300)
      await lumioSend('POST', '/playlists/adds', { playlistId, itemIds: ids.slice(start, start + 300) }).catch(() => undefined)
    void queryClient.invalidateQueries({ queryKey: ['playlist-adds', playlistId] })
  }

  const create = useMutation({
    mutationFn: async ({ name, ids = [] }: { name: string; ids?: string[] }) => {
      const id = (
        await playlists.createPlaylist({
          createPlaylistDto: { Name: name, Ids: ids, UserId: session.userId, MediaType: MediaType.Audio, IsPublic: false },
        })
      ).data.Id!
      await markOwner(id)
      if (ids.length) void recordAdds(id, ids)
      return id
    },
    onSuccess: () => refresh(),
  })
  const add = useMutation({
    mutationFn: async ({ playlistId, ids }: { playlistId: string; ids: string[]; name?: string }) => {
      await playlists.addItemToPlaylist({ playlistId, ids, userId: session.userId })
      void recordAdds(playlistId, ids)
    },
    onSuccess: (_, { playlistId, name }) => {
      refresh(playlistId)
      if (name) toast.success(name)
    },
  })
  const remove = useMutation({
    mutationFn: async ({ playlistId, entryIds }: { playlistId: string; entryIds: string[] }) =>
      playlists.removeItemFromPlaylist({ playlistId, entryIds }),
    onSuccess: (_, { playlistId }) => refresh(playlistId),
  })
  const update = useMutation({
    mutationFn: async ({ playlistId, name, isPublic }: { playlistId: string; name?: string; isPublic?: boolean }) => {
      await playlists.updatePlaylist({ playlistId, updatePlaylistDto: { Name: name, IsPublic: isPublic } })
      // Going public: make sure the playlist can be traced back to its creator (for their profile).
      if (isPublic) await markOwner(playlistId)
    },
    onSuccess: (_, { playlistId }) => refresh(playlistId),
  })
  /**
   * The "Edit details" dialog: name and public/private (any owner), and description and cover, which Jellyfin lets
   * only admins change. `image` null removes the chosen cover (back to the mosaic).
   */
  const editDetails = useMutation({
    mutationFn: async ({
      playlistId,
      name,
      isPublic,
      description,
      image,
    }: {
      playlistId: string
      name: string
      isPublic: boolean
      description?: string
      image?: File | null
    }) => {
      await playlists.updatePlaylist({ playlistId, updatePlaylistDto: { Name: name, IsPublic: isPublic } })
      if (isPublic) await markOwner(playlistId)
      if (description === undefined && image === undefined) return
      const images = getImageApi(api)
      if (image) {
        // Jellyfin reads the body as base64 text (as jellyfin-web sends it).
        await images.setItemImage({ itemId: playlistId, imageType: 'Primary', body: (await coverBase64(image)) as unknown as File }, { headers: { 'Content-Type': 'image/jpeg' } })
      } else if (image === null) {
        await images.deleteItemImage({ itemId: playlistId, imageType: 'Primary' }).catch(() => undefined)
      }
      // The update replaces the whole item: start from the stored one and change only the description and the mark.
      const { data: item } = await getLibraryApi(api).getItem({ userId: session.userId, itemId: playlistId })
      const tags = (item.Tags ?? []).filter((tag) => tag !== CUSTOM_COVER_TAG)
      const custom = image ? true : image === null ? false : !!item.Tags?.includes(CUSTOM_COVER_TAG)
      await getItemUpdateApi(api).updateItem({
        itemId: playlistId,
        baseItemDto: { ...item, Name: name, Overview: description ?? item.Overview, Tags: custom ? [...tags, CUSTOM_COVER_TAG] : tags },
      })
    },
    onSuccess: (_, { playlistId }) => refresh(playlistId),
  })
  const move = useMutation({
    mutationFn: async ({ playlistId, entryId, index }: { playlistId: string; entryId: string; index: number }) =>
      playlists.moveItem({ playlistId, itemId: entryId, newIndex: index }),
    onSuccess: (_, { playlistId }) => refresh(playlistId),
  })
  /** Shares a playlist with someone who may then add, remove and reorder songs (a shared playlist), or stops it. */
  const share = useMutation({
    mutationFn: async ({ playlistId, userId, canEdit }: { playlistId: string; userId: string; canEdit: boolean }) => {
      if (canEdit) await playlists.updatePlaylistUser({ playlistId, userId, updatePlaylistUserDto: { CanEdit: true } })
      else await playlists.removeUserFromPlaylist({ playlistId, userId })
    },
    onSuccess: (_, { playlistId }) => {
      refresh(playlistId)
      void queryClient.invalidateQueries({ queryKey: ['playlist-infos'] })
      void queryClient.invalidateQueries({ queryKey: ['playlist-users', playlistId] })
    },
  })
  const destroy = useMutation({
    mutationFn: async (playlistId: string) => getLibraryApi(api).deleteItem({ itemId: playlistId }),
    onSuccess: () => refresh(),
  })
  return { create, add, remove, update, editDetails, move, destroy, share }
}

/**
 * What a user keeps in their Listen library beyond Jellyfin's own data: official playlists and others' public
 * playlists they saved, their folders, and what they pinned to the top. Stored per user in Jellyfin's display
 * preferences (a place every client may use).
 */
export interface LibraryFolder {
  id: string
  name: string
  /** Library entries in the folder (keys like `playlist:<id>`, `artist:<id>`), in order. */
  items: string[]
}

export interface ListenLibrary {
  /** Official playlist slugs and playlist ids, newest first. */
  saved: string[]
  folders: LibraryFolder[]
  /**
   * Entries pinned to the top of the library, in their order (keys as in folders, `folder:<id>`, or `liked` and
   * `episodes` for Liked Songs and Your Episodes, which start out pinned).
   */
  pinned: string[]
}

/** Liked Songs and Your Episodes start out pinned, as in Spotify; once the pins were saved, they are as the user left them. */
const DEFAULT_PINS = ['liked', 'episodes']

/** Where an entry goes: into a folder (or none), and pinned at a place among the pins, or not pinned. */
export interface LibraryPlace {
  folderId: string | null
  /** Its index among the pins (counted without the entry itself), or null for not pinned. */
  pinAt: number | null
  /** Its place in the folder (counted without the entry itself); at the end when left out. */
  folderAt?: number
}

/** Where Listen keeps the user's library (and podcast progress): a display-preferences record of its own. */
export const PREFS_ID = 'lumio-listen'
export const CLIENT = 'lumio'

const EMPTY_LIBRARY: ListenLibrary = { saved: [], folders: [], pinned: DEFAULT_PINS }

/** Adds entries (`podcast:<id>` …) to the saved ones, newest first, outside React (an import). */
export async function addToListenLibrary(api: Api, userId: string, ids: string[]) {
  const prefs = getDisplayPreferenceApi(api)
  const { data } = await prefs.getDisplayPreferences({ displayPreferencesId: PREFS_ID, userId, client: CLIENT })
  const saved = data.CustomPrefs?.saved ? (JSON.parse(data.CustomPrefs.saved) as string[]) : []
  const added = ids.filter((id) => !saved.includes(id))
  if (!added.length) return
  await prefs.updateDisplayPreferences({
    displayPreferencesId: PREFS_ID,
    userId,
    client: CLIENT,
    displayPreferencesDto: { ...data, CustomPrefs: { ...data.CustomPrefs, saved: JSON.stringify([...added, ...saved]) } },
  })
}

export function useListenLibrary() {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const key = ['listen-library', session.userId]
  const query = useQuery({
    queryKey: key,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ListenLibrary> => {
      try {
        const { data } = await getDisplayPreferenceApi(api).getDisplayPreferences({ displayPreferencesId: PREFS_ID, userId: session.userId, client: CLIENT })
        const read = <T,>(name: string, fallback: T) => (data.CustomPrefs?.[name] ? (JSON.parse(data.CustomPrefs[name]!) as T) : fallback)
        const pinned = read<string[]>('pinned', [])
        return { saved: read('saved', []), folders: read('folders', []), pinned: data.CustomPrefs?.pinsSet ? pinned : [...DEFAULT_PINS, ...pinned] }
      } catch {
        return EMPTY_LIBRARY
      }
    },
  })
  const save = useMutation({
    mutationFn: async (next: ListenLibrary) => {
      const prefs = getDisplayPreferenceApi(api)
      // The endpoint replaces the whole record: start from what is stored.
      const { data } = await prefs.getDisplayPreferences({ displayPreferencesId: PREFS_ID, userId: session.userId, client: CLIENT })
      await prefs.updateDisplayPreferences({
        displayPreferencesId: PREFS_ID,
        userId: session.userId,
        client: CLIENT,
        displayPreferencesDto: {
          ...data,
          CustomPrefs: {
            ...data.CustomPrefs,
            saved: JSON.stringify(next.saved),
            folders: JSON.stringify(next.folders),
            pinned: JSON.stringify(next.pinned),
            pinsSet: '1',
          },
        },
      })
      return next
    },
    onMutate: (next) => queryClient.setQueryData(key, next),
    onError: () => void queryClient.invalidateQueries({ queryKey: key }),
  })
  const current = query.data ?? EMPTY_LIBRARY
  const { saved, folders, pinned } = current
  const update = (patch: Partial<ListenLibrary>) => save.mutate({ ...current, ...patch })
  return {
    saved,
    folders,
    pinned,
    isSaved: (id: string) => saved.includes(id),
    toggle: (id: string) => update({ saved: saved.includes(id) ? saved.filter((entry) => entry !== id) : [id, ...saved] }),
    isPinned: (entry: string) => pinned.includes(entry),
    togglePin: (entry: string) => update({ pinned: pinned.includes(entry) ? pinned.filter((item) => item !== entry) : [entry, ...pinned] }),
    /** Creates a folder (optionally with a first entry in it) and returns its id. */
    createFolder: (name: string, first?: string) => {
      const id = crypto.randomUUID().slice(0, 8)
      update({ folders: [...folders.map((folder) => ({ ...folder, items: folder.items.filter((item) => item !== first) })), { id, name, items: first ? [first] : [] }] })
      return id
    },
    renameFolder: (id: string, name: string) => update({ folders: folders.map((folder) => (folder.id === id ? { ...folder, name } : folder)) }),
    /** Deletes a folder; what was in it goes back to the library. */
    deleteFolder: (id: string) => update({ folders: folders.filter((folder) => folder.id !== id), pinned: pinned.filter((item) => item !== `folder:${id}`) }),
    /** Moves an entry into a folder, or out of all folders (null). */
    moveToFolder: (entry: string, folderId: string | null) =>
      update({
        folders: folders.map((folder) => ({
          ...folder,
          items: folder.id === folderId ? [...folder.items.filter((item) => item !== entry), entry] : folder.items.filter((item) => item !== entry),
        })),
      }),
    folderOf: (entry: string) => folders.find((folder) => folder.items.includes(entry))?.id ?? null,
    /** Moves an entry (dragged in the library) into or out of a folder and onto or off the pins in one go. */
    place: (entry: string, { folderId, pinAt, folderAt }: LibraryPlace) => {
      const rest = pinned.filter((item) => item !== entry)
      update({
        folders: folders.map((folder) => {
          const others = folder.items.filter((item) => item !== entry)
          if (folder.id !== folderId) return { ...folder, items: others }
          const at = folderAt ?? others.length
          return { ...folder, items: [...others.slice(0, at), entry, ...others.slice(at)] }
        }),
        pinned: pinAt === null ? rest : [...rest.slice(0, pinAt), entry, ...rest.slice(pinAt)],
      })
    },
  }
}

/** The first few distinct album covers of a list of tracks, for a playlist's mosaic. */
export function mosaicSources(tracks: BaseItemDto[], count = 4) {
  const seen = new Set<string>()
  const sources: BaseItemDto[] = []
  for (const track of tracks) {
    const key = track.AlbumId ?? track.Id ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(track)
    if (sources.length === count) break
  }
  return sources
}
