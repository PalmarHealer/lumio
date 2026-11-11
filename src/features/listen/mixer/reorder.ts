/**
 * The moves that turn a playlist's order into another, for Jellyfin's "move one entry" call
 * (`POST /Playlists/{id}/Items/{entryId}/Move/{newIndex}`: the entry is taken out, then put in at `newIndex` of the
 * list without it). Few moves: the longest run of entries already in the right relative order stays where it is, only
 * the others move, each in target order, right behind the entry that comes before it in the target (or to the front).
 * By then that entry is in place relative to all others already settled, so after the last move the order is the
 * target. This holds while every song in the playlist is visible to the person (Jellyfin counts positions among the
 * visible ones), and needs entries that can be told apart: current Jellyfin hands out the song's id as the entry id,
 * so a song in the playlist twice can't be moved on its own (`hasSharedEntries`). Pure, so node can check it.
 */

export interface Move {
  entry: string
  index: number
}

/** Indexes of a longest strictly increasing subsequence of `values` (patience sorting, O(n log n)). */
function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = []
  const previous = new Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const kept = new Set<number>()
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = previous[i]!) kept.add(i)
  return kept
}

/**
 * The moves from `current` to `target` (both lists of the same unique entry ids). Throws when they don't hold the
 * same entries.
 */
export function planMoves(current: readonly string[], target: readonly string[]): Move[] {
  const goal = new Map(target.map((entry, index) => [entry, index]))
  if (current.length !== target.length || goal.size !== target.length || current.some((entry) => !goal.has(entry))) {
    throw new Error('The orders hold different entries')
  }
  const positions = current.map((entry) => goal.get(entry)!)
  const staying = longestIncreasing(positions)
  const moving = new Set(current.filter((_, index) => !staying.has(index)))
  const list = [...current]
  const moves: Move[] = []
  for (let i = 0; i < target.length; i++) {
    const entry = target[i]!
    if (!moving.has(entry)) continue
    list.splice(list.indexOf(entry), 1)
    const index = i === 0 ? 0 : list.indexOf(target[i - 1]!) + 1
    list.splice(index, 0, entry)
    moves.push({ entry, index })
  }
  return moves
}

/**
 * Turns a sorted list of track ids back into playlist entries. Entries must be told apart (see `hasSharedEntries`);
 * where a server still hands out own entry ids for a song in the playlist twice, they are handed out in their order.
 */
export function entriesInOrder(tracks: ReadonlyArray<{ id: string; entry: string }>, order: readonly string[]): string[] {
  const byId = new Map<string, string[]>()
  for (const track of tracks) byId.set(track.id, [...(byId.get(track.id) ?? []), track.entry])
  const entries = order.map((id) => {
    const entry = byId.get(id)?.shift()
    if (!entry) throw new Error('The order holds a song the playlist does not')
    return entry
  })
  if ([...byId.values()].some((left) => left.length)) throw new Error('The order leaves songs out')
  return entries
}

/**
 * Whether entries can't be told apart: current Jellyfin hands out the song's own id as the entry id, so a song in a
 * playlist twice has two equal entries, and moving "that entry" always moves the first of them. Such a playlist can't
 * be put into an order entry by entry.
 */
export function hasSharedEntries(entries: ReadonlyArray<string | null | undefined>): boolean {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry || seen.has(entry)) return true
    seen.add(entry)
  }
  return false
}
