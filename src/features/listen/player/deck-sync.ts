import { driftCorrection } from '../mixer/engine'

/**
 * Timing for the mixer's two <audio> decks: waking up at the right moment (also in a hidden tab), starting deck B so
 * its first sound lands on A's cue point, and keeping B on A's beat while both play.
 *
 * A media element can't be started at an exact time the way a Web Audio source can: `play()` takes a moment before
 * its position starts moving. So B is started that moment early (`playLead`, learned from the transitions before),
 * and what is left of the error is closed by nudging B's rate (pitch kept) for the first beats.
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

/**
 * How far B is off A's beat (seconds; positive: B is ahead), given that A's `aOut` and B's `bIn` belong together and
 * B plays at `rate`.
 */
export function alignmentError(a: HTMLAudioElement, b: HTMLAudioElement, aOut: number, bIn: number, rate: number) {
  return (b.currentTime - bIn) / rate - (a.currentTime - aOut)
}

/** Errors below this are left alone (single readings of an element's position jitter by several milliseconds). */
const DEADBAND_S = 0.006
/** Above this, B jumps to the right place instead of catching up by rate. */
const JUMP_OVER_S = 0.25
const MEASURE_EVERY_S = 0.1
/** How many readings the correction looks at (their median). */
const WINDOW = 5
/** Readings start once B has really moved this far (right after `play()` its position still stands). */
const SETTLE_S = 0.15

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export interface Alignment {
  a: HTMLAudioElement
  b: HTMLAudioElement
  aOut: number
  bIn: number
  rate: number
  /** The error once B has settled (the median of its first readings): how well it started. Called once. */
  onStart?: (error: number) => void
  /** Each reading, for diagnostics. */
  onMeasure?: (error: number) => void
  /** Whether A's position still says where the beat is (not while A is braking). */
  active?: () => boolean
}

/**
 * Keeps B on A's beat: reads the error every 100 ms and nudges B's rate around `rate` by the median of the last
 * readings (single readings of `currentTime` jitter, the median doesn't follow them); a big error is jumped over once.
 * Returns a stop, which leaves B at exactly `rate`.
 */
export function keepAligned(ctx: BaseAudioContext | null, alignment: Alignment): () => void {
  const { a, b, aOut, bIn, rate } = alignment
  const from = b.currentTime
  let stopped = false
  let cancelWake = () => {}
  let readings: number[] = []
  let started = false
  let jumped = false
  const step = () => {
    if (stopped) return
    const steady = !a.paused && !b.paused && !a.seeking && !b.seeking && a.readyState >= 3 && b.readyState >= 3 && b.currentTime - from >= SETTLE_S
    if (steady && (alignment.active?.() ?? true)) {
      const error = alignmentError(a, b, aOut, bIn, rate)
      alignment.onMeasure?.(error)
      readings = [...readings, error].slice(-WINDOW)
      const typical = median(readings)
      if (!started && readings.length >= 3) {
        started = true
        alignment.onStart?.(typical)
      }
      if (readings.length >= 3 && Math.abs(typical) > JUMP_OVER_S && !jumped) {
        jumped = true
        readings = []
        b.currentTime = bIn + rate * (a.currentTime - aOut + playLead)
      } else if (readings.length >= 3) b.playbackRate = Math.abs(typical) < DEADBAND_S ? rate : driftCorrection(typical, rate)
    }
    cancelWake = wakeAfter(ctx, MEASURE_EVERY_S, step)
  }
  step()
  return () => {
    stopped = true
    cancelWake()
    b.playbackRate = rate
  }
}
