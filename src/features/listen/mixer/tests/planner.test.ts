// The planner on synthetic songs: every plan keeps the invariants (`check`), and each scenario gets the kind of
// transition it calls for. Run: pnpm test:mixer
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { camelotLabel, fromCamelot, harmonicScore } from '../camelot.ts'
import { planFallback, planTransition, planVariants } from '../planner.ts'
import { check, deckPosition, describe, fixture } from './fixtures.ts'

const rel = (tr: any) => (tr.rateB.length ? tr.rateB[0].v : 1) / (tr.rateA.length ? tr.rateA[tr.rateA.length - 1].v : 1)
const unsynced = (tr: any) => tr.rateA.length === 0 && tr.rateB.length === 0
const NEVER = (tr: any) => tr.preset === 'hardCut' || tr.preset === 'brake' || (tr.preset === 'dropSwap' && tr.length < (8 * 4 * 60) / 200)

/** Plans a pair in a test of its own: no invariant broken, no cut unless forced, and `extra`'s wish met. */
function plan(name: string, a: any, b: any, style: 'clean' | 'party', extra: (tr: any) => [boolean, string] | void = () => {}, opts?: any) {
  test(`${name} [${style}]`, () => {
    const tr = planTransition(a, b, { from: 'A', to: 'B' }, style, opts)
    const errors = check(tr, a, b, { phrases: true })
    if (!opts?.preset && NEVER(tr)) errors.push(`auto produced a cut (${tr.preset}, ${tr.length.toFixed(2)} s)`)
    assert.deepEqual(errors, [], describe(tr))
    const more = extra(tr)
    if (more) assert.ok(more[0], `want: ${more[1]}; got ${describe(tr)}`)
  })
}

test('camelot', () => {
  assert.equal(camelotLabel(0, false), '8B')
  assert.equal(camelotLabel(9, true), '8A')
  assert.equal(camelotLabel(6, false), '2B')
  assert.ok([...Array(12).keys()].every((k) => fromCamelot(camelotLabel(k, true))?.key === k))
})

test('harmony: same > adjacent > boost > clash; an unclear key is neutral', () => {
  const am = { key: 9, minor: true }
  assert.ok(harmonicScore(am, am) > harmonicScore(am, { key: 4, minor: true }))
  assert.ok(harmonicScore(am, { key: 4, minor: true }) > harmonicScore(am, { key: 11, minor: true }))
  assert.ok(harmonicScore(am, { key: 11, minor: true }) > harmonicScore(am, { key: 3, minor: true }))
  assert.ok(Math.abs(harmonicScore({ key: 9, minor: true, keyClarity: 0.1 }, { key: 3, minor: true }) - 0.6) < 1e-9)
})

// Same tempo, same key, instrumental intro and outro.
const A1 = fixture({ bpm: 124, duration: 240, introBars: 16, outroBars: 32 })
const B1 = fixture({ bpm: 124, duration: 230, introBars: 32, outroBars: 16 })
plan('equal tempo same key', A1, B1, 'clean', (tr) => [tr.length >= (8 * 4 * 60) / 124 - 0.1 && tr.preset === 'blend' && Math.abs(rel(tr) - 1) < 0.002, 'a blend of 8 bars or more at rate 1'])
plan('equal tempo same key', A1, B1, 'party')

// ±4 % tempo.
const B2 = fixture({ bpm: 124 * 1.04, duration: 220, introBars: 32 })
plan('+4 % tempo', A1, B2, 'clean', (tr) => [Math.abs(rel(tr) * 1.04 - 1) < 0.01 && tr.length > 0 && tr.rateA.length === 2, 'beatmatched, meeting in the middle, A gliding first'])
const B2b = fixture({ bpm: 124 / 1.04, duration: 220, introBars: 32 })
plan('−4 % tempo', A1, B2b, 'party', (tr) => [unsynced(tr) || Math.abs(rel(tr) - 1.04) < 0.01, 'relative rate ≈ 1.04'])

