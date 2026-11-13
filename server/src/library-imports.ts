/**
 * What someone brought over from another service's library (Spotify): liked songs, saved albums, followed artists and
 * playlists. The app finds what it can in Jellyfin and makes it real there (favourites, playlists); everything is kept
 * here too, so what Jellyfin doesn't have yet waits (greyed out in the app) until it arrives or is removed, and the
 * administrators can see what people are missing (the wishlist).
 */
export const LIBRARY_KINDS = ['track', 'album', 'artist', 'playlist'] as const
export type LibraryKind = (typeof LIBRARY_KINDS)[number]

export interface PlaylistEntry {
  /** The service's id of the song, when it has one. */
  uri?: string
  title: string
  artist?: string
  album?: string
  /** The library's song, once found. */
  id?: string
}

export interface LibraryImportData {
  /** A song's or album's title, an artist's or playlist's name. */
  title: string
  artist?: string
  album?: string
  /** A playlist's Jellyfin playlist and its songs, in the service's order. */
  playlistId?: string
  entries?: PlaylistEntry[]
}

export interface LibraryImport {
  kind: LibraryKind
  /** The service's id (a Spotify URI; a playlist's name, which the export gives instead). */
  extId: string
  data: LibraryImportData
  /** The library's item, once found (a playlist: once all its songs are). */
  matchedId: string | null
  at: number
}

/** Most entries in one part of an import, and songs in one playlist. */
export const LIBRARY_BATCH = 2000
export const PLAYLIST_MAX = 10_000

const text = (value: unknown, max = 300) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)
const itemId = (value: unknown) => (typeof value === 'string' && /^[0-9a-f-]{32,36}$/i.test(value) ? value : undefined)

/** An entry as sent by the app, checked and trimmed; null when it isn't one. */
export function validLibraryImport(raw: unknown): Omit<LibraryImport, 'at'> | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const kind = LIBRARY_KINDS.find((entry) => entry === value.kind)
  const extId = text(value.extId, 300)
  const data = value.data as Record<string, unknown> | undefined
  const title = text(data?.title)
  if (!kind || !extId || !title) return null
  const clean: LibraryImportData = { title, artist: text(data?.artist), album: text(data?.album) }
  if (kind === 'playlist') {
    clean.playlistId = itemId(data?.playlistId)
    if (!Array.isArray(data?.entries)) return null
    clean.entries = (data.entries as unknown[]).slice(0, PLAYLIST_MAX).flatMap((entry) => {
      const song = entry as Record<string, unknown> | null
      const songTitle = text(song?.title)
      return songTitle ? [{ uri: text(song?.uri, 100), title: songTitle, artist: text(song?.artist), album: text(song?.album), id: itemId(song?.id) }] : []
    })
  }
  return { kind, extId, data: clean, matchedId: itemId(value.matchedId) ?? null }
}

// ---- the wishlist ----

const loose = (value: string) =>
  value
    .toLocaleLowerCase('en')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export interface WishlistEntry {
  title: string
  artist?: string
  /** How many people are missing it. */
  people: number
  /** For albums and artists: how many of their songs are missing (liked or in playlists). */
  songs: number
}

export interface Wishlist {
  albums: WishlistEntry[]
  artists: WishlistEntry[]
  tracks: WishlistEntry[]
  /** How many people wait for anything. */
  people: number
}

/**
 * What the people's imports miss in Jellyfin, most wanted first: albums (saved ones, and the albums of missing
 * songs), artists (followed ones, and the artists of everything missing) and songs.
 */
export function wishlist(rows: Array<LibraryImport & { userId: string }>, limit = 100): Wishlist {
  type Tally = { title: string; artist?: string; people: Set<string>; songs: Set<string> }
  const tally = (map: Map<string, Tally>, key: string, title: string, artist: string | undefined, userId: string, song?: string) => {
    if (!key.replace(/\|/g, '').trim()) return
    const entry = map.get(key) ?? { title, artist, people: new Set<string>(), songs: new Set<string>() }
    entry.people.add(userId)
    if (song) entry.songs.add(song)
    map.set(key, entry)
  }
  const albums = new Map<string, Tally>()
  const artists = new Map<string, Tally>()
  const tracks = new Map<string, Tally>()
  const people = new Set<string>()
  const song = (userId: string, title: string, artist?: string, album?: string) => {
    const key = `${loose(artist ?? '')}|${loose(title)}`
    tally(tracks, key, title, artist, userId, key)
    if (album) tally(albums, `${loose(artist ?? '')}|${loose(album)}`, album, artist, userId, key)
    if (artist) tally(artists, loose(artist), artist, undefined, userId, key)
    people.add(userId)
  }
  for (const row of rows) {
    if (row.kind === 'playlist') {
      for (const entry of row.data.entries ?? []) if (!entry.id) song(row.userId, entry.title, entry.artist, entry.album)
      continue
    }
    if (row.matchedId) continue
    people.add(row.userId)
    if (row.kind === 'track') song(row.userId, row.data.title, row.data.artist, row.data.album)
    else if (row.kind === 'album') {
      tally(albums, `${loose(row.data.artist ?? '')}|${loose(row.data.title)}`, row.data.title, row.data.artist, row.userId)
      if (row.data.artist) tally(artists, loose(row.data.artist), row.data.artist, undefined, row.userId)
    } else tally(artists, loose(row.data.title), row.data.title, undefined, row.userId)
  }
  const top = (map: Map<string, Tally>) =>
    [...map.values()]
      .map((entry) => ({ title: entry.title, artist: entry.artist, people: entry.people.size, songs: entry.songs.size }))
      .sort((a, b) => b.people - a.people || b.songs - a.songs || a.title.localeCompare(b.title))
      .slice(0, limit)
  return { albums: top(albums), artists: top(artists), tracks: top(tracks), people: people.size }
}
