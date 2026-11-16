import type { Track } from './music-catalog.ts'
import type { Store } from './store.ts'
import { artistIdsOf } from './taste-model.ts'

/**
 * "Listeners like you also love …": artists the listener doesn't know yet, loved by other listeners on this server
 * whose taste is like theirs (the artists they love, by long-run plays).
 * - Only other people who share their listening for this (privacy setting `shareTaste`, on unless turned off) count.
 * - An artist is only suggested when at least MIN_LISTENERS such people love it, so a suggestion never gives away what
 *   one person listens to (on a server of a few friends it would otherwise read like their history).
 * - Artist level rather than song level: with a handful of listeners, songs heard by several of them are rare, artists
 *   are not.
 */
const HORIZON = 365 * 24 * 60 * 60_000
const HALF_LIFE = 182 * 24 * 60 * 60_000
export const MIN_LISTENERS = 3
/** Each other listener's artists that count (their most loved). */
const TOP_ARTISTS = 200

type Vector = Map<string, number>

function norm(vector: Vector) {
  let total = 0
  for (const value of vector.values()) total += value * value
  return Math.sqrt(total)
}

/** Everyone's loved artists (long-run plays of library songs, fading over half a year), by person; made for a few hours. */
export function listenerArtists(store: Store, byId: (id: string) => Track | undefined, now = Date.now()) {
  const result = new Map<string, Vector>()
  for (const row of store.communityRows(now - HORIZON)) {
    const track = byId(row.key)
    if (!track) continue
    let vector = result.get(row.userId)
    if (!vector) {
      vector = new Map()
      result.set(row.userId, vector)
    }
    const weight = row.plays * 0.5 ** (Math.max(0, now - row.last) / HALF_LIFE)
    for (const id of artistIdsOf(track)) vector.set(id, (vector.get(id) ?? 0) + weight)
  }
  // Log-scaled and cut to each person's top artists: one person's 500 plays of one band shouldn't outweigh everyone.
  for (const [userId, vector] of result) {
    const top = [...vector].sort((a, b) => b[1] - a[1]).slice(0, TOP_ARTISTS)
    result.set(userId, new Map(top.map(([id, value]) => [id, Math.log1p(value)])))
  }
  return result
}

/**
 * The suggested artists for one listener (0–1, the strongest 1), from the others' loved artists weighted by how alike
 * their taste is; artists the listener already loves (`known`) are left out.
 */
export function communityArtists(store: Store, userId: string, mine: Vector, everyone: Map<string, Vector>, known: (artist: string) => boolean) {
  const result = new Map<string, number>()
  const mineNorm = norm(mine)
  if (!mineNorm) return result
  const support = new Map<string, number>()
  for (const [other, theirs] of everyone) {
    if (other === userId || !store.privacy(other).shareTaste) continue
    let dot = 0
    for (const [id, value] of mine) dot += value * (theirs.get(id) ?? 0)
    if (!dot) continue
    const similarity = dot / (mineNorm * norm(theirs))
    for (const [id, value] of theirs) {
      if (known(id)) continue
      result.set(id, (result.get(id) ?? 0) + similarity * value)
      support.set(id, (support.get(id) ?? 0) + 1)
    }
  }
  for (const id of [...result.keys()]) if ((support.get(id) ?? 0) < MIN_LISTENERS) result.delete(id)
  let max = 0
  for (const value of result.values()) if (value > max) max = value
  if (max > 0) for (const [id, value] of result) result.set(id, value / max)
  return result
}
