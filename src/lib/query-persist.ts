import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query'

/**
 * Keeps the data the app last loaded (home rows, albums, playlists, artists …) in the browser's IndexedDB, so the next
 * start shows it at once and refreshes it in the background instead of waiting for the server. Data older than a week
 * is dropped; signing out clears it.
 */
const DB_NAME = 'lumio'
const STORE = 'kv'
const KEY = 'query-cache-v1'
const MAX_AGE_MS = 7 * 24 * 60 * 60_000
const SAVE_AFTER_MS = 2000
/** Restoring may hold the first render this long at most; a slow disk mustn't slow the start down. */
export const RESTORE_TIMEOUT_MS = 400

/**
 * Queries not worth keeping: typed searches, answers that change by the minute, what the browser measures itself, the
 * mixer's whole-track analyses (tens of kilobytes a song; the server has them at hand) and playlists' mixer settings
 * (their transitions add up, and an old copy would make a playlist mix or not mix by what it was once).
 * Never stream info ('playback'): it holds one playback's session and, for a stored episode, a blob: URL that is dead
 * after a restart; restored, the player opened that dead address and the title "could not be played".
 */
const SKIP = new Set([
  'storage-info', 'podcast-search', 'places', 'dominant-color', 'playlist-infos', 'remote-sessions', 'server-clock-offset',
  'playback', 'track-mix', 'playlist-mixer',
])

interface Saved {
  savedAt: number
  state: ReturnType<typeof dehydrate>
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const request = action(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).finally(() => db.close())
}

const available = () => typeof indexedDB !== 'undefined'

/** Puts the saved data back into the client (before the first render). */
export async function restoreQueryCache(client: QueryClient) {
  if (!available()) return
  try {
    const saved = (await run('readonly', (store) => store.get(KEY))) as Saved | undefined
    // Filtered here too: data saved by an older version may hold what is skipped now.
    if (saved && Date.now() - saved.savedAt < MAX_AGE_MS) hydrate(client, { ...saved.state, queries: saved.state.queries.filter((query) => !SKIP.has(String(query.queryKey[0]))) })
  } catch {
    // Nothing kept (or the browser blocks IndexedDB): the app loads from the server as usual.
  }
}

const keep = (query: Query) => query.state.status === 'success' && !SKIP.has(String(query.queryKey[0]))

/** Saves the client's data a moment after it changes, from now on. */
export function persistQueryCache(client: QueryClient) {
  if (!available()) return () => undefined
  let timer: number | undefined
  const unsubscribe = client.getQueryCache().subscribe(() => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const saved: Saved = { savedAt: Date.now(), state: dehydrate(client, { shouldDehydrateQuery: keep }) }
      void run('readwrite', (store) => store.put(saved, KEY)).catch(() => undefined)
    }, SAVE_AFTER_MS)
  })
  return () => {
    window.clearTimeout(timer)
    unsubscribe()
  }
}

/** About how much the kept data takes (its size as text). */
export async function persistedQueryBytes() {
  if (!available()) return 0
  try {
    const saved = await run('readonly', (store) => store.get(KEY))
    return saved ? new Blob([JSON.stringify(saved)]).size : 0
  } catch {
    return 0
  }
}

/** Forgets the saved data (signing out, or the settings' clear button). */
export async function clearPersistedQueries() {
  if (!available()) return
  await run('readwrite', (store) => store.delete(KEY)).catch(() => undefined)
}
