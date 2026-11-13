import type { Api } from '@jellyfin/sdk'
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getDisplayPreferenceApi } from '@jellyfin/sdk/lib/utils/api/display-preference-api'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { externalItem, externalOf } from '@/lib/external-items'
import { plainText } from '@/lib/format'
import { getLocale } from '@/lib/i18n'
import { CLIENT, PREFS_ID, useListenLibrary } from './playlists'
import { fetchFeed, relayedImage } from '@/features/social/social'

/**
 * Podcasts, from Apple's public podcast directory (the iTunes Search API: search, charts, and each show's latest
 * episodes with their audio files). It needs no key and answers browsers directly, so Lumio needs no server of its
 * own for them. Episodes play from their hosts. What the user follows and how far they got is kept with their
 * Listen library in Jellyfin.
 */
const ITUNES = 'https://itunes.apple.com'
const HOUR = 60 * 60_000
/** Apple returns at most 200 episodes per show, the newest. */
const EPISODE_LIMIT = 200

/** The store whose charts and catalog are used: Germany for German, the US otherwise. */
const country = () => (getLocale() === 'de' ? 'DE' : 'US')

export interface Podcast {
  id: string
  name: string
  author: string
  image?: string
  genre?: string
  episodeCount?: number
  /** Latest episode's date. */
  updated?: string
  url?: string
  /** The show's RSS feed (for chapters and transcripts, where the browser may read it). */
  feedUrl?: string
}

export interface Episode {
  /** Lumio's item for the player (with the audio file and artwork). */
  item: BaseItemDto
  /** Apple's id of the episode (its page is /listen/podcast/<show>/episode/<trackId>). */
  trackId: string
  podcastId: string
  guid: string
  title: string
  description: string
  published?: string
  seconds: number
  image?: string
}

/** Apple's artwork URLs carry their size; any size can be asked for. */
/** Apple's cover in a fixed size, through the Lumio server (Apple's image host allows no CORS and Lumio keeps them). */
const sized = (url: string | undefined, size = 600) => relayedImage(url?.replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/, `/${size}x${size}bb.jpg`))

interface ItunesPodcast {
  collectionId: number
  collectionName: string
  artistName: string
  artworkUrl600?: string
  artworkUrl100?: string
  primaryGenreName?: string
  trackCount?: number
  releaseDate?: string
  collectionViewUrl?: string
  feedUrl?: string
}

interface ItunesEpisode {
  trackId: number
  trackName: string
  collectionId: number
  collectionName: string
  episodeUrl?: string
  episodeGuid?: string
  description?: string
  shortDescription?: string
  releaseDate?: string
  trackTimeMillis?: number
  artworkUrl600?: string
  artworkUrl160?: string
}

const toPodcast = (entry: ItunesPodcast): Podcast => ({
  id: String(entry.collectionId),
  name: entry.collectionName,
  author: entry.artistName,
  image: sized(entry.artworkUrl600 ?? entry.artworkUrl100),
  genre: entry.primaryGenreName,
  episodeCount: entry.trackCount,
  updated: entry.releaseDate,
  url: entry.collectionViewUrl,
  feedUrl: entry.feedUrl,
})

function toEpisode(entry: ItunesEpisode, podcast: Podcast): Episode {
  const guid = entry.episodeGuid || String(entry.trackId)
  const image = sized(entry.artworkUrl600 ?? entry.artworkUrl160) ?? podcast.image
  const seconds = Math.round((entry.trackTimeMillis ?? 0) / 1000)
  const description = (entry.description || entry.shortDescription || '').trim()
  const item = externalItem(
    {
      Id: `podcast-episode-${entry.trackId}`,
      Name: entry.trackName,
      Album: podcast.name,
      AlbumArtist: podcast.author,
      Artists: [podcast.author],
      RunTimeTicks: seconds * 10_000_000,
      PremiereDate: entry.releaseDate,
      Overview: description,
    },
    { kind: 'podcast', url: entry.episodeUrl!, image, href: episodePath(podcast.id, String(entry.trackId)), podcastId: podcast.id, guid },
  )
  return { item, trackId: String(entry.trackId), podcastId: podcast.id, guid, title: entry.trackName, description, published: entry.releaseDate, seconds, image }
}

export const episodePath = (podcastId: string, trackId: string) => `/listen/podcast/${podcastId}/episode/${trackId}`

