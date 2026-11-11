import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { useSocialUrl, type LumioFetch } from '@/features/social/social'
import { camelotLabel } from './camelot'
import { MIX_VERSION, type MixStyle, type PlaylistMixer, type TrackMix, type Transition } from './types'

/**
 * The mixer mode's data from the Lumio server:
 * - a playlist's mixer settings (`/music/mixer/<id>`): on/off, style, stored transitions. Small, kept like other
 *   playlist data; saving updates the cache at once and goes back on failure.
 * - the whole-track analyses (`/music/mix?ids=…`), one query per song. They only change with `MIX_VERSION` (part of
 *   the key), so a found one stays fresh for good. A song not analysed yet comes back as null and is queued on the
 *   server by the asking; such nulls are asked again after a while, as they fill in. Single asks made in the same
 *   moment travel together, up to 200 ids a request. Analyses are large (tens of kilobytes a song), so they are not
 *   written to the browser's kept query cache (see lib/query-persist.ts).
 */

export const DEFAULT_MIXER: PlaylistMixer = { on: false, style: 'clean', transitions: {}, updated: 0 }

/** A null analysis is asked for again after this long (the server works through its queue a song every few seconds). */
const NULL_RETRY_MS = 60_000
/** Analyses stay in memory this long after nothing uses them. */
const MIX_GC_MS = 30 * 60_000
/** Most ids the server takes in one request. */
const BATCH = 200

/**
 * A fetch to the Lumio server that stays the same function while the session does (`useLumioFetch` makes a new one on
 * every render, which would restart effects that depend on it).
 */
export function useStableLumioFetch(): LumioFetch {
  const { session } = useAuthedSession()
  const base = useSocialUrl()
  const token = session.accessToken
  return useMemo<LumioFetch>(
    () => (path, init) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { Authorization: `MediaBrowser Token="${token}"`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
      }),
    [base, token],
  )
}

// ---- playlist mixer settings ----

/** The playlist a queue source names (`playlist:<id>`), or null for albums, artists, official playlists, podcasts … */
export function playlistOfSource(source: string | null | undefined): string | null {
  const match = source?.match(/^playlist:([0-9a-f]{32})$/i)
  return match ? match[1]! : null
}

export const mixerKey = (playlistId: string) => ['playlist-mixer', playlistId] as const

const isStyle = (value: unknown): value is MixStyle => value === 'clean' || value === 'party'

/** The settings as the server sent them, with anything missing or odd filled in from the default. */
function readMixer(raw: unknown): PlaylistMixer {
  if (!raw || typeof raw !== 'object') return DEFAULT_MIXER
  const value = raw as Partial<PlaylistMixer>
  return {
    on: value.on === true,
    style: isStyle(value.style) ? value.style : 'clean',
    transitions: value.transitions && typeof value.transitions === 'object' ? (value.transitions as Record<string, Transition>) : {},
    updated: typeof value.updated === 'number' && Number.isFinite(value.updated) ? value.updated : 0,
  }
}

export function mixerOptions(lumioFetch: LumioFetch, playlistId: string) {
  return {
    queryKey: mixerKey(playlistId),
    queryFn: async (): Promise<PlaylistMixer> => {
      const response = await lumioFetch(`/music/mixer/${playlistId}`)
      // Not visible to this person (or gone): nothing to mix.
      if (response.status === 404) return DEFAULT_MIXER
      if (!response.ok) throw new Error(`Lumio server ${response.status}`)
      return readMixer(await response.json())
    },
  }
}

/** A playlist's mixer settings (off while unknown: no Lumio server, not loaded yet). */
export function usePlaylistMixer(playlistId: string | null | undefined) {
  const lumioFetch = useStableLumioFetch()
  return useQuery({ ...mixerOptions(lumioFetch, playlistId ?? ''), enabled: !!playlistId })
}

