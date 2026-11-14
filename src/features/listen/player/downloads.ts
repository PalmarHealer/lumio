import { downloadsWaitForWifi, onDownloadsAllowedChange } from '@/lib/network'
import { useSyncExternalStore } from 'react'
import { lumioGet } from '@/features/social/social'
import { remindPersistentStorage } from '@/lib/persistent-storage'

/**
 * Downloads, as Spotify's: albums, playlists and podcast episodes kept on this device for good, in their own quality,
 * never dropped to make room (unlike the cache, see audio-cache). A downloaded song always plays from here, whatever
 * the streaming quality. Collections stay in step with their source: songs added to a downloaded playlist are fetched,
 * removed ones dropped (when no other download holds them). Changing the download quality fetches everything again.
 *
 * The files sit in Cache Storage; an index in localStorage knows the collections, their songs and the quality.
 */
const CACHE_NAME = 'lumio-downloads-v1'
const INDEX_KEY = 'lumio.downloads.v1'

export const downloadsAvailable = typeof window !== 'undefined' && 'caches' in window

interface Collection {
  name: string
  /** The songs it holds (download ids, see downloadId). */
  ids: string[]
  /** Where entries from outside the library (podcast episodes) are fetched from, by download id. */
  urls?: Record<string, string>
  /** What it belongs to in the library (an episode's podcast, `podcast:<id>`), for the library's "Downloaded" filter. */
  group?: string
  added: number
}

interface Index {
  /** The quality the files are in (kbps; null = the original file). */
  quality: number | null
  /** Downloaded files by track id. */
  tracks: Record<string, { bytes: number; added: number }>
  /** What was downloaded, by key (`album:<id>`, `playlist:<id>`, `liked`, `official:<slug>`, `episode:<guid>`). */
  collections: Record<string, Collection>
}

let index: Index = (() => {
  try {
    return { quality: null, tracks: {}, collections: {}, ...(JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as Partial<Index>) }
  } catch {
    return { quality: null, tracks: {}, collections: {} }
  }
})()

/** Songs waiting to be downloaded, in order. */
let pending: string[] = []
/** The song being downloaded right now, and how far (bytes; total 0 when the server didn't say). */
let current: { id: string; received: number; total: number } | null = null
let running = false
/** Bumped on every change, for the hooks. */
let version = 0
const listeners = new Set<() => void>()

/**
 * Where a song goes that no download holds any more: into the song cache, when the player says it is good enough
 * (see setReleaseHandler). Set by the player once signed in.
 */
let release: ((id: string, blob: Blob, quality: number | null) => Promise<void>) | null = null

export function setReleaseHandler(next: typeof release) {
  release = next
}

/** Builds the address a song is downloaded from (in the download quality); set by the player once signed in. */
let source: ((trackId: string, quality: number | null) => string) | null = null

function changed() {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    // Kept for this visit only.
  }
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const requestFor = (id: string) => new Request(`https://lumio.downloads/audio/${encodeURIComponent(id)}`)

/** Episodes (from outside the library) are kept by their feed GUID, library songs by their id. */
export const downloadId = (item: { Id?: string | null }, guid?: string) => (guid ? `podcast:${guid}` : (item.Id ?? ''))

/** Where a download is fetched from: an episode's own file, or the library song in the download quality. */
function urlFor(id: string, quality: number | null) {
  for (const collection of Object.values(index.collections)) if (collection.urls?.[id]) return collection.urls[id]
  return id.startsWith('podcast:') ? null : (source?.(id, quality) ?? null)
}

/** The track ids any download holds. */
function wanted() {
  return new Set(Object.values(index.collections).flatMap((collection) => collection.ids))
}

/**
 * Lines up what is wanted but not there yet, and drops files nothing holds any more. `toCache`: they left a playlist
 * as it changed (not removed by the user), so they may go on in the cache.
 */
async function reconcile(toCache = false) {
  const want = wanted()
  pending = [...want].filter((id) => !index.tracks[id])
  const unused = Object.keys(index.tracks).filter((id) => !want.has(id))
  if (unused.length && downloadsAvailable) {
    const cache = await caches.open(CACHE_NAME)
    for (const id of unused) {
      // A library song left behind (e.g. taken out of a downloaded playlist) moves to the cache rather than vanishing.
      if (toCache && release && !id.startsWith('podcast:')) {
        const file = await cache.match(requestFor(id)).catch(() => undefined)
        if (file) await release(id, await file.blob(), index.quality).catch(() => undefined)
      }
      await cache.delete(requestFor(id)).catch(() => undefined)
      delete index.tracks[id]
    }
  }
  changed()
  void run()
}

