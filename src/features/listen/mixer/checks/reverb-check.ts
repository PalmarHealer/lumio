import { REVERB_RT60_S } from '../engine'
import { renderTransition } from '../render'
import type { DeckAutomation, Keyframe, Transition } from '../types'

/**
 * Check of the reverb send (browser only): A plays noise (or a tone) whose reverb send rises over its last 30 %, A is
 * cut at `length` and the hall rings on into silence (B is silent). The same transition without reverb is rendered too:
 * the difference is the hall's return alone (the dry path is the same in both). Measured on it:
 * - the tail's decay in the octave around 500 Hz and 4 kHz (Schroeder backward integration, −5 to −35 dB, as RT60):
 *   500 Hz as designed (`REVERB_RT60_S`), 4 kHz shorter (the highs die first);
 * - clicks: the largest second difference within ±20 ms of the cut against the 200 ms before it (a step or kink shows);
 * - the cost: render time with and without the reverb, per second of audio.
 * Run it with the dev server: `/src/features/listen/mixer/checks/reverb.html`.
 */

const LENGTH = 8
const PRE = 4
const POST = 6

const neutral = (reverb?: Keyframe[]): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [], ...(reverb ? { reverb } : {}) })

function transition(reverb: boolean): Transition {
  return {
    v: 2,
    from: 'a',
    to: 'b',
    style: 'clean',
    preset: 'blend',
    aOut: 20,
    bAt: LENGTH,
    bIn: 0,
    length: LENGTH,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    tempo: { a: 120, b: 120 },
    a: neutral(
      reverb
        ? [
            { t: LENGTH * 0.7, v: 0 },
            { t: LENGTH, v: 1 },
          ]
        : undefined,
    ),
    b: neutral(),
    effects: [],
    custom: false,
    confidence: 1,
  }
}

function source(kind: 'tone' | 'noise', rate: number, seconds: number) {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: Math.round(seconds * rate), sampleRate: rate })
  let seed = 1
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let c = 0; c < 2; c++) {
    const data = new Float32Array(buffer.length)
    for (let i = 0; i < data.length; i++) data[i] = kind === 'tone' ? 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate) : 0.3 * random()
    buffer.copyToChannel(data, c)
  }
  return buffer
}

/** RT60 of a decaying signal from `from` (samples): Schroeder integral, −5 to −35 dB, extrapolated to −60 dB. */
function rt60(data: Float32Array, from: number, rate: number) {
  const tail = data.subarray(from)
  const energy = new Float64Array(tail.length)
  let sum = 0
  for (let i = tail.length - 1; i >= 0; i--) energy[i] = sum += tail[i]! * tail[i]!
  const db = (i: number) => 10 * Math.log10(energy[i]! / energy[0]! + 1e-30)
  const at = (level: number) => {
    let i = 0
    while (i < tail.length - 1 && db(i) > level) i++
    return i / rate
  }
  return (60 / 30) * (at(-35) - at(-5))
}

/** Largest |second difference| within ±20 ms of the cut, against the largest over the 200 ms before. */
function clickRatio(data: Float32Array, cut: number, rate: number) {
  const d2 = (i: number) => Math.abs(data[i + 1]! - 2 * data[i]! + data[i - 1]!)
  let near = 0
  let before = 0
  const span = Math.round(0.02 * rate)
  for (let i = cut - span; i < cut + span; i++) near = Math.max(near, d2(i))
  for (let i = cut - 11 * span; i < cut - span; i++) before = Math.max(before, d2(i))
  return near / before
}

/** An octave band-pass (RBJ, constant 0 dB peak) run over `data`. */
function band(data: Float32Array, frequency: number, rate: number) {
  const w = (2 * Math.PI * frequency) / rate
  const alpha = Math.sin(w) * Math.sinh((Math.LN2 / 2) * ((1 * w) / Math.sin(w)))
  const a0 = 1 + alpha
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0]
  const out = new Float32Array(data.length)
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  for (let i = 0; i < data.length; i++) {
    const x = data[i]!
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y
    ;[x2, x1, y2, y1] = [x1, x, y1, y]
  }
  return out
}

