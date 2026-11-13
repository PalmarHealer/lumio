import type { Api } from '@jellyfin/sdk'
import { BaseItemKind, ItemFields, ItemSortBy, MediaType, SortOrder, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getArtistApi } from '@jellyfin/sdk/lib/utils/api/artist-api'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api'
import { getUserDataApi } from '@jellyfin/sdk/lib/utils/api/user-data-api'
import type { QueryClient } from '@tanstack/react-query'
import { lumioSend, type LumioFetch } from '@/features/social/social'
import { zipEntries } from '@/lib/zip'
import { addToListenLibrary } from './playlists'
import { isEpisodeSaved, podcastOptions, searchPodcasts, toggleSavedEpisode, type Episode, type Podcast } from './podcasts'
import { librarySongs, looseName, songFinder, type ImportStep, type LibraryItem } from './spotify-import'

/**
 * Bringing someone's Spotify library over (the account data export: YourLibrary.json and Playlist*.json): liked songs,
 * saved albums, followed artists, playlists, followed podcasts and saved episodes.
 * - What Jellyfin has becomes real at once: favourites (songs, albums, artists), Jellyfin playlists with the songs found,
 *   podcasts followed and episodes saved (they come from iTunes, not Jellyfin).
 * - Everything from the library is kept on the Lumio server too (GET /me/library-imports/spotify), so what Jellyfin
 *   doesn't have yet waits: greyed out in the library and in its playlists, until it arrives (it is then made real and
 *   put in its place, see rematchLibraryImports) or is removed. The administrators see what people miss (the wishlist).
 */
export interface ExportSong {
  uri?: string
  title: string
  artist?: string
  album?: string
}

export interface SpotifyLibrary {
  tracks: ExportSong[]
  albums: Array<{ uri: string; title: string; artist?: string }>
  artists: Array<{ uri: string; name: string }>
  playlists: Array<{ name: string; entries: ExportSong[] }>
  shows: Array<{ uri: string; name: string; publisher?: string }>
  episodes: Array<{ uri: string; name: string; show: string }>
}

export type LibraryKind = 'track' | 'album' | 'artist' | 'playlist'

export interface PlaylistEntry extends ExportSong {
  /** The library's song, once found. */
  id?: string
}

/** An entry as the Lumio server keeps it. */
export interface LibraryImportRow {
  kind: LibraryKind
  /** Spotify's URI (a playlist: its name, which the export gives instead). */
  extId: string
  data: { title: string; artist?: string; album?: string; playlistId?: string; entries?: PlaylistEntry[] }
  /** The library's item once found (a playlist: once all its songs are). */
  matchedId: string | null
  at?: number
}

const SOURCE = 'spotify'
const ENDPOINT = `/me/library-imports/${SOURCE}`
/** Entries per request (the server takes 2000; playlists are big). */
const BATCH = 200
/** Jellyfin calls at once (favourites, playlist moves). */
const PARALLEL = 6

// ---- reading the export ----

interface RawLibrary {
  tracks?: Array<{ artist?: string; album?: string; track?: string; uri?: string }>
  albums?: Array<{ artist?: string; album?: string; uri?: string }>
  artists?: Array<{ name?: string; uri?: string }>
  shows?: Array<{ name?: string; publisher?: string; uri?: string }>
  episodes?: Array<{ name?: string; show?: string; uri?: string }>
}

interface RawPlaylists {
  playlists?: Array<{ name?: string; items?: Array<{ track?: { trackName?: string; artistName?: string; albumName?: string; trackUri?: string } | null }> }>
}

