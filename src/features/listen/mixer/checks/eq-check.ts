import { createDeck, scheduleAutomation } from '../engine'

/**
 * Check of the low band's kill (browser only): the steady level (dB) of tones through a deck whose low band is held at a
 * value, 40-400 Hz. Killed (0), what is left of the bass must be well down: 150 Hz by at least 24 dB, 120 Hz by 36 dB
 * (the isolator alone: 12 and 19); at 0.5 (−6 dB) the low band is only turned down, as before. Run it with the dev
 * server: `/src/features/listen/mixer/checks/eq.html`.
 */

export const FREQUENCIES = [40, 60, 80, 100, 120, 150, 180, 200, 250, 300, 400]

export async function lowResponse(low: number, sampleRate = 48000) {
  const levels: Record<number, number> = {}
  for (const frequency of FREQUENCIES) {
    const ctx = new OfflineAudioContext(1, sampleRate, sampleRate)
    const deck = createDeck(ctx, ctx.destination)
    const tone = new OscillatorNode(ctx, { frequency })
    tone.connect(deck.input)
    scheduleAutomation(deck, { gain: [], low: [{ t: 0, v: low }], mid: [], high: [], filter: [] }, 0)
    tone.start()
    const data = (await ctx.startRendering()).getChannelData(0)
    let peak = 0
    for (let i = sampleRate / 2; i < sampleRate; i++) peak = Math.max(peak, Math.abs(data[i]!))
    levels[frequency] = Math.round(200 * Math.log10(peak)) / 10
  }
  return levels
}

export async function checkLowKill() {
  const killed = await lowResponse(0)
  const half = await lowResponse(0.5)
  const pass = killed[150]! <= -24 && killed[120]! <= -36 && killed[400]! > -1.5 && half[60]! < -5.5 && half[60]! > -6.5 && half[400]! > -1
  return { killed, half, pass }
}
