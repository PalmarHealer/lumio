import type { Api } from '@jellyfin/sdk'
import { BaseItemKind, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import type { LumioFetch } from '@/features/social/social'
import { zipEntries } from '@/lib/zip'

/**
 * Bringing someone's Spotify listening history into their Lumio history (for Wrapped). Spotify's privacy export comes
 * as a zip, or as its JSON files: the extended streaming history (Streaming_History_Audio_*.json, every play since the
 * account began) or the account data's last year (StreamingHistory_music_*.json, StreamingHistory_podcast_*.json).
 * The files are read here, in the browser; only the plays go to the Lumio server: when, how long, what (the song as
 * found in the library, else its name), how it started and ended. No addresses, countries or devices. Private sessions
 * stay out, as in Spotify's own Wrapped.
 */
export interface ImportPlay {
  /** The play itself (its time and track): imported again, it is the same play. */
  id: string
  kind: 'audio' | 'podcast'
  /** The library's song when found, else Spotify's URI (or the name, for the older files). */
  key: string
  title: string
  subtitle?: string
  artist?: string
  album?: string
  contextId?: string
  client: string
  startedAt: number
  seconds: number
  reasonStart?: string
  reasonEnd?: string
  shuffle?: boolean
  offline?: boolean
}

export type ImportStep =
  | { step: 'reading'; done: number; total: number }
  | { step: 'library'; done: number; total: number }
  | { step: 'uploading'; done: number; total: number }

export interface ImportResult {
  plays: number
  matched: number
  first: number | null
  last: number | null
}

export interface ImportSummary {
  count: number
  matched: number
  first: number | null
  last: number | null
}

/** Plays per request (the server takes up to 5000). */
const BATCH = 2000
/** Shorter plays than this are left out (a song only touched). */
const MIN_MS = 1000

interface ExtendedEntry {
  ts?: string
  ms_played?: number
  master_metadata_track_name?: string | null
  master_metadata_album_artist_name?: string | null
  master_metadata_album_album_name?: string | null
  spotify_track_uri?: string | null
  episode_name?: string | null
  episode_show_name?: string | null
  spotify_episode_uri?: string | null
  reason_start?: string | null
  reason_end?: string | null
  shuffle?: boolean | null
  offline?: boolean | null
  incognito_mode?: boolean | null
}

interface AccountEntry {
  endTime?: string
  msPlayed?: number
  artistName?: string
  trackName?: string
  podcastName?: string
  episodeName?: string
}

/**
 * A play's identity: the minute it ended, and what it was. Both of Spotify's export formats give these (the account
 * data only to the minute), so a newer export, or the other format, finds the plays already brought in.
 */
const playId = (end: number, by: string | null | undefined, title: string) => `${new Date(end).toISOString().slice(0, 16)}|${(by ?? '').toLowerCase()}|${title.toLowerCase()}`

/** Spotify's reasons, as the server keeps them (letters only). */
const reason = (value: string | null | undefined) => (value ? value.replace(/[^a-z]/g, '').slice(0, 20) || undefined : undefined)

function fromExtended(entry: ExtendedEntry): ImportPlay | null {
  const ms = Number(entry.ms_played)
  const end = Date.parse(entry.ts ?? '')
  if (entry.incognito_mode || !Number.isFinite(ms) || ms < MIN_MS || !Number.isFinite(end)) return null
  const common = {
    client: 'Spotify',
    startedAt: end - ms,
    seconds: Math.round(ms / 1000),
    reasonStart: reason(entry.reason_start),
    reasonEnd: reason(entry.reason_end),
    shuffle: typeof entry.shuffle === 'boolean' ? entry.shuffle : undefined,
    offline: typeof entry.offline === 'boolean' ? entry.offline : undefined,
  }
  if (entry.master_metadata_track_name && entry.spotify_track_uri) {
    return {
      ...common,
      id: playId(end, entry.master_metadata_album_artist_name, entry.master_metadata_track_name),
      kind: 'audio',
      key: entry.spotify_track_uri,
      title: entry.master_metadata_track_name,
      subtitle: entry.master_metadata_album_artist_name ?? undefined,
      artist: entry.master_metadata_album_artist_name ?? undefined,
      album: entry.master_metadata_album_album_name ?? undefined,
    }
  }
  if (entry.episode_name && entry.spotify_episode_uri) {
    return {
      ...common,
      id: playId(end, entry.episode_show_name, entry.episode_name),
      kind: 'podcast',
      key: entry.spotify_episode_uri,
      title: entry.episode_name,
      subtitle: entry.episode_show_name ?? undefined,
    }
  }
  // Audiobooks and videos stay out.
  return null
}

function fromAccount(entry: AccountEntry, podcast: boolean): ImportPlay | null {
  const ms = Number(entry.msPlayed)
  // "2024-03-01 18:22", in UTC.
  const end = Date.parse(`${(entry.endTime ?? '').replace(' ', 'T')}:00Z`)
  if (!Number.isFinite(ms) || ms < MIN_MS || !Number.isFinite(end)) return null
  const title = podcast ? entry.episodeName : entry.trackName
  const by = podcast ? entry.podcastName : entry.artistName
  if (!title) return null
  const key = `spotify:${podcast ? 'episode' : 'track'}:${by ?? ''}|${title}`.slice(0, 200)
  return {
    id: playId(end, by, title),
    kind: podcast ? 'podcast' : 'audio',
    key,
    title,
    subtitle: by,
    artist: podcast ? undefined : by,
    client: 'Spotify',
    startedAt: end - ms,
    seconds: Math.round(ms / 1000),
  }
}

/** Reads the plays out of the chosen files (zips, or Spotify's JSON files). */
export async function readSpotifyExport(files: File[], onStep: (step: ImportStep) => void): Promise<ImportPlay[]> {
  const sources: Array<{ name: string; read: () => Promise<string> }> = []
  const text = new TextDecoder()
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      for (const entry of await zipEntries(file)) {
        if (/\.json$/i.test(entry.name)) sources.push({ name: entry.name, read: async () => text.decode(await entry.read()) })
      }
    } else sources.push({ name: file.name, read: () => file.text() })
  }
  const wanted = sources.filter(({ name }) => /Streaming_?History/i.test(name) && !/Video/i.test(name))
  if (!wanted.length) throw new Error('no-history')
  const plays: ImportPlay[] = []
  for (const [index, source] of wanted.entries()) {
    onStep({ step: 'reading', done: index, total: wanted.length })
    const entries = JSON.parse(await source.read()) as unknown
    if (!Array.isArray(entries)) continue
    const base = source.name.split('/').pop() ?? source.name
    const account = /^StreamingHistory/i.test(base)
    const podcast = /podcast/i.test(base)
    for (const entry of entries) {
      const play = account ? fromAccount(entry as AccountEntry, podcast) : fromExtended(entry as ExtendedEntry)
      if (play) plays.push(play)
    }
  }
  onStep({ step: 'reading', done: wanted.length, total: wanted.length })
  return plays
}

