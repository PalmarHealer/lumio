import { brakeRateAt } from './engine.ts'
import { lanePosition, rateAdvance, type Lane } from './timeline.ts'
import type { Keyframe, Transition } from './types.ts'

/**
 * How a time-stretching player plays one deck of a transition (v2): where the deck is in its track at each moment and
 * at which rate, as points a stretch node can follow. The track position comes from the planner's own timeline
 * (`lanePosition` / `rateAdvance`), so the player and the planner agree to the sample.
 *
 * "Advance" is the track time a deck has played since its start (the integral of its rate curve). Before its start a
 * deck is taken to play straight at rate 1: for A that is the ordinary playback leading into the transition.
 */

export interface DeckPlan {
  /** Transition time the deck starts at. */
  at: number
  lane: Lane
  rate: Keyframe[]
}

export function deckPlan(transition: Transition, deck: 'a' | 'b'): DeckPlan {
  return deck === 'a'
    ? { at: 0, lane: { start: transition.aOut, path: transition.pathA ?? [] }, rate: transition.rateA ?? [] }
    : { at: transition.bAt, lane: { start: transition.bIn, path: transition.pathB ?? [] }, rate: transition.rateB ?? [] }
}

const validSegment = (segment: { from: number; to: number; repeat: number }) =>
  Number.isFinite(segment.from) && Number.isFinite(segment.to) && segment.to > segment.from && segment.repeat >= 1

/** Track time a deck has played by transition time `t` (negative before its start). */
export const advanceAt = (plan: DeckPlan, t: number) => (t < plan.at ? t - plan.at : rateAdvance(plan.rate, plan.at, t))

/** A deck's track position at transition time `t`. */
export const positionAt = (plan: DeckPlan, t: number) => lanePosition(plan.lane, advanceAt(plan, t))

/** The rate at transition time `t` (1 before the deck's start). */
export function rateOf(plan: DeckPlan, t: number) {
  if (t < plan.at) return 1
  return rateAdvance(plan.rate, t, t + 1e-4) / 1e-4
}

/** The transition time at which a deck has played `advance` (≥ 0) of its track. */
export function timeOfAdvance(plan: DeckPlan, advance: number) {
  if (advance <= 0) return plan.at + advance
  let low = plan.at
  let high = plan.at + Math.max(1, advance * 2)
  while (advanceAt(plan, high) < advance) high = plan.at + (high - plan.at) * 2
  for (let i = 0; i < 64; i++) {
    const middle = (low + high) / 2
    if (advanceAt(plan, middle) < advance) low = middle
    else high = middle
  }
  return high
}

/** Advances at which the deck jumps (a loop going round, or the next segment starting elsewhere). */
export function jumpsOf(lane: Lane) {
  const jumps: number[] = []
  let advance = 0
  let previousEnd: number | null = null
  for (const segment of lane.path) {
    if (!validSegment(segment)) continue
    const span = segment.to - segment.from
    for (let r = 0; r < Math.round(segment.repeat); r++) {
      if (advance > 0 && (r > 0 || previousEnd !== segment.from)) jumps.push(advance)
      advance += span
    }
    previousEnd = segment.to
  }
  return jumps
}

/** How much of its track a deck plays through its path (after that it plays straight on). */
export function pathLength(lane: Lane) {
  return lane.path.filter(validSegment).reduce((sum, segment) => sum + (segment.to - segment.from) * Math.round(segment.repeat), 0)
}

export interface SchedulePoint {
  /** Transition time. */
  t: number
  /** Track position there. */
  position: number
  /** Rate until the next point (track seconds per second). */
  rate: number
  /** A jump: the position doesn't follow on from the point before. */
  jump: boolean
}

/**
 * The deck from transition time `from` to `to` as points: one at every rate keyframe and jump, and every `step`
 * seconds in between. Each point's position is exact, and its rate is the one that reaches the next point's position,
 * so a player following them linearly never drifts; at a jump the new position starts as far into its segment as the
 * deck's advance says (the beat runs on without a gap, even if the player switches a render quantum late).
 */