// A 30 % tempo gap: no beatmatch, and no cut.
const B3 = fixture({ bpm: 90, duration: 200, introBars: 8 })
plan('30 % tempo gap', A1, B3, 'clean', (tr) => [unsynced(tr) && ['echoOut', 'fadeOut', 'fadeIn', 'none'].includes(tr.preset), 'technique without beatmatch'])
plan('30 % tempo gap', A1, B3, 'party', (tr) => [unsynced(tr) && ['echoOut', 'fadeOut'].includes(tr.preset), 'technique without beatmatch'])

// Half time: A 140, B 70.
const A4 = fixture({ bpm: 140, duration: 220, introBars: 16, outroBars: 32 })
const B4 = fixture({ bpm: 70, duration: 240, introBars: 8, outroBars: 8 })
plan('half time', A4, B4, 'clean', (tr) => [tr.length > 8 && Math.abs(rel(tr) - 1) < 0.01, 'beatmatched in half time at rate 1'])
const B4b = fixture({ bpm: 71.5, duration: 240, introBars: 8 })
plan('half time +2 %', A4, B4b, 'clean', (tr) => [unsynced(tr) || Math.abs(rel(tr) - 140 / (2 * 71.5)) < 0.01, 'relative rate ≈ 0.979'])

// Vocals: A sings to the very end and B from its first bar; or both leave a window.
const A5 = fixture({ bpm: 124, duration: 200, vocals: [[30, 196]] })
const B5 = fixture({ bpm: 124, duration: 200, vocals: [[1, 180]] })
plan('vocals everywhere', A5, B5, 'clean')
plan('vocals everywhere', A5, B5, 'party')
const A5b = fixture({ bpm: 124, duration: 210, vocals: [[30, 120], [140, 186]], outroBars: 24 })
const B5b = fixture({ bpm: 124, duration: 200, vocals: [[16, 60], [80, 170]], introBars: 32 })
plan('vocals in the window', A5b, B5b, 'clean')

// An unsure analysis.
const A6 = fixture({ bpm: 124, bpmConfidence: 0.2, keyClarity: 0.1 })
plan('unsure tempo', A6, B1, 'clean', (tr) => [tr.confidence < 0.7 && unsynced(tr), 'safe technique, low confidence'])
plan('unsure tempo', A6, B1, 'party', (tr) => [tr.confidence < 0.7 && unsynced(tr), 'safe technique, low confidence'])
const A6b = fixture({ bpm: 124, vocalSource: 'none' })
plan('vocals unknown', A6b, B1, 'clean', (tr) => [tr.length <= (16 * 4 * 60) / 124 + 0.1, '≤ 16 bars'])

// Drops: party lands B's drop on the swap or as A stops.
const period = 60 / 128
const B7 = fixture({ bpm: 128, duration: 260, introBars: 16, drops: [0.2 + 32 * 4 * period], vocals: [[100, 160]], cuesIn: [0.2 + 16 * 4 * period] })
const A7 = fixture({ bpm: 128, duration: 250, chorus: [[120, 150]], drops: [0.2 + 96 * 4 * period], vocals: [[40, 150]], cuesOut: [0.2 + 80 * 4 * period] })
plan('drops', A7, B7, 'party', (tr) => {
  const drop = B7.drops[0]
  const swap = tr.b.low.filter((k: any) => k.v >= 0.5)[0]?.t ?? tr.length
  const atSwap = deckPosition(tr, 'b', swap) ?? tr.bIn
  const end = deckPosition(tr, 'b', tr.length) ?? tr.bIn
  return [Math.abs(atSwap - drop) < 0.1 || Math.abs(end - drop) < 0.1, `B's drop at ${drop.toFixed(2)} on the swap (${atSwap.toFixed(2)}) or as A stops (${end.toFixed(2)})`]
})
plan('drops', A7, B7, 'clean', (tr) => [tr.bIn < 30, 'clean starts B near its start'])

