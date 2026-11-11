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

/** Why saving the settings failed: 403 (not an editor), 409 (someone else saved in between; `current` is theirs), other. */
export class MixerSaveError extends Error {
  readonly status: number
  readonly current: PlaylistMixer | null
  constructor(status: number, current: PlaylistMixer | null = null) {
    super(`Saving the mixer settings failed (${status})`)
    this.status = status
    this.current = current
  }
}

export type MixerChange = Partial<Pick<PlaylistMixer, 'on' | 'style' | 'transitions'>>

interface PendingSave {
  change: MixerChange
}

/** Saves under way per playlist, oldest first: what is answered later must not undo a change still waiting. */
const pendingSaves = new Map<string, PendingSave[]>()

/** The changes made after this save, merged (the newest wins), which the settings shown must keep. */
function changesAfter(playlistId: string, save: PendingSave | undefined): MixerChange {
  const list = pendingSaves.get(playlistId) ?? []
  const index = save ? list.indexOf(save) : -1
  return Object.assign({}, ...list.slice(index + 1).map((entry) => entry.change)) as MixerChange
}

/**
 * Saves changes to a playlist's mixer settings (only its editors may). The page shows them at once.
 *
 * Saves of one playlist run one after the other (a mutation scope). Each sends its own change on top of the settings
 * as they are by then, with the `updated` the previous save got back; the server turns down a save based on an older
 * one (409). Whatever answers, changes made after it and not yet saved stay in place: on success the server's settings
 * plus those; on failure only this change goes back, and on a 409 the other person's settings come in, plus those.
 */
export function useSaveMixer(playlistId: string) {
  const lumioFetch = useStableLumioFetch()
  const queryClient = useQueryClient()
  const key = mixerKey(playlistId)
  return useMutation({
    scope: { id: `playlist-mixer:${playlistId}` },
    mutationFn: async (change: MixerChange) => {
      const latest = queryClient.getQueryData<PlaylistMixer>(key) ?? DEFAULT_MIXER
      // `latest.updated` is the server's (changes shown early never touch it).
      const body: PlaylistMixer = { ...latest, ...change, updated: latest.updated }
      const response = await lumioFetch(`/music/mixer/${playlistId}`, { method: 'PUT', body: JSON.stringify(body) })
      if (response.status === 409) throw new MixerSaveError(409, readMixer(await response.json().catch(() => null)))
      if (!response.ok) throw new MixerSaveError(response.status)
      return readMixer(await response.json())
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<PlaylistMixer>(key) ?? DEFAULT_MIXER
      const save: PendingSave = { change }
      pendingSaves.set(playlistId, [...(pendingSaves.get(playlistId) ?? []), save])
      queryClient.setQueryData<PlaylistMixer>(key, { ...previous, ...change })
      return { previous, save }
    },
    onSuccess: (saved, _change, context) => queryClient.setQueryData<PlaylistMixer>(key, { ...saved, ...changesAfter(playlistId, context?.save) }),
    onError: (error, change, context) => {
      const later = changesAfter(playlistId, context?.save)
      if (error instanceof MixerSaveError && error.status === 409 && error.current) {
        queryClient.setQueryData<PlaylistMixer>(key, { ...error.current, ...later })
        return
      }
      // Only this change goes back (to what was shown before it).
      const previous = context?.previous ?? DEFAULT_MIXER
      const undone = Object.fromEntries(Object.keys(change).map((field) => [field, previous[field as keyof MixerChange]])) as MixerChange
      queryClient.setQueryData<PlaylistMixer>(key, (current) => ({ ...(current ?? DEFAULT_MIXER), ...undone, ...later }))
    },
    onSettled: (_data, _error, _change, context) => {
      const rest = (pendingSaves.get(playlistId) ?? []).filter((entry) => entry !== context?.save)
      if (rest.length) pendingSaves.set(playlistId, rest)
      else pendingSaves.delete(playlistId)
    },
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

/** Tempo and key of a song as the whole-track analysis found them (`/music/mix?summary=1`), for showing them. */
export interface MixSummary {
  bpm: number
  bpmConfidence: number
  key: number
  minor: boolean
  keyClarity: number
  duration: number
}

export const mixSummaryKey = (id: string) => ['track-mix-summary', MIX_VERSION, id] as const

function readSummary(raw: unknown): MixSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as MixSummary
  return [value.bpm, value.key, value.duration].every((x) => typeof x === 'number' && Number.isFinite(x)) ? value : null
}

interface Waiting {
  id: string
  resolve: (answer: unknown) => void
  reject: (error: unknown) => void
}

type Kind = 'full' | 'summary'

/** Asks made in the same moment, per kind of answer, and the fetch they go out with. */
const batches: Record<Kind, { waiting: Waiting[]; fetch: LumioFetch | null; timer: ReturnType<typeof setTimeout> | null }> = {
  full: { waiting: [], fetch: null, timer: null },
  summary: { waiting: [], fetch: null, timer: null },
}

async function flush(kind: Kind) {
  const batch = batches[kind]
  const waiting = batch.waiting
  const lumioFetch = batch.fetch!
  batch.waiting = []
  batch.fetch = null
  batch.timer = null
  const byId = new Map<string, Waiting[]>()
  for (const entry of waiting) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry])
  const ids = [...byId.keys()]
  await Promise.all(
    Array.from({ length: Math.ceil(ids.length / BATCH) }, async (_, part) => {
      const chunk = ids.slice(part * BATCH, (part + 1) * BATCH)
      try {
        const response = await lumioFetch(`/music/mix?ids=${chunk.join(',')}${kind === 'summary' ? '&summary=1' : ''}`)
        if (!response.ok) throw new Error(`Lumio server ${response.status}`)
        const found = (await response.json()) as Record<string, unknown>
        for (const id of chunk) for (const entry of byId.get(id)!) entry.resolve(found[id])
      } catch (error) {
        for (const id of chunk) for (const entry of byId.get(id)!) entry.reject(error)
      }
    }),
  )
}

