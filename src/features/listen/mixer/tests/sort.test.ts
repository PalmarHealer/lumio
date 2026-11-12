// Sort & build on a synthetic library: the order is a better playlist than the input, unanalysed songs keep their
// place, and the built transitions are valid. Run: pnpm test:mixer
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harmonicScore } from '../camelot.ts'
import { buildTransitions, customCount, transitionFor } from '../resolve.ts'
import { estimateMixLength, pairScore, sortForMix } from '../sort.ts'
import { check, fixture } from './fixtures.ts'

/** A deterministic pseudo-random library of `n` synthetic songs. */
function library(n: number, start = 42) {
  let seed = start
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const tracks: Array<{ id: string; mix: any }> = []
  for (let i = 0; i < n; i++) {
    const bpm = [96, 100, 120, 122, 124, 126, 128, 128, 130, 140, 174][Math.floor(rnd() * 11)] * (0.98 + rnd() * 0.04)
    const duration = 160 + rnd() * 120
    const drops = rnd() < 0.3 ? [60 + rnd() * 30] : []
    tracks.push({
      id: 't' + i,
      mix: fixture({ bpm, duration, key: Math.floor(rnd() * 12), minor: rnd() < 0.5, loudness: -16 + rnd() * 11, drops, keyClarity: 0.3 + rnd() * 0.7 }),
    })
  }
  return tracks
}

const meanScore = (order: string[], byId: Map<string, any>, style: 'clean' | 'party') => {
  let total = 0
  for (let i = 1; i < order.length; i++) total += pairScore(byId.get(order[i - 1]), byId.get(order[i]), style)
  return total / (order.length - 1)
}

for (const n of [12, 60, 300]) {
  for (const style of ['clean', 'party'] as const) {
    test(`sort ${n} songs [${style}]: a permutation that scores better, within a second`, () => {
      const tracks = library(n)
      const byId = new Map(tracks.map((t) => [t.id, t.mix]))
      const t0 = performance.now()
      const order = sortForMix(tracks, style)
      const ms = performance.now() - t0
      assert.equal(order.length, n)
      assert.equal(new Set(order).size, n)
      const before = meanScore(tracks.map((t) => t.id), byId, style)
      const after = meanScore(order, byId, style)
      assert.ok(after > before, `mean pair score ${before.toFixed(3)} → ${after.toFixed(3)}`)
      assert.ok(ms < 1000, `${ms.toFixed(0)} ms`)
    })
  }
}

test('sort keeps unanalysed songs in their place', () => {
  const tracks = library(20)
  tracks[3].mix = null
  tracks[11].mix = { garbage: true }
  tracks[19].mix = null
  const order = sortForMix(tracks, 'party')
  assert.equal(order[3], 't3')
  assert.equal(order[11], 't11')
  assert.equal(order[19], 't19')
  assert.equal(new Set(order).size, 20)
})

test('sort of tiny lists', () => {
  assert.deepEqual(sortForMix([], 'clean'), [])
  assert.deepEqual(sortForMix([{ id: 'x', mix: null }], 'clean'), ['x'])
})

test('harmony: sorting doesn\'t make neighbours clash more', () => {
  const tracks = library(60, 7)
  const byId = new Map(tracks.map((t) => [t.id, t.mix]))
  const harm = (order: string[]) => order.slice(1).reduce((s, id, i) => s + harmonicScore(byId.get(order[i]), byId.get(id)), 0) / (order.length - 1)
  assert.ok(harm(sortForMix(tracks, 'clean')) >= harm(tracks.map((t) => t.id)))
})

test('build: transitions valid, custom ones replaced or kept, stored ones checked', () => {
  const tracks = library(30)
  const byId = new Map(tracks.map((t) => [t.id, t.mix]))
  const order = sortForMix(tracks, 'party')
  const existing: any = {
    on: true,
    style: 'party',
    updated: 0,
    transitions: {
      [`${order[0]}>${order[1]}`]: { ...transitionFor(null, order[0], order[1], byId, 'party'), custom: true },
      ['t0>t999']: { ...transitionFor(null, 't0', 't1', byId, 'party'), from: 't0', to: 't999', custom: true },
    },
  }
  assert.equal(customCount(existing), 2)
  const built = buildTransitions(order, byId, 'party', existing)
  assert.equal(built.replacedCustom, 2)
  assert.equal(Object.keys(built.transitions).length, 29)
  const kept = buildTransitions(order, byId, 'party', existing, { keepCustom: true })
  assert.equal(kept.replacedCustom, 1)
  assert.equal(kept.transitions[`${order[0]}>${order[1]}`].custom, true)
  for (let i = 0; i + 1 < order.length; i++) {
    const tr = built.transitions[`${order[i]}>${order[i + 1]}`]
    assert.deepEqual(check(tr, byId.get(order[i]), byId.get(order[i + 1])), [], `${order[i]} > ${order[i + 1]} ${tr.preset}`)
  }
  const clean = buildTransitions(order, byId, 'clean', null)
  const party = estimateMixLength(order, byId, built.transitions)
  const cleanLength = estimateMixLength(order, byId, clean.transitions)
  assert.ok(party.mixed < cleanLength.mixed && cleanLength.shorterBy < 0.2 && party.shorterBy > 0.1, `party ${(party.shorterBy * 100).toFixed(0)} % shorter, clean ${(cleanLength.shorterBy * 100).toFixed(0)} %`)
  // A stored transition for a pair that no longer exists after reordering: auto.
  const stale = transitionFor(existing, order[1], order[0], byId, 'clean')
  assert.equal(stale.custom, false)
  assert.equal(stale.from, order[1])
  assert.equal(transitionFor(existing, order[0], order[1], byId, 'clean').custom, true)
  // A re-analysed shorter song drops the stored transition; one without tempo or of version 1 is replanned.
  const shorter = new Map(byId)
  shorter.set(order[0], { ...byId.get(order[0]), duration: 20 })
  assert.equal(transitionFor(existing, order[0], order[1], shorter, 'clean').custom, false)
  const { tempo: _dropped, ...legacy } = existing.transitions[`${order[0]}>${order[1]}`]
  void _dropped
  assert.equal(transitionFor({ ...existing, transitions: { [`${order[0]}>${order[1]}`]: legacy } }, order[0], order[1], byId, 'clean').custom, false)
  const v1 = { ...existing.transitions[`${order[0]}>${order[1]}`], v: 1, rate: 1 }
  assert.equal(transitionFor({ ...existing, transitions: { [`${order[0]}>${order[1]}`]: v1 } }, order[0], order[1], byId, 'clean').custom, false)
})

test('unanalysed pair: a plain crossfade; mix length with an unknown song', () => {
  const fallback = transitionFor(null, 'x', 'y', {}, 'clean', { durations: { x: 180 } })
  assert.equal(fallback.preset, 'crossfade')
  assert.equal(fallback.aOut, 176)
  const unknown = estimateMixLength(['x', 'y'], {}, {}, { x: 100 })
  assert.equal(unknown.original, 100)
  assert.equal(unknown.unknown, 1)
})