export interface ReverbReport {
  kind: 'tone' | 'noise'
  sampleRate: number
  /** Measured RT60 of the tail (s) around 500 Hz and 4 kHz, and the designed one. */
  rt60: number
  rt60High: number
  designed: number
  /** Largest second-difference jump around the cut relative to the signal's own (≤ ~1: no click). */
  click: number
  /** Tail level 0.5 s after the cut (dBFS RMS over 50 ms) and peak of the whole render. */
  tailDb: number
  peak: number
  /** Extra render time per second of audio for the reverb (ms), i.e. cost as a share of real time ×1000. */
  costMsPerS: number
  pass: boolean
}

export async function checkReverb(kind: 'tone' | 'noise' = 'noise', sampleRate = 48000): Promise<ReverbReport> {
  const a = source(kind, sampleRate, 40)
  const b = new AudioBuffer({ numberOfChannels: 2, length: sampleRate * 40, sampleRate })
  const render = async (reverb: boolean) => {
    const started = performance.now()
    const out = await renderTransition({ a, b, transition: transition(reverb), preRoll: PRE, postRoll: POST, sampleRate })
    return { out, ms: performance.now() - started }
  }
  // Warm-up (worklets, the impulse), then each way twice, the faster counts.
  await render(true)
  const dry = [await render(false), await render(false)].sort((x, y) => x.ms - y.ms)[0]!
  const wet = [await render(true), await render(true)].sort((x, y) => x.ms - y.ms)[0]!
  const data = wet.out.getChannelData(0)
  const ret = data.map((value, i) => value - dry.out.getChannelData(0)[i]!)
  const cut = Math.round((PRE + LENGTH) * sampleRate)
  // The tail from 50 ms after the cut (A's 5 ms declick and the hall's onset behind).
  const from = cut + Math.round(0.05 * sampleRate)
  const measured = rt60(band(ret, 500, sampleRate), from, sampleRate)
  const measuredHigh = rt60(band(ret, 4000, sampleRate), from, sampleRate)
  let power = 0
  const at = cut + Math.round(0.5 * sampleRate)
  for (let i = at; i < at + Math.round(0.05 * sampleRate); i++) power += data[i]! ** 2
  let peak = 0
  for (const value of data) peak = Math.max(peak, Math.abs(value))
  const click = clickRatio(ret, cut, sampleRate)
  const seconds = PRE + LENGTH + POST
  const report = {
    kind,
    sampleRate,
    rt60: measured,
    rt60High: measuredHigh,
    designed: REVERB_RT60_S,
    click,
    tailDb: 10 * Math.log10(power / Math.round(0.05 * sampleRate) + 1e-30),
    peak,
    costMsPerS: (wet.ms - dry.ms) / seconds,
  }
  // A tone (one frequency) has a fluctuating tail: only noise's decay is judged.
  const rtOk = kind === 'tone' || (Math.abs(measured - REVERB_RT60_S) < 0.3 && measuredHigh < measured)
  return { ...report, pass: rtOk && click < 1.5 && peak <= 1 }
}

export interface EchoTailReport {
  sampleRate: number
  /** Samples above full scale, and the peak, after A is gone (B loud alone plus A's echo ringing). */
  over: number
  peak: number
  pass: boolean
}

/**
 * The echo out's tail must stay under the limiter: two loud noise decks, an echo on A (1 beat, feedback 0.7, about
 * 10 s to −60 dB, faded within 6 s), B playing on at full level. Without the limiter after `length`, B and the tail
 * add up past full scale.
 */
export async function checkEchoTail(sampleRate = 48000): Promise<EchoTailReport> {
  const loud = (seed: number) => {
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: sampleRate * 40, sampleRate })
    let state = seed
    for (let c = 0; c < 2; c++) {
      const data = new Float32Array(buffer.length)
      for (let i = 0; i < data.length; i++) data[i] = 0.7 * (((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1)
      buffer.copyToChannel(data, c)
    }
    return buffer
  }
  const echo: Transition = {
    ...transition(false),
    bAt: 0,
    length: 4,
    effects: [{ kind: 'echo', deck: 'a', at: 2, beats: 1, feedback: 0.7 }],
  }
  const out = await renderTransition({ a: loud(7), b: loud(11), transition: echo, preRoll: 2, postRoll: 8, sampleRate })
  let over = 0
  let peak = 0
  for (let c = 0; c < out.numberOfChannels; c++) {
    const data = out.getChannelData(c)
    for (let i = Math.round((2 + 4) * sampleRate); i < data.length; i++) {
      const value = Math.abs(data[i]!)
      peak = Math.max(peak, value)
      if (value > 1) over++
    }
  }
  return { sampleRate, over, peak, pass: over === 0 }
}
