// The editor's live checks and suggestions on synthetic songs. Run: pnpm test:mixer
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkTransition, slipDeck, suggestions } from '../editor-checks.ts'
import { finalizeTransition, planTransition } from '../planner.ts'
import { fixture } from './fixtures.ts'

/** A hand-made overlap: A out at `aOut`, B in at `bIn`, both at full volume for `length` seconds, A gone at the end. */
function overlap(a: any, b: any, aOut: number, bIn: number, length: number, extra: Partial<any> = {}) {
  const flat = { gain: [], low: [], mid: [], high: [], filter: [] }
  return {
    v: 2,
    from: 'A',
    to: 'B',
    style: 'party',
    preset: 'crossfade',
    aOut,
    bAt: 0,
    bIn,
    length,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    tempo: { a: a.bpm, b: b.bpm },
    a: { ...flat, gain: [{ t: 0, v: 1 }, { t: length - 0.05, v: 1 }, { t: length, v: 0 }] },
    b: { ...flat, gain: [{ t: 0, v: 1 }] },
    effects: [],
    custom: true,
    confidence: 1,
    ...extra,
  } as any
}

const kinds = (issues: Array<{ kind: string; severity: string }>, severity = 'warn') => issues.filter((x) => x.severity === severity).map((x) => x.kind)

const A = fixture({ bpm: 124, duration: 240, introBars: 16, outroBars: 32 })
const B = fixture({ bpm: 124, duration: 230, introBars: 32, outroBars: 16 })

test("the planner's own blend raises no warnings", () => {
  for (const style of ['clean', 'party'] as const) {
    const tr = planTransition(A, B, { from: 'A', to: 'B' }, style)
    assert.deepEqual(kinds(checkTransition(tr, A, B)), [], JSON.stringify(checkTransition(tr, A, B)))
  }
})

test('two basslines, located in the overlap', () => {
  const tr = overlap(A, B, A.downbeats[A.downbeats.length - 24], B.downbeats[0], 16)
  const issues = checkTransition(tr, A, B).filter((x) => x.kind === 'basslines')
  assert.ok(issues.length > 0, 'two basslines found')
  assert.ok(issues[0].from >= 0 && issues[0].to <= 16 && issues[0].to > issues[0].from)
})

test('two voices at once', () => {
  const A5 = fixture({ bpm: 124, duration: 200, vocals: [[20, 196]] })
  const B5 = fixture({ bpm: 124, duration: 200, vocals: [[1, 180]] })
  const tr = overlap(A5, B5, A5.downbeats[A5.downbeats.length - 20], B5.downbeats[2], 12, { b: { gain: [{ t: 0, v: 1 }], low: [{ t: 0, v: 0 }], mid: [], high: [], filter: [] } })
  assert.ok(checkTransition(tr, A5, B5).some((x) => x.kind === 'voices' && x.severity === 'warn'))
})

test('clashing keys over each other', () => {
  const Am = fixture({ bpm: 124, duration: 240, key: 9, minor: true, outroBars: 32 })
  const Ebm = fixture({ bpm: 124, duration: 230, key: 3, minor: true, introBars: 32 })
  const tr = overlap(Am, Ebm, Am.downbeats[Am.downbeats.length - 24], Ebm.downbeats[0], 12)
  assert.ok(checkTransition(tr, Am, Ebm).some((x) => x.kind === 'keyClash'))
})

test('energy: a jump up is flagged, a song that only ends soft is not held against B', () => {
  const soft = fixture({ bpm: 124, duration: 240, loudness: -22, outroBars: 32 })
  const loud = fixture({ bpm: 124, duration: 230, loudness: -8, introBars: 32 })
  const up = overlap(soft, loud, soft.downbeats[soft.downbeats.length - 24], loud.downbeats[40], 8)
  assert.ok(checkTransition(up, soft, loud).some((x) => x.kind === 'energyJump'), 'a 14 dB jump')
  // Same loudness, but A fades out over its last 20 s: B after A's soft ending is no jump against A's body.
  const fading = fixture({ bpm: 124, duration: 240, loudness: -9, outroBars: 32, fadeOut: 20 })
  const same = fixture({ bpm: 124, duration: 230, loudness: -9, introBars: 32 })
  const end = overlap(fading, same, fading.downbeats[fading.downbeats.length - 4], same.downbeats[40], 4)
  assert.ok(!checkTransition(end, fading, same).some((x) => x.kind === 'energyJump' && x.message.includes('lauter')))
})

