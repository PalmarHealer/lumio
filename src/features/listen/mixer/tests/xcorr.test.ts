/** Finding a recording inside a longer stretch of the same audio (xcorr.ts), as the player does to locate A. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { locate, mono } from '../xcorr.ts'

/** Seeded noise with some tone in it (music-like enough for a sharp correlation peak). */
function audio(length: number, seed = 7) {
  let state = seed
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647) * 2 - 1
  return Float32Array.from({ length }, (_, i) => 0.5 * random() + 0.3 * Math.sin(i * 0.05))
}

test('locates a needle to the sample, with a score near 1', () => {
  const haystack = audio(48000)
  for (const at of [0, 1234, 20000, 48000 - 4096]) {
    const match = locate(haystack.slice(at, at + 4096), haystack, 0, 48000)
    assert.ok(match)
    assert.ok(Math.abs(match.offset - at) < 0.05, `at ${at}: ${match.offset}`)
    assert.ok(match.score > 0.999)
  }
})

test('refines between samples', () => {
  // The needle is the haystack delayed by half a sample (linear interpolation).
  const haystack = audio(16384)
  const needle = Float32Array.from({ length: 2048 }, (_, i) => (haystack[5000 + i]! + haystack[5001 + i]!) / 2)
  const match = locate(needle, haystack, 4000, 6000)
  assert.ok(match)
  assert.ok(Math.abs(match.offset - 5000.5) < 0.2, `${match.offset}`)
})

test('searches only the given range, and finds nothing outside the haystack', () => {
  const haystack = audio(20000)
  const needle = haystack.slice(15000, 16024)
  const inRange = locate(needle, haystack, 14000, 16000)
  assert.ok(inRange && Math.abs(inRange.offset - 15000) < 0.05)
  const elsewhere = locate(needle, haystack, 0, 5000)
  assert.ok(elsewhere && elsewhere.score < 0.5)
  assert.equal(locate(needle, haystack, 30000, 40000), null)
})

test('mono averages the channels over a range', () => {
  const left = Float32Array.from([1, 2, 3, 4])
  const right = Float32Array.from([3, 2, 1, 0])
  assert.deepEqual([...mono([left, right], 1, 3)], [2, 2])
})
