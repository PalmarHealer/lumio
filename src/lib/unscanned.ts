import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'

/**
 * Until Jellyfin's scan has probed a new file, a track is named after its file ("04. Artist - Title") with no number,
 * artists or length, and an album after its folder ("Title (2018)"). These read the file name the way the tags would.
 */
const FILE_TRACK = /^(\d{1,3})(?:\.\s*|\s+-\s+)(?:(.+?)\s+-\s+)?(.+)$/

function fileTrack(item: BaseItemDto) {
  if (item.Type !== 'Audio' || item.IndexNumber != null || !item.Name) return undefined
  const match = FILE_TRACK.exec(item.Name)
  return match ? { index: Number(match[1]), artist: match[2], title: match[3] } : undefined
}

/** The name to show: without the file's track number and artist, or the folder's year. */
export function displayName(item: BaseItemDto): string {
  const name = item.Name ?? ''
  if (item.Type === 'MusicAlbum' && item.ProductionYear == null) return name.replace(/\s+\(\d{4}\)$/, '')
  return fileTrack(item)?.title ?? name
}

/** The artist named in the file name of a track that has no tags yet. */
export function fileArtist(item: BaseItemDto): string | undefined {
  return fileTrack(item)?.artist
}

/** The track number: the tag's, else the file name's. */
export function trackIndex(item: BaseItemDto): number | undefined {
  return item.IndexNumber ?? fileTrack(item)?.index
}
