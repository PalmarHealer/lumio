import { useQueries, useQuery } from '@tanstack/react-query'
import { relayFetch } from '@/features/social/social'
import { getLocale } from '@/lib/i18n'
import { hasService, ownKey } from '@/lib/services'

/**
 * Information about artists from outside Jellyfin, each optional (it needs its key in the environment):
 * - Last.fm: listeners, play counts, biography, popular tracks and similar artists.
 * Concerts (Ticketmaster) live in `concerts.ts`. Keys are public by design (they end up in the browser); their
 * secrets are never used.
 */

const DAY = 24 * 60 * 60_000

async function lastfm<T>(params: Record<string, string>): Promise<T> {
  // The server's key is added by the server; the app's own (if built with one) for asking Last.fm directly.
  const key = ownKey('lastfm')
  const query = new URLSearchParams({ ...params, ...(key ? { api_key: key } : {}), format: 'json', autocorrect: '1' })
  // Through the Lumio server, which keeps the answers for everyone.
  const response = await relayFetch('lastfm', '', query, 'https://ws.audioscrobbler.com/2.0/')
  if (!response.ok) throw new Error(`Last.fm ${response.status}`)
  const data = (await response.json()) as T & { error?: number }
  if (data.error) throw new Error(`Last.fm error ${data.error}`)
  return data
}

export interface LastfmArtist {
  name: string
  listeners: number
  playcount: number
  /** Biography without Last.fm's "Read more" link; empty when there is none. */
  bio: string
  /** The English biography, when there is none in the app's language. */
  bioEnglish: string
  tags: string[]
  similar: string[]
  url?: string
}

/** Removes Last.fm's trailing link ("<a href=…>Read more on Last.fm</a>") and any other markup. */
function cleanBio(html: string | undefined) {
  return (html ?? '')
    .replace(/<a [^>]*>.*?<\/a>\.?/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/User-contributed text is available.*$/s, '')
    .trim()
}

export function useLastfmArtist(name: string | undefined) {
  return useQuery({
    queryKey: ['lastfm-artist', name, getLocale()],
    enabled: hasService('lastfm') && !!name,
    // Changes rarely: fresh for a week, kept a month.
    staleTime: 7 * DAY,
    gcTime: 30 * DAY,
    retry: false,
    queryFn: async (): Promise<LastfmArtist> => {
      type Response = {
        artist: {
          name: string
          url?: string
          stats?: { listeners?: string; playcount?: string }
          bio?: { content?: string; summary?: string }
          tags?: { tag?: Array<{ name: string }> }
          similar?: { artist?: Array<{ name: string }> }
        }
      }
      const { artist } = await lastfm<Response>({ method: 'artist.getinfo', artist: name!, lang: getLocale() })
      const bio = cleanBio(artist.bio?.content || artist.bio?.summary)
      // Many artists have a biography only in English on Last.fm; kept apart, as a last resort (see useArtistBio).
      let bioEnglish = ''
      if (!bio && getLocale() !== 'en') {
        const english = await lastfm<Response>({ method: 'artist.getinfo', artist: name!, lang: 'en' }).catch(() => null)
        bioEnglish = cleanBio(english?.artist.bio?.content || english?.artist.bio?.summary)
      }
      return {
        name: artist.name,
        url: artist.url,
        listeners: Number(artist.stats?.listeners ?? 0),
        playcount: Number(artist.stats?.playcount ?? 0),
        bio,
        bioEnglish,
        tags: (artist.tags?.tag ?? []).map((tag) => tag.name),
        similar: (artist.similar?.artist ?? []).map((entry) => entry.name),
      }
    },
  })
}

export interface LastfmTrack {
  name: string
  playcount: number
  listeners: number
}

export function useLastfmTopTracks(name: string | undefined) {
  return useQuery({
    queryKey: ['lastfm-top-tracks', name],
    enabled: hasService('lastfm') && !!name,
    // Changes rarely: fresh for a week, kept a month.
    staleTime: 7 * DAY,
    gcTime: 30 * DAY,
    retry: false,
    queryFn: async (): Promise<LastfmTrack[]> => {
      type Response = { toptracks: { track?: Array<{ name: string; playcount?: string; listeners?: string }> } }
      const data = await lastfm<Response>({ method: 'artist.gettoptracks', artist: name!, limit: '50' })
      return (data.toptracks.track ?? []).map((track) => ({
        name: track.name,
        playcount: Number(track.playcount ?? 0),
        listeners: Number(track.listeners ?? 0),
      }))
    },
  })
}

