/** Putting a playlist into a new order with Jellyfin's one-entry moves (reorder.ts), and the playlist sorts. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addedDates, sortPlaylist } from '../../playlist-sort.ts'
import { entriesInOrder, hasSharedEntries, planMoves } from '../reorder.ts'

/** Jellyfin's move: the entry is taken out, then put in at `index` of the list without it (at the end past it). */
function applyMoves(list: string[], moves: Array<{ entry: string; index: number }>) {
  const result = [...list]
  for (const move of moves) {
    result.splice(result.indexOf(move.entry), 1)
    result.splice(Math.min(move.index, result.length), 0, move.entry)
  }
  return result
}

/** Length of a longest increasing run (the entries that need not move). */
function longestIncreasing(values: number[]) {
  const tails: number[] = []
  for (const value of values) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid]! < value) lo = mid + 1
      else hi = mid
    }
    tails[lo] = value
  }
  return tails.length
}

test('reaches any order with the fewest moves', () => {
  let state = 11
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647
  for (let trial = 0; trial < 2000; trial++) {
    const count = Math.floor(random() * 40)
    const current = Array.from({ length: count }, (_, i) => `e${i}`)
    const target = [...current].sort(() => random() - 0.5)
    const moves = planMoves(current, target)
    assert.deepEqual(applyMoves(current, moves), target)
    assert.equal(moves.length, count - longestIncreasing(current.map((entry) => target.indexOf(entry))))
  }
})

test('no moves for the same order; different entries are refused', () => {
  assert.deepEqual(planMoves(['a', 'b', 'c'], ['a', 'b', 'c']), [])
  assert.throws(() => planMoves(['a', 'b'], ['a', 'c']))
})

test('tells shared entries (a song twice) apart from distinct ones', () => {
  assert.equal(hasSharedEntries(['a', 'b', 'c']), false)
  assert.equal(hasSharedEntries(['a', 'b', 'a']), true)
  assert.equal(hasSharedEntries(['a', undefined]), true)
  assert.deepEqual(entriesInOrder([{ id: 's1', entry: 'x' }, { id: 's2', entry: 'y' }], ['s2', 's1']), ['y', 'x'])
})

const track = (id: string, fields: Record<string, unknown>) => ({ Id: id, ...fields })

test('sorts by title, artist, album and duration, keeping ties in place', () => {
  const tracks = [
    track('1', { Name: 'b Song', Artists: ['Zed'], Album: 'Beta', IndexNumber: 2, RunTimeTicks: 300 }),
    track('2', { Name: 'Ä Song', Artists: ['adam'], Album: 'Alpha', IndexNumber: 1, RunTimeTicks: 100 }),
    track('3', { Name: 'c Song', Artists: ['Adam'], Album: 'Beta', IndexNumber: 1, RunTimeTicks: 100 }),
  ]
  const none = () => 0
  assert.deepEqual(sortPlaylist(tracks, 'titleAsc', none), ['2', '1', '3'])
  assert.deepEqual(sortPlaylist(tracks, 'titleDesc', none), ['3', '1', '2'])
  assert.deepEqual(sortPlaylist(tracks, 'artist', none), ['2', '3', '1'])
  assert.deepEqual(sortPlaylist(tracks, 'album', none), ['2', '3', '1'])
  assert.deepEqual(sortPlaylist(tracks, 'duration', none), ['2', '3', '1'])
})

test('"added" uses the playlist dates only when Lumio knows them for every song', () => {
  const tracks = [track('1', { DateCreated: '2024-01-02T00:00:00Z' }), track('2', { DateCreated: '2024-01-01T00:00:00Z' })]
  const all = addedDates(tracks, { '1': { at: 10 }, '2': { at: 20 } })
  assert.equal(all.source, 'playlist')
  assert.deepEqual(sortPlaylist(tracks, 'addedNewest', all.at), ['2', '1'])
  const some = addedDates(tracks, { '1': { at: 10 } })
  assert.equal(some.source, 'library')
  assert.deepEqual(sortPlaylist(tracks, 'addedNewest', some.at), ['1', '2'])
  assert.deepEqual(sortPlaylist(tracks, 'addedOldest', some.at), ['2', '1'])
})