/** An episode rebuilt from its player item alone (saved episodes, "continue listening"). */
export function episodeFromItem(item: BaseItemDto, duration?: number): Episode | undefined {
  const external = externalOf(item)
  if (!external) return undefined
  return {
    item,
    trackId: (item.Id ?? '').replace('podcast-episode-', ''),
    podcastId: external.podcastId,
    guid: external.guid,
    title: item.Name ?? '',
    description: item.Overview ?? '',
    published: item.PremiereDate ?? undefined,
    seconds: Math.round(duration ?? (item.RunTimeTicks ?? 0) / 10_000_000),
    image: external.image,
  }
}

async function itunes<T>(path: string, params: Record<string, string>): Promise<T> {
  const response = await fetch(`${ITUNES}/${path}?${new URLSearchParams({ ...params, country: country() })}`)
  if (!response.ok) throw new Error(`iTunes ${response.status}`)
  return (await response.json()) as T
}

/** Shows found by name (iTunes' podcast search). */
export async function searchPodcasts(term: string, limit = 25) {
  const data = await itunes<{ results: ItunesPodcast[] }>('search', { media: 'podcast', entity: 'podcast', term: term.trim(), limit: String(limit) })
  return data.results.map(toPodcast)
}

export function usePodcastSearch(term: string) {
  return useQuery({
    queryKey: ['podcast-search', term, country()],
    enabled: term.trim().length > 1,
    staleTime: HOUR,
    queryFn: async () => {
      const data = await itunes<{ results: ItunesPodcast[] }>('search', { media: 'podcast', entity: 'podcast', term: term.trim(), limit: '25' })
      return data.results.map(toPodcast)
    },
  })
}

/** A show with its latest episodes (newest first). */
export function podcastOptions(id: string | undefined, limit = EPISODE_LIMIT) {
  return {
    queryKey: ['podcast', id, limit, country()],
    enabled: !!id,
    staleTime: HOUR,
    queryFn: async () => {
      const data = await itunes<{ results: Array<ItunesPodcast & ItunesEpisode & { wrapperType: string }> }>('lookup', {
        id: id!,
        media: 'podcast',
        entity: 'podcastEpisode',
        limit: String(limit),
      })
      const show = data.results.find((entry) => entry.wrapperType === 'track')
      if (!show) throw new Error('Podcast not found')
      const podcast = toPodcast(show)
      const episodes = data.results
        .filter((entry) => entry.wrapperType === 'podcastEpisode' && entry.episodeUrl)
        .map((entry) => toEpisode(entry, podcast))
        .sort((a, b) => Date.parse(b.published ?? '') - Date.parse(a.published ?? ''))
      return { podcast, episodes }
    },
  }
}

export function usePodcast(id: string | undefined) {
  return useQuery(podcastOptions(id))
}

/** Apple's podcast categories (genre ids), for the charts. */
export const PODCAST_GENRES = [
  { id: '1489', de: 'Nachrichten', en: 'News' },
  { id: '1303', de: 'Comedy', en: 'Comedy' },
  { id: '1324', de: 'Gesellschaft', en: 'Society & Culture' },
  { id: '1488', de: 'True Crime', en: 'True Crime' },
  { id: '1318', de: 'Technologie', en: 'Technology' },
  { id: '1533', de: 'Wissenschaft', en: 'Science' },
  { id: '1487', de: 'Geschichte', en: 'History' },
  { id: '1321', de: 'Wirtschaft', en: 'Business' },
  { id: '1545', de: 'Sport', en: 'Sports' },
  { id: '1512', de: 'Gesundheit', en: 'Health & Fitness' },
  { id: '1309', de: 'Film & TV', en: 'TV & Film' },
  { id: '1310', de: 'Musik', en: 'Music' },
]

/** The most popular shows in the user's country, all or in one category. */
export function useTopPodcasts(genre?: string) {
  return useQuery({
    queryKey: ['podcast-charts', genre, country()],
    staleTime: 6 * HOUR,
    queryFn: async (): Promise<Podcast[]> => {
      type Entry = {
        id: { attributes: { 'im:id': string } }
        'im:name': { label: string }
        'im:artist'?: { label: string }
        'im:image'?: Array<{ label: string }>
        category?: { attributes?: { label?: string } }
      }
      const path = `${country().toLowerCase()}/rss/toppodcasts/limit=50${genre ? `/genre=${genre}` : ''}/json`
      const response = await fetch(`${ITUNES}/${path}`)
      if (!response.ok) throw new Error(`iTunes ${response.status}`)
      const data = (await response.json()) as { feed: { entry?: Entry[] | Entry } }
      const entries = Array.isArray(data.feed.entry) ? data.feed.entry : data.feed.entry ? [data.feed.entry] : []
      return entries.map((entry) => ({
        id: entry.id.attributes['im:id'],
        name: entry['im:name'].label,
        author: entry['im:artist']?.label ?? '',
        image: sized(entry['im:image']?.at(-1)?.label),
        genre: entry.category?.attributes?.label,
      }))
    },
  })
}

