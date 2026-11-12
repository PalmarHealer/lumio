import type { Api } from '@jellyfin/sdk'
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api'
import type { LumioFetch } from '@/features/social/social'
import { ticksToSeconds } from '@/lib/format'
import { bakeKey, bakeTransition, clipRange, ENGINE_VERSION, sourceIdentity, wav24 } from '../baked'
import { deckPlan, trackSpan } from '../deck-schedule'
import { loadDeckAudio } from '../editor/audio'
import type { PreviewSource } from '../preview'
import type { RenderStems } from '../render'
import type { PlaylistMixer, Transition } from '../types'
import { laneStems, stemsToLoad } from './lane-stems'
import { loadStem, stemStatus, type StemWindowStatus } from './mix-mode'
import { covered, MAX_SONG } from './windows'

/**
 * Baking one transition when a playlist leaves Mix-Modus: both songs' audio (as far as the clip reaches) and their real
 * stems where they are separated, rendered by the engine into a clip (deck A's and deck B's parts), uploaded in the
 * server's order (what the clip is first, then its parts) and referenced from the transition. The player then plays
 * A → clip → B, and falls back to playing the transition live on any mismatch.
 */

export interface BakeDeps {
  api: Api
  userId: string
  accessToken: string
  deviceId: string
  lumioFetch: LumioFetch
}

/** Bakes audio at this rate (the engine caps clips at 48 kHz). */
const RATE = 44_100

const toBuffer = (source: PreviewSource) => {
  const buffer = new AudioBuffer({ length: source.channels[0]!.length, numberOfChannels: 2, sampleRate: source.sampleRate })
  for (let c = 0; c < 2; c++) buffer.copyToChannel(source.channels[Math.min(c, source.channels.length - 1)]! as Float32Array<ArrayBuffer>, c)
  return buffer
}

/** The song's real stems over [from, to] of its track, when one separated window covers it; else none (approximated). */
async function stemsFor(deps: BakeDeps, item: string, windows: StemWindowStatus[] | undefined, from: number, to: number, duration: number, context: BaseAudioContext): Promise<RenderStems | undefined> {
  // A second to spare either side, but never past the song (or what the server separates): the windows end there.
  const end = Math.min(to + 1, duration > 0 ? duration : Infinity, MAX_SONG)
  const window = windows?.find((w) => w.state === 'ready' && covered([w.window], Math.max(0, from - 1), end))
  if (!window) return undefined
  const names = stemsToLoad()
  const loaded = await Promise.all(names.map((stem) => loadStem(deps.lumioFetch, item, window.window, stem, context)))
  const placed = (source: PreviewSource) => ({ buffer: toBuffer(source), origin: source.origin })
  return laneStems(Object.fromEntries(names.map((stem, i) => [stem, placed(loaded[i]!)])))
}

/** Bakes a transition and uploads its clip; returns the clip's key. */
export async function bakePair(deps: BakeDeps, playlistId: string, items: { a: BaseItemDto; b: BaseItemDto }, transition: Transition): Promise<string> {
  const from = items.a.Id!
  const to = items.b.Id!
  const { start, end } = clipRange(transition)
  const reachA = trackSpan(deckPlan(transition, 'a'), start, transition.length + 0.1)
  const reachB = trackSpan(deckPlan(transition, 'b'), transition.bAt, end)
  const decode = new OfflineAudioContext(2, 1, RATE)
  const common = { api: deps.api, userId: deps.userId, accessToken: deps.accessToken, deviceId: deps.deviceId, context: decode }
  const [a, b, status] = await Promise.all([
    loadDeckAudio({ ...common, id: from, until: reachA.to + 2 }),
    loadDeckAudio({ ...common, id: to, until: reachB.to + 2 }),
    stemStatus(deps.lumioFetch, [from, to]).catch(() => ({}) as Record<string, StemWindowStatus[]>),
  ])
  const [stemsA, stemsB] = await Promise.all([
    stemsFor(deps, from, status[from], reachA.from, reachA.to, ticksToSeconds(items.a.RunTimeTicks ?? 0), decode).catch(() => undefined),
    stemsFor(deps, to, status[to], reachB.from, reachB.to, ticksToSeconds(items.b.RunTimeTicks ?? 0), decode).catch(() => undefined),
  ])
  const clip = await bakeTransition({ a: toBuffer(a), b: toBuffer(b), transition, stems: { a: stemsA, b: stemsB } })
  const key = await bakeKey({ playlist: playlistId, transition, a: sourceIdentity(items.a), b: sourceIdentity(items.b) })

  const put = async (path: string, init: RequestInit) => {
    const response = await deps.lumioFetch(path, { method: 'PUT', ...init })
    if (!response.ok) throw new Error(`Lumio server ${response.status}`)
  }
  // What the clip is, first (the server only takes parts of a clip it knows), then its two parts.
  await put(`/music/mix/baked/${key}`, { body: JSON.stringify({ playlistId, from, to, start: clip.start, length: clip.length, engine: ENGINE_VERSION }) })
  for (const part of ['a', 'b'] as const)
    await put(`/music/mix/baked/${key}?part=${part}`, { body: wav24(clip[part], clip.sampleRate), headers: { 'Content-Type': 'audio/wav' } })
  return key
}

