import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * Every song of a music library, as the mixes need them (see home-playlists.ts), kept in memory and on disk. Reading a
 * big library from Jellyfin takes minutes (111,000 songs: 137 MB of answers), so it is read in full once, then only
 * what changed since (Jellyfin's DateLastSaved), and in full again once a day to drop what was deleted.
 *
 * A library's songs are shared by everyone who may see it; a person whose account limits what they may see inside a
 * library (parental ratings, tags) gets a copy of their own, read with their own token.
 */
export interface ArtistRef {
  Id?: string
  Name?: string
}

export interface Track {
  Id: string
  Name?: string
  ServerId?: string
  Type?: string
  MediaType?: string
  IsFolder?: boolean
  AlbumId?: string
  Album?: string
  AlbumPrimaryImageTag?: string
  AlbumArtist?: string
  AlbumArtists?: ArtistRef[]
  ArtistItems?: ArtistRef[]
  Artists?: string[]
  Genres?: string[]
  DateCreated?: string
  PremiereDate?: string
  ProductionYear?: number
  RunTimeTicks?: number
  IndexNumber?: number
  ParentIndexNumber?: number
  ImageTags?: Record<string, string>
  HasLyrics?: boolean
  NormalizationGain?: number
  AlbumNormalizationGain?: number
}

/** What Jellyfin keeps per person and song. */
export interface UserData {
  PlayCount?: number
  IsFavorite?: boolean
  Played?: boolean
  LastPlayedDate?: string
}

interface Catalog {
  key: string
  library: string
  tracks: Map<string, Track>
  /** When it was last brought up to date, and last read in full. */
  at: number
  fullAt: number
}

/** How far a first read has come (for the app's "being prepared" note). */
export interface Progress {
  read: number
  total: number
}

const PAGE = 2000
/** Pages read at once on a full read (Jellyfin answers a page of 2000 songs in about 2.5 s). */
const PARALLEL = 4
/** Changes are looked for this often; the whole library is read again once a day. */
const UPDATE_EVERY = 10 * 60_000
const FULL_EVERY = 24 * 60 * 60_000
const FIELDS = 'Genres,DateCreated'

const KEPT: Array<keyof Track> = [
  'Id', 'Name', 'ServerId', 'Type', 'MediaType', 'IsFolder', 'AlbumId', 'Album', 'AlbumPrimaryImageTag', 'AlbumArtist', 'AlbumArtists', 'ArtistItems', 'Artists',
  'Genres', 'DateCreated', 'PremiereDate', 'ProductionYear', 'RunTimeTicks', 'IndexNumber', 'ParentIndexNumber', 'ImageTags', 'HasLyrics', 'NormalizationGain',
  'AlbumNormalizationGain',
]

/** The same names and ids over and over (a genre on 20,000 songs): kept once. */
const strings = new Map<string, string>()
const intern = (value: string) => {
  const kept = strings.get(value)
  if (kept !== undefined) return kept
  strings.set(value, value)
  return value
}
const internArtists = (list: ArtistRef[] | undefined) => list?.map((artist) => ({ Id: artist.Id ? intern(artist.Id) : undefined, Name: artist.Name ? intern(artist.Name) : undefined }))

/** A song with only what the mixes and the app's lists use (Jellyfin's blur hashes alone are a third of an answer). */
function lean(item: Record<string, unknown>): Track {
  const track: Record<string, unknown> = {}
  for (const key of KEPT) if (item[key] !== undefined && item[key] !== null) track[key] = item[key]
  const result = track as unknown as Track
  if (result.ServerId) result.ServerId = intern(result.ServerId)
  if (result.Album) result.Album = intern(result.Album)
  if (result.AlbumId) result.AlbumId = intern(result.AlbumId)
  if (result.AlbumArtist) result.AlbumArtist = intern(result.AlbumArtist)
  if (result.Genres) result.Genres = result.Genres.map(intern)
  if (result.Artists) result.Artists = result.Artists.map(intern)
  result.ArtistItems = internArtists(result.ArtistItems)
  result.AlbumArtists = internArtists(result.AlbumArtists)
  if (result.ImageTags) result.ImageTags = result.ImageTags.Primary ? { Primary: result.ImageTags.Primary } : undefined
  return result
}

export class MusicCatalog {
  private catalogs = new Map<string, Catalog>()
  private loading = new Map<string, Promise<Catalog>>()
  private updating = new Set<string>()
  private progress = new Map<string, Progress>()

  private jellyfinUrl: string
  private dir: string

  constructor(jellyfinUrl: string, dir: string) {
    this.jellyfinUrl = jellyfinUrl
    this.dir = dir
  }

  /** The key a library's songs are kept under for someone (their own copy when their account is limited). */
  static keyOf(library: string, userId: string, restricted: boolean) {
    return restricted ? `${library}|${userId}` : library
  }

  /** How far the first read of a library has come (undefined: it's there). */
  progressOf(key: string) {
    return this.catalogs.has(key) ? undefined : this.progress.get(key)
  }

  /**
   * A library's songs, read with this person's token when they aren't there yet; brought up to date in the background
   * when they are.
   */
  async tracks(library: string, userId: string, token: string, restricted: boolean): Promise<Map<string, Track>> {
    const key = MusicCatalog.keyOf(library, userId, restricted)
    let catalog = this.catalogs.get(key)
    if (!catalog) {
      let loading = this.loading.get(key)
      if (!loading) {
        loading = this.load(key, library, userId, token).finally(() => this.loading.delete(key))
        this.loading.set(key, loading)
      }
      catalog = await loading
    } else if (Date.now() - catalog.at > UPDATE_EVERY) {
      void this.update(catalog, userId, token)
    }
    return catalog.tracks
  }

  private file(key: string) {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json.gz`)
  }

  /** From disk (then brought up to date), or read in full. */
  private async load(key: string, library: string, userId: string, token: string): Promise<Catalog> {
    const saved = await readFile(this.file(key))
      .then((data) => JSON.parse(gunzipSync(data).toString('utf8')) as { key: string; at: number; fullAt: number; tracks: Record<string, unknown>[] })
      .catch(() => null)
    if (saved?.key === key) {
      const catalog: Catalog = { key, library, at: saved.at, fullAt: saved.fullAt, tracks: new Map(saved.tracks.map((item) => { const track = lean(item); return [track.Id, track] })) }
      this.catalogs.set(key, catalog)
      void this.update(catalog, userId, token)
      return catalog
    }
    const started = Date.now()
    const tracks = await this.readAll(key, library, userId, token)
    const catalog: Catalog = { key, library, at: started, fullAt: started, tracks }
    this.catalogs.set(key, catalog)
    this.progress.delete(key)
    await this.save(catalog)
    return catalog
  }

  private async page(library: string, userId: string, token: string, start: number, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      ParentId: library,
      Recursive: 'true',
      IncludeItemTypes: 'Audio',
      Fields: FIELDS,
      EnableUserData: 'false',
      EnableImageTypes: 'Primary',
      ImageTypeLimit: '1',
      StartIndex: String(start),
      Limit: String(PAGE),
      ...extra,
    })
    const response = await fetch(`${this.jellyfinUrl}/Users/${userId}/Items?${params}`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Jellyfin ${response.status}`)
    return (await response.json()) as { Items?: Record<string, unknown>[]; TotalRecordCount?: number }
  }

  /** Every song, a few pages at a time. */
  private async readAll(key: string, library: string, userId: string, token: string) {
    const tracks = new Map<string, Track>()
    const first = await this.page(library, userId, token, 0)
    const total = first.TotalRecordCount ?? 0
    for (const item of first.Items ?? []) tracks.set(String(item.Id), lean(item))
    this.progress.set(key, { read: tracks.size, total })
    const starts: number[] = []
    for (let start = PAGE; start < total; start += PAGE) starts.push(start)
    const next = async (): Promise<void> => {
      const start = starts.shift()
      if (start === undefined) return
      const page = await this.page(library, userId, token, start)
      for (const item of page.Items ?? []) tracks.set(String(item.Id), lean(item))
      this.progress.set(key, { read: tracks.size, total })
      return next()
    }
    await Promise.all(Array.from({ length: PARALLEL }, next))
    return tracks
  }

  /** What changed since the last look (new and edited songs); once a day everything, which drops deleted ones. */
  private async update(catalog: Catalog, userId: string, token: string) {
    if (this.updating.has(catalog.key)) return
    this.updating.add(catalog.key)
    try {
      const started = Date.now()
      if (started - catalog.fullAt > FULL_EVERY) {
        catalog.tracks = await this.readAll(`${catalog.key}#full`, catalog.library, userId, token)
        this.progress.delete(`${catalog.key}#full`)
        catalog.fullAt = started
      } else {
        // A little overlap, so nothing saved while the last look ran is missed.
        const since = new Date(catalog.at - 5 * 60_000).toISOString()
        for (let start = 0; ; start += PAGE) {
          const page = await this.page(catalog.library, userId, token, start, { MinDateLastSaved: since })
          for (const item of page.Items ?? []) catalog.tracks.set(String(item.Id), lean(item))
          if (!page.Items?.length || start + PAGE >= (page.TotalRecordCount ?? 0)) break
        }
      }
      catalog.at = started
      await this.save(catalog)
    } catch (error) {
      console.warn('Music catalog update:', error instanceof Error ? error.message : error)
    } finally {
      this.updating.delete(catalog.key)
    }
  }

  private async save(catalog: Catalog) {
    await mkdir(this.dir, { recursive: true })
    const file = this.file(catalog.key)
    const data = gzipSync(JSON.stringify({ key: catalog.key, at: catalog.at, fullAt: catalog.fullAt, tracks: [...catalog.tracks.values()] }))
    await writeFile(`${file}.tmp`, data)
    await rename(`${file}.tmp`, file)
  }
}

