import { createBufferDeck, stretchedSpans, type BufferDeckKind } from '../buffer-deck'
import { deckPlan, timeOfAdvance, type DeckPlan } from '../deck-schedule'
import { renderTransition, setTempoChangeKind } from '../render'
import type { DeckAutomation, Keyframe, Transition } from '../types'

/**
 * Regression check (browser only: it needs Web Audio and the stretch worklet): does a deck stay where its rate curve
 * says while its tempo glides, and does nothing jump where it switches between exact and stretched playback?
 *
 * A click track (a click every 0.25 s) plays as deck B (or A) of a beatmatched transition; each click's arrival in the
 * output is found by cross-correlation with the click itself and compared with the moment the deck's plan
 * (`timeOfAdvance`, the integral of its rate) says that track position sounds. Run it with the dev server:
 * `/src/features/listen/mixer/checks/glide.html` (`?live` also plays the deck in real time, as the player does). Both
 * common sample rates are checked: at 44.1 kHz the stretcher's timing depends on how its hop meets the render quantum
 * (stretch.ts).
 */

const CLICK_EVERY = 0.25
/** Clicks sit off the grid of whole seconds, so no click lies exactly on a keyframe or a switch. */
const CLICK_OFFSET = 0.0123
const CLICK_S = 0.002

const clickShape = (rate: number) =>
  Float32Array.from({ length: Math.round(CLICK_S * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 3000 * i) / rate) * Math.exp(-i / (0.0005 * rate)))

function clickTrack(seconds: number, rate: number) {
  const data = new Float32Array(Math.round(seconds * rate))
  const shape = clickShape(rate)
  for (let at = CLICK_OFFSET; at < seconds - 0.01; at += CLICK_EVERY) data.set(shape, Math.round(at * rate))
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: data.length, sampleRate: rate })
  buffer.copyToChannel(data, 0)
  return buffer
}

const silence = (seconds: number, rate: number) => new AudioBuffer({ numberOfChannels: 1, length: Math.round(seconds * rate), sampleRate: rate })
const neutral = (): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [] })

/** Clicks found in `output` (seconds into it): coarse onsets, refined by cross-correlation with the click (±3 ms). */
function findClicks(output: Float32Array, rate: number) {
  const shape = clickShape(rate)
  const found: number[] = []
  const gap = Math.round(0.1 * rate)
  let quietSince = -gap
  for (let i = 0; i < output.length; i++) {
    if (Math.abs(output[i]!) < 0.05) continue
    if (i - quietSince >= gap) {
      const reach = Math.round(0.003 * rate)
      const score = (lag: number) => {
        let sum = 0
        for (let k = 0; k < shape.length; k++) sum += (output[lag + k] ?? 0) * shape[k]!
        return sum
      }
      let best = i - reach
      for (let lag = i - reach; lag <= i + reach; lag++) if (score(lag) > score(best)) best = lag
      const [l, c, r] = [score(best - 1), score(best), score(best + 1)]
      const shift = (l - r) / (2 * (l - 2 * c + r) || 1)
      found.push((best + Math.max(-0.5, Math.min(0.5, shift))) / rate)
    }
    quietSince = i
  }
  return found
}

export interface GlideReport {
  deck: 'a' | 'b'
  mode: 'render' | 'live'
  kind: BufferDeckKind
  sampleRate: number
  clicks: number
  /** Worst |error| (ms) where the deck plays exactly (rate 1) and where it is stretched. */
  exactMs: number
  stretchedMs: number
  /** Largest change of the error (ms) from one click to the next across an exact↔stretched switch. */
  switchJumpMs: number
  /** Clicks expected in the checked window but not found, and found but not expected. */
  missing: number
  extra: number
  pass: boolean
  /** Per click: transition time and error (ms; positive = late); NaN where the click wasn't found. */
  errors: Array<[number, number]>
}

/**
 * The case the planner made for BAAB → Rock That Body: B starts beatmatched and glides back to 1 well after `length`.
 * Checking A instead, A glides to the meeting tempo after t = 0 and holds it until it is gone.
 */
function transitionFor(deck: 'a' | 'b', meet = deck === 'a' ? 0.9885 : 1.0117): Transition {
  const rateB: Keyframe[] = [
    { t: 3.778, v: meet },
    { t: 18.948, v: meet },
    { t: 34.298, v: 1 },
  ]
  const rateA: Keyframe[] = [
    { t: 0, v: 1 },
    { t: 3, v: meet },
    { t: 15.2, v: meet },
  ]
  return {
    v: 2,
    from: 'a',
    to: 'b',
    style: 'party',
    preset: 'blend',
    aOut: 40,
    bAt: 3.778,
    bIn: 10,
    length: 15.2,
    pathA: [],
    pathB: [],
    rateA: deck === 'a' ? rateA : [],
    rateB: deck === 'b' ? rateB : [],
    tempo: { a: 128, b: 126.5 },
    a: neutral(),
    b: neutral(),
    effects: [],
    custom: false,
    confidence: 1,
  }
}