/**
 * Fetches a download: library songs straight from Jellyfin; podcast episodes through the Lumio server (most podcast
 * hosts don't let browsers read their files), straight from the host only without it.
 */
async function fetchAudio(id: string, url: string) {
  if (!id.startsWith('podcast:')) return fetch(url)
  const relayed = await lumioGet(`/podcast-audio?url=${encodeURIComponent(url)}`).catch(() => null)
  return relayed?.ok ? relayed : fetch(url)
}

/** Downloads the pending songs one after another; stops when offline and goes on once back. */
async function run() {
  if (running || !source || !downloadsAvailable) return
  running = true
  try {
    const cache = await caches.open(CACHE_NAME)
    // On mobile data with "only over Wi-Fi" set: waits until Wi-Fi is back.
    while (pending.length && source !== null && !downloadsWaitForWifi()) {
      const id = pending[0]!
      const quality = index.quality
      try {
        const url = urlFor(id, quality)
        if (!url) throw new Error('No source')
        const response = await fetchAudio(id, url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await readWithProgress(id, response)
        // The quality may have changed meanwhile: then this file is stale.
        if (quality !== index.quality) {
          current = null
          continue
        }
        await cache.put(requestFor(id), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }))
        if (wanted().has(id)) index.tracks[id] = { bytes: blob.size, added: Date.now() }
        else await cache.delete(requestFor(id))
        pending = pending.filter((entry) => entry !== id)
        current = null
        changed()
      } catch {
        current = null
        // Offline or the server failed: tried again when the connection is back.
        if (!navigator.onLine) break
        pending = [...pending.filter((entry) => entry !== id), id]
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
  } finally {
    running = false
    current = null
    changed()
  }
}

/** Reads a download, telling how far it is (a few times a second) while the bytes come in. */
async function readWithProgress(id: string, response: Response): Promise<Blob> {
  const total = Number(response.headers.get('content-length') ?? 0)
  current = { id, received: 0, total }
  changed()
  if (!response.body) return response.blob()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let shown = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    current = { id, received: current!.received + value.length, total }
    if (Date.now() - shown > 250) {
      shown = Date.now()
      version++
      for (const listener of listeners) listener()
    }
  }
  // Stays the current song until it is stored (see run).
  return new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') ?? 'audio/mpeg' })
}

if (typeof window !== 'undefined') window.addEventListener('online', () => void run())
onDownloadsAllowedChange(() => void run())

/** Set by the player when signed in: where songs are downloaded from. Starts what is pending. */
export function setDownloadSource(next: typeof source) {
  source = next
  if (next) void reconcile()
}

/**
 * The download quality changed (the settings): every file is fetched again in the new one. Downloads stay downloads;
 * until a song is fetched again, it streams.
 */
export async function setDownloadQuality(quality: number | null) {
  if (index.quality === quality) return
  index.quality = quality
  // Library songs only: episodes are their host's file, the same in any quality.
  const songs = Object.keys(index.tracks).filter((id) => !id.startsWith('podcast:'))
  if (downloadsAvailable) {
    const cache = await caches.open(CACHE_NAME)
    for (const id of songs) await cache.delete(requestFor(id)).catch(() => undefined)
  }
  for (const id of songs) delete index.tracks[id]
  await reconcile()
}

/** Downloads a collection (or updates what it holds). */
export function downloadCollection(key: string, name: string, ids: string[], urls?: Record<string, string>, group?: string) {
  // Without persistent storage the browser may delete downloads again: said once more when starting one.
  if (!index.collections[key]) remindPersistentStorage()
  index.collections[key] = { name, ids: [...new Set(ids)], urls, group, added: index.collections[key]?.added ?? Date.now() }
  void reconcile()
}

/** The same, for a playlist that changed: songs it no longer has may move to the cache. */
function updateCollection(key: string, collection: Collection, ids: string[]) {
  index.collections[key] = { ...collection, ids }
  void reconcile(true)
}

/** Removes a collection's download (its songs stay while another download holds them). */
export function removeDownload(key: string) {
  delete index.collections[key]
  void reconcile()
}

/** Keeps a downloaded collection in step with its source (songs added or removed since). */
export function syncDownload(key: string, ids: string[]) {
  const collection = index.collections[key]
  if (!collection) return
  const next = [...new Set(ids)]
  if (next.length === collection.ids.length && next.every((id, position) => collection.ids[position] === id)) return
  updateCollection(key, collection, next)
}

