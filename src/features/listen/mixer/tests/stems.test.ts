/** The stem lanes' live approximation (stems.ts), on synthetic signals: what each lane takes away, and what it keeps. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StemSplit } from '../stems.ts'

const RATE = 48000

/** Runs the splitter over a whole stereo signal with fixed gains. */
function split(left: Float32Array, right: Float32Array, gains: { drums?: number; vocals?: number; instrumental?: number }) {
  const s = new StemSplit(RATE)
  const outLeft = new Float32Array(left.length)
  const outRight = new Float32Array(left.length)
  const g = (v = 1) => Float32Array.of(v)
  for (let at = 0; at < left.length; at += 128) {
    const n = Math.min(128, left.length - at)
    s.run(left.subarray(at, at + n), right.subarray(at, at + n), outLeft.subarray(at, at + n), outRight.subarray(at, at + n), g(gains.drums), g(gains.vocals), g(gains.instrumental), n)
  }
  return [outLeft, outRight] as const
}

/** Level (dB) of frequency `f` in `x` over [from, to] seconds (Goertzel, amplitude of a sine). */
function tone(x: Float32Array, f: number, from: number, to: number) {
  const a = Math.round(from * RATE)
  const b = Math.round(to * RATE)
  const w = (2 * Math.PI * f) / RATE
  let s1 = 0
  let s2 = 0
  for (let i = a; i < b; i++) {
    const s = x[i]! + 2 * Math.cos(w) * s1 - s2
    s2 = s1
    s1 = s
  }
  const power = s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2
  return 20 * Math.log10((2 * Math.sqrt(power)) / (b - a) + 1e-12)
}

const rms = (x: Float32Array, from: number, to: number) => {
  let sum = 0
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) sum += x[i]! ** 2
  return 10 * Math.log10(sum / (Math.round(to * RATE) - Math.round(from * RATE)) + 1e-20)
}

const signal = (seconds: number, at: (t: number, channel: number) => number) =>
  [0, 1].map((c) => Float32Array.from({ length: seconds * RATE }, (_, i) => at(i / RATE, c))) as [Float32Array, Float32Array]

/** Seeded noise. */
function noise(seed: number) {
  let state = seed
  return () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1
}

test('all lanes at 1: the output is the input', () => {
  const random = noise(3)
  const [l, r] = signal(1, (t, c) => 0.3 * random() + 0.3 * Math.sin(2 * Math.PI * (c ? 220 : 330) * t))
  const [ol, or] = split(l, r, {})
  let worst = 0
  for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.abs(ol[i]! - l[i]!), Math.abs(or[i]! - r[i]!))
  assert.ok(worst < 1e-5, `${worst}`)
})

test('drums at 0: clicks go, a steady tone stays', () => {
  const random = noise(5)
  // A quiet 440 Hz tone, with a snare-like hit every half second (noise decaying over 30 ms).
  const [l, r] = signal(3, (t) => 0.15 * Math.sin(2 * Math.PI * 440 * t) + (t % 0.5 < 0.08 ? 0.6 * random() * Math.exp(-(t % 0.5) / 0.03) : 0))
  const [ol] = split(l, r, { drums: 0 })
  // The hits' attacks (their first 15 ms) lose most of their energy...
  const before = rms(l, 1.5, 1.515)
  const after = rms(ol, 1.5, 1.515)
  assert.ok(before - after > 6, `burst only ${(before - after).toFixed(1)} dB down`)
  // ...the tone between them keeps its level.
  assert.ok(Math.abs(tone(ol, 440, 1.2, 1.45) - tone(l, 440, 1.2, 1.45)) < 1, 'tone level changed')
})

