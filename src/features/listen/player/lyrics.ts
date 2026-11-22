import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getArtistApi } from '@jellyfin/sdk/lib/utils/api/artist-api'
import { getLyricApi } from '@jellyfin/sdk/lib/utils/api/lyric-api'
import type { Api } from '@jellyfin/sdk'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { externalOf } from '@/lib/external-items'
import { ticksToSeconds } from '@/lib/format'
import { lumioGet, lumioSend, relayFetch } from '@/features/social/social'
import { artistsOf } from '@/lib/item-links'
import { lyricsProviders, type FoundLyrics, type LyricsProvider, type LyricsTrack } from './lyrics-providers'

export interface LyricLine {
  /** Seconds into the track; missing for plain (unsynced) lyrics. */
  time?: number
  text: string
  /** Who sings the line, when the lyrics say so ("{Jennie} …" at the line's start; see `withSingers`). */
  singer?: string
}

export interface Lyrics {
  lines: LyricLine[]
  synced: boolean
  /** 'jellyfin', 'lrclib' or a plugin's provider id (see lyricsSourceName). */
  source: string
  /** How the source calls itself, when it isn't one Lumio knows (lyrics a tool added on the server). */
  sourceName?: string
}

/** "[01:23.45] text" lines of an LRC file; lines without a timestamp are skipped when any line has one. */
function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const stamp of stamps) lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]), text })
  }
  return lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
}

/**
 * A track's lyrics: from Jellyfin first (embedded or .lrc files, or fetched by a lyrics plugin), then what the Lumio
 * server kept from an earlier find, then the providers (lrclib, which needs no key, and the ones plugins add) in turn.
 * Synced lyrics (a time per line) win over plain ones; what a provider finds is kept on the server for everyone.
 */
export function useLyrics(item: BaseItemDto | undefined) {
  const { api } = useAuthedSession()
  return useQuery(lyricsOptions(api, item))
}

/** The lyrics query, also for loading them ahead (the next track's). */
export function lyricsOptions(api: Api, item: BaseItemDto | undefined) {
  return queryOptions({
    // v2: lines carry their singer (withSingers); lyrics kept from before are read again.
    queryKey: ['lyrics', 2, item?.Id],
    // Podcasts have no lyrics.
    enabled: !!item?.Id && !externalOf(item),
    // Lyrics don't change: kept (also across restarts, see query-persist) as long as the saved data is. "None" is asked
    // again after a while: a provider, or an admin's tool, may have found them since.
    staleTime: (query) => (query.state.data ? Infinity : 12 * 60 * 60_000),
    gcTime: 30 * 24 * 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const found = await findLyrics(api, item!)
      return found && withSingers(api, found)
    },
  })
}

async function findLyrics(api: Api, item: BaseItemDto): Promise<Lyrics | null> {
  try {
    const { data } = await getLyricApi(api).getLyrics({ itemId: item.Id! })
    const lines = (data.Lyrics ?? []).map((line) => ({
      time: line.Start != null ? ticksToSeconds(line.Start) : undefined,
      text: line.Text ?? '',
    }))
    if (lines.length) return { lines, synced: lines.some((line) => line.time !== undefined), source: 'jellyfin' }
  } catch {
    // No lyrics in Jellyfin (404); try the others.
  }
  let best: Lyrics | null = null
  const kept = await lumioGet(`/music/lyrics/${item.Id}`).catch(() => null)
  if (kept?.ok) {
    best = (await kept.json()) as Lyrics
    if (best.synced) return best
  }
  const track = lyricsTrack(item)
  for (const provider of [lrclib, ...lyricsProviders()]) {
    let found: Lyrics | null = null
    try {
      found = toLyrics(await provider.find(track), provider.id)
    } catch (error) {
      console.warn(`Lyrics provider "${provider.id}" failed`, error)
    }
    // Plain lyrics only help while there are none; synced ones end the search.
    if (!found || (best && !found.synced)) continue
    void lumioSend('PUT', `/music/lyrics/${item.Id}`, found).catch(() => undefined)
    if (found.synced) return found
    best = found
  }
  return best
}

/** "{Jennie} Click-clack": the singer in braces at a line's start (as lrclib's K-pop lyrics often have it). */
const SINGER = /^\s*\{([^{}]{1,40})\}\s*/

/**
 * Takes the singers out of the lines ("{Jennie} …" becomes the line "…" sung by Jennie). Names often lost their accents
 * on the way into lrclib ("{Ros?}"): a name with "?" is looked up among the library's artists ("ROSÉ"), written in the
 * lyrics' own case ("Rosé").
 */