/**
 * Stores the clip's key on the pair's transition (the server fills in where the clip is), on top of the settings as
 * they are now; once more when someone else saved in between (409). False when the pair's transition has changed
 * since it was baked (the clip belongs to the old one; the server frees clips nothing refers to).
 */
export async function attachBaked(lumioFetch: LumioFetch, playlistId: string, pair: string, key: string, sources: { a: string; b: string }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = (await (await lumioFetch(`/music/mixer/${playlistId}`)).json()) as PlaylistMixer
    const transition = current.transitions?.[pair]
    if (!transition || (await bakeKey({ playlist: playlistId, transition, ...sources })) !== key) return false
    const baked = { key, url: '', start: 0, length: 0 }
    const body: PlaylistMixer = { ...current, transitions: { ...current.transitions, [pair]: { ...transition, baked } } }
    const response = await lumioFetch(`/music/mixer/${playlistId}`, { method: 'PUT', body: JSON.stringify(body) })
    if (response.ok) return true
    if (response.status !== 409) throw new Error(`Lumio server ${response.status}`)
  }
  throw new Error('Conflicting saves')
}

/**
 * After the playlist's order changed: baked clips of pairs that are no longer neighbours are let go (their transitions
 * stay, as the user made them; only the reference to the clip goes, and the server frees clips nothing refers to).
 */
export async function dropStaleBakes(lumioFetch: LumioFetch, playlistId: string, order: readonly string[]): Promise<boolean> {
  const neighbours = new Set(neighbourPairs(order))
  // On top of the settings as they are; again when someone (a bake, another editor) saved in between (409).
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await lumioFetch(`/music/mixer/${playlistId}`).catch(() => null)
    if (!response?.ok) return false
    const current = (await response.json()) as PlaylistMixer
    let changed = false
    const transitions = Object.fromEntries(
      Object.entries(current.transitions ?? {}).map(([pair, transition]) => {
        if (!transition.baked || neighbours.has(pair)) return [pair, transition]
        changed = true
        const { baked: _baked, ...rest } = transition
        return [pair, rest as Transition]
      }),
    )
    if (!changed) return false
    const saved = await lumioFetch(`/music/mixer/${playlistId}`, { method: 'PUT', body: JSON.stringify({ ...current, transitions }) }).catch(() => null)
    if (saved?.ok) return true
    if (saved?.status !== 409) return false
  }
  return false
}

/** The pair keys of neighbouring songs in an order. */
export const neighbourPairs = (order: readonly string[]) => order.slice(1).map((to, i) => `${order[i]}>${to}`)

/** The playlist's song order as Jellyfin has it now. */
export async function playlistOrder(deps: BakeDeps, playlistId: string): Promise<string[]> {
  const items = (await getPlaylistApi(deps.api).getPlaylistItems({ playlistId, userId: deps.userId })).data.Items ?? []
  return items.map((item) => item.Id ?? '')
}
