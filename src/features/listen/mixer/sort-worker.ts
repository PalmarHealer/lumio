import { buildTransitions } from './resolve.ts'
import { estimateMixLength, sortForMix, type MixLength } from './sort.ts'
import type { MixStyle, PlaylistMixer, TrackMix, Transition } from './types.ts'

/**
 * "Sort & build transitions" off the main thread: sorting spends up to most of a second improving the order, and a
 * playlist of a few hundred songs plans as many transitions. The dialog asks again whenever the style, the analyses or
 * "keep custom transitions" change.
 */

export interface SortRequest {
  /** Matches the answer to the ask (only the newest answer counts). */
  ask: number
  /** The playlist in its current order (a song twice appears twice). */
  tracks: Array<{ id: string; mix: TrackMix | null }>
  style: MixStyle
  existing: PlaylistMixer | null
  keepCustom: boolean
  /** Song lengths from the library, for songs without an analysis. */
  durations: Record<string, number>
  /** An order already found for this style and these analyses: only the transitions are built again. */
  order?: string[]
}

export interface SortResult {
  ask: number
  order: string[]
  transitions: Record<string, Transition>
  replacedCustom: number
  length: MixLength
}

const scope = self as unknown as { onmessage: ((event: MessageEvent<SortRequest>) => void) | null; postMessage: (message: SortResult) => void }

scope.onmessage = (event) => {
  const { ask, tracks, style, existing, keepCustom, durations } = event.data
  const mixes = Object.fromEntries(tracks.map((track) => [track.id, track.mix]))
  const order = event.data.order ?? sortForMix(tracks, style)
  const { transitions, replacedCustom } = buildTransitions(order, mixes, style, existing, { keepCustom, durations })
  scope.postMessage({ ask, order, transitions, replacedCustom, length: estimateMixLength(order, mixes, transitions, durations) })
}