/** Reads the library out of the chosen files (the account data zip, or its YourLibrary.json and Playlist*.json). */
export async function readSpotifyLibrary(files: File[]): Promise<SpotifyLibrary> {
  const sources: Array<{ name: string; read: () => Promise<string> }> = []
  const text = new TextDecoder()
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      for (const entry of await zipEntries(file)) if (/\.json$/i.test(entry.name)) sources.push({ name: entry.name, read: async () => text.decode(await entry.read()) })
    } else sources.push({ name: file.name, read: () => file.text() })
  }
  const base = (name: string) => name.split('/').pop() ?? name
  const library: SpotifyLibrary = { tracks: [], albums: [], artists: [], playlists: [], shows: [], episodes: [] }
  const libraryFile = sources.find(({ name }) => /^YourLibrary\.json$/i.test(base(name)))
  const playlistFiles = sources.filter(({ name }) => /^Playlist\d*\.json$/i.test(base(name)))
  if (!libraryFile && !playlistFiles.length) throw new Error('no-library')
  const clean = (value: string | undefined) => value?.trim() || undefined
  if (libraryFile) {
    const raw = JSON.parse(await libraryFile.read()) as RawLibrary
    for (const track of raw.tracks ?? []) if (clean(track.track)) library.tracks.push({ uri: track.uri, title: track.track!.trim(), artist: clean(track.artist), album: clean(track.album) })
    for (const album of raw.albums ?? []) if (clean(album.album) && album.uri) library.albums.push({ uri: album.uri, title: album.album!.trim(), artist: clean(album.artist) })
    for (const artist of raw.artists ?? []) if (clean(artist.name) && artist.uri) library.artists.push({ uri: artist.uri, name: artist.name!.trim() })
    for (const show of raw.shows ?? []) if (clean(show.name) && show.uri) library.shows.push({ uri: show.uri, name: show.name!.trim(), publisher: clean(show.publisher) })
    for (const episode of raw.episodes ?? []) if (clean(episode.name) && clean(episode.show) && episode.uri) library.episodes.push({ uri: episode.uri, name: episode.name!.trim(), show: episode.show!.trim() })
  }
  for (const file of playlistFiles) {
    const raw = JSON.parse(await file.read()) as RawPlaylists
    for (const playlist of raw.playlists ?? []) {
      const name = clean(playlist.name)
      // Episodes and local files in playlists are left out; empty playlists too.
      const entries = (playlist.items ?? []).flatMap((item) => {
        const track = item.track
        return track && clean(track.trackName) ? [{ uri: track.trackUri, title: track.trackName!.trim(), artist: clean(track.artistName), album: clean(track.albumName) }] : []
      })
      if (name && entries.length) library.playlists.push({ name, entries })
    }
  }
  return library
}

// ---- finding it in Jellyfin ----

type Find = (title: string, artist?: string, album?: string) => string | undefined

interface Finders {
  song: Find
  album: Find
  artist: (name: string) => string | undefined
}

const ALBUM_FIELDS = { fields: [ItemFields.DateCreated], enableImages: false, enableUserData: false }

/** Finders over the given songs, albums and artists (the whole library, or what is new in it). */
function finders(songs: LibraryItem[], albums: BaseItemDto[], artists: BaseItemDto[]): Finders {
  const findSong = songFinder(songs)
  const albumsByName = new Map<string, Array<{ id: string; artists: Set<string> }>>()
  for (const album of albums) {
    if (!album.Id || !album.Name) continue
    const entry = { id: album.Id, artists: new Set([album.AlbumArtist ?? '', ...(album.AlbumArtists ?? []).map((artist) => artist.Name ?? ''), ...(album.Artists ?? [])].filter(Boolean).map((name) => looseName(name))) }
    for (const key of new Set([looseName(album.Name), looseName(album.Name, true)])) albumsByName.set(key, [...(albumsByName.get(key) ?? []), entry])
  }
  const artistsByName = new Map<string, string>()
  for (const artist of artists) if (artist.Id && artist.Name) artistsByName.set(looseName(artist.Name), artist.Id)
  return {
    song: (title, artist) => (artist ? findSong(title, artist)?.id : undefined),
    album: (title, artist) => {
      const candidates = albumsByName.get(looseName(title)) ?? albumsByName.get(looseName(title, true)) ?? []
      const wanted = artist ? looseName(artist) : ''
      return (candidates.find((candidate) => !wanted || candidate.artists.has(wanted)) ?? (wanted ? undefined : candidates[0]))?.id
    },
    artist: (name) => artistsByName.get(looseName(name)),
  }
}

async function libraryFinders(api: Api, userId: string, onStep: (step: ImportStep) => void) {
  const [songs, albums, artists] = await Promise.all([
    librarySongs(api, userId, onStep),
    getLibraryApi(api)
      .getItems({ userId, recursive: true, includeItemTypes: [BaseItemKind.MusicAlbum], ...ALBUM_FIELDS })
      .then(({ data }) => data.Items ?? []),
    getArtistApi(api)
      .getArtists({ userId, enableImages: false, enableUserData: false })
      .then(({ data }) => data.Items ?? []),
  ])
  return finders(songs, albums, artists)
}

/** What an import would bring: for each kind what Jellyfin has (with its item) and what it doesn't. */
export interface LibraryPlan {
  tracks: Array<ExportSong & { id?: string }>
  albums: Array<SpotifyLibrary['albums'][number] & { id?: string }>
  artists: Array<SpotifyLibrary['artists'][number] & { id?: string }>
  playlists: Array<{ name: string; entries: PlaylistEntry[] }>
  shows: Array<SpotifyLibrary['shows'][number] & { podcast?: Podcast }>
  episodes: Array<SpotifyLibrary['episodes'][number] & { episode?: Episode }>
}