/** Removes every download (the settings' button). */
export async function clearDownloads() {
  index = { quality: index.quality, tracks: {}, collections: {} }
  pending = []
  if (downloadsAvailable) await caches.delete(CACHE_NAME).catch(() => undefined)
  changed()
}

export const isDownloaded = (id: string | null | undefined) => !!id && !!index.tracks[id]


/** A playable address for a downloaded song, or null when it isn't downloaded. */
export async function downloadedAudioUrl(id: string | null | undefined): Promise<string | null> {
  if (!id || !downloadsAvailable || !index.tracks[id]) return null
  try {
    const response = await (await caches.open(CACHE_NAME)).match(requestFor(id))
    if (!response) {
      delete index.tracks[id]
      changed()
      void reconcile()
      return null
    }
    // A new object URL each time; the player releases it once no element plays it any more.
    return URL.createObjectURL(await response.blob())
  } catch {
    return null
  }
}

/** Whether a song is downloaded (re-renders when that changes). */
export function useIsDownloaded(id: string | null | undefined) {
  return useSyncExternalStore(subscribe, () => isDownloaded(id))
}

export type DownloadState =
  | { saved: false }
  | {
      saved: true
      done: number
      total: number
      /** The song of this collection being downloaded now, and how far (0–1). */
      current?: { id: string; share: number }
    }

const shareOf = (entry: NonNullable<typeof current>) => (entry.total ? Math.min(1, entry.received / entry.total) : 0)

/** Whether a collection is downloaded, and how far. */
export function useDownloadState(key: string): DownloadState {
  useSyncExternalStore(subscribe, () => version)
  const collection = index.collections[key]
  if (!collection) return { saved: false }
  const now = current && collection.ids.includes(current.id) ? { id: current.id, share: shareOf(current) } : undefined
  return { saved: true, done: collection.ids.filter((id) => index.tracks[id]).length, total: collection.ids.length, current: now }
}

/** A song's download: there, coming in now (how far, 0–1), waiting its turn, or none. */
export type TrackDownload = { state: 'done' } | { state: 'loading'; share: number } | { state: 'queued' } | null

export function useTrackDownload(id: string | null | undefined): TrackDownload {
  useSyncExternalStore(subscribe, () => version)
  if (!id) return null
  if (index.tracks[id]) return { state: 'done' }
  if (current?.id === id) return { state: 'loading', share: shareOf(current) }
  if (pending.includes(id)) return { state: 'queued' }
  return null
}

/** The library entries with downloads (their keys, and the podcasts of downloaded episodes). */
export function useDownloadedKeys(): Set<string> {
  useSyncExternalStore(subscribe, () => version)
  return new Set(Object.entries(index.collections).flatMap(([key, collection]) => (collection.group ? [key, collection.group] : [key])))
}

/** What is downloading now (how far) and what waits, in order; each with the collection it belongs to. */
export function useDownloadQueue() {
  useSyncExternalStore(subscribe, () => version)
  const collectionOf = (id: string) => Object.values(index.collections).find((collection) => collection.ids.includes(id))?.name
  return {
    current: current ? { id: current.id, share: shareOf(current), received: current.received, total: current.total, collection: collectionOf(current.id) } : null,
    pending: pending.filter((id) => id !== current?.id).map((id) => ({ id, collection: collectionOf(id) })),
  }
}

/** The downloaded collections and the songs each holds (for the offline library). */
export function downloadedCollections() {
  return Object.entries(index.collections).map(([key, collection]) => ({ key, ids: collection.ids }))
}

/** Everything downloaded, each with its size and how far it is (newest first). */
export function useDownloadList() {
  useSyncExternalStore(subscribe, () => version)
  return Object.entries(index.collections)
    .map(([key, collection]) => ({
      key,
      name: collection.name,
      added: collection.added,
      total: collection.ids.length,
      done: collection.ids.filter((id) => index.tracks[id]).length,
      bytes: collection.ids.reduce((sum, id) => sum + (index.tracks[id]?.bytes ?? 0), 0),
    }))
    .sort((a, b) => b.added - a.added)
}

/** How much is downloaded, and what is still to come. */
export function useDownloadStats() {
  useSyncExternalStore(subscribe, () => version)
  const files = Object.values(index.tracks)
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    pending: pending.length,
    collections: Object.keys(index.collections).length,
    quality: index.quality,
  }
}
