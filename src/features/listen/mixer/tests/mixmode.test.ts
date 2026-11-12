/** Mix-Modus: which windows of its songs a playlist asks stems for (mixmode/windows.ts), and which stem feeds which lane. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LANE_STEMS, laneStems, stemsToLoad } from '../mixmode/lane-stems.ts'
import { covered, MAX_SONG, MAX_WINDOW, neededWindow, playlistWindows, tidyWindows, transitionWindows, validWindow } from '../mixmode/windows.ts'
import type { Transition } from '../types.ts'

const still = () => ({ gain: [], low: [], mid: [], high: [], filter: [] })
const transition = (from: string, to: string): Transition =>
  ({
    v: 2,
    from,
    to,
    style: 'clean',
    preset: 'crossfade',
    aOut: 180,
    bAt: 4,
    bIn: 20,
    length: 16,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    tempo: { a: 120, b: 120 },
    a: still(),
    b: still(),
    effects: [],
    custom: true,
    confidence: 1,
  }) as Transition

test('a stored transition asks for what it plays, with a margin', () => {
  const w = transitionWindows(transition('x', 'y'))
  assert.ok(w.a.start <= 170 && w.a.end >= 196)
  assert.ok(w.b.start <= 20 && w.b.end >= 32)
})

test('windows are joined, cut to the server limit and capped in number', () => {
  assert.deepEqual(tidyWindows([{ start: 10, end: 50 }, { start: 40, end: 90 }], 300), [{ start: 10, end: 90 }])
  const long = tidyWindows([{ start: 0, end: 700 }], 900)
  assert.deepEqual(long.map((w) => [w.start, w.end]), [[0, 299.999], [299.999, 599.998], [599.998, 700]])
  assert.equal(tidyWindows(Array.from({ length: 20 }, (_, i) => ({ start: i * 20, end: i * 20 + 5 })), 1000).length, 8)
  assert.deepEqual(tidyWindows([{ start: 290, end: 330 }], 300), [{ start: 290, end: 300 }])
})

test('a playlist asks each song for its opening and close, or what its stored transitions play', () => {
  const durations = { x: 200, y: 240, z: 220 }
  const wanted = playlistWindows(['x', 'y', 'z'], { 'x>y': transition('x', 'y') }, durations)
  // x only goes out (into y, stored), z only comes in (after y, not stored: its opening).
  assert.equal(wanted.x!.length, 1)
  assert.deepEqual(wanted.z, [{ start: 0, end: 75 }])
  // y comes in (stored: around 20 s) and goes out (not stored: its last 90 s).
  assert.equal(wanted.y!.length, 2)
  assert.ok(covered(wanted.y!, 20, 30))
  assert.ok(covered(wanted.y!, 150, 240))
  assert.equal(covered(wanted.y!, 100, 120), false)
})

test('the instrumental lane plays the server\'s "other" stem only; the bass stem feeds no lane', () => {
  assert.deepEqual(LANE_STEMS, { vocals: 'vocals', drums: 'drums', instrumental: 'other' })
  assert.equal(stemsToLoad().includes('bass' as never), false)
  assert.deepEqual(laneStems({ vocals: 1, drums: 2, bass: 3, other: 4 }), { vocals: 1, drums: 2, instrumental: 4 })
  assert.deepEqual(laneStems({ bass: 3 }), {})
})

test('every window is one the server takes: never longer than its limit after rounding, never past MAX_SONG', () => {
  let state = 5
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647
  for (let trial = 0; trial < 2000; trial++) {
    const start = random() * 600
    const pieces = tidyWindows([{ start, end: start + random() * 1500 }], 1500)
    for (const w of pieces) {
      assert.ok(validWindow(w), JSON.stringify(w))
      assert.ok(w.end - w.start <= MAX_WINDOW)
    }
  }
  // A 25-minute track: its close lies past what the server separates, so it is cut there (or left out).
  const long = playlistWindows(['a', 'b'], {}, { a: 1500, b: 200 })
  assert.ok(long.a!.every((w) => w.end <= MAX_SONG && validWindow(w)))
})

test("the editor's window is cut to the song, the server's limit and its longest window", () => {
  assert.deepEqual(neededWindow({ start: 1190, end: 1260 }, 1500), { start: 1190, end: 1200 })
  assert.deepEqual(neededWindow({ start: 10, end: 400 }, 600), { start: 10, end: 309.999 })
  assert.equal(neededWindow({ start: 1300, end: 1350 }, 1500), null)
})