export type LibraryPart = 'tracks' | 'albums' | 'artists' | 'playlists' | 'podcasts'

export type LibraryStep = ImportStep | { step: 'podcasts'; done: number; total: number } | { step: 'saving'; done: number; total: number }

/** A show found by its name (and publisher, when iTunes lists more than one by that name). */
async function findShow(show: SpotifyLibrary['shows'][number]) {
  const results = await searchPodcasts(show.name, 10).catch(() => [] as Podcast[])
  const named = results.filter((podcast) => looseName(podcast.name) === looseName(show.name))
  const publisher = show.publisher ? looseName(show.publisher) : ''
  return named.find((podcast) => publisher && looseName(podcast.author).includes(publisher)) ?? named[0]
}

/** Finds the export's library in Jellyfin (and its podcasts at iTunes), for the preview. */
export async function planLibraryImport(api: Api, userId: string, library: SpotifyLibrary, onStep: (step: LibraryStep) => void): Promise<LibraryPlan> {
  const find = await libraryFinders(api, userId, onStep)
  const plan: LibraryPlan = {
    tracks: library.tracks.map((song) => ({ ...song, id: find.song(song.title, song.artist, song.album) })),
    albums: library.albums.map((album) => ({ ...album, id: find.album(album.title, album.artist) })),
    artists: library.artists.map((artist) => ({ ...artist, id: find.artist(artist.name) })),
    playlists: library.playlists.map((playlist) => ({ name: playlist.name, entries: playlist.entries.map((song) => ({ ...song, id: find.song(song.title, song.artist, song.album) })) })),
    shows: [],
    episodes: [],
  }
  // Podcasts: each show at iTunes, then its saved episodes among its latest.
  const showNames = [...new Set([...library.shows.map((show) => show.name), ...library.episodes.map((episode) => episode.show)])]
  const found = new Map<string, Podcast | undefined>()
  for (const [index, name] of showNames.entries()) {
    onStep({ step: 'podcasts', done: index, total: showNames.length })
    found.set(name, await findShow(library.shows.find((show) => show.name === name) ?? { uri: '', name }))
  }
  plan.shows = library.shows.map((show) => ({ ...show, podcast: found.get(show.name) }))
  const episodesOf = new Map<string, Episode[]>()
  for (const episode of library.episodes) {
    const podcast = found.get(episode.show)
    if (podcast && !episodesOf.has(podcast.id)) episodesOf.set(podcast.id, (await podcastOptions(podcast.id).queryFn().catch(() => null))?.episodes ?? [])
    const match = podcast ? episodesOf.get(podcast.id)?.find((candidate) => looseName(candidate.title) === looseName(episode.name)) : undefined
    plan.episodes.push({ ...episode, episode: match })
  }
  onStep({ step: 'podcasts', done: showNames.length, total: showNames.length })
  return plan
}

// ---- importing ----

/** Runs jobs a few at a time. */
async function inParallel<T>(items: T[], job: (item: T) => Promise<unknown>, onDone?: (done: number) => void) {
  let next = 0
  let done = 0
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!
        await job(item).catch(() => undefined)
        onDone?.(++done)
      }
    }),
  )
}

export async function libraryImports(request: LumioFetch): Promise<LibraryImportRow[]> {
  const response = await request(ENDPOINT)
  if (!response.ok) throw new Error('Lumio server unavailable')
  return ((await response.json()) as { items: LibraryImportRow[] }).items
}

async function saveRows(request: LumioFetch, rows: LibraryImportRow[]) {
  for (let start = 0; start < rows.length; start += BATCH) {
    const response = await request(ENDPOINT, { method: 'POST', body: JSON.stringify({ items: rows.slice(start, start + BATCH) }) })
    if (!response.ok) throw new Error('upload')
  }
}