/** One song's answer from `/music/mix`; asks of the same kind made in the same moment go out together. */
function load(kind: Kind, lumioFetch: LumioFetch, id: string): Promise<unknown> {
  const batch = batches[kind]
  return new Promise((resolve, reject) => {
    batch.waiting.push({ id, resolve, reject })
    batch.fetch ??= lumioFetch
    batch.timer ??= setTimeout(() => void flush(kind), 0)
  })
}

/** The server only knows Jellyfin's 32-digit ids (other items, like podcast episodes, are never mixed). */
export const analysable = (id: string | null | undefined): id is string => !!id && /^[0-9a-f]{32}$/i.test(id)

export function mixOptions(lumioFetch: LumioFetch, id: string) {
  return {
    queryKey: mixKey(id),
    queryFn: async () => readMix(await load('full', lumioFetch, id)),
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

export function mixSummaryOptions(lumioFetch: LumioFetch, id: string) {
  return {
    queryKey: mixSummaryKey(id),
    queryFn: async () => readSummary(await load('summary', lumioFetch, id)),
    staleTime: (query: { state: { data: MixSummary | null | undefined } }) => (query.state.data ? Infinity : NULL_RETRY_MS),
    retry: 1,
  }
}

/**
 * Tempo and key of a playlist's songs as the mixer sees them ("124 BPM · 8A"), by id, for the rows of a mixer
 * playlist; '' for a song without an analysis yet. Only the small summaries are fetched, not the whole analyses.
 */
export function useMixInfo(ids: readonly string[], enabled: boolean): Record<string, string> {
  const lumioFetch = useStableLumioFetch()
  const unique = useMemo(() => (enabled ? [...new Set(ids.filter(analysable))] : []), [ids, enabled])
  const results = useQueries({ queries: unique.map((id) => mixSummaryOptions(lumioFetch, id)) })
  const signature = results.map((result) => (result.data ? `${Math.round(result.data.bpm)}:${result.data.key}:${result.data.minor}` : '')).join(',')
  return useMemo(() => {
    const info: Record<string, string> = {}
    unique.forEach((id, index) => {
      const summary = results[index]?.data
      if (!summary) return void (info[id] = '')
      const key = camelotLabel(summary.key, summary.minor)
      info[id] = [summary.bpm > 0 ? `${Math.round(summary.bpm)} BPM` : '', key].filter(Boolean).join(' · ')
    })
    return info
    // `results` is a new array on every render; the signature says when its answers changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, signature])
}