test('vocals at 0: a centred tone in the voice range goes, a wide one stays', () => {
  // Alone in the centre: cancelled (only the range's edges leak).
  const [cl, cr] = signal(2, (t) => 0.3 * Math.sin(2 * Math.PI * 1000 * t))
  const [col] = split(cl, cr, { vocals: 0 })
  assert.ok(tone(cl, 1000, 1, 2) - tone(col, 1000, 1, 2) > 20, 'centre alone')
  // 1 kHz in the centre (left = right), 2.5 kHz as loud only on the sides (left = -right): the octaves overlap a
  // little, so the centre goes less far.
  const [l, r] = signal(2, (t, c) => 0.3 * Math.sin(2 * Math.PI * 1000 * t) + (c ? -1 : 1) * 0.3 * Math.sin(2 * Math.PI * 2500 * t))
  const [ol] = split(l, r, { vocals: 0 })
  assert.ok(tone(l, 1000, 1, 2) - tone(ol, 1000, 1, 2) > 12, `centre only ${(tone(l, 1000, 1, 2) - tone(ol, 1000, 1, 2)).toFixed(1)} dB down`)
  assert.ok(Math.abs(tone(ol, 2500, 1, 2) - tone(l, 2500, 1, 2)) < 1, 'side tone changed')
})

test('instrumental at 0: the rest goes, the bass stays', () => {
  // A 60 Hz bass in the centre and a wide 3 kHz pad.
  const [l, r] = signal(2, (t, c) => 0.4 * Math.sin(2 * Math.PI * 60 * t) + (c ? -1 : 1) * 0.3 * Math.sin(2 * Math.PI * 3000 * t))
  const [ol] = split(l, r, { instrumental: 0 })
  assert.ok(Math.abs(tone(ol, 60, 1, 2) - tone(l, 60, 1, 2)) < 1, 'bass changed')
  assert.ok(tone(l, 3000, 1, 2) - tone(ol, 3000, 1, 2) > 15, 'pad stayed')
})

test('real stems take a component over: the voice from its stem, the instrumental as the mix without it', () => {
  // A centred 1 kHz "voice" (also given as its real stem) over a wide 3 kHz pad.
  const [l, r] = signal(2, (t, c) => 0.3 * Math.sin(2 * Math.PI * 1000 * t) + (c ? -1 : 1) * 0.2 * Math.sin(2 * Math.PI * 3000 * t))
  const voice = signal(2, (t) => 0.3 * Math.sin(2 * Math.PI * 1000 * t))
  const run = (gains: { vocals: number; instrumental: number }, use: number) => {
    const s = new StemSplit(RATE)
    const out = [new Float32Array(l.length), new Float32Array(l.length)]
    for (let at = 0; at < l.length; at += 128) {
      const n = Math.min(128, l.length - at)
      const slice = (x: Float32Array) => x.subarray(at, at + n)
      s.run(slice(l), slice(r), slice(out[0]!), slice(out[1]!), Float32Array.of(1), Float32Array.of(gains.vocals), Float32Array.of(gains.instrumental), n, {
        vocals: voice.map(slice),
        use: { drums: Float32Array.of(0), vocals: Float32Array.of(use), instrumental: Float32Array.of(0) },
      })
    }
    return out
  }
  // With its real stem, the voice goes completely (not to -24 dB) and the pad stays.
  const [noVoice] = run({ vocals: 0, instrumental: 1 }, 1)
  assert.ok(tone(l, 1000, 1, 2) - tone(noVoice!, 1000, 1, 2) > 60, 'voice left')
  assert.ok(Math.abs(tone(noVoice!, 3000, 1, 2) - tone(l, 3000, 1, 2)) < 0.5, 'pad changed')
  // The instrumental is the mix without the real voice: at 0 the pad goes, the voice stays.
  const [noRest] = run({ vocals: 1, instrumental: 0 }, 1)
  assert.ok(tone(l, 3000, 1, 2) - tone(noRest!, 3000, 1, 2) > 20, 'pad left')
  assert.ok(Math.abs(tone(noRest!, 1000, 1, 2) - tone(l, 1000, 1, 2)) < 0.5, 'voice changed')
  // All lanes at 1 with real stems in use: the input again.
  const [same] = run({ vocals: 1, instrumental: 1 }, 1)
  let worst = 0
  for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.abs(same![i]! - l[i]!))
  assert.ok(worst < 1e-5, `${worst}`)
})
