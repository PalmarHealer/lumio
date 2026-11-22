import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'

/** How often the user played each artist's songs (their most played songs, counted per artist id). */
export type ArtistAffinity = Map<string, number>

const DAY_MS = 24 * 60 * 60 * 1000

/** Lower case without accents, so "Tiësto" matches "tiesto". */
export function normalize(text: string) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/** How well the name itself matches: exact, from its start, from a word's start, somewhere, or not at all (matched by artist). */
function textScore(name: string, term: string) {
  if (!term) return 0
  if (name === term) return 100
  if (name.startsWith(term)) return 70
  if (name.split(/[\s\-_/(),.&+]+/).some((word) => word.startsWith(term))) return 50
  if (name.includes(term)) return 30
  return 10
}

function artistIds(item: BaseItemDto) {
  if (item.Type === 'MusicArtist') return item.Id ? [item.Id] : []
  return [...(item.ArtistItems ?? []), ...(item.AlbumArtists ?? [])].map((artist) => artist.Id).filter((id): id is string => !!id)
}

/** Ties go to whole artists and albums before single songs, as before. */
const TYPE_BONUS: Record<string, number> = { MusicArtist: 8, MusicAlbum: 4, Playlist: 3, Movie: 6, Series: 6, BoxSet: 4 }

/**
 * A result's score: how well its name matches the term plus how much the user cares about it (plays, favourite, played
 * lately, and how much they listen to its artist). So "Boom" puts the BLACKPINK song the user plays above any "Boom" artist
 * they never heard, as Spotify does.
 */
export function scoreResult(item: BaseItemDto, term: string, affinity: ArtistAffinity | undefined, now = Date.now()) {
  const data = item.UserData
  let score = textScore(normalize(item.Name ?? ''), normalize(term)) + (TYPE_BONUS[item.Type ?? ''] ?? 0)
  const plays = data?.PlayCount ?? 0
  if (plays > 0) score += Math.min(60, 25 + 12 * Math.log2(plays))
  if (data?.IsFavorite) score += 45
  const last = data?.LastPlayedDate ? Date.parse(data.LastPlayedDate) : NaN
  if (!Number.isNaN(last)) score += now - last < 7 * DAY_MS ? 20 : now - last < 60 * DAY_MS ? 10 : 0
  if (affinity) {
    const heard = Math.max(0, ...artistIds(item).map((id) => affinity.get(id) ?? 0))
    if (heard > 0) score += Math.min(item.Type === 'MusicArtist' ? 60 : 40, 10 * Math.log2(1 + heard))
  }
  return score
}

/** The results best first; equal scores keep the server's order. */
export function rankResults(items: BaseItemDto[], term: string, affinity: ArtistAffinity | undefined) {
  const now = Date.now()
  return items
    .map((item, index) => ({ item, index, score: scoreResult(item, term, affinity, now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}