/** Compares found clicks with the plan over [from, to] (transition time; `zero` = output time of t = 0). */
function compare(found: number[], plan: DeckPlan, zero: number, from: number, to: number) {
  const stretched = stretchedSpans(plan, from, to)
  const inStretch = (t: number) => stretched.some(([a, b]) => t >= a && t <= b)
  const expected: number[] = []
  const start = plan.lane.start
  // Track positions of the clicks this deck reaches within the window.
  for (let at = CLICK_OFFSET; at < 120; at += CLICK_EVERY) {
    if (at < start - (plan.at - from) - 1) continue
    const t = timeOfAdvance(plan, at - start)
    if (t > from + 0.05 && t < to - 0.05) expected.push(t)
    if (t > to) break
  }
  let exactMs = 0
  let stretchedMs = 0
  let switchJumpMs = 0
  let missing = 0
  let previous: { error: number; stretched: boolean } | null = null
  const used = new Set<number>()
  const errors: Array<[number, number]> = []
  for (const t of expected) {
    const index = found.findIndex((f) => Math.abs(f - zero - t) < 0.02)
    if (index < 0) {
      errors.push([t, NaN])
      missing++
      previous = null
      continue
    }
    used.add(index)
    const error = (found[index]! - zero - t) * 1000
    const isStretched = inStretch(t)
    errors.push([t, error])
    if (isStretched) stretchedMs = Math.max(stretchedMs, Math.abs(error))
    else exactMs = Math.max(exactMs, Math.abs(error))
    if (previous && previous.stretched !== isStretched) switchJumpMs = Math.max(switchJumpMs, Math.abs(error - previous.error))
    previous = { error, stretched: isStretched }
  }
  const extra = found.filter((f, index) => !used.has(index) && f - zero > from + 0.05 && f - zero < to - 0.05).length
  return { clicks: expected.length, errors, exactMs, stretchedMs, switchJumpMs, missing, extra }
}

/**
 * Limits: the exact path is sample-exact; stretched clicks land within 0.4 ms (cross-correlated; the stretcher smears
 * them a little), so the switch between the two moves them by as little.
 */
const LIMITS = { exactMs: 0.1, stretchedMs: 1, switchJumpMs: 1 }

const judge = (result: Omit<GlideReport, 'pass'>): GlideReport => ({
  ...result,
  pass: result.missing === 0 && result.extra === 0 && result.exactMs <= LIMITS.exactMs && result.stretchedMs <= LIMITS.stretchedMs && result.switchJumpMs <= LIMITS.switchJumpMs,
})

export async function checkRender(deck: 'a' | 'b', kind: BufferDeckKind = 'hybrid', sampleRate = 44100, meet?: number): Promise<GlideReport> {
  const transition = transitionFor(deck, meet)
  const preRoll = 8
  const postRoll = 25
  setTempoChangeKind(kind)
  try {
    const output = await renderTransition({
      a: deck === 'a' ? clickTrack(90, sampleRate) : silence(90, sampleRate),
      b: deck === 'b' ? clickTrack(90, sampleRate) : silence(90, sampleRate),
      transition,
      preRoll,
      postRoll,
      sampleRate,
    })
    const plan = deckPlan(transition, deck)
    const from = deck === 'a' ? -preRoll : transition.bAt
    const to = deck === 'a' ? transition.length : transition.length + postRoll
    return judge({ deck, mode: 'render', kind, sampleRate, ...compare(findClicks(output.getChannelData(0), sampleRate), plan, preRoll, from, to) })
  } finally {
    setTempoChangeKind('hybrid')
  }
}

/** The recorder: posts every rendered block of its input with the context frame it starts at. */
const RECORDER = `registerProcessor('glide-recorder', class extends AudioWorkletProcessor {
  process(inputs) { const input = inputs[0]; this.port.postMessage({ frame: currentFrame, data: input && input[0] ? input[0].slice(0) : new Float32Array(128) }); return true }
})`

/**
 * B's deck in a real-time context, as the player plays it (buffer-deck.ts, scheduled `latency` ahead), recorded frame
 * by frame. Takes as long as the glide (about 40 s).
 */
export async function checkLive(kind: BufferDeckKind = 'hybrid', sampleRate = 44100): Promise<GlideReport> {
  const transition = transitionFor('b')
  const plan = deckPlan(transition, 'b')
  const ctx = new AudioContext({ sampleRate, latencyHint: 'playback' })
  try {
    const url = URL.createObjectURL(new Blob([RECORDER], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const recorder = new AudioWorkletNode(ctx, 'glide-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
    const blocks: Array<{ frame: number; data: Float32Array }> = []
    recorder.port.onmessage = (event: MessageEvent<{ frame: number; data: Float32Array }>) => void blocks.push(event.data)
    const player = await createBufferDeck(ctx, recorder, kind)
    const track = clickTrack(90, sampleRate)
    await player.load([track.getChannelData(0), track.getChannelData(0)] as Float32Array<ArrayBuffer>[], 0, sampleRate)
    await ctx.resume()
    // Until B has been back at rate 1 for a few seconds.
    const to = (transition.rateB.at(-1)?.t ?? transition.length) + 4
    const zero = ctx.currentTime + player.latency + 0.5 - transition.bAt
    player.play(plan, transition.bAt, to, zero)
    await new Promise((resolve) => setTimeout(resolve, (zero + to - ctx.currentTime + 0.5) * 1000))
    player.dispose()
    // Blocks laid out at their own frames (a dropped block leaves silence, not a shift).
    const first = blocks[0]!.frame
    const last = blocks[blocks.length - 1]!
    const output = new Float32Array(last.frame + last.data.length - first)
    for (const block of blocks) output.set(block.data, block.frame - first)
    return judge({ deck: 'b', mode: 'live', kind, sampleRate, ...compare(findClicks(output, sampleRate), plan, zero - first / sampleRate, transition.bAt, to) })
  } finally {
    await ctx.close()
  }
}
