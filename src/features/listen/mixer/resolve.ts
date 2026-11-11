import { mixOf, type MixLookup } from './analysis.ts'
import { finalizeTransition, planFallback, planTransition } from './planner.ts'
import { PRESETS } from './presets.ts'
import { pairKey, type MixStyle, type PlaylistMixer, type Transition, type TrackMix } from './types.ts'

/**
 * Which transition plays between two songs of a mixer playlist:
 * - the one stored for the pair (made by "sort & build" or in the editor), as long as it still fits: the same pair,
 *   a format this version understands, and times that lie inside both songs as they are analysed now;
 * - otherwise an automatic one, planned on the spot in the playlist's style (a pair that no longer exists after the
 *   order changed has nothing stored, so it gets one too), or a plain short crossfade while a song has no analysis.
 */

export interface ResolveOptions {
  /** Song lengths (seconds) by id, for songs without an analysis yet. */
  durations?: Readonly<Record<string, number>>
}

type Transitions = Readonly<Record<string, Transition>>

/** The transitions of a playlist's mixer settings, or a transitions map as it is (pair keys never read "on"). */
function transitionsOf(source: PlaylistMixer | Transitions | null | undefined): Transitions {
  if (!source) return {}
  if ('on' in source && 'transitions' in source) return (source as PlaylistMixer).transitions ?? {}
  return source as Transitions
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function durationOf(mix: TrackMix | null, id: string, opts: ResolveOptions) {
  if (mix && finite(mix.duration) && mix.duration > 0) return mix.duration
  const known = opts.durations?.[id]
  return finite(known) && known > 0 ? known : NaN
}

/** Whether a stored transition still applies to this pair and these analyses. */
export function storedFits(transition: unknown, fromId: string, toId: string, aDuration: number, bDuration: number): transition is Transition {
  if (!transition || typeof transition !== 'object') return false
  const t = transition as Transition
  if (t.v !== 1 || t.from !== fromId || t.to !== toId) return false
  if (!(PRESETS as readonly string[]).includes(t.preset)) return false
  if (![t.aOut, t.bIn, t.length, t.rate].every(finite) || t.length < 0 || t.aOut < 0 || t.bIn < 0) return false
  if (!t.a || !t.b || !Array.isArray(t.effects)) return false
  // Stored before the tempo was part of a transition: the echo and the rate easing can't be counted, so plan again.
  if (!t.tempo || !finite(t.tempo.a) || !finite(t.tempo.b) || t.tempo.a <= 0 || t.tempo.b <= 0) return false
  // The songs may have been analysed again since (another edit of the file): the times must still lie inside them.
  if (finite(aDuration) && t.aOut + t.length > aDuration + 0.05) return false
  if (finite(bDuration) && t.bIn >= bDuration) return false
  return true
}

/** An automatic transition for the pair, from the analyses when both exist, else a plain crossfade. */
export function autoTransition(fromId: string, toId: string, mixes: MixLookup, style: MixStyle, opts: ResolveOptions = {}): Transition {
  const a = mixOf(mixes, fromId)
  const b = mixOf(mixes, toId)
  if (a && b) return planTransition(a, b, { from: fromId, to: toId }, style)
  if (a) return planTransition(a, null, { from: fromId, to: toId }, style)
  return planFallback(fromId, toId, durationOf(a, fromId, opts), style)
}

/** The transition to play from one song into the next. */
export function transitionFor(
  mixer: PlaylistMixer | null,
  fromId: string,
  toId: string,
  mixes: MixLookup,
  style: MixStyle,
  opts: ResolveOptions = {},
): Transition {
  const stored = mixer?.transitions?.[pairKey(fromId, toId)]
  if (stored) {
    const aDuration = durationOf(mixOf(mixes, fromId), fromId, opts)
    const bDuration = durationOf(mixOf(mixes, toId), toId, opts)
    if (storedFits(stored, fromId, toId, aDuration, bDuration)) return finalizeTransition(stored, finite(aDuration) ? aDuration : stored.aOut + stored.length, bDuration)
  }
  return autoTransition(fromId, toId, mixes, style, opts)
}

/** How many hand-made transitions a playlist keeps. */
export function customCount(source: PlaylistMixer | Transitions | null | undefined): number {
  return Object.values(transitionsOf(source)).filter((t) => t?.custom === true).length
}

export interface BuildOptions extends ResolveOptions {
  /** Keep hand-made transitions of pairs that stay neighbours (default: "sort & build" replaces everything). */
  keepCustom?: boolean
}

/**
 * Plans a transition for every neighbouring pair of `order` ("sort & build"): a new map by pair key, and how many
 * hand-made transitions it replaces (for the warning before, "X custom transitions will be replaced").
 */
export function buildTransitions(
  order: readonly string[],
  mixes: MixLookup,
  style: MixStyle,
  existing: PlaylistMixer | Transitions | null,
  opts: BuildOptions = {},
): { transitions: Record<string, Transition>; replacedCustom: number } {
  const previous = transitionsOf(existing)
  const transitions: Record<string, Transition> = {}
  let kept = 0
  for (let i = 0; i + 1 < order.length; i++) {
    const from = order[i]
    const to = order[i + 1]
    const key = pairKey(from, to)
    if (Object.hasOwn(transitions, key)) continue
    const stored = previous[key]
    if (opts.keepCustom && stored?.custom) {
      const aDuration = durationOf(mixOf(mixes, from), from, opts)
      const bDuration = durationOf(mixOf(mixes, to), to, opts)
      if (storedFits(stored, from, to, aDuration, bDuration)) {
        transitions[key] = stored
        kept++
        continue
      }
    }
    transitions[key] = autoTransition(from, to, mixes, style, opts)
  }
  return { transitions, replacedCustom: customCount(previous) - kept }
}
