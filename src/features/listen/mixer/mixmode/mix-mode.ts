import { useSyncExternalStore } from 'react'
import type { LumioFetch } from '@/features/social/social'
import type { PreviewSource } from '../preview'
import { pairKey, type Transition } from '../types'
import type { Window } from './windows'

/**
 * "Mix-Modus" of a playlist (spec §4, Tier B): entering it pre-heats the playlist (the server separates stems for the
 * windows around its transitions), so the editor and playback can use real stems; leaving it bakes each hand-made
 * transition of neighbouring songs into a clip (with the real stems), stores it with the transition and lets the stems
 * go. Which playlists are in it, and a bake under way, are kept on this device, so a reload goes on where it was.
 */

export type MixModeState =
  | { phase: 'on'; since: number }
  /** Leaving: the pairs (pair keys) still to bake, and those that couldn't be. */
  | { phase: 'baking'; since: number; pending: string[]; done: number; failed: string[] }

const KEY = 'lumio.mixmode'
const listeners = new Set<() => void>()
let states: Record<string, MixModeState> = (() => {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, MixModeState>) ?? {}
  } catch {
    return {}
  }
})()

export function setMixMode(playlistId: string, state: MixModeState | null) {
  const { [playlistId]: _previous, ...rest } = states
  states = state ? { ...rest, [playlistId]: state } : rest
  try {
    localStorage.setItem(KEY, JSON.stringify(states))
  } catch {
    // Not remembered: a reload leaves Mix-Modus without baking (the stems expire on the server).
  }
  for (const listener of listeners) listener()
}

export const mixModeOf = (playlistId: string): MixModeState | null => states[playlistId] ?? null
export const mixModes = () => states

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useMixMode(playlistId: string): MixModeState | null {
  return useSyncExternalStore(subscribe, () => states[playlistId] ?? null)
}

export function useMixModes(): Record<string, MixModeState> {
  return useSyncExternalStore(subscribe, () => states)
}

// ---- the server (analysis' routes) ----

export type StemName = 'vocals' | 'drums' | 'bass' | 'other'

export interface StemWindowStatus {
  window: { id: string; start: number; end: number }
  state: 'queued' | 'running' | 'failed' | 'ready' | 'missing'
  stems: StemName[]
  error?: string
}

export type PreheatAnswer = { queued: number; ready: number } | 'unavailable' | 'forbidden' | 'failed'

/** Asks for the songs' stems (their windows), held for the playlist. 'unavailable': the server has no stem worker. */
export async function preheat(lumioFetch: LumioFetch, playlistId: string, items: Array<{ id: string; windows: Window[] }>): Promise<PreheatAnswer> {
  const response = await lumioFetch('/music/stems/preheat', { method: 'POST', body: JSON.stringify({ playlistId, items }) }).catch(() => null)
  if (!response) return 'failed'
  if (response.status === 503) return 'unavailable'
  if (response.status === 403) return 'forbidden'
  if (!response.ok) return 'failed'
  return (await response.json()) as { queued: number; ready: number }
}

/** Lets go of the playlist's stems (the server deletes those no other playlist holds). */
export async function releaseStems(lumioFetch: LumioFetch, playlistId: string) {
  await lumioFetch('/music/stems/release', { method: 'POST', body: JSON.stringify({ playlistId }) }).catch(() => null)
}

/** Per song, its windows' state (≤ 400 songs a call). */
export async function stemStatus(lumioFetch: LumioFetch, ids: readonly string[]): Promise<Record<string, StemWindowStatus[]>> {
  const out: Record<string, StemWindowStatus[]> = {}
  for (let start = 0; start < ids.length; start += 400) {
    const response = await lumioFetch(`/music/stems/status?ids=${ids.slice(start, start + 400).join(',')}`)
    if (!response.ok) throw new Error(`Lumio server ${response.status}`)
    Object.assign(out, (await response.json()) as Record<string, StemWindowStatus[]>)
  }
  return out
}

/** Where a song stands: all its windows separated, some still coming, or one failed. */
export function songStemState(windows: readonly StemWindowStatus[] | undefined): 'ready' | 'waiting' | 'failed' | 'none' {
  if (!windows?.length) return 'none'
  if (windows.some((w) => w.state === 'failed')) return 'failed'
  return windows.every((w) => w.state === 'ready') ? 'ready' : 'waiting'
}

/** One stem of a window, decoded (FLAC from the server), with its place in the song. */
export async function loadStem(lumioFetch: LumioFetch, item: string, window: StemWindowStatus['window'], stem: StemName, context: BaseAudioContext): Promise<PreviewSource> {
  const response = await lumioFetch(`/music/stems/${item}/${window.id}/${stem}`)
  if (!response.ok) throw new Error(`Stem not available (${response.status})`)
  const decoded = await context.decodeAudioData(await response.arrayBuffer())
  const channels = [0, 1].map((c) => decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1)).slice())
  return { channels, origin: window.start, sampleRate: decoded.sampleRate }
}

/** Two stems played as one (the instrumental: bass and the rest), sample by sample. */
export function mixSources(x: PreviewSource, y: PreviewSource): PreviewSource {
  const length = Math.min(x.channels[0]!.length, y.channels[0]!.length)
  const channels = [0, 1].map((c) => {
    const out = new Float32Array(length)
    const p = x.channels[Math.min(c, x.channels.length - 1)]!
    const q = y.channels[Math.min(c, y.channels.length - 1)]!
    for (let i = 0; i < length; i++) out[i] = p[i]! + q[i]!
    return out
  })
  return { channels, origin: x.origin, sampleRate: x.sampleRate }
}

/**
 * Leaving Mix-Modus: every hand-made transition of songs that are neighbours now goes to the baking (one already baked
 * as it is is skipped there), which lets the stems go when done; without any, they are let go at once.
 */
export function leaveMixMode(lumioFetch: LumioFetch, playlistId: string, order: readonly string[], transitions: Readonly<Record<string, Transition>> | undefined) {
  const pending = [...new Set(order.slice(1).map((to, i) => pairKey(order[i]!, to)).filter((pair) => transitions?.[pair]?.custom))]
  if (!pending.length) {
    void releaseStems(lumioFetch, playlistId)
    setMixMode(playlistId, null)
    return
  }
  setMixMode(playlistId, { phase: 'baking', since: Date.now(), pending, done: 0, failed: [] })
}