export function deckSchedule(plan: DeckPlan, from: number, to: number, step = 0.05): SchedulePoint[] {
  const times = new Set<number>([from, to])
  if (plan.at > from && plan.at < to) times.add(plan.at)
  for (const keyframe of plan.rate) if (keyframe.t > from && keyframe.t < to) times.add(keyframe.t)
  for (let t = from + step; t < to; t += step) times.add(t)
  const jumps = new Set<number>()
  for (const advance of jumpsOf(plan.lane)) {
    const t = timeOfAdvance(plan, advance)
    if (t > from && t < to) {
      times.add(t)
      jumps.add(t)
    }
  }
  const sorted = [...times].sort((x, y) => x - y)
  return sorted.map((t, i) => {
    const next = sorted[i + 1]
    const advance = advanceAt(plan, t)
    // Just before a jump (within the bisection's precision) the point still belongs to the pass that ends there.
    const position = lanePosition(plan.lane, advance)
    const rate = next === undefined ? rateOf(plan, t) : (advanceAt(plan, next) - advance) / (next - t)
    return { t, position, rate, jump: jumps.has(t) }
  })
}

/** The part of its track a deck plays between transition times `from` and `to` (to load it beforehand). */
export function trackSpan(plan: DeckPlan, from: number, to: number) {
  let low = Infinity
  let high = -Infinity
  for (const point of deckSchedule(plan, from, to, 0.25)) {
    low = Math.min(low, point.position)
    high = Math.max(high, point.position)
  }
  // The end of each pass (just before a jump) is played too.
  for (const advance of jumpsOf(plan.lane)) {
    const t = timeOfAdvance(plan, advance)
    if (t <= from || t >= to) continue
    const before = lanePosition(plan.lane, advance - 1e-6)
    low = Math.min(low, before)
    high = Math.max(high, before)
  }
  return { from: low, to: high }
}

/** From when B plays straight at rate 1 again (its path walked, its rate back at 1, A gone): it may leave the buffer. */
export function bSettled(transition: Transition) {
  const plan = deckPlan(transition, 'b')
  const lastRate = plan.rate.length ? plan.rate[plan.rate.length - 1]!.t : 0
  const pathEnd = timeOfAdvance(plan, pathLength(plan.lane))
  return Math.max(transition.length, lastRate, pathEnd)
}

/** The slowest a braking deck plays (and the pitch it falls to: −48 semitones would be silence anyway). */
const BRAKE_FLOOR = 1 / 16
const BRAKE_STEP_S = 0.02

/**
 * Deck A with a brake: the brake multiplies A's rate curve (a turntable running down) and the pitch falls with it, as
 * on a record. Returns the plan to schedule and the detune (semitones) over transition time.
 */
export function withBrake(transition: Transition, plan: DeckPlan): { plan: DeckPlan; semitones?: (t: number) => number } {
  const brake = transition.effects.find((effect) => effect.kind === 'brake')
  if (!brake || !(brake.length > 0)) return { plan }
  const factor = (t: number) => Math.max(BRAKE_FLOOR, t <= brake.at ? 1 : brakeRateAt(t - brake.at, brake.length))
  const end = brake.at + brake.length
  const rate: Keyframe[] = plan.rate.filter((keyframe) => keyframe.t < brake.at || keyframe.t > end)
  for (let t = brake.at; t <= end + 1e-9; t += BRAKE_STEP_S) rate.push({ t, v: rateOf(plan, t) * factor(t) })
  // After the brake A stays at its floor (it is silent by then).
  rate.push({ t: end + BRAKE_STEP_S, v: rateOf(plan, end) * BRAKE_FLOOR })
  rate.sort((x, y) => x.t - y.t)
  const braked = { ...plan, rate: rate.filter((keyframe) => keyframe.t <= end + BRAKE_STEP_S || keyframe.t < brake.at) }
  return { plan: braked, semitones: (t) => 12 * Math.log2(factor(Math.min(t, end))) }
}
