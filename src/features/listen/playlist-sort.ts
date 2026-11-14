/**
 * The ways a playlist can be sorted from its "Sortieren" menu (all but "Passend", which needs the mixer's analyses and
 * goes through its own dialog). Sorting is stable: songs that compare equal keep their order.
 *
 * "Hinzugefügt": Jellyfin doesn't keep when a song was put into a playlist (its entries hold only the song). Lumio
 * records it for songs added through Lumio (`/playlists/adds`); when it knows the date for every song, that is used
 * ("added to the playlist"). Otherwise the songs' library date (DateCreated) is, and the menu says so ("added to the
 * library"), rather than mixing two kinds of dates.
 */

/** What sorting reads of a song (a Jellyfin item has these; kept structural so node can test this file). */
export interface SortableTrack {
  Id?: string | null
  Name?: string | null
  Artists?: string[] | null
  AlbumArtist?: string | null
  Album?: string | null
  ParentIndexNumber?: number | null
  IndexNumber?: number | null
  RunTimeTicks?: number | null
  DateCreated?: string | null
}

export type PlaylistSortKey = 'titleAsc' | 'titleDesc' | 'artist' | 'album' | 'addedNewest' | 'addedOldest' | 'duration'

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true })

const text = (value: string | null | undefined) => (value ?? '').trim()
const firstArtist = (track: SortableTrack) => text(track.Artists?.[0] ?? track.AlbumArtist)
const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** Within an album: disc, then track number, then title. */
function albumPosition(a: SortableTrack, b: SortableTrack) {
  return (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0) || collator.compare(text(a.Name), text(b.Name))
}

/** When each song was added: to the playlist when Lumio knows that for all of them, else to the library. */
export function addedDates(tracks: readonly SortableTrack[], adds: Readonly<Record<string, { at: number }>> | undefined): { source: 'playlist' | 'library'; at: (track: SortableTrack) => number } {
  if (adds && tracks.length > 0 && tracks.every((track) => adds[track.Id ?? ''])) return { source: 'playlist', at: (track) => adds[track.Id ?? '']!.at }
  return { source: 'library', at: (track) => time(track.DateCreated) }
}

/** The playlist's track ids in the order of `key`. */
export function sortPlaylist(tracks: readonly SortableTrack[], key: PlaylistSortKey, added: (track: SortableTrack) => number): string[] {
  const compare: (a: SortableTrack, b: SortableTrack) => number = {
    titleAsc: (a: SortableTrack, b: SortableTrack) => collator.compare(text(a.Name), text(b.Name)),
    titleDesc: (a: SortableTrack, b: SortableTrack) => collator.compare(text(b.Name), text(a.Name)),
    artist: (a: SortableTrack, b: SortableTrack) => collator.compare(firstArtist(a), firstArtist(b)) || collator.compare(text(a.Album), text(b.Album)) || albumPosition(a, b),
    album: (a: SortableTrack, b: SortableTrack) => collator.compare(text(a.Album), text(b.Album)) || albumPosition(a, b),
    addedNewest: (a: SortableTrack, b: SortableTrack) => added(b) - added(a),
    addedOldest: (a: SortableTrack, b: SortableTrack) => added(a) - added(b),
    duration: (a: SortableTrack, b: SortableTrack) => (a.RunTimeTicks ?? 0) - (b.RunTimeTicks ?? 0),
  }[key]
  // Array.prototype.sort is stable: equal songs keep their place relative to each other.
  return [...tracks].sort(compare).map((track) => track.Id ?? '')
}
