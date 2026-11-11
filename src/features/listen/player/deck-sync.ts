import { driftCorrection } from '../mixer/engine'

/**
 * Timing for the mixer's two <audio> decks: waking up at the right moment (also in a hidden tab), starting an element
 * so its first sound lands where it should, and keeping each element on its deck's plan (the transition's clock) while
 * a transition runs.
 *
 * A media element can't be started at an exact time the way a Web Audio source can: `play()` takes a moment before
 * its position starts moving. So it is started that moment early (`playLead`, learned from the transitions before),
 * and what is left of the error is closed by nudging its rate (pitch kept).
 */

/**
 * Calls `fn` after `seconds`, on whichever fires first: a timer, or the audio clock. Timers of a hidden tab may be
 * throttled to a second or more; an AudioContext keeps time (a silent source's `ended` event). Returns a cancel.
 */
export function wakeAfter(ctx: BaseAudioContext | null, seconds: number, fn: () => void): () => void {
  let done = false
  let node: ConstantSourceNode | null = null
  const cancel = () => {
    done = true
    window.clearTimeout(timer)
    if (!node) return
    node.onended = null
    node.disconnect()
    node = null
  }
  const fire = () => {
    if (done) return
    cancel()
    fn()
  }
  const timer = window.setTimeout(fire, Math.max(0, seconds * 1000))
  // Worth it only for longer waits: the event comes per render quantum, a short timer is more precise.
  if (ctx && ctx.state === 'running' && seconds > 0.05) {
    node = new ConstantSourceNode(ctx, { offset: 0 })
    node.connect(ctx.destination)
    node.onended = fire
    node.start()
    node.stop(ctx.currentTime + seconds)
  }
  return cancel
}

/**
 * How early B's `play()` is called before its sound should start: the element's start-up time. Begins with a typical
 * value and learns from each transition's first measured error; kept per device, as it depends on the device.
 */
const LEAD_KEY = 'lumio.mixer.playLead'
let playLead = (() => {
  try {
    const stored = Number(localStorage.getItem(LEAD_KEY))
    return stored > 0 && stored < 0.3 ? stored : 0.04
  } catch {
    return 0.04
  }
})()

export const currentPlayLead = () => playLead

/** Learns from a start that came out `error` seconds off (positive: B came early). */
export function learnPlayLead(error: number) {
  if (!Number.isFinite(error) || Math.abs(error) > 0.5) return
  const latency = playLead - error
  playLead = Math.max(0, Math.min(0.3, playLead * 0.6 + latency * 0.4))
  try {
    localStorage.setItem(LEAD_KEY, playLead.toFixed(4))
  } catch {
    // Learned for this visit only.
  }
}

/**
 * Calls `onCue(late)` once element `a` is `lead` seconds before `cue` (its own position, in seconds): coarse wake-ups
 * while far away, then one short timer. `late` is how far past that moment it really is (0 or a few ms on time;
 * more when the tab was asleep). Only while `a` plays; returns a cancel.
 */
export function waitForCue(ctx: BaseAudioContext | null, a: HTMLAudioElement, cue: number, lead: number, onCue: (late: number) => void): () => void {
  let cancelWake = () => {}
  let stopped = false
  const step = () => {
    if (stopped) return
    const left = (cue - lead - a.currentTime) / (a.playbackRate || 1)
    if (left <= 0.002) {
      stopped = true
      return onCue(Math.max(0, -left))
    }
    // Far away: wake up a little before and look again; close: the last stretch in one go.
    cancelWake = wakeAfter(ctx, left > 0.3 ? left - 0.2 : left - 0.001, step)
  }
  step()
  return () => {
    stopped = true
    cancelWake()
  }
}

/** Errors below this are left alone (single readings of an element's position jitter by several milliseconds). */
const DEADBAND_S = 0.006
/** Above this an audible element jumps to the right place (once) instead of catching up by rate. */
const JUMP_OVER_S = 0.25
/** A muted element (its sound comes from a buffer deck) jumps whenever it is this far off: nobody hears it. */
const MUTED_JUMP_OVER_S = 0.03
const MEASURE_EVERY_S = 0.1
/** How many readings the correction looks at (their median). */
const WINDOW = 5
/** Readings start once the element has really moved this far (right after `play()` or a jump its position stands). */
const SETTLE_S = 0.15
/** The slowest and fastest an element plays. */
const MIN_RATE = 0.0625
const MAX_RATE = 16

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export interface PlanFollow {
  element: HTMLAudioElement
  /** Transition time now. */
  clock: () => number
  /** Where the element should be, and at which rate, at transition time t. */
  position: (t: number) => number
  rate: (t: number) => number
  /** Whether the pitch follows the rate at t (a brake); otherwise the element keeps it. */
  pitchFollows?: (t: number) => boolean
  /** The element is muted (a buffer deck sounds instead): it may jump whenever it is off. */
  muted?: boolean
  /** The error once the element has settled (the median of its first readings): how well it started. Called once. */
  onStart?: (error: number) => void
}

/**
 * Keeps an element on its deck's plan: reads its error every 100 ms (against the transition's clock) and sets its
 * rate to the plan's, nudged by the median of the last readings (single readings jitter; the median doesn't follow
 * them). A big error is jumped over. Returns a stop.
 */
export function followPlan(ctx: BaseAudioContext | null, follow: PlanFollow): () => void {
  const { element } = follow
  let from = element.currentTime
  let stopped = false
  let cancelWake = () => {}
  let readings: number[] = []
  let started = false
  let jumped = false
  const step = () => {
    if (stopped) return
    const t = follow.clock()
    const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, follow.rate(t)))
    element.preservesPitch = !follow.pitchFollows?.(t)
    const steady = !element.paused && !element.seeking && element.readyState >= 3 && Math.abs(element.currentTime - from) >= SETTLE_S
    if (steady) {
      const error = element.currentTime - follow.position(t)
      readings = [...readings, error].slice(-WINDOW)
      const typical = median(readings)
      if (!started && readings.length >= 3) {
        started = true
        follow.onStart?.(typical)
      }
      const jumpOver = follow.muted ? MUTED_JUMP_OVER_S : JUMP_OVER_S
      if (readings.length >= 3 && Math.abs(typical) > jumpOver && (follow.muted || !jumped)) {
        jumped = true
        readings = []
        element.currentTime = follow.position(t + playLead)
        from = element.currentTime
      } else if (readings.length >= 3) element.playbackRate = Math.abs(typical) < DEADBAND_S ? rate : Math.min(MAX_RATE, Math.max(MIN_RATE, driftCorrection(typical, rate)))
      else element.playbackRate = rate
    } else if (!element.paused) element.playbackRate = rate
    cancelWake = wakeAfter(ctx, MEASURE_EVERY_S, step)
  }
  step()
  return () => {
    stopped = true
    cancelWake()
  }
}
