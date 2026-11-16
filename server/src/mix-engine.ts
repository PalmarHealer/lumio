import type { Track } from './music-catalog.ts'
import { artistIdsOf } from './taste-model.ts'

/**
 * Puts a mix together from pools (the familiar songs, deep cuts, discoveries …), each with its share of the mix and a
 * weight per song:
 * - Each pool is drawn in a weighted random order (Efraimidis–Spirakis on weight^1.5), the same for the same seed: the
 *   loved songs come first more often, yet not always the same ones.
 * - The pools take turns by their shares (whichever is furthest behind its share goes next), so the new songs are
 *   spread through the mix instead of piling up at the end.
 * - The same artist doesn't come back within a few songs nor more than `maxPerArtist` times; an album not twice in a
 *   row. When no pool has a song that keeps the spacing, it gives way; the limit per artist never does (the mix ends
 *   shorter instead).
 * - A pool that runs dry hands its share to the others.
 */
export interface Pool {
  tracks: Track[]
  weight: (track: Track) => number
  share: number
}

export interface AssembleOptions {
  size: number
  seed: string
  maxPerArtist?: number
  /** An artist's own limit, where it differs (a radio's artist comes back more often). */
  artistLimit?: (id: string) => number | undefined
  /** How many songs pass before an artist may come back. */
  artistGap?: number
  /** Songs to leave out. */
  exclude?: ReadonlySet<string>
}

export function seeded(seed: string) {
  let state = 0
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A shuffle that leans towards what weighs more (the user's taste), yet stays a mix: each entry draws a random key
 * scaled by its weight (Efraimidis–Spirakis), the same for the same seed.
 */
export function weightedShuffle<T>(items: T[], weight: (item: T) => number, seed: string) {
  const random = seeded(seed)
  return items
    .map((item) => ({ item, key: random() ** (1 / (1 + weight(item))) }))
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.item)
}

/**
 * The first songs of a weighted random order (heavier songs tend to come first; those weighing nothing are left out).
 * A mix takes a few dozen songs from pools of tens of thousands, so only the best few hundred keys are sorted.
 */
export function weightedOrder(tracks: Track[], weight: (track: Track) => number, seed: string, keep = Infinity) {
  const random = seeded(seed)
  const keyed: Array<{ track: Track; key: number }> = []
  for (const track of tracks) {
    const value = weight(track)
    if (value > 0) keyed.push({ track, key: Math.log(random() || 1e-12) / value ** 1.5 })
  }
  if (keyed.length > keep * 2) {
    // The keep-th highest key, found without sorting everything.
    const keys = keyed.map((entry) => entry.key)
    const cut = nthHighest(keys, keep)
    return keyed
      .filter((entry) => entry.key >= cut)
      .sort((a, b) => b.key - a.key)
      .slice(0, keep)
      .map((entry) => entry.track)
  }
  return keyed.sort((a, b) => b.key - a.key).map((entry) => entry.track)
}

/** The n-th highest value (quickselect; reorders `values`). */
function nthHighest(values: number[], n: number) {
  let low = 0
  let high = values.length - 1
  const target = Math.min(n, values.length) - 1
  while (low < high) {
    const pivot = values[(low + high) >> 1]!
    let i = low
    let j = high
    while (i <= j) {
      while (values[i]! > pivot) i++
      while (values[j]! < pivot) j--
      if (i <= j) {
        ;[values[i], values[j]] = [values[j]!, values[i]!]
        i++
        j--
      }
    }
    if (target <= j) high = j
    else if (target >= i) low = i
    else break
  }
  return values[target]!
}

export function assemble(pools: Pool[], options: AssembleOptions): Track[] {
  const { size, seed, maxPerArtist = Math.max(2, Math.ceil(size / 12)), artistGap = 3 } = options
  const used = new Set<string>(options.exclude)
  // Enough of each pool's head that the spacing rules can still be kept (a pool of one artist runs out fast).
  const keep = Math.max(size * 20, 400)
  const queues = pools.map((pool, i) => ({ share: pool.share, taken: 0, list: weightedOrder(pool.tracks, pool.weight, `${seed}:${i}`, keep) }))
  const result: Track[] = []
  const perArtist = new Map<string, number>()

  // Strict: the artist isn't among the last few songs, under their limit, not the same album twice in a row. Loose: only
  // the limit holds (for mixes of few artists).
  const fits = (track: Track, strict: boolean) => {
    if (!track.Id || used.has(track.Id)) return false
    const artists = artistIdsOf(track)
    if (artists.some((id) => (perArtist.get(id) ?? 0) >= (options.artistLimit?.(id) ?? maxPerArtist))) return false
    if (strict) {
      const recent = result.slice(-artistGap)
      if (recent.some((other) => artistIdsOf(other).some((id) => artists.includes(id)))) return false
      if (track.AlbumId && result.at(-1)?.AlbumId === track.AlbumId) return false
    }
    return true
  }
  const take = (queue: (typeof queues)[number], strict: boolean) => {
    const at = queue.list.findIndex((track) => fits(track, strict))
    return at < 0 ? undefined : queue.list.splice(at, 1)[0]
  }

  while (result.length < size) {
    const live = queues.filter((queue) => queue.share > 0 && queue.list.length)
    if (!live.length) break
    const total = live.reduce((sum, queue) => sum + queue.share, 0)
    // The pools furthest behind their share go first; the next one steps in when one has nothing that fits.
    const order = [...live].sort((a, b) => a.taken - (a.share / total) * (result.length + 1) - (b.taken - (b.share / total) * (result.length + 1)))
    let picked: { queue: (typeof queues)[number]; track: Track } | undefined
    for (const strict of [true, false]) {
      for (const queue of order) {
        const track = take(queue, strict)
        if (track) {
          picked = { queue, track }
          break
        }
      }
      if (picked) break
    }
    if (!picked) break
    used.add(picked.track.Id)
    picked.queue.taken++
    for (const id of artistIdsOf(picked.track)) perArtist.set(id, (perArtist.get(id) ?? 0) + 1)
    result.push(picked.track)
  }
  return result
}
