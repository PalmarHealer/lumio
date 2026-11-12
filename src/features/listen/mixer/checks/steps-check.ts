import { createDeck, scheduleAutomation } from '../engine'
import type { DeckAutomation, Keyframe } from '../types'

/**
 * Check of steps in automation curves (browser only): two keyframes at the same time are a jump, and a jump right
 * where a curve starts to be played (t = 0, or the moment a paused transition resumes) must be taken, not held at its
 * first value. Per lane, a tone in the lane's range plays through a deck whose lane jumps from neutral to its far end
 * at t = 0, at t = 0.5, and when scheduled from (`from`) exactly the jump's time; the level after the jump is
 * measured against the tone's own. The deck is the same for the player (element or buffer feeding it) and the render.
 * Run it with the dev server: `/src/features/listen/mixer/checks/steps.html`.
 */

const RATE = 48000

type Lane = keyof DeckAutomation

/** Per lane: the tone to listen to, the far value, and the most (dB) that may be left after jumping there. */
const CASES: Array<{ lane: Lane; tone: number; neutral: number; far: number; atMostDb: number }> = [
  { lane: 'gain', tone: 1000, neutral: 1, far: 0, atMostDb: -90 },
  { lane: 'low', tone: 60, neutral: 1, far: 0, atMostDb: -40 },
  { lane: 'mid', tone: 700, neutral: 1, far: 0, atMostDb: -30 },
  { lane: 'high', tone: 8000, neutral: 1, far: 0, atMostDb: -40 },
  { lane: 'filter', tone: 2000, neutral: 0, far: -1, atMostDb: -40 },
]

const neutral = (): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [] })

/** Level (dB, steady peak) of the tone over [from, to] seconds, through a deck with `automation` played from `start`. */
async function level(tone: number, automation: DeckAutomation, options: { from?: number }, from: number, to: number) {
  const ctx = new OfflineAudioContext(1, Math.round(1.5 * RATE), RATE)
  const deck = createDeck(ctx, ctx.destination)
  const osc = new OscillatorNode(ctx, { frequency: tone })
  osc.connect(deck.input)
  osc.start()
  // Played from context time 0 as transition time `options.from` (resuming there).
  scheduleAutomation(deck, automation, -(options.from ?? 0), options)
  const data = (await ctx.startRendering()).getChannelData(0)
  let peak = 0
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) peak = Math.max(peak, Math.abs(data[i]!))
  return 20 * Math.log10(peak + 1e-12)
}

export interface StepReport {
  lane: Lane
  /** dB after the jump at t = 0, at t = 0.5, and when resumed exactly at a jump; and before the mid jump. */
  atStart: number
  midway: number
  resumed: number
  before: number
  pass: boolean
}

export async function checkSteps(): Promise<StepReport[]> {
  const reports: StepReport[] = []
  for (const { lane, tone, neutral: n, far, atMostDb } of CASES) {
    const step = (t: number): Keyframe[] => [
      { t, v: n },
      { t, v: far },
    ]
    const at = (keyframes: Keyframe[]) => ({ ...neutral(), [lane]: keyframes })
    // Filters settle within tens of ms; measured from 0.2 s after each jump.
    const atStart = await level(tone, at(step(0)), {}, 0.2, 1.4)
    const before = await level(tone, at(step(0.5)), {}, 0.1, 0.45)
    const midway = await level(tone, at(step(0.5)), {}, 0.7, 1.4)
    const resumed = await level(tone, at(step(0.5)), { from: 0.5 }, 0.2, 1.4)
    // Before the mid jump the lane is neutral: the tone passes (within 1 dB of its −0 dB peak).
    const pass = atStart <= atMostDb && midway <= atMostDb && resumed <= atMostDb && before > -1.5
    reports.push({ lane, atStart, midway, resumed, before, pass })
  }
  return reports
}

/** The reverb send jumping to 1 at t = 0 (and on resuming at a jump): its return must sound right away. */
export async function checkReverbStep() {
  const tail = async (keyframes: Keyframe[], from?: number) => {
    const ctx = new OfflineAudioContext(1, RATE, RATE)
    const deck = createDeck(ctx, ctx.destination)
    const osc = new OscillatorNode(ctx, { frequency: 500 })
    const cut = new GainNode(ctx)
    osc.connect(cut).connect(deck.input)
    // The tone stops at 0.3 s: what is heard after it is the reverb alone.
    cut.gain.setValueAtTime(0, 0.3)
    osc.start()
    scheduleAutomation(deck, { ...neutral(), reverb: keyframes }, -(from ?? 0), { from })
    const data = (await ctx.startRendering()).getChannelData(0)
    let peak = 0
    for (let i = Math.round(0.35 * RATE); i < Math.round(0.6 * RATE); i++) peak = Math.max(peak, Math.abs(data[i]!))
    return 20 * Math.log10(peak + 1e-12)
  }
  const atStart = await tail([
    { t: 0, v: 0 },
    { t: 0, v: 1 },
  ])
  const resumed = await tail(
    [
      { t: 0.5, v: 0 },
      { t: 0.5, v: 1 },
    ],
    0.5,
  )
  return { lane: 'reverb', atStart, resumed, pass: atStart > -40 && resumed > -40 }
}