/** A name as compared: no case, accents, features or remaster notes, only letters and digits. */
export function looseName(value: string, dropAllNotes = false) {
  let name = value.toLocaleLowerCase('en').normalize('NFKD').replace(/\p{M}/gu, '')
  name = name.replace(/\s*[([][^)\]]*\b(feat|ft|featuring|with)\b\.?[^)\]]*[)\]]/g, '')
  name = name.replace(/\s+-\s+[^-]*\b(remaster(ed)?|radio edit|single version|album version|mono|stereo)\b.*$/g, '')
  if (dropAllNotes) name = name.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '')
  return name
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

interface LibrarySong {
  id: string
  albumId?: string
  album: string
  artists: Set<string>
  /** Its title names another version (remix, live …): never found by the bare title. */
  version: boolean
}

/** The library's songs, as far as matching needs them. */
export type LibraryItem = Pick<BaseItemDto, 'Id' | 'Name' | 'Album' | 'AlbumId' | 'AlbumArtist' | 'Artists' | 'AlbumArtists'>

/** Every song in the library (fetched in pages). */
export async function librarySongs(api: Api, userId: string, onStep: (step: ImportStep) => void) {
  const items: LibraryItem[] = []
  const page = 5000
  let total = Infinity
  for (let start = 0; start < total; start += page) {
    const { data } = await getLibraryApi(api).getItems({
      userId,
      recursive: true,
      includeItemTypes: [BaseItemKind.Audio],
      enableImages: false,
      enableUserData: false,
      startIndex: start,
      limit: page,
    })
    total = data.TotalRecordCount ?? 0
    onStep({ step: 'library', done: Math.min(total, start + page), total })
    items.push(...(data.Items ?? []))
    if (!data.Items?.length) break
  }
  return items
}