/** The shows the user follows (`podcast:<id>` in their Listen library), newest follow first. */
export function useFollowedPodcasts() {
  const library = useListenLibrary()
  const ids = library.saved.filter((entry) => entry.startsWith('podcast:')).map((entry) => entry.slice(8))
  const results = useQueries({ queries: ids.map((id) => podcastOptions(id, 10)) })
  return {
    ids,
    podcasts: results.map((result) => result.data?.podcast).filter((podcast): podcast is Podcast => !!podcast),
    /** The latest episodes of all followed shows, newest first. */
    episodes: results
      .flatMap((result) => result.data?.episodes ?? [])
      .sort((a, b) => Date.parse(b.published ?? '') - Date.parse(a.published ?? '')),
    isLoading: results.some((result) => result.isLoading),
  }
}

// ---- progress: how far the user got in each episode ----

export interface EpisodeProgress {
  position: number
  duration: number
  done: boolean
  /** When it was last listened to (ms). */
  at: number
  /** For "continue listening": the episode itself, as the player needs it. */
  item?: BaseItemDto
}

/** Older entries are dropped beyond this many. */
const KEEP = 300
/** Writes are bundled: at most one save to the server in this time, sooner when playback pauses or stops. */
const SAVE_AFTER_MS = 20_000

let progress: Record<string, EpisodeProgress> = {}
const listeners = new Set<() => void>()
let saver: ((all: Record<string, EpisodeProgress>) => Promise<void>) | null = null
let saveTimer: number | undefined
/** Writes one key of the user's Listen preferences (set while signed in). */
let writePref: ((key: string, value: string) => Promise<void>) | null = null

function emit() {
  snapshot = { progress, saved }
  for (const listener of listeners) listener()
}

/** Episodes the user saved ("Your episodes", like Liked Songs for podcasts), newest first, as player items. */
let saved: BaseItemDto[] = []
let snapshot = { progress, saved }

function useStore() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}

export function useSavedEpisodes() {
  return useStore().saved
}

export function useEpisodeSaved(guid: string) {
  return useStore().saved.some((item) => externalOf(item)?.guid === guid)
}

/** Whether an episode is in "Your episodes" (outside React). */
export function isEpisodeSaved(guid: string | undefined) {
  return !!guid && saved.some((entry) => externalOf(entry)?.guid === guid)
}

/** Saves an episode to "Your episodes", or takes it out again. */
export function toggleSavedEpisode(item: BaseItemDto) {
  const guid = externalOf(item)?.guid
  if (!guid) return
  const has = saved.some((entry) => externalOf(entry)?.guid === guid)
  saved = has ? saved.filter((entry) => externalOf(entry)?.guid !== guid) : [compactItem(item, true), ...saved]
  emit()
  void writePref?.('savedEpisodes', JSON.stringify(saved)).catch(() => undefined)
}

export function podcastProgress(guid: string): EpisodeProgress | undefined {
  return progress[guid]
}

export function usePodcastProgress() {
  return useStore().progress
}

/** Called by the player while an episode plays; finished once less than a minute (or 5 %) is left. */
export function recordPodcastProgress(guid: string, item: BaseItemDto, position: number, duration: number, urgent: boolean) {
  if (!duration) return
  const done = duration - position < Math.max(60, duration * 0.05)
  progress = { ...progress, [guid]: { position: done ? 0 : position, duration, done, at: Date.now(), item: compactItem(item) } }
  emit()
  scheduleSave(urgent ? 1000 : SAVE_AFTER_MS)
}

/** Marks an episode as played or unplayed by hand. */
export function setEpisodeDone(guid: string, item: BaseItemDto, done: boolean, duration: number) {
  progress = { ...progress, [guid]: { position: 0, duration, done, at: Date.now(), item: compactItem(item) } }
  emit()
  scheduleSave(1000)
}

/** Only what the player needs is stored; saved episodes keep a short description for their list. */
function compactItem(item: BaseItemDto, keepDescription = false): BaseItemDto {
  return { ...item, Overview: keepDescription ? item.Overview?.slice(0, 600) : undefined }
}

function scheduleSave(delay: number) {
  if (!saver) return
  if (saveTimer !== undefined && delay >= SAVE_AFTER_MS) return
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    const kept = Object.fromEntries(
      Object.entries(progress)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, KEEP),
    )
    void saver?.(kept).catch(() => undefined)
  }, delay)
}

