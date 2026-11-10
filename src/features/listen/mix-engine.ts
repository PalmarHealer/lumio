import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { seeded } from './official'
import { artistIdsOf } from './taste-model'

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
  tracks: BaseItemDto[]
  weight: (track: BaseItemDto) => number
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

/** A weighted random order: heavier songs tend to come first. Songs weighing nothing are left out. */
export function weightedOrder(tracks: BaseItemDto[], weight: (track: BaseItemDto) => number, seed: string) {
  const random = seeded(seed)
  return tracks
    .map((track) => ({ track, weight: weight(track) }))
    .filter((entry) => entry.weight > 0)
    .map((entry) => ({ track: entry.track, key: Math.log(random() || 1e-12) / entry.weight ** 1.5 }))
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.track)
}

export function assemble(pools: Pool[], options: AssembleOptions): BaseItemDto[] {
  const { size, seed, maxPerArtist = Math.max(2, Math.ceil(size / 12)), artistGap = 3 } = options
  const used = new Set<string>(options.exclude)
  const queues = pools.map((pool, i) => ({ share: pool.share, taken: 0, list: weightedOrder(pool.tracks, pool.weight, `${seed}:${i}`) }))
  const result: BaseItemDto[] = []
  const perArtist = new Map<string, number>()

  // Strict: the artist isn't among the last few songs, under their limit, not the same album twice in a row. Loose: only
  // the limit holds (for mixes of few artists).
  const fits = (track: BaseItemDto, strict: boolean) => {
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
    let picked: { queue: (typeof queues)[number]; track: BaseItemDto } | undefined
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
    used.add(picked.track.Id!)
    picked.queue.taken++
    for (const id of artistIdsOf(picked.track)) perArtist.set(id, (perArtist.get(id) ?? 0) + 1)
    result.push(picked.track)
  }
  return result
}