/** The songs by their loose title (and by their title without any notes). */
function libraryIndex(items: LibraryItem[]) {
  const byTitle = new Map<string, LibrarySong[]>()
  const byBareTitle = new Map<string, LibrarySong[]>()
  for (const item of items) {
    if (!item.Id || !item.Name) continue
    const song: LibrarySong = {
      id: item.Id,
      albumId: item.AlbumId ?? undefined,
      album: looseName(item.Album ?? ''),
      version: otherVersion(item.Name),
      artists: new Set([...(item.Artists ?? []), ...(item.AlbumArtists?.map((artist) => artist.Name ?? '') ?? []), item.AlbumArtist ?? ''].filter(Boolean).map((name) => looseName(name))),
    }
    for (const [map, key] of [[byTitle, looseName(item.Name)], [byBareTitle, looseName(item.Name, true)]] as const) {
      const list = map.get(key)
      if (list) list.push(song)
      else map.set(key, [song])
    }
  }
  return { byTitle, byBareTitle }
}

/** Notes in a title that make it another recording than the plain title ("Monster - Robin Schulz Remix"). */
const VERSION = /\b(remix|rmx|mix|instrumental|live|acoustic|unplugged|karaoke|sped up|slowed|nightcore|cover|club edit|extended|vip|bootleg|rework|flip)\b/i

function otherVersion(title: string) {
  const notes = [...title.matchAll(/[([]([^)\]]*)[)\]]/g)].map((match) => match[1]).join(' ') + ' ' + (title.match(/\s+-\s+(.*)$/)?.[1] ?? '')
  return VERSION.test(notes)
}

/**
 * Finds songs in the library: the same title and artist, the same album if it can (a title without its notes, "Live",
 * "Remix" …, when the full one isn't there).
 */
export function songFinder(items: LibraryItem[]) {
  const library = libraryIndex(items)
  const found = new Map<string, LibrarySong | null>()
  return (title: string, artistName: string, albumName?: string) => {
    const cacheKey = `${title}|${artistName}|${albumName ?? ''}`
    let song = found.get(cacheKey)
    if (song === undefined) {
      const artist = looseName(artistName)
      const album = looseName(albumName ?? '')
      const pick = (candidates: LibrarySong[] | undefined) => {
        const byArtist = candidates?.filter((candidate) => candidate.artists.has(artist)) ?? []
        return byArtist.find((candidate) => candidate.album === album) ?? byArtist[0]
      }
      // Without its notes only when they don't name another version (a remix isn't the original).
      song = pick(library.byTitle.get(looseName(title))) ?? (otherVersion(title) ? undefined : pick(library.byBareTitle.get(looseName(title, true))?.filter((candidate) => !candidate.version))) ?? null
      found.set(cacheKey, song)
    }
    return song ? { id: song.id, albumId: song.albumId } : undefined
  }
}

/**
 * Points each song to the library's, when the library has it (same title and artist; the same album if it can).
 * Returns how many plays found their song.
 */
export function matchLibrary(plays: ImportPlay[], items: LibraryItem[]) {
  const find = songFinder(items)
  let matched = 0
  for (const play of plays) {
    if (play.kind !== 'audio' || !play.artist) continue
    const song = find(play.title, play.artist, play.album)
    if (!song) continue
    play.key = song.id
    play.contextId = song.albumId
    matched += 1
  }
  return matched
}

/** Reads, matches and hands in a Spotify export; importing the same export again adds nothing. */
export async function importSpotify(api: Api, userId: string, request: LumioFetch, files: File[], onStep: (step: ImportStep) => void): Promise<ImportResult> {
  const plays = await readSpotifyExport(files, onStep)
  if (!plays.length) throw new Error('no-history')
  const matched = matchLibrary(plays, await librarySongs(api, userId, onStep))
  for (let start = 0; start < plays.length; start += BATCH) {
    onStep({ step: 'uploading', done: start, total: plays.length })
    const response = await request('/me/imports/spotify', { method: 'POST', body: JSON.stringify({ plays: plays.slice(start, start + BATCH) }) })
    if (!response.ok) throw new Error('upload')
  }
  onStep({ step: 'uploading', done: plays.length, total: plays.length })
  let first = Infinity
  let last = -Infinity
  for (const play of plays) {
    first = Math.min(first, play.startedAt)
    last = Math.max(last, play.startedAt)
  }
  return { plays: plays.length, matched, first, last }
}

export async function spotifyImportSummary(request: LumioFetch): Promise<ImportSummary> {
  const response = await request('/me/imports/spotify')
  if (!response.ok) throw new Error('Lumio server unavailable')
  return (await response.json()) as ImportSummary
}

export async function removeSpotifyImport(request: LumioFetch) {
  const response = await request('/me/imports/spotify', { method: 'DELETE' })
  if (!response.ok) throw new Error('Lumio server unavailable')
}