test('beats running apart: different tempos without a rate', () => {
  const fast = fixture({ bpm: 130, duration: 230, introBars: 32 })
  const tr = overlap(A, fast, A.downbeats[A.downbeats.length - 24], fast.downbeats[0], 12, { b: { gain: [{ t: 0, v: 1 }], low: [{ t: 0, v: 0 }], mid: [], high: [], filter: [] } })
  assert.ok(checkTransition(tr, A, fast).some((x) => x.kind === 'beatsApart'))
})

test('stem lanes count: B\'s voice lane down silences the voice clash', () => {
  const A5 = fixture({ bpm: 124, duration: 200, vocals: [[20, 196]] })
  const B5 = fixture({ bpm: 124, duration: 200, vocals: [[1, 180]] })
  const tr = overlap(A5, B5, A5.downbeats[A5.downbeats.length - 20], B5.downbeats[2], 12, { b: { gain: [{ t: 0, v: 1 }], low: [{ t: 0, v: 0 }], mid: [], high: [], filter: [], vocals: [{ t: 0, v: 0 }] } })
  assert.ok(!checkTransition(tr, A5, B5).some((x) => x.kind === 'voices'))
})

test('nothing to judge: no analysis, no overlap', () => {
  const tr = planTransition(A, B, { from: 'A', to: 'B' }, 'party')
  assert.deepEqual(checkTransition(tr, null, B), [])
  assert.deepEqual(checkTransition({ ...tr, length: 0 }, A, B), [])
})

test('fast enough for every edit', () => {
  const tr = overlap(A, B, A.downbeats[A.downbeats.length - 40], B.downbeats[0], 32)
  checkTransition(tr, A, B)
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) checkTransition(tr, A, B)
  const ms = (performance.now() - t0) / 50
  assert.ok(ms < 16, `${ms.toFixed(2)} ms per check`)
})

test('suggestions: points inside the songs, loops on bars, the planner\'s variants as presets', () => {
  const sg = suggestions(A, B, { from: 'A', to: 'B' }, 'party')
  assert.ok(sg.outPoints.length > 0 && sg.outPoints.every((p) => p.at > 0 && p.at < A.duration && p.score >= 0 && p.score <= 1))
  assert.ok(sg.inPoints.length > 0 && sg.inPoints.every((p) => p.at >= 0 && p.at < B.duration))
  for (const l of sg.loops) {
    const track = l.deck === 'a' ? A : B
    assert.ok(track.downbeats.some((d: number) => Math.abs(d - l.from) < 0.01) && l.to > l.from, l.label)
  }
  assert.ok(sg.presets.length > 0 && new Set(sg.presets.map((p) => p.id)).size === sg.presets.length)
  assert.deepEqual(suggestions(null, B, { from: 'A', to: 'B' }, 'clean').outPoints, [])
})

test('finalizeTransition keeps the stem lanes; slipDeck moves a deck with its loops', () => {
  const tr = planTransition(A, B, { from: 'A', to: 'B' }, 'clean')
  const withStems = { ...tr, b: { ...tr.b, vocals: [{ t: 0, v: 0 }, { t: tr.length, v: 1 }], drums: [{ t: 1, v: 0.5 }] } }
  const fixed = finalizeTransition(withStems, A.duration, B.duration)
  assert.equal(fixed.b.vocals?.length, 2)
  assert.equal(fixed.b.drums?.length, 1)
  const looped = { ...tr, pathB: [{ from: tr.bIn, to: tr.bIn + 4, repeat: 2 }] }
  const slipped = slipDeck(looped, 'b', 2, A.duration, B.duration)
  assert.ok(Math.abs(slipped.bIn - (tr.bIn + 2)) < 0.002)
  assert.equal(slipped.pathB.length, 1, 'the loop moved with the deck')
  assert.ok(Math.abs(slipped.pathB[0].from - slipped.bIn) < 0.002)
  assert.equal(slipped.length, tr.length)
})
