import { mixOf } from './analysis.ts'
import type { Technique } from './planner.ts'
import { autoTransition, customCount, storedFits, techniqueOf, varietyAvoid } from './resolve.ts'
import { estimateMixLength, sortForMix, type MixLength } from './sort.ts'
import { pairKey, type MixStyle, type PlaylistMixer, type TrackMix, type Transition } from './types.ts'

/**
 * "Sort & build transitions" off the main thread, in steps the dialog can show:
 * 1. the order (sorting takes up to most of a second) and how many custom transitions go: answered at once;
 * 2. the transitions, planned pair by pair (tens of milliseconds each, so a few hundred songs take a while), with
 *    progress and an estimate of the shortening that firms up as pairs come in;
 * 3. the finished map and the exact length.
 * Pairs are planned spread over the playlist (every 64th first, then the ones between …), so the early estimate stands
 * for the whole playlist rather than its first songs. The set's variety (no special technique twice in a row, none
 * beyond its share, see `varietyAvoid`) needs the playing order, so a last pass walks the pairs in order and plans again
 * only those whose technique the rule rules out there, avoiding it. That gives what planning in order would: a pair
 * whose technique isn't ruled out is planned the same with or without the others avoided (they weren't chosen). Between short runs the worker yields, so a newer ask (another
 * style, "keep custom" switched) takes over at once and the old one stops. Planned pairs are kept while the worker
 * lives (the dialog is open): a pair asked again with the same style and the same analyses isn't planned twice.
 */

export interface SortRequest {
  /** Matches the answers to the ask (only the newest ask is worked on). */
  ask: number
  /** What the ask was made from (style, songs, analyses, "keep custom" …), handed back with the finished result. */
  inputs: string
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

export type SortMessage =
  /** The order is found; `pairs` transitions are to be planned. */
  | { kind: 'order'; ask: number; order: string[]; pairs: number; replacedCustom: number }
  /** `done` of `pairs` planned; `shorterBy` the estimate so far (null before any pair with known lengths). */
  | { kind: 'progress'; ask: number; done: number; pairs: number; shorterBy: number | null }
  | { kind: 'done'; ask: number; inputs: string; order: string[]; transitions: Record<string, Transition>; replacedCustom: number; length: MixLength }
  | { kind: 'failed'; ask: number }

/** How long the worker plans before it reports and yields. */
const SLICE_MS = 60

const scope = self as unknown as { onmessage: ((event: MessageEvent<SortRequest>) => void) | null; postMessage: (message: SortMessage) => void }

/** The newest ask: a build for an older one stops at its next yield. */
let current = 0
/** Planned automatic transitions, by style, pair and which of the two songs had an analysis. */
const planned = new Map<string, Transition>()

const yieldToMessages = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Every index below `count` once, spread out: 0, 64, 128 …, then 32, 96 …, down to the odd ones. */
function spreadOrder(count: number): number[] {
  const seen = new Uint8Array(count)
  const result: number[] = []
  let step = 1
  while (step * 2 < count) step *= 2
  for (; step >= 1; step /= 2) {
    for (let i = 0; i < count; i += step) {
      if (seen[i]) continue
      seen[i] = 1
      result.push(i)
    }
  }
  return result
}

async function build(request: SortRequest) {
  const { ask, inputs, tracks, style, existing, keepCustom, durations } = request
  const mixes = Object.fromEntries(tracks.map((track) => [track.id, track.mix]))
  const order = request.order ?? sortForMix(tracks, style)
  if (ask !== current) return

  const lengthOf = (id: string) => {
    const mix = mixOf(mixes, id)
    const value = mix && Number.isFinite(mix.duration) && mix.duration > 0 ? mix.duration : durations[id]
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : NaN
  }
  const known = (id: string) => Number.isFinite(lengthOf(id))
  // The neighbouring pairs, each once (a pair can come up twice when songs repeat).
  const pairs: Array<{ from: string; to: string; key: string }> = []
  const seenPairs = new Set<string>()
  for (let i = 0; i + 1 < order.length; i++) {
    const key = pairKey(order[i]!, order[i + 1]!)
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    pairs.push({ from: order[i]!, to: order[i + 1]!, key })
  }
  // Hand-made transitions stay where their pair does and they still fit (as `buildTransitions` decides).
  const stored = existing?.transitions ?? {}
  const kept = new Map<string, Transition>()
  if (keepCustom) {
    for (const pair of pairs) {
      const transition = stored[pair.key]
      if (transition?.custom && storedFits(transition, pair.from, pair.to, lengthOf(pair.from), lengthOf(pair.to))) kept.set(pair.key, transition)
    }
  }
  const replacedCustom = customCount(existing) - kept.size
  scope.postMessage({ kind: 'order', ask, order, pairs: pairs.length, replacedCustom })

  // The estimate: what the planned pairs save on average, for all pairs, against the whole playlist played in full.
  const original = order.reduce((sum, id) => sum + (known(id) ? lengthOf(id) : 0), 0)
  const pairsKnown = pairs.filter((pair) => known(pair.from) && known(pair.to)).length
  let saved = 0
  let measured = 0
  const transitions: Record<string, Transition> = {}
  let done = 0
  let sliceStart = performance.now()
  const plan = (pair: (typeof pairs)[number], avoid: Technique[] = []) => {
    const cacheKey = `${style}|${pair.key}|${mixes[pair.from] ? 1 : 0}${mixes[pair.to] ? 1 : 0}|${[...avoid].sort().join(',')}`
    let transition = planned.get(cacheKey)
    if (!transition) {
      transition = autoTransition(pair.from, pair.to, mixes, style, avoid.length ? { durations, avoid } : { durations })
      planned.set(cacheKey, transition)
    }
    return transition
  }
  for (const index of spreadOrder(pairs.length)) {
    const pair = pairs[index]!
    const transition = kept.get(pair.key) ?? plan(pair)
    transitions[pair.key] = transition
    done++
    if (known(pair.from) && known(pair.to)) {
      const alone = estimateMixLength([pair.from, pair.to], mixes, { [pair.key]: transition }, durations)
      saved += alone.original - alone.mixed
      measured++
    }
    if (done < pairs.length && performance.now() - sliceStart >= SLICE_MS) {
      const shorterBy = measured > 0 && original > 0 ? Math.min(1, Math.max(0, ((saved / measured) * pairsKnown) / original)) : null
      scope.postMessage({ kind: 'progress', ask, done, pairs: pairs.length, shorterBy })
      await yieldToMessages()
      if (ask !== current) return
      sliceStart = performance.now()
    }
  }
  // Variety, in playing order (as `buildTransitions` keeps it): kept hand-made transitions count as plain ones.
  const history: Array<Technique | undefined> = []
  for (const pair of pairs) {
    if (kept.has(pair.key)) {
      history.push(undefined)
      continue
    }
    const avoid = varietyAvoid(history)
    const technique = techniqueOf(transitions[pair.key]!)
    if (technique && avoid.includes(technique)) transitions[pair.key] = plan(pair, avoid)
    history.push(techniqueOf(transitions[pair.key]!))
    if (performance.now() - sliceStart >= SLICE_MS) {
      await yieldToMessages()
      if (ask !== current) return
      sliceStart = performance.now()
    }
  }
  scope.postMessage({ kind: 'done', ask, inputs, order, transitions, replacedCustom, length: estimateMixLength(order, mixes, transitions, durations) })
}

scope.onmessage = (event) => {
  current = event.data.ask
  build(event.data).catch(() => {
    if (event.data.ask === current) scope.postMessage({ kind: 'failed', ask: event.data.ask })
  })
}