/** Why saving the settings failed: 403 (not an editor), 409 (someone else saved in between), anything else. */
export class MixerSaveError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Saving the mixer settings failed (${status})`)
    this.status = status
  }
}

export type MixerChange = Partial<Pick<PlaylistMixer, 'on' | 'style' | 'transitions'>>

/**
 * Saves changes to a playlist's mixer settings (only its editors may). The page shows them at once; on failure it goes
 * back to what was there, or, when someone else saved in between (409), to what they saved.
 */
export function useSaveMixer(playlistId: string) {
  const lumioFetch = useStableLumioFetch()
  const queryClient = useQueryClient()
  const key = mixerKey(playlistId)
  return useMutation({
    // One save after the other: each sends the `updated` the previous one got back (else the server sees a conflict).
    scope: { id: `playlist-mixer:${playlistId}` },
    // The change itself is already in the cache by now (onMutate runs first): the whole settings are sent.
    mutationFn: async (_change: MixerChange) => {
      const current = queryClient.getQueryData<PlaylistMixer>(key) ?? DEFAULT_MIXER
      // The optimistic copy carries the `updated` it was based on, which is what the server checks against.
      const response = await lumioFetch(`/music/mixer/${playlistId}`, { method: 'PUT', body: JSON.stringify(current) })
      if (response.status === 409) {
        queryClient.setQueryData(key, readMixer(await response.json().catch(() => null)))
        throw new MixerSaveError(409)
      }
      if (!response.ok) throw new MixerSaveError(response.status)
      return readMixer(await response.json())
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<PlaylistMixer>(key)
      queryClient.setQueryData<PlaylistMixer>(key, { ...(previous ?? DEFAULT_MIXER), ...change })
      return { previous }
    },
    onError: (error, _change, context) => {
      // A conflict already put the other person's settings in place.
      if (error instanceof MixerSaveError && error.status === 409) return
      queryClient.setQueryData(key, context?.previous ?? DEFAULT_MIXER)
    },
    onSuccess: (saved) => queryClient.setQueryData(key, saved),
  })
}

// ---- whole-track analyses ----

export const mixKey = (id: string) => ['track-mix', MIX_VERSION, id] as const

/** An analysis this version of the planner can use, or null. */
function readMix(raw: unknown): TrackMix | null {
  if (!raw || typeof raw !== 'object') return null
  const mix = raw as TrackMix
  return mix.v === MIX_VERSION && Number.isFinite(mix.duration) && mix.duration > 0 ? mix : null
}

interface Waiting {
  id: string
  resolve: (mix: TrackMix | null) => void
  reject: (error: unknown) => void
}

let waiting: Waiting[] = []
let waitingFetch: LumioFetch | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

async function flush() {
  flushTimer = null
  const batch = waiting
  const lumioFetch = waitingFetch!
  waiting = []
  waitingFetch = null
  const byId = new Map<string, Waiting[]>()
  for (const entry of batch) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
  const ids = [...byId.keys()]
  await Promise.all(
    Array.from({ length: Math.ceil(ids.length / BATCH) }, async (_, part) => {
      const chunk = ids.slice(part * BATCH, (part + 1) * BATCH)
      try {
        const response = await lumioFetch(`/music/mix?ids=${chunk.join(',')}`)
        if (!response.ok) throw new Error(`Lumio server ${response.status}`)
        const found = (await response.json()) as Record<string, unknown>
        for (const id of chunk) for (const entry of byId.get(id)!) entry.resolve(readMix(found[id]))
      } catch (error) {
        for (const id of chunk) for (const entry of byId.get(id)!) entry.reject(error)
      }
    }),
  )
}

/** One song's analysis; asks made in the same moment go out together. */
function loadMix(lumioFetch: LumioFetch, id: string): Promise<TrackMix | null> {
  return new Promise((resolve, reject) => {
    waiting.push({ id, resolve, reject })
    waitingFetch ??= lumioFetch
    flushTimer ??= setTimeout(() => void flush(), 0)
  })
}

/** The server only knows Jellyfin's 32-digit ids (other items, like podcast episodes, are never mixed). */
export const analysable = (id: string | null | undefined): id is string => !!id && /^[0-9a-f]{32}$/i.test(id)

export function mixOptions(lumioFetch: LumioFetch, id: string) {
  return {
    queryKey: mixKey(id),
    queryFn: () => loadMix(lumioFetch, id),
    // Found analyses never go stale (a new analysis comes with a new MIX_VERSION, a new key); nulls do, as they fill in.
    staleTime: (query: { state: { data: TrackMix | null | undefined } }) => (query.state.data ? Infinity : NULL_RETRY_MS),
    gcTime: MIX_GC_MS,
    retry: 1,
  }
}

/** The analyses of these songs as far as they are known now, by id (fetched when missing, within `timeoutMs`). */
export async function fetchMixes(queryClient: QueryClient, lumioFetch: LumioFetch, ids: readonly string[], timeoutMs: number): Promise<Map<string, TrackMix | null>> {
  const wanted = [...new Set(ids.filter(analysable))]
  const settled = Promise.allSettled(wanted.map((id) => queryClient.fetchQuery(mixOptions(lumioFetch, id))))
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([settled, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
  clearTimeout(timer)
  return new Map(wanted.map((id) => [id, queryClient.getQueryData<TrackMix | null>(mixKey(id)) ?? null]))
}

/** Starts loading analyses ahead (for the songs coming up next). */
export function prefetchMixes(queryClient: QueryClient, lumioFetch: LumioFetch, ids: readonly string[]) {
  for (const id of new Set(ids.filter(analysable))) void queryClient.prefetchQuery(mixOptions(lumioFetch, id))
}

export interface MixesState {
  /** By id: the analysis, null while there is none (yet), absent while loading. */
  mixes: Map<string, TrackMix | null>
  /** Songs with an analysis, songs asked about, and whether all have answered once. */
  analysed: number
  total: number
  loaded: boolean
  /** Asks again for the songs without an analysis. */
  refresh: () => void
}

/**
 * The analyses of a playlist's songs. With `pollMs`, songs without one are asked again that often (the server analyses
 * them meanwhile), so a dialog can show them coming in.
 */
export function useTrackMixes(ids: readonly string[], options: { enabled?: boolean; pollMs?: number } = {}): MixesState {
  const lumioFetch = useStableLumioFetch()
  const queryClient = useQueryClient()
  const enabled = options.enabled ?? true
  // Disabled, no queries are made at all (a long playlist would otherwise hold one idle observer per song).
  const unique = useMemo(() => (enabled ? [...new Set(ids.filter(analysable))] : []), [ids, enabled])
  const results = useQueries({
    queries: unique.map((id) => ({
      ...mixOptions(lumioFetch, id),
      enabled,
      refetchInterval: options.pollMs ? (query: { state: { data: TrackMix | null | undefined } }) => (query.state.data ? false : options.pollMs!) : undefined,
    })),
  })
  // A new Map only when an answer changed, so what is computed from it isn't redone on every render.
  const signature = results.map((result) => (result.data === undefined ? 'u' : result.data ? 'm' : 'n')).join('')
  const mixes = useMemo(() => {
    const map = new Map<string, TrackMix | null>()
    unique.forEach((id, index) => {
      const data = results[index]?.data
      if (data !== undefined) map.set(id, data)
    })
    return map
    // `results` is a new array on every render; the signature says when its answers changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, signature])
  return {
    mixes,
    analysed: results.filter((result) => !!result.data).length,
    total: unique.length,
    loaded: results.every((result) => result.data !== undefined || result.isError),
    refresh: () => {
      for (const id of unique) if (!queryClient.getQueryData(mixKey(id))) void queryClient.refetchQueries({ queryKey: mixKey(id), exact: true })
    },
  }
}

/**
 * Tempo and key of a playlist's songs as the mixer sees them ("124 BPM · 8A"), by id, for the rows of a mixer
 * playlist; '' for a song without an analysis yet.
 */
export function useMixInfo(ids: readonly string[], enabled: boolean): Record<string, string> {
  const { mixes } = useTrackMixes(ids, { enabled })
  return useMemo(() => {
    const info: Record<string, string> = {}
    for (const id of ids) {
      const mix = mixes.get(id)
      if (!mix) {
        info[id] = ''
        continue
      }
      const key = camelotLabel(mix.key, mix.minor)
      info[id] = [mix.bpm > 0 ? `${Math.round(mix.bpm)} BPM` : '', key].filter(Boolean).join(' · ')
    }
    return info
  }, [ids, mixes])
}
