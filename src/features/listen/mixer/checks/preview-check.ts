import { createTransitionPreview, type TransitionPreview } from '../preview'
import type { DeckAutomation, Transition } from '../types'

/**
 * Check of the editor preview (browser only, real time: about 10 s). Deck B plays a click track (a click every 0.25 s),
 * A is silent; the output is recorded frame by frame. Checked: a loop's seam keeps the click grid (no gap, no double),
 * an automation edit takes effect within ~50 ms without a restart, a timing edit restarts where it was, a scrub sounds
 * briefly, and the reported position stays in the loop while looping.
 * Run it with the dev server: `/src/features/listen/mixer/checks/preview.html`.
 */

const RATE = 48000
const EVERY = 0.25
const neutral = (): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [] })

function clicks(seconds: number) {
  const data = new Float32Array(seconds * RATE)
  for (let at = 0; at < seconds; at += EVERY) for (let i = 0; i < 96; i++) data[Math.round(at * RATE) + i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / RATE) * Math.exp(-i / 24)
  return data
}

const transition = (overrides: Partial<Transition> = {}): Transition => ({
  v: 2,
  from: 'a',
  to: 'b',
  style: 'clean',
  preset: 'blend',
  aOut: 30,
  bAt: 0,
  bIn: 10,
  length: 6,
  pathA: [],
  pathB: [],
  rateA: [],
  rateB: [],
  tempo: { a: 120, b: 120 },
  a: neutral(),
  b: neutral(),
  effects: [],
  custom: false,
  confidence: 1,
  ...overrides,
})

const RECORDER = [
  "registerProcessor('preview-recorder', class extends AudioWorkletProcessor {",
  '  process(inputs) { const input = inputs[0]; this.port.postMessage({ frame: currentFrame, data: input && input[0] ? input[0].slice(0) : new Float32Array(128) }); return true }',
  '})',
].join('\n')

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

type Block = { frame: number; data: Float32Array }

/** Onsets (context seconds) of the clicks in the recording. */
function onsetsOf(blocks: Block[]) {
  const onsets: number[] = []
  let quiet = -Infinity
  for (const block of blocks) {
    for (let i = 0; i < block.data.length; i++) {
      if (Math.abs(block.data[i]!) < 0.02) continue
      const t = (block.frame + i) / RATE
      if (t - quiet > 0.05) onsets.push(t)
      quiet = t
    }
  }
  return onsets
}

/** Peak (dB) of the recording over a context-time range. */
function peakOf(blocks: Block[], from: number, to: number) {
  let max = 0
  for (const block of blocks) {
    for (let i = 0; i < block.data.length; i++) {
      const t = (block.frame + i) / RATE
      if (t >= from && t < to) max = Math.max(max, Math.abs(block.data[i]!))
    }
  }
  return 20 * Math.log10(max + 1e-9)
}

export async function checkPreview() {
  const ctx = new AudioContext({ sampleRate: RATE })
  const url = URL.createObjectURL(new Blob([RECORDER], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const recorder = new AudioWorkletNode(ctx, 'preview-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' })
  const blocks: Block[] = []
  recorder.port.onmessage = (event: MessageEvent<Block>) => void blocks.push(event.data)
  const silent = { channels: [new Float32Array(60 * RATE)], origin: 0, sampleRate: RATE }
  const b = { channels: [clicks(40)], origin: 0, sampleRate: RATE }
  const preview: TransitionPreview = await createTransitionPreview({ a: silent, b, transition: transition(), context: ctx, destination: recorder })

  // 1. A loop [1, 2] (four clicks) for three passes: the clicks keep their 0.25 s grid across the seams.
  preview.setLoop({ from: 1, to: 2 })
  const loopStart = ctx.currentTime
  preview.play(1)
  await wait(3.4)
  const positions: number[] = []
  const unsubscribe = preview.onPosition((t) => positions.push(t))
  await wait(0.3)
  unsubscribe()
  preview.pause()
  const loopOnsets = onsetsOf(blocks).filter((t) => t > loopStart)
  const gaps = loopOnsets.slice(1).map((t, i) => t - loopOnsets[i]!)
  const loop = { clicks: loopOnsets.length, worstGapErrorMs: +(Math.max(...gaps.map((g) => Math.abs(g - EVERY))) * 1000).toFixed(3) }
  const positionsInLoop = positions.length > 0 && positions.every((t) => t >= 1 && t <= 2)

  // 2. An automation edit while playing (B's volume to 0): the clicks stop within ~50 ms, without a restart.
  preview.setLoop(null)
  await wait(0.3)
  preview.play(3)
  await wait(1)
  const editAt = ctx.currentTime
  preview.setTransition(transition({ b: { ...neutral(), gain: [{ t: 0, v: 0 }] } }))
  await wait(0.6)
  const lastClick = onsetsOf(blocks).filter((t) => t < editAt + 0.3).at(-1) ?? 0
  const automationEdit = { lastClickAfterEditMs: Math.round((lastClick - editAt) * 1000), peakAfterDb: +peakOf(blocks, editAt + 0.25, editAt + 0.55).toFixed(1) }
  preview.pause()

  // 3. A timing edit while playing (B enters an eighth later in its track): restarts where it was, on the new grid.
  preview.setTransition(transition())
  await wait(0.3)
  preview.play(3)
  await wait(1)
  const before = preview.position()
  preview.setTransition(transition({ bIn: 10.125 }))
  await wait(0.6)
  const after = preview.position()
  const restartOnsets = onsetsOf(blocks).filter((t) => t > ctx.currentTime - 0.55)
  const restartGaps = restartOnsets.slice(1).map((t, i) => t - restartOnsets[i]!)
  // (The restart itself may move the grid by the eighth: only the gaps after it count.)
  const timingEdit = { positionMoved: +(after - before).toFixed(3), clicksAfter: restartOnsets.length, gapsOnGrid: restartGaps.slice(1).every((g) => Math.abs(g - EVERY) < 0.002) }
  preview.pause()

  // 4. A scrub while paused, onto a click: about 80 ms of sound, still paused after.
  preview.setTransition(transition())
  await wait(0.3)
  const scrubAt = ctx.currentTime
  preview.scrub(2)
  await wait(0.5)
  const scrub = { clicks: onsetsOf(blocks).filter((t) => t > scrubAt).length, playing: preview.playing }

  // 5. A real stem arriving: B's whole track as its "voice" stem, the voice lane at 0: B falls silent.
  await preview.setStems('b', { vocals: b })
  preview.setTransition(transition({ b: { ...neutral(), vocals: [{ t: 0, v: 0 }] } }))
  const stemAt = ctx.currentTime
  preview.play(3)
  await wait(1)
  preview.pause()
  const realStem = { clicks: onsetsOf(blocks).filter((t) => t > stemAt).length, peakDb: +peakOf(blocks, stemAt + 0.3, stemAt + 1).toFixed(1) }

  preview.dispose()
  await ctx.close()
  const pass =
    loop.worstGapErrorMs < 1 &&
    loop.clicks >= 12 &&
    positionsInLoop &&
    automationEdit.peakAfterDb < -60 &&
    automationEdit.lastClickAfterEditMs < 250 &&
    timingEdit.positionMoved > 0.4 &&
    timingEdit.positionMoved < 0.8 &&
    timingEdit.gapsOnGrid &&
    scrub.clicks >= 1 &&
    !scrub.playing
  return { loop, positionsInLoop, automationEdit, timingEdit, scrub, realStem, pass: pass && realStem.clicks === 0 && realStem.peakDb < -60 }
}