// Garbage analyses: always a valid plan.
const garbage: any[] = [
  {},
  { duration: NaN },
  { duration: 180, beats: [NaN, 'x', -3], bpm: NaN },
  { duration: 12, beats: [0, 0.5, 1], bpm: 120 },
  { ...fixture(), phrases: [], downbeats: [] },
  { ...fixture(), vocals: [{ start: 50, end: 20 }, { start: NaN, end: 4 }], energy: null, bands: null, sections: null },
  { ...fixture(), duration: -5 },
  { ...fixture(), beats: fixture().beats.map(() => 3) },
  { ...fixture({ duration: 35 }) },
]
for (const [i, g] of garbage.entries()) {
  for (const style of ['clean', 'party'] as const) {
    test(`garbage #${i} [${style}]`, () => {
      const known = Number.isFinite(g?.duration) && g.duration > 0 ? g : null
      const asA = planTransition(g, B1, { from: 'A', to: 'B' }, style)
      assert.deepEqual(check(asA, known, B1), [], describe(asA))
      const asB = planTransition(A1, g, { from: 'A', to: 'B' }, style)
      assert.deepEqual(check(asB, A1, known), [], describe(asB))
    })
  }
}

test('fallback', () => {
  const fb = planFallback('A', 'B', 200)
  assert.deepEqual(check(fb, { duration: 200 }, null), [])
  assert.equal(fb.aOut, 196)
  assert.deepEqual(check(planFallback('A', 'B', NaN), null, null), [])
})

// Forced presets on a matching pair: all valid; long ones without a beatmatch stay short.
for (const preset of ['crossfade', 'fadeOut', 'fadeIn', 'bassSwap', 'filterBuild', 'echoOut', 'dropSwap', 'hardCut', 'brake', 'none']) {
  for (const style of ['clean', 'party'] as const) plan(`forced ${preset}`, A1, B1, style, (tr) => [tr.preset === preset, preset], { preset })
}
plan('forced bassSwap, 30 % gap', A1, B3, 'clean', (tr) => [tr.length - tr.bAt <= (2 * 4 * 60) / 124 + 0.14, 'overlap ≤ 2 bars (+ the 40 ms lead-in)'], { preset: 'bassSwap' })

// Attack clarity: no long beatmatch over unclear phrases; without the measure, a blend at lower confidence.
{
  const A = fixture({ bpm: 124, duration: 240, introBars: 16, outroBars: 32, clarity: (t) => (t > 150 ? 0.3 : 0.9) })
  const B = fixture({ bpm: 124, duration: 230, introBars: 32, outroBars: 16 })
  plan('unclear outro', A, B, 'clean', (tr) => [!['bassSwap', 'crossfade', 'filterBuild'].includes(tr.preset) || tr.aOut + tr.length <= 150 + 0.1, 'no beatmatch over unclear phrases'])
  const A2 = fixture({ bpm: 124, duration: 240, introBars: 16, outroBars: 32, clarity: null })
  const B2c = fixture({ bpm: 124, duration: 230, introBars: 32, outroBars: 16, clarity: null })
  plan('clarity unknown', A2, B2c, 'clean', (tr) => [tr.confidence < 0.8, 'lower confidence'])
}

// Loops: A sings until 8 bars before its end, B from its 4th bar: a long blend loops whole bars, or A plays out.
{
  const p = 60 / 124
  const A = fixture({ bpm: 124, duration: 220, outroBars: 8, vocals: [[20, 0.2 + (Math.floor((220 - 0.2) / (4 * p)) - 8) * 4 * p - 0.3]] })
  const B = fixture({ bpm: 124, duration: 220, introBars: 4, vocals: [[0.2 + 4 * 4 * p + 0.2, 200]], cuesIn: [0.2 + 4 * 4 * p] })
  for (const style of ['clean', 'party'] as const)
    plan('blend with loops', A, B, style, (tr) => {
      const loops = [...tr.pathA, ...tr.pathB].filter((s: any) => s.repeat > 1)
      const downbeat = (m: any, t: number) => m.downbeats.some((d: number) => Math.abs(d - t) < 0.002 || Math.abs(d - 0.02 - t) < 0.002)
      const onBars = tr.pathA.every((s: any, k: number) => (k === 0 || downbeat(A, s.from)) && downbeat(A, s.to)) && tr.pathB.every((s: any, k: number) => (k === 0 || downbeat(B, s.from)) && downbeat(B, s.to))
      const playsOut = Math.abs((deckPosition(tr, 'a', tr.length) ?? 0) - A.downbeats[A.downbeats.length - 1]) < 2.5
      return [tr.preset !== 'blend' || (onBars && (loops.length > 0 || playsOut)), 'loops of whole bars on downbeats, or A playing out']
    })
}