/** Names compared loosely: case, accents, "feat." parts and punctuation don't matter. */
export function sameName(a: string | null | undefined, b: string | null | undefined) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s*[([].*?(feat|ft|with|remaster|version|edit).*?[)\]]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
  return !!a && !!b && normalize(a) === normalize(b)
}

// ---- charts (Last.fm): ranks of artists, and the most played songs ----

/** The countries whose charts are checked, as ISO code and Last.fm's country name. */
const CHART_COUNTRIES: Array<[code: string, name: string]> = [
  ['DE', 'Germany'],
  ['AT', 'Austria'],
  ['CH', 'Switzerland'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['FR', 'France'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['NL', 'Netherlands'],
  ['PL', 'Poland'],
  ['SE', 'Sweden'],
  ['BR', 'Brazil'],
  ['MX', 'Mexico'],
  ['JP', 'Japan'],
]

/** The country whose charts Lumio shows by default: Germany for German, the US otherwise. */
export const homeChartCountry = () => (getLocale() === 'de' ? CHART_COUNTRIES[0]! : CHART_COUNTRIES[3]!)

/** The top 1000 artists, worldwide (no country) or in one country. */
function chartArtistsOptions(country: string | undefined) {
  return {
    queryKey: ['lastfm-chart-artists', country ?? 'world'],
    enabled: hasService('lastfm'),
    staleTime: DAY,
    retry: false,
    queryFn: async (): Promise<string[]> => {
      type Response = { artists?: { artist?: Array<{ name: string }> }; topartists?: { artist?: Array<{ name: string }> } }
      const data = await lastfm<Response>(country ? { method: 'geo.gettopartists', country, limit: '1000' } : { method: 'chart.gettopartists', limit: '1000' })
      return ((country ? data.topartists : data.artists)?.artist ?? []).map((artist) => artist.name)
    },
  }
}

export interface ArtistRanks {
  /** Place among the top 1000 worldwide. */
  world?: number
  /** Places in the countries where the artist is in the top 1000, best first. */
  countries: Array<{ code: string; rank: number }>
}

/**
 * Where an artist ranks on Last.fm: worldwide and per country (the closest there is to Spotify's "top cities", which no
 * open source offers). Only loaded when asked for (`enabled`); the charts are shared by every artist and kept a day.
 */
export function useArtistRanks(name: string | undefined, enabled: boolean) {
  const results = useQueries({
    queries: [undefined, ...CHART_COUNTRIES.map(([, country]) => country)].map((country) => ({ ...chartArtistsOptions(country), enabled: hasService('lastfm') && enabled && !!name })),
  })
  const rank = (list: string[] | undefined) => {
    const index = list?.findIndex((entry) => sameName(entry, name)) ?? -1
    return index >= 0 ? index + 1 : undefined
  }
  const ranks: ArtistRanks = {
    world: rank(results[0]?.data),
    countries: CHART_COUNTRIES.map(([code], index) => ({ code, rank: rank(results[index + 1]?.data) }))
      .filter((entry): entry is { code: string; rank: number } => entry.rank !== undefined)
      .sort((a, b) => a.rank - b.rank),
  }
  return { ranks, isLoading: results.some((result) => result.isLoading) }
}

export interface ChartTrack {
  name: string
  artist: string
  listeners: number
}

/** The most played songs worldwide (no country) or in one country, best first (up to 200). */
export async function fetchChartTracks(country?: string): Promise<ChartTrack[]> {
  if (!hasService('lastfm')) return []
  type Track = { name: string; artist: { name: string }; listeners?: string }
  type Response = { tracks?: { track?: Track[] } }
  const data = await lastfm<Response>(country ? { method: 'geo.gettoptracks', country, limit: '200' } : { method: 'chart.gettoptracks', limit: '200' })
  return (data.tracks?.track ?? []).map((track) => ({ name: track.name, artist: track.artist.name, listeners: Number(track.listeners ?? 0) }))
}

/** Names of artists similar to one (Last.fm), most similar first. */
export async function fetchSimilarArtists(name: string): Promise<string[]> {
  if (!hasService('lastfm')) return []
  type Response = { similarartists?: { artist?: Array<{ name: string }> } }
  const data = await lastfm<Response>({ method: 'artist.getsimilar', artist: name, limit: '30' })
  return (data.similarartists?.artist ?? []).map((artist) => artist.name)
}

/** An artist's tags on Last.fm (genres, moods), most used first; empty without Last.fm. */
export async function fetchArtistTags(name: string): Promise<string[]> {
  if (!hasService('lastfm')) return []
  type Response = { toptags?: { tag?: Array<{ name: string; count?: number | string }> } }
  const data = await lastfm<Response>({ method: 'artist.gettoptags', artist: name })
  return (data.toptags?.tag ?? []).filter((tag) => Number(tag.count ?? 0) >= 10).map((tag) => tag.name.toLowerCase())
}

// ---- an artist's links (MusicBrainz) ----

export interface ArtistLink {
  kind: 'website' | 'instagram' | 'x' | 'facebook' | 'youtube' | 'tiktok' | 'soundcloud' | 'bandcamp' | 'twitch' | 'threads' | 'bluesky' | 'wikipedia' | 'genius'
  url: string
}

const LINK_HOSTS: Array<[ArtistLink['kind'], RegExp]> = [
  ['instagram', /(^|\.)instagram\.com$/],
  ['x', /(^|\.)(twitter|x)\.com$/],
  ['facebook', /(^|\.)facebook\.com$/],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['soundcloud', /(^|\.)soundcloud\.com$/],
  ['bandcamp', /(^|\.)bandcamp\.com$/],
  ['twitch', /(^|\.)twitch\.tv$/],
  ['threads', /(^|\.)threads\.net$/],
  ['bluesky', /(^|\.)bsky\.app$/],
  ['wikipedia', /(^|\.)wikipedia\.org$/],
  ['genius', /(^|\.)genius\.com$/],
]

/**
 * An artist's own channels (website, social networks, lyrics), from MusicBrainz: by the MusicBrainz id Jellyfin keeps
 * for the artist, or else found by name. MusicBrainz asks for at most one request a second, which this stays far under.
 */
export function useArtistLinks(name: string | undefined, musicBrainzId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['artist-links', musicBrainzId ?? name],
    enabled: enabled && !!(musicBrainzId || name),
    // Changes rarely: fresh for a week, kept a month.
    staleTime: 7 * DAY,
    gcTime: 30 * DAY,
    retry: false,
    queryFn: async (): Promise<ArtistLink[]> => {
      // Through the Lumio server (cached a week), which also keeps to MusicBrainz's one call a second.
      const musicbrainz = async (path: string, query: Record<string, string>) =>
        (await relayFetch('musicbrainz', path, new URLSearchParams(query), 'https://musicbrainz.org/ws/2/')).json()
      let id = musicBrainzId
      if (!id) {
        const found = (await musicbrainz('artist', { query: `artist:"${name}"`, fmt: 'json', limit: '3' })) as {
          artists?: Array<{ id: string; name: string; score: number }>
        }
        id = found.artists?.find((artist) => artist.score >= 95 && sameName(artist.name, name))?.id
        if (!id) return []
      }
      const data = (await musicbrainz(`artist/${id}`, { inc: 'url-rels', fmt: 'json' })) as { relations?: Array<{ type: string; url?: { resource: string } }> }
      const links: ArtistLink[] = []
      for (const relation of data.relations ?? []) {
        const url = relation.url?.resource
        if (!url) continue
        let host = ''
        try {
          host = new URL(url).hostname
        } catch {
          continue
        }
        const kind = relation.type === 'official homepage' ? 'website' : LINK_HOSTS.find(([, pattern]) => pattern.test(host))?.[0]
        if (kind && !links.some((link) => link.kind === kind)) links.push({ kind, url })
      }
      const order = ['website', 'instagram', 'x', 'tiktok', 'youtube', 'facebook', 'threads', 'bluesky', 'soundcloud', 'bandcamp', 'twitch', 'genius', 'wikipedia']
      return links.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    },
  })
}