/** Forgets one entry (a greyed-out one removed), or the whole import. */
export async function removeLibraryImport(request: LumioFetch, entry?: { kind: LibraryKind; extId: string }) {
  const query = entry ? `?${new URLSearchParams({ kind: entry.kind, id: entry.extId })}` : ''
  const response = await request(`${ENDPOINT}${query}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Lumio server unavailable')
}

const favourite = (api: Api, userId: string, itemId: string) => getUserDataApi(api).markFavoriteItem({ userId, itemId })

/** A Jellyfin playlist with the songs found so far (the rest are placed when they arrive). */
async function createPlaylist(api: Api, userId: string, name: string, ids: string[]) {
  const playlists = getPlaylistApi(api)
  const id = (await playlists.createPlaylist({ createPlaylistDto: { Name: name, Ids: ids, UserId: userId, MediaType: MediaType.Audio, IsPublic: false } })).data.Id!
  // As the app's own playlists: the creator among its editors (see usePlaylistActions), who added the songs.
  await playlists.updatePlaylistUser({ playlistId: id, userId, updatePlaylistUserDto: { CanEdit: true } }).catch(() => undefined)
  for (let start = 0; start < ids.length; start += 300) await lumioSend('POST', '/playlists/adds', { playlistId: id, itemIds: ids.slice(start, start + 300) }).catch(() => undefined)
  return id
}

export interface LibraryImportResult {
  found: number
  waiting: number
  playlists: number
}

/**
 * Brings the chosen parts of a plan in: favourites, playlists, podcasts; and keeps every entry on the Lumio server. A
 * playlist imported before (by its name) isn't made again.
 */
export async function importLibrary(api: Api, userId: string, request: LumioFetch, plan: LibraryPlan, parts: Set<LibraryPart>, onStep: (step: LibraryStep) => void): Promise<LibraryImportResult> {
  const rows: LibraryImportRow[] = []
  const favourites: string[] = []
  const result: LibraryImportResult = { found: 0, waiting: 0, playlists: 0 }
  const keep = (kind: LibraryKind, extId: string | undefined, data: LibraryImportRow['data'], id: string | undefined) => {
    if (!extId) return
    rows.push({ kind, extId, data, matchedId: id ?? null })
    if (id) favourites.push(id)
    result[id ? 'found' : 'waiting'] += 1
  }
  if (parts.has('tracks')) for (const song of plan.tracks) keep('track', song.uri ?? `${song.artist ?? ''}|${song.title}`, { title: song.title, artist: song.artist, album: song.album }, song.id)
  if (parts.has('albums')) for (const album of plan.albums) keep('album', album.uri, { title: album.title, artist: album.artist }, album.id)
  if (parts.has('artists')) for (const artist of plan.artists) keep('artist', artist.uri, { title: artist.name }, artist.id)

  onStep({ step: 'saving', done: 0, total: favourites.length })
  await inParallel(favourites, (id) => favourite(api, userId, id), (done) => onStep({ step: 'saving', done, total: favourites.length }))

  if (parts.has('playlists')) {
    const before = new Map((await libraryImports(request).catch(() => [] as LibraryImportRow[])).filter((row) => row.kind === 'playlist').map((row) => [row.extId, row]))
    for (const playlist of plan.playlists) {
      const ids = playlist.entries.flatMap((entry) => (entry.id ? [entry.id] : []))
      result.found += ids.length
      result.waiting += playlist.entries.length - ids.length
      const old = before.get(playlist.name)
      if (old?.data.playlistId) continue
      const playlistId = await createPlaylist(api, userId, playlist.name, ids).catch(() => undefined)
      if (!playlistId) continue
      result.playlists += 1
      rows.push({ kind: 'playlist', extId: playlist.name, data: { title: playlist.name, playlistId, entries: playlist.entries }, matchedId: ids.length === playlist.entries.length ? playlistId : null })
    }
  }

  if (parts.has('podcasts')) {
    const shows = plan.shows.flatMap((show) => (show.podcast ? [`podcast:${show.podcast.id}`] : []))
    if (shows.length) await addToListenLibrary(api, userId, shows).catch(() => undefined)
    for (const { episode } of plan.episodes) if (episode && !isEpisodeSaved(episode.guid)) toggleSavedEpisode(episode.item)
  }

  await saveRows(request, rows)
  return result
}

// ---- when Jellyfin gets what was missing ----

/** What still waits: entries not found, and playlists with songs not found. */
export function waitingRows(rows: LibraryImportRow[]) {
  return rows.filter((row) => (row.kind === 'playlist' ? row.data.entries?.some((entry) => !entry.id) : !row.matchedId))
}

/** Where a playlist's waiting song stands among its songs: after the songs before it in Spotify's order that are there. */
export function placeInPlaylist(entries: PlaylistEntry[], index: number, present: ReadonlySet<string>) {
  let at = 0
  for (const entry of entries.slice(0, index)) if (entry.id && present.has(entry.id)) at += 1
  return at
}

/**
 * Looks for the waiting entries again (in the whole library, or among items new in it) and makes the found ones real:
 * favourites, and songs added to their playlists in their place. Returns how many were found.
 */
export async function rematchLibraryImports(api: Api, userId: string, request: LumioFetch, newItems?: BaseItemDto[]) {
  const rows = waitingRows(await libraryImports(request))
  if (!rows.length) return 0
  const find = newItems
    ? finders(
        newItems.filter((item) => item.Type === 'Audio'),
        newItems.filter((item) => item.Type === 'MusicAlbum'),
        newItems.filter((item) => item.Type === 'MusicArtist'),
      )
    : await libraryFinders(api, userId, () => undefined)
  const changed: LibraryImportRow[] = []
  const favourites: string[] = []
  let found = 0
  for (const row of rows) {
    if (row.kind === 'playlist') continue
    const id = row.kind === 'track' ? find.song(row.data.title, row.data.artist, row.data.album) : row.kind === 'album' ? find.album(row.data.title, row.data.artist) : find.artist(row.data.title)
    if (!id) continue
    favourites.push(id)
    changed.push({ ...row, matchedId: id })
  }
  await inParallel(favourites, (id) => favourite(api, userId, id))
  found += favourites.length

  const playlists = getPlaylistApi(api)
  for (const row of rows) {
    if (row.kind !== 'playlist' || !row.data.playlistId || !row.data.entries) continue
    const playlistId = row.data.playlistId
    const entries = row.data.entries.map((entry) => ({ ...entry }))
    const arrived = entries.flatMap((entry, index) => {
      if (entry.id || !entry.artist) return []
      const id = find.song(entry.title, entry.artist, entry.album)
      return id ? [{ index, id }] : []
    })
    if (!arrived.length) continue
    // A playlist deleted in the meantime: its waiting songs go with it.
    const current = await playlists.getPlaylistItems({ playlistId, userId }).catch(() => null)
    if (!current) {
      await removeLibraryImport(request, { kind: 'playlist', extId: row.extId }).catch(() => undefined)
      continue
    }
    await playlists.addItemToPlaylist({ playlistId, ids: arrived.map((song) => song.id), userId })
    void lumioSend('POST', '/playlists/adds', { playlistId, itemIds: arrived.map((song) => song.id) }).catch(() => undefined)
    // They land at the end; each is moved to its place, in Spotify's order.
    const present = new Set((current.data.Items ?? []).map((item) => item.Id!))
    const added = ((await playlists.getPlaylistItems({ playlistId, userId })).data.Items ?? []).slice(-arrived.length)
    // A song in the playlist twice arrives twice: each copy is moved once.
    const moved = new Set<string>()
    for (const song of arrived) {
      entries[song.index]!.id = song.id
      const entryId = added.find((item) => item.Id === song.id && !moved.has(item.PlaylistItemId ?? ''))?.PlaylistItemId
      if (entryId) moved.add(entryId)
      if (entryId) await playlists.moveItem({ playlistId, itemId: entryId, newIndex: placeInPlaylist(entries, song.index, present) }).catch(() => undefined)
      present.add(song.id)
    }
    found += arrived.length
    changed.push({ ...row, data: { ...row.data, entries }, matchedId: entries.every((entry) => entry.id) ? playlistId : null })
  }
  if (changed.length) await saveRows(request, changed)
  return found
}

/** Items Jellyfin got since a moment (songs, albums, artists), newest first. */
export async function newLibraryItems(api: Api, userId: string, since: number) {
  const { data } = await getLibraryApi(api).getItems({
    userId,
    recursive: true,
    includeItemTypes: [BaseItemKind.Audio, BaseItemKind.MusicAlbum, BaseItemKind.MusicArtist],
    sortBy: [ItemSortBy.DateCreated],
    sortOrder: [SortOrder.Descending],
    fields: [ItemFields.DateCreated],
    enableImages: false,
    enableUserData: false,
    limit: 500,
  })
  return (data.Items ?? []).filter((item) => (Date.parse(item.DateCreated ?? '') || 0) > since)
}

/** The queries showing what an import changed. */
export function refreshAfterImport(queryClient: QueryClient, userId: string) {
  for (const key of ['library-imports', 'liked-songs', 'saved-albums', 'followed-artists', 'favorites', 'playlists', 'playlist-tracks', 'listen-library'])
    void queryClient.invalidateQueries({ queryKey: [key, userId] })
  void queryClient.invalidateQueries({ queryKey: ['playlist-tracks'] })
}