/** Connects the progress to the signed-in user's Jellyfin (by MusicPlayerHost); null on sign-out. */
export async function connectPodcastProgress(connection: { api: Api; userId: string } | null) {
  window.clearTimeout(saveTimer)
  saveTimer = undefined
  progress = {}
  saved = []
  saver = null
  writePref = null
  emit()
  if (!connection) return
  const prefs = getDisplayPreferenceApi(connection.api)
  const ids = { displayPreferencesId: PREFS_ID, userId: connection.userId, client: CLIENT }
  try {
    const { data } = await prefs.getDisplayPreferences(ids)
    progress = JSON.parse(data.CustomPrefs?.podcastProgress ?? '{}') as Record<string, EpisodeProgress>
    saved = JSON.parse(data.CustomPrefs?.savedEpisodes ?? '[]') as BaseItemDto[]
    emit()
  } catch {
    // Starts empty.
  }
  writePref = async (key, value) => {
    // The endpoint replaces the whole record: start from what is stored (the library lives there too).
    const { data } = await prefs.getDisplayPreferences(ids)
    await prefs.updateDisplayPreferences({ ...ids, displayPreferencesDto: { ...data, CustomPrefs: { ...data.CustomPrefs, [key]: value } } })
  }
  saver = (all) => writePref!('podcastProgress', JSON.stringify(all))
}

/** Episodes started but not finished, most recent first. */
export function useContinueListening() {
  const all = usePodcastProgress()
  return Object.values(all)
    .filter((entry) => !entry.done && entry.position > 30 && entry.item)
    .sort((a, b) => b.at - a.at)
    .slice(0, 12)
}

// ---- what only the show's feed knows: chapters, transcripts, full show notes ----

export interface Chapter {
  start: number
  title: string
}