/** Someone's plays and hearts as Jellyfin keeps them (also plays from other apps), for songs they played or love. */
export async function userDataOf(jellyfinUrl: string, userId: string, token: string, libraries: string[]) {
  const result = new Map<string, UserData>()
  for (const library of libraries) {
    for (const filter of ['IsPlayed', 'IsFavorite']) {
      const params = new URLSearchParams({ ParentId: library, Recursive: 'true', IncludeItemTypes: 'Audio', Filters: filter, EnableImages: 'false', EnableUserData: 'true' })
      const response = await fetch(`${jellyfinUrl}/Users/${userId}/Items?${params}`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Jellyfin ${response.status}`)
      const page = (await response.json()) as { Items?: Array<{ Id: string; UserData?: UserData }> }
      for (const item of page.Items ?? []) {
        const data = item.UserData
        if (data) result.set(item.Id, { PlayCount: data.PlayCount, IsFavorite: data.IsFavorite, Played: data.Played, LastPlayedDate: data.LastPlayedDate })
      }
    }
  }
  return result
}

/** The songs of some playlists (for the taste profile's left-out playlists). */
export async function playlistTrackIds(jellyfinUrl: string, userId: string, token: string, playlists: string[]) {
  const ids = new Set<string>()
  for (const playlist of playlists) {
    const params = new URLSearchParams({ ParentId: playlist, EnableImages: 'false', EnableUserData: 'false' })
    const response = await fetch(`${jellyfinUrl}/Users/${userId}/Items?${params}`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(60_000) }).catch(() => null)
    if (!response?.ok) continue
    for (const item of ((await response.json()) as { Items?: Array<{ Id: string }> }).Items ?? []) ids.add(item.Id)
  }
  return ids
}
