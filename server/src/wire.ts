import type { MixPlaylist } from './home-playlists.ts'
import type { ArtistRef, Track, UserData } from './music-catalog.ts'

/**
 * Playlists as sent to the app, packed: each song once beside the playlists (which list ids), and what repeats from
 * song to song kept once: the server id and kind every song shares, each album's name, cover and artist, each artist's
 * name. The app unpacks them into Jellyfin's items as they were (src/features/listen/official.ts); a home page of a
 * big library was 2 MB unpacked, two thirds of it repeats.
 */
export type WirePlaylist = Omit<MixPlaylist, 'tracks'> & { tracks: string[] }

/** A song without what the tables hold; `a`/`b`: its artists' and its album artists' ids. */
export type PackedTrack = Omit<Track, 'ServerId' | 'Type' | 'MediaType' | 'IsFolder' | 'ArtistItems' | 'AlbumArtists' | 'Album' | 'AlbumPrimaryImageTag' | 'AlbumArtist' | 'Artists'> & {
  a?: string[]
  b?: string[]
  /** Only when they aren't the artists' names (a name without an artist item). */
  Artists?: string[]
  /** Only when it isn't the album's. */
  AlbumArtist?: string
  UserData?: UserData
}

export interface WirePlaylists {
  at: number
  serverId?: string
  /** Artist id → name. */
  artists: Record<string, string>
  /** Album id → [name, cover tag, album artist]. */
  albums: Record<string, [string | null, string | null, string | null]>
  tracks: Record<string, PackedTrack>
  playlists: WirePlaylist[]
}

const sameList = (a: string[] | undefined, b: string[]) => (a ?? []).length === b.length && b.every((value, index) => a![index] === value)

export function pack(playlists: MixPlaylist[], userData: (track: Track) => UserData | undefined): WirePlaylists {
  const result: WirePlaylists = { at: Date.now(), artists: {}, albums: {}, tracks: {}, playlists: [] }
  const ids = (list: ArtistRef[] | undefined) =>
    list?.flatMap((artist) => {
      if (!artist.Id) return []
      result.artists[artist.Id] ??= artist.Name ?? ''
      return [artist.Id]
    })
  for (const playlist of playlists) {
    for (const track of playlist.tracks) {
      if (result.tracks[track.Id]) continue
      const { ServerId, Type: _type, MediaType: _media, IsFolder: _folder, ArtistItems, AlbumArtists, Album, AlbumPrimaryImageTag, AlbumArtist, Artists, HasLyrics, ...rest } = track
      result.serverId ??= ServerId
      const packed: PackedTrack = { ...rest }
      if (HasLyrics) packed.HasLyrics = true
      const a = ids(ArtistItems)
      const b = ids(AlbumArtists)
      if (a?.length) packed.a = a
      if (b?.length) packed.b = b
      if (!sameList(Artists, (ArtistItems ?? []).map((artist) => artist.Name ?? ''))) packed.Artists = Artists
      if (track.AlbumId) {
        result.albums[track.AlbumId] ??= [Album ?? null, AlbumPrimaryImageTag ?? null, AlbumArtist ?? null]
        if (result.albums[track.AlbumId]![2] !== (AlbumArtist ?? null)) packed.AlbumArtist = AlbumArtist
      } else if (AlbumArtist) packed.AlbumArtist = AlbumArtist
      const data = userData(track)
      if (data) packed.UserData = data
      result.tracks[track.Id] = packed
    }
    result.playlists.push({ ...playlist, tracks: playlist.tracks.map((track) => track.Id) })
  }
  return result
}