export interface TranscriptCue {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface EpisodeExtras {
  chapters: Chapter[]
  /** Where the chapters come from: the feed (Podcasting 2.0) or timestamps in the description. */
  chaptersFrom?: 'feed' | 'description'
  transcript: TranscriptCue[]
  /** The feed's show notes, when longer than Apple's description. */
  notes?: string
}

/** "1:02:03" or "12:34" in seconds. */
function clock(value: string) {
  return value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

/**
 * Chapters written into a description, as many shows do: lines like "12:34 Topic", "(1:02:03) Topic" or
 * "[05:10] - Topic". Three or more in rising order count as chapters.
 */
export function chaptersFromText(text: string): Chapter[] {
  const found: Chapter[] = []
  for (const match of text.matchAll(/(?:^|\n)[^\S\n]*[([]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?[^\S\n]*[-–—:|.]?[^\S\n]*([^\n]{2,120})/g)) {
    found.push({ start: clock(match[1]!), title: match[2]!.trim() })
  }
  const rising = found.every((chapter, index) => index === 0 || chapter.start > found[index - 1]!.start)
  return found.length >= 3 && rising ? found : []
}

function parseVtt(text: string): TranscriptCue[] {
  const cues: TranscriptCue[] = []
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n')
    const timing = lines.findIndex((line) => line.includes('-->'))
    if (timing < 0) continue
    const [from, to] = lines[timing]!.split('-->').map((part) => part.trim().split(' ')[0]!.replace(',', '.'))
    const body = lines.slice(timing + 1).join(' ').trim()
    const speaker = body.match(/^<v ([^>]+)>/)?.[1]
    cues.push({ start: clock(from!), end: clock(to!), text: body.replace(/<[^>]+>/g, '').trim(), speaker })
  }
  return cues.filter((cue) => cue.text)
}

/** Neighbouring cues joined into sentences of a sensible length, so the transcript reads as text. */
function joinCues(cues: TranscriptCue[]) {
  const joined: TranscriptCue[] = []
  for (const cue of cues) {
    const last = joined.at(-1)
    if (last && last.speaker === cue.speaker && last.text.length < 220 && !/[.!?]$/.test(last.text)) {
      last.text = `${last.text} ${cue.text}`
      last.end = cue.end
    } else joined.push({ ...cue })
  }
  return joined
}

/**
 * Chapters, a transcript and the full show notes of an episode, from the show's RSS feed (Podcasting 2.0 tags),
 * read through the Lumio server (most feeds don't let browsers read them). Without it, chapters still come from
 * timestamps in the description.
 */
export function useEpisodeExtras(episode: Episode | undefined, feedUrl: string | undefined) {
  return useQuery({
    queryKey: ['episode-extras', episode?.guid, feedUrl],
    enabled: !!episode,
    staleTime: 6 * HOUR,
    retry: false,
    queryFn: async (): Promise<EpisodeExtras> => {
      const extras: EpisodeExtras = { chapters: [], transcript: [] }
      try {
        if (!feedUrl) throw new Error('no feed')
        const xml = new DOMParser().parseFromString(await (await fetchFeed(feedUrl)).text(), 'text/xml')
        const items = [...xml.getElementsByTagName('item')]
        const item = items.find((entry) => entry.getElementsByTagName('guid')[0]?.textContent?.trim() === episode!.guid)
        if (item) {
          const tag = (name: string) => [...item.getElementsByTagName('*')].filter((element) => element.tagName === name)
          const notes = plainText(tag('content:encoded')[0]?.textContent ?? tag('description')[0]?.textContent ?? '')
          if (notes.length > episode!.description.length + 20) extras.notes = notes
          const chaptersUrl = tag('podcast:chapters')[0]?.getAttribute('url')
          if (chaptersUrl) {
            const data = (await (await fetchFeed(chaptersUrl)).json()) as { chapters?: Array<{ startTime: number; title?: string; toc?: boolean }> }
            extras.chapters = (data.chapters ?? []).filter((chapter) => chapter.title && chapter.toc !== false).map((chapter) => ({ start: chapter.startTime, title: chapter.title! }))
            if (extras.chapters.length) extras.chaptersFrom = 'feed'
          }
          // The transcript in the most useful format offered: timed text (VTT, SRT, JSON) before plain HTML.
          const transcripts = tag('podcast:transcript').map((element) => ({ url: element.getAttribute('url'), type: element.getAttribute('type') ?? '' }))
          const timed = transcripts.find((entry) => /vtt|srt/.test(entry.type)) ?? transcripts.find((entry) => /json/.test(entry.type))
          if (timed?.url) {
            const response = await fetchFeed(timed.url)
            if (/json/.test(timed.type)) {
              const data = (await response.json()) as { segments?: Array<{ startTime: number; endTime: number; body: string; speaker?: string }> }
              extras.transcript = joinCues((data.segments ?? []).map((segment) => ({ start: segment.startTime, end: segment.endTime, text: segment.body, speaker: segment.speaker })))
            } else extras.transcript = joinCues(parseVtt(await response.text()))
          }
        }
      } catch {
        // The feed (or a file it points to) can't be read from the browser; what the description holds still helps.
      }
      if (!extras.chapters.length) {
        extras.chapters = chaptersFromText(extras.notes ?? episode!.description)
        if (extras.chapters.length) extras.chaptersFrom = 'description'
      }
      return extras
    },
  })
}

/** Apple's artwork in another size; relayed URLs are resized inside (the size is part of Apple's address). */
export function artworkSize(url: string | undefined, size: number) {
  if (!url) return undefined
  const relayed = url.match(/[?&]url=([^&]+)/)
  if (relayed) return sized(decodeURIComponent(relayed[1]!), size)
  return url.replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/, `/${size}x${size}bb.jpg`)
}

/** What a show's feed says about it, beyond Apple's listing. */
export interface PodcastInfo {
  description: string
  categories: string[]
  website?: string
  language?: string
  explicit: boolean
  copyright?: string
}

/** A show's description, categories, website and language, from its feed (through the Lumio server). */
export function usePodcastInfo(feedUrl: string | undefined) {
  return useQuery({
    queryKey: ['podcast-info', feedUrl],
    enabled: !!feedUrl,
    staleTime: 6 * HOUR,
    gcTime: 7 * 24 * HOUR,
    retry: false,
    queryFn: async (): Promise<PodcastInfo> => {
      const xml = new DOMParser().parseFromString(await (await fetchFeed(feedUrl!)).text(), 'text/xml')
      const channel = xml.getElementsByTagName('channel')[0]
      if (!channel) throw new Error('Not a feed')
      // The channel's own tags, not those of its episodes.
      const own = (name: string) => [...channel.children].filter((element) => element.tagName === name)
      const text = (name: string) => own(name)[0]?.textContent?.trim() || undefined
      const categories = [...new Set([...channel.getElementsByTagName('itunes:category')].map((element) => element.getAttribute('text') ?? '').filter(Boolean))]
      return {
        description: plainText(text('itunes:summary') ?? text('description') ?? ''),
        categories,
        website: text('link'),
        language: text('language'),
        explicit: /yes|true/i.test(text('itunes:explicit') ?? ''),
        copyright: text('copyright'),
      }
    },
  })
}
