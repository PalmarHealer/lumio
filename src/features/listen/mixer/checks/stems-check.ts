import { createDeck, loadEngineWorklets, scheduleAutomation } from '../engine'
import type { DeckAutomation } from '../types'

/**
 * Check of the stem lanes in a real deck (browser only: the stem split runs as an AudioWorklet), and a helper for
 * listening renders: a stretch of a song through a deck with its stem lanes held at given values.
 * Run it with the dev server: `/src/features/listen/mixer/checks/stems.html`.
 */

const RATE = 48000

const neutral = (): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [] })

/** `seconds` of `source` (from `from`) through a deck with `lanes` (stem lane values held throughout). */
export async function listen(source: AudioBuffer, from: number, seconds: number, lanes: { drums?: number; vocals?: number; instrumental?: number }) {
  const rate = source.sampleRate
  const ctx = new OfflineAudioContext(2, Math.round(seconds * rate), rate)
  await loadEngineWorklets(ctx)
  const deck = createDeck(ctx, ctx.destination)
  const player = new AudioBufferSourceNode(ctx, { buffer: source })
  player.connect(deck.input)
  player.start(0, from)
  const automation = neutral()
  for (const [lane, value] of Object.entries(lanes) as Array<[keyof typeof lanes, number]>) automation[lane] = [{ t: 0, v: value }]
  scheduleAutomation(deck, automation, 0)
  return ctx.startRendering()
}

const toneBuffer = (make: (t: number, channel: number) => number, seconds: number) => {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: seconds * RATE, sampleRate: RATE })
  for (let c = 0; c < 2; c++) buffer.copyToChannel(Float32Array.from({ length: buffer.length }, (_, i) => make(i / RATE, c)), c)
  return buffer
}

/** Peak (dB) of `buffer`'s left channel over [from, to] seconds. */
function peak(buffer: AudioBuffer, from: number, to: number) {
  const data = buffer.getChannelData(0)
  let max = 0
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) max = Math.max(max, Math.abs(data[i]!))
  return 20 * Math.log10(max + 1e-12)
}

export async function checkStems() {
  // A centred 1 kHz tone: the voice lane at 0 takes it away; with no lanes it passes exactly (the direct path).
  const centre = toneBuffer((t) => 0.3 * Math.sin(2 * Math.PI * 1000 * t), 2)
  const removed = peak(await listen(centre, 0, 2, { vocals: 0 }), 1, 2) - peak(centre, 1, 2)
  const straight = await listen(centre, 0, 2, {})
  let exact = 0
  for (let i = 0; i < straight.length; i++) exact = Math.max(exact, Math.abs(straight.getChannelData(0)[i]! - centre.getChannelData(0)[i]!))
  // All lanes at 1 but explicitly set: through the split, the input again to rounding.
  const ones = await listen(centre, 0, 2, { drums: 1, vocals: 1, instrumental: 1 })
  let rounding = 0
  for (let i = 0; i < ones.length; i++) rounding = Math.max(rounding, Math.abs(ones.getChannelData(0)[i]! - centre.getChannelData(0)[i]!))
  // A wide 3 kHz pad and a centred 60 Hz bass: instrumental at 0 keeps the bass, takes the pad.
  const pad = toneBuffer((t, c) => 0.4 * Math.sin(2 * Math.PI * 60 * t) + (c ? -1 : 1) * 0.3 * Math.sin(2 * Math.PI * 3000 * t), 2)
  const noPad = await listen(pad, 0, 2, { instrumental: 0 })
  const right = noPad.getChannelData(1)
  // What is left is the bass alone: left and right alike.
  let wide = 0
  for (let i = RATE; i < 2 * RATE; i++) wide = Math.max(wide, Math.abs(noPad.getChannelData(0)[i]! - right[i]!))
  const report = { voiceRemovedDb: removed, directExact: exact, splitRounding: rounding, padLeftDb: 20 * Math.log10(wide / 2 + 1e-12) }
  return { ...report, pass: removed < -20 && exact === 0 && rounding < 1e-5 && report.padLeftDb < -30 }
}
