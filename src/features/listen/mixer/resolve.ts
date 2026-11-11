import { mixOf, type MixLookup } from './analysis.ts'
import { finalizeTransition, planFallback, planTransition } from './planner.ts'
import { deckPosition } from './timeline.ts'
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
  // Older versions (v1 had one rate and a negative bIn) are planned again.
  if (t.v !== 2 || t.from !== fromId || t.to !== toId) return false
  if (!(PRESETS as readonly string[]).includes(t.preset)) return false
  if (![t.aOut, t.bAt, t.bIn, t.length].every(finite) || t.length < 0 || t.aOut < 0 || t.bIn < 0 || t.bAt < 0 || t.bAt > t.length) return false
  // Paths of whole segments, rates the player can play (B's ending at its own tempo), automation it can read.
  const segmentsOk = (path: unknown) =>
    Array.isArray(path) && path.every((s) => s && finite(s.from) && finite(s.to) && s.to > s.from && Number.isInteger(s.repeat) && s.repeat >= 1)
  if (!segmentsOk(t.pathA) || !segmentsOk(t.pathB)) return false
  const ratesOk = (curve: unknown) => Array.isArray(curve) && curve.every((k) => k && finite(k.t) && finite(k.v) && k.v >= 0.5 && k.v <= 2)
  if (!ratesOk(t.rateA) || !ratesOk(t.rateB)) return false
  if (t.rateB.length > 0 && t.rateB[t.rateB.length - 1].v !== 1) return false
  const decks = [t.a, t.b]
  if (!decks.every((deck) => deck && typeof deck === 'object' && (['gain', 'low', 'mid', 'high', 'filter'] as const).every((band) => Array.isArray(deck[band])))) return false
  if (!Array.isArray(t.effects)) return false
  if (!t.tempo || !finite(t.tempo.a) || !finite(t.tempo.b) || t.tempo.a <= 0 || t.tempo.b <= 0) return false
  // The songs may have been analysed again since (another edit of the file): both decks must stay inside them.
  const aEnd = deckPosition(t, 'a', t.length) ?? t.aOut
  const bEnd = deckPosition(t, 'b', t.length) ?? t.bIn
  if (finite(aDuration) && Math.max(aEnd, ...t.pathA.map((s) => s.to)) > aDuration + 0.05) return false
  if (finite(bDuration) && (t.bIn >= bDuration || Math.max(bEnd, ...t.pathB.map((s) => s.to)) > bDuration + 0.05)) return false
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
    if (storedFits(stored, fromId, toId, aDuration, bDuration)) return finalizeTransition(stored, finite(aDuration) ? aDuration : (deckPosition(stored, 'a', stored.length) ?? stored.aOut), bDuration)
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