// Loudness: a blend keeps both decks at full volume (no gain dips).
{
  const quiet = fixture({ bpm: 124, duration: 240, introBars: 16, outroBars: 32, loudness: -14 })
  const loud = fixture({ bpm: 124, duration: 230, introBars: 32, outroBars: 16, loudness: -9 })
  for (const [x, y, name] of [[quiet, loud, 'louder B'], [loud, quiet, 'louder A']] as const) {
    plan(`blend with a ${name}`, x, y, 'clean', (tr) => {
      const minA = Math.min(...tr.a.gain.filter((k: any) => k.t < tr.length - 0.05).map((k: any) => k.v))
      const endB = tr.b.gain.length ? tr.b.gain[tr.b.gain.length - 1].v : 1
      return [tr.preset !== 'blend' || tr.b.gain.length === 0 || ((minA >= 0.99 || tr.a.gain.length === 0) && endB === 1), 'no gain dip']
    })
  }
}

test('variants: valid, distinct labels, the best first', () => {
  for (const style of ['clean', 'party'] as const) {
    const variants = planVariants(A7, B7, { from: 'A', to: 'B' }, style, { count: 4 })
    assert.ok(variants.length >= 1)
    for (const v of variants) assert.deepEqual(check(v.transition, A7, B7), [], v.label)
    assert.deepEqual(variants[0].transition, planTransition(A7, B7, { from: 'A', to: 'B' }, style))
    assert.equal(new Set(variants.map((v) => v.label)).size, variants.length)
  }
})

test('relaxVoices is opt-in: off by default, labelled when used', () => {
  const plain = planVariants(A5, B5, { from: 'A', to: 'B' }, 'party', { count: 4 })
  assert.ok(plain.every((v) => !v.label.startsWith('Test:')))
  const relaxed = planVariants(A5, B5, { from: 'A', to: 'B' }, 'party', { count: 4, relaxVoices: 2 })
  for (const v of relaxed) assert.ok(v.transition.preset !== 'blend' || v.label.startsWith('Test: Gesang darf sich kurz berühren'), v.label)
})

test('back to back is never automatic (round 2), only when picked', () => {
  const pairs: Array<[any, any]> = [[A1, B1], [A1, B3], [A5, B5], [A6, B1], [A6b, B1], [A4, B4b], [A7, B7]]
  for (const style of ['clean', 'party'] as const) {
    for (const [a, b] of pairs) {
      for (const v of planVariants(a, b, { from: 'A', to: 'B' }, style, { count: 4 })) assert.notEqual(v.transition.preset, 'none', `${style}: ${v.label}`)
    }
    assert.equal(planTransition(A1, B1, { from: 'A', to: 'B' }, style, { preset: 'none' }).preset, 'none')
  }
})

test("echo out: B's bass eases in over a bar after A's goes", () => {
  const tr = planTransition(A1, B3, { from: 'A', to: 'B' }, 'party', { preset: 'echoOut' })
  assert.equal(tr.preset, 'echoOut')
  const aLowGone = tr.a.low.find((k: any) => k.v <= 0.05)?.t ?? 0
  const bLowFull = tr.b.low.find((k: any) => k.v >= 0.99)?.t ?? 0
  const beat = 60 / tr.tempo.a
  assert.ok(bLowFull - aLowGone >= 4 * beat - 0.05, `B's low full ${(bLowFull - aLowGone).toFixed(2)} s after A's went`)
})

test('timing: 100 plans', () => {
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) planTransition(A7, B7, { from: 'A' + i, to: 'B' }, i % 2 ? 'clean' : 'party')
  const ms = (performance.now() - t0) / 100
  assert.ok(ms < 200, `${ms.toFixed(1)} ms per plan`)
})
