import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

/**
 * Songs kept in the browser (Cache Storage) so they start instantly and play without a connection: the next tracks
 * of the queue are downloaded ahead while one plays, and songs played often can stay for good. An index next to the
 * files (in localStorage) knows their sizes and how often and when each was played; past the size limit the least
 * valuable go first (rarely played, long ago). How far ahead and how much space is set per device in the settings.
 */
const CACHE_NAME = 'lumio-audio-v1'
const INDEX_KEY = 'lumio.audioCache.index'
/** Songs played this often count as "often played" (kept when that option is on). */
export const OFTEN_PLAYED = 3

export const audioCacheAvailable = typeof window !== 'undefined' && 'caches' in window

interface Entry {
  bytes: number
  plays: number
  lastPlayed: number
  added: number
}

type Index = Record<string, Entry>

let index: Index = (() => {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as Index
  } catch {
    return {}
  }
})()
let stats = summarize()
const listeners = new Set<() => void>()
interface Prefetch {
  job: Promise<void>
  controller: AbortController
  received: number
  total: number
}

const inFlight = new Map<string, Prefetch>()
/** The object URL handed to the audio element last; released when the next one is made. */
let lastUrl: string | null = null

function summarize() {
  const entries = Object.values(index)
  return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }
}

function saveIndex() {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch {
    // The index stays in memory for this visit.
  }
  stats = summarize()
  for (const listener of listeners) listener()
}

/** Cache Storage wants a URL as key; this one never goes over the network. */
const requestFor = (key: string) => new Request(`https://lumio.cache/audio/${encodeURIComponent(key)}`)

export function useAudioCacheStats() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => stats,
  )
}

export const isCached = (key: string) => !!index[key]

/**
 * A cached copy of a song (keys are `id|quality`): the one in `key`'s quality, else, when `anyQuality`, any other
 * quality kept (on mobile data or offline a song cached over Wi-Fi beats streaming it again).
 */
export function cachedKey(key: string, anyQuality: boolean): string | null {
  if (index[key]) return key
  if (!anyQuality) return null
  const prefix = key.slice(0, key.indexOf('|') + 1)
  if (!prefix) return null
  return Object.keys(index).find((other) => other.startsWith(prefix)) ?? null
}

/** A playable URL for a cached song, or null when it isn't cached (or the cache can't be read). */
export async function cachedAudioUrl(key: string): Promise<string | null> {
  if (!audioCacheAvailable || !index[key]) return null
  try {
    const response = await (await caches.open(CACHE_NAME)).match(requestFor(key))
    if (!response) {
      delete index[key]
      saveIndex()
      return null
    }
    if (lastUrl) URL.revokeObjectURL(lastUrl)
    lastUrl = URL.createObjectURL(await response.blob())
    return lastUrl
  } catch {
    return null
  }
}

/** Notes that a song was played (for keeping often played ones and for what to drop first). */
export function recordCachedPlay(key: string) {
  const entry = index[key]
  if (!entry) return
  index[key] = { ...entry, plays: entry.plays + 1, lastPlayed: Date.now() }
  saveIndex()
}

export interface CacheLimits {
  maxBytes: number
  keepOftenPlayed: boolean
}

/**
 * Downloads a song into the cache unless it is there already (or on its way); then trims the cache to the limit.
 * Runs at low priority and can be called off (`cancelPrefetches`): the song playing always goes first.
 */
export function prefetchAudio(key: string, url: string, limits: CacheLimits, plays = 0): Promise<void> {
  if (!audioCacheAvailable || index[key]) return Promise.resolve()
  const running = inFlight.get(key)
  if (running) return running.job
  const controller = new AbortController()
  const entry: Prefetch = { job: Promise.resolve(), controller, received: 0, total: 0 }
  entry.job = (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal, priority: 'low' } as RequestInit)
      if (!response.ok || !response.body) return
      entry.total = Number(response.headers.get('Content-Length')) || 0
      const parts: Uint8Array[] = []
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        entry.received += value.byteLength
      }
      const blob = new Blob(parts as BlobPart[], { type: response.headers.get('Content-Type') ?? 'audio/mpeg' })
      // A single file bigger than the whole allowance isn't kept.
      if (!blob.size || blob.size > limits.maxBytes) return
      const cache = await caches.open(CACHE_NAME)
      await cache.put(requestFor(key), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }))
      index[key] = { bytes: blob.size, plays, lastPlayed: Date.now(), added: Date.now() }
      saveIndex()
      await trim(limits, key)
    } catch {
      // Called off, offline, storage full or the server said no: the song simply streams as usual.
    } finally {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    }
  })()
  inFlight.set(key, entry)
  return entry.job
}

/** How far a song's download into the cache is (0–1; null when none runs or its size is unknown). */
export function prefetchProgress(key: string): number | null {
  const entry = inFlight.get(key)
  return entry?.total ? entry.received / entry.total : null
}

/** Waits for a running download of a song into the cache (resolves at once when none runs). */
export const prefetchDone = (key: string) => inFlight.get(key)?.job ?? Promise.resolve()

/** Calls off the downloads into the cache, all but `keep`'s: a song starting gets the whole connection. */
export function cancelPrefetches(keep?: string | null) {
  for (const [key, entry] of inFlight) if (key !== keep) entry.controller.abort()
}

/**
 * Takes a song the user had downloaded and no longer keeps (it left a downloaded playlist): it stays in the cache like
 * any other song, until room is needed. Counts as played once, so it isn't the very first to go.
 */
export async function adoptIntoCache(key: string, blob: Blob, limits: CacheLimits) {
  if (!audioCacheAvailable || index[key] || !blob.size || blob.size > limits.maxBytes) return
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(requestFor(key), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }))
    index[key] = { bytes: blob.size, plays: 1, lastPlayed: Date.now(), added: Date.now() }
    saveIndex()
    await trim(limits, key)
  } catch {
    // Storage full or blocked: the song is simply gone, as before.
  }
}

/**
 * Drops songs until the cache fits the limit: those played rarely and long ago first. Often played songs go last (or
 * never, when they are to be kept and there is anything else to drop). `keep` (the song just added) stays.
 */
async function trim(limits: CacheLimits, keep?: string) {
  let total = summarize().bytes
  if (total <= limits.maxBytes) return
  const often = (entry: Entry) => limits.keepOftenPlayed && entry.plays >= OFTEN_PLAYED
  const order = Object.entries(index)
    .filter(([key]) => key !== keep)
    .sort(([, a], [, b]) => Number(often(a)) - Number(often(b)) || a.plays - b.plays || a.lastPlayed - b.lastPlayed)
  const cache = await caches.open(CACHE_NAME)
  for (const [key, entry] of order) {
    if (total <= limits.maxBytes) break
    await cache.delete(requestFor(key))
    delete index[key]
    total -= entry.bytes
  }
  saveIndex()
}


/** What the browser allows this site to store, and whether it keeps it for good. */
export function useStorageInfo() {
  return useQuery({
    queryKey: ['storage-info', stats.bytes],
    enabled: !!navigator.storage?.estimate,
    queryFn: async () => {
      const [estimate, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? Promise.resolve(false)])
      return { quota: estimate.quota ?? 0, usage: estimate.usage ?? 0, persisted }
    },
  })
}

/** Applies a new limit right away (the settings). */
export function trimAudioCache(limits: CacheLimits) {
  if (audioCacheAvailable) void trim(limits).catch(() => undefined)
}

/** Empties the cache (the settings' button). */
export async function clearAudioCache() {
  if (audioCacheAvailable) await caches.delete(CACHE_NAME).catch(() => undefined)
  index = {}
  saveIndex()
}