async function withSingers(api: Api, lyrics: Lyrics): Promise<Lyrics> {
  // Curly apostrophes got lost the same way ("I?m", "don?t"): a "?" between two letters is never a question mark.
  const mended = lyrics.lines.map((line) => (/\p{L}\?\p{L}/u.test(line.text) ? { ...line, text: line.text.replace(/(\p{L})\?(?=\p{L})/gu, '$1’') } : line))
  if (!mended.some((line) => SINGER.test(line.text))) return { ...lyrics, lines: mended }
  const lines: LyricLine[] = mended.map((line) => {
    const match = SINGER.exec(line.text)
    return match ? { ...line, text: line.text.slice(match[0].length), singer: match[1]!.trim() } : line
  })
  const broken = [...new Set(lines.map((line) => line.singer).filter((name): name is string => !!name && LOST.test(name)))]
  const repaired = new Map(await Promise.all(broken.map(async (name) => [name, await repairName(api, name)] as const)))
  return { ...lyrics, lines: lines.map((line) => (line.singer && repaired.get(line.singer) ? { ...line, singer: repaired.get(line.singer) } : line)) }
}

/** A letter lost on the way: "?" or the replacement character. */
const LOST = /[?�]/u

/** "Ros?" → "Rosé", when an artist in the library has that name with a letter in place of each "?". */
async function repairName(api: Api, name: string): Promise<string | undefined> {
  const chars = [...name]
  const known = name.split(LOST)[0]!.trim()
  if (known.length < 2) return undefined
  const fits = (candidate: string) => {
    const letters = [...candidate]
    return letters.length === chars.length && chars.every((char, i) => LOST.test(char) || char.toLowerCase() === letters[i]!.toLowerCase())
  }
  try {
    const { data } = await getArtistApi(api).getArtists({ searchTerm: known, limit: 50, enableImages: false })
    const artist = (data.Items ?? []).map((item) => item.Name ?? '').find(fits)
    if (!artist) return undefined
    const letters = [...artist]
    return chars
      .map((char, i) => {
        if (!LOST.test(char)) return char
        // In the lyrics' own case: "Ros?" with the library's "ROSÉ" gives "Rosé".
        const before = chars[i - 1] ?? ''
        return before && before === before.toLowerCase() ? letters[i]!.toLowerCase() : letters[i]!
      })
      .join('')
  } catch {
    return undefined
  }
}

/** What providers are told about a song. */
function lyricsTrack(item: BaseItemDto): LyricsTrack {
  const artists = artistsOf(item).map((artist) => artist.name)
  return {
    id: item.Id!,
    title: item.Name ?? '',
    artists: artists.length ? artists : item.AlbumArtist ? [item.AlbumArtist] : [],
    album: item.Album ?? undefined,
    albumArtist: item.AlbumArtist ?? undefined,
    duration: Math.round(ticksToSeconds(item.RunTimeTicks ?? 0)),
    musicBrainzTrackId: item.ProviderIds?.MusicBrainzTrack ?? undefined,
    isrc: item.ProviderIds?.ISRC ?? undefined,
  }
}

function toLyrics(found: FoundLyrics | null | undefined, source: string): Lyrics | null {
  if (found?.lrc?.trim()) {
    const lines = parseLrc(found.lrc)
    if (lines.length) return { lines, synced: true, source }
  }
  if (found?.plain?.trim()) return { lines: found.plain.trim().split(/\r?\n/).map((text) => ({ text })), synced: false, source }
  return null
}

interface LrclibEntry {
  duration?: number
  instrumental?: boolean
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

/**
 * lrclib.net (through the Lumio server, which keeps its answers): the exact song first (title, artist, album and
 * length must all match), else a search by title and artist, taking the closest in length (synced ones first).
 */
const lrclib: LyricsProvider = {
  id: 'lrclib',
  name: 'LRCLIB',
  async find(track) {
    // The track's own artist: an album's ("Various Artists" on a compilation) rarely matches.
    const artist = track.artists[0] ?? ''
    const ask = (path: string, params: Record<string, string>) => relayFetch('lyrics', path, new URLSearchParams(params), 'https://lrclib.net/')
    const exact = await ask('api/get', { track_name: track.title, artist_name: artist, album_name: track.album ?? '', duration: String(track.duration) })
    if (exact.ok) {
      const found = (await exact.json()) as LrclibEntry
      if (found.instrumental) return null
      if (found.syncedLyrics || found.plainLyrics) return { lrc: found.syncedLyrics, plain: found.plainLyrics }
    }
    const search = await ask('api/search', { track_name: track.title, artist_name: artist })
    if (!search.ok) return null
    const off = (entry: LrclibEntry) => (track.duration ? Math.abs((entry.duration ?? 0) - track.duration) : 0)
    // Another cut of the song (a radio edit, a live take) has other timings: only near the same length.
    const [match] = ((await search.json()) as LrclibEntry[])
      .filter((entry) => !entry.instrumental && (entry.syncedLyrics || entry.plainLyrics) && off(entry) <= 3)
      .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || off(a) - off(b))
    return match ? { lrc: match.syncedLyrics, plain: match.plainLyrics } : null
  },
}
