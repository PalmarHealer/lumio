import { assemble, weightedShuffle } from './mix-engine.ts'
import type { Track } from './music-catalog.ts'
import { looseName, similarArtistNames, type Lastfm, type Listener, type Locale, type MixPlaylist } from './home-playlists.ts'

/**
 * Radio, as Spotify's: an artist's songs mixed with songs of artists who make similar music (Last.fm's similar
 * artists, as far as the library has them; otherwise artists sharing their genres), leaning towards what the listener
 * likes (the taste model: plays now and over time, hearts, skips; what just played steps back) and with a third of songs
 * they haven't heard yet. Each listener has their own radio of an artist, made anew every day at midnight (the same all
 * day, on every device). Also what keeps music going when the queue runs out ("autoplay"): more of what was just
 * played, drawn anew each time.
 */
const RADIO_SIZE = 50
/** Songs of the artist itself in a radio, the rest from similar artists. */
const OWN_SHARE = 0.4
/** Songs the listener hasn't heard yet. */
const NEW_SHARE = 0.3
const SIMILAR_ARTISTS = 10

const messages = {
  de: {
    title: (name: string) => `${name} Radio`,
    with: (names: string[]) => (names.length ? `Mit ${names.join(', ')} und anderen Künstler*innen` : 'Songs wie diese, jeden Tag neu gemischt.'),
  },
  en: {
    title: (name: string) => `${name} Radio`,
    with: (names: string[]) => (names.length ? `With ${names.join(', ')} and more` : 'Songs like these, mixed anew every day.'),
  },
}

/** The library's artists by loose name (made once per listener's library). */
const nameIndexes = new WeakMap<Listener['index'], Map<string, string>>()
function byName(listener: Listener) {
  let index = nameIndexes.get(listener.index)
  if (!index) {
    index = new Map()
    for (const [id, entry] of listener.index) {
      const key = entry.name ? looseName(entry.name) : ''
      // Several artists under one name: the one with the most songs.
      const other = index.get(key)
      if (key && (!other || listener.index.get(other)!.tracks.length < entry.tracks.length)) index.set(key, id)
    }
    nameIndexes.set(listener.index, index)
  }
  return index
}

/** An artist's songs in the library, the listener's most played first. */
function artistTracks(listener: Listener, artistId: string, limit: number) {
  const plays = (track: Track) => listener.userData(track)?.PlayCount ?? 0
  return [...(listener.index.get(artistId)?.tracks ?? [])].sort((a, b) => plays(b) - plays(a) || (a.Name ?? '').localeCompare(b.Name ?? '')).slice(0, limit)
}

/** The genres an artist's songs carry, most common first. */
function genresOf(listener: Listener, artistId: string) {
  const counts = new Map<string, number>()
  for (const track of listener.index.get(artistId)?.tracks ?? []) for (const genre of track.Genres ?? []) counts.set(genre, (counts.get(genre) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([genre]) => genre)
}

/** The library's artists similar to one (Last.fm, in its order), or else artists sharing its genres. */
export async function similarArtists(listener: Listener, artistId: string, lastfm: Lastfm | null, seed = '') {
  const artist = listener.index.get(artistId)
  if (!artist) return []
  const names = byName(listener)
  const matched: string[] = []
  if (lastfm && artist.name) {
    for (const name of await similarArtistNames(lastfm, artist.name).catch(() => [] as string[])) {
      const id = names.get(looseName(name))
      if (id && id !== artistId && !matched.includes(id)) matched.push(id)
      if (matched.length >= SIMILAR_ARTISTS) break
    }
  }
  if (!matched.length) {
    const genres = new Set(genresOf(listener, artistId).slice(0, 3))
    if (genres.size) {
      const sharing = [...listener.index.values()].filter((entry) => entry.id !== artistId && entry.tracks.length >= 3 && entry.tracks.some((track) => track.Genres?.some((genre) => genres.has(genre))))
      matched.push(...weightedShuffle(sharing, () => 0, `${seed}:${artistId}:similar`).slice(0, SIMILAR_ARTISTS).map((entry) => entry.id))
    }
  }
  return matched.slice(0, SIMILAR_ARTISTS).map((id) => ({ Id: id, Name: listener.index.get(id)!.name }))
}

/**
 * A radio around an artist: their songs and similar artists' songs, the artist every third song or so; known
 * favourites weighted by love, new songs by how near they are to the taste.
 */
export async function buildRadio(listener: Listener, artistId: string, lastfm: Lastfm | null, seed: string, exclude?: ReadonlySet<string>) {
  const { model } = listener
  const own = artistTracks(listener, artistId, 200)
  const similar = await similarArtists(listener, artistId, lastfm, seed)
  const ownIds = new Set(own.map((track) => track.Id))
  const others = similar.flatMap((entry) => artistTracks(listener, entry.Id, 40)).filter((track) => !ownIds.has(track.Id))
  const known = (list: Track[]) => list.filter(model.known)
  const fresh = (list: Track[]) => list.filter((track) => !model.known(track))
  const tracks = assemble(
    [
      { tracks: known(own), weight: model.love, share: OWN_SHARE * (1 - NEW_SHARE) },
      { tracks: fresh(own), weight: (track) => 0.3 + model.novelty(track), share: OWN_SHARE * NEW_SHARE },
      { tracks: known(others), weight: model.love, share: (1 - OWN_SHARE) * (1 - NEW_SHARE) },
      { tracks: fresh(others), weight: (track) => 0.3 + model.novelty(track), share: (1 - OWN_SHARE) * NEW_SHARE },
    ],
    // The artist itself may come back every third song; a similar one at most six times.
    { size: RADIO_SIZE, seed, exclude, maxPerArtist: 6, artistGap: 2, artistLimit: (id) => (id === artistId ? RADIO_SIZE : undefined) },
  )
  return { tracks, similar }
}

/** Today's radio of an artist for this listener, as a playlist (its page is /listen/official/radio-<artist id>). */
export async function radioPlaylist(listener: Listener, artistId: string, lastfm: Lastfm | null, locale: Locale, day: string): Promise<MixPlaylist | null> {
  const artist = listener.index.get(artistId)
  if (!artist) return null
  const t = messages[locale]
  const { tracks, similar } = await buildRadio(listener, artistId, lastfm, `${listener.userId}:${artistId}:${day}`)
  return {
    slug: `radio-${artistId}`,
    kind: 'radio',
    personal: true,
    artist: { Id: artistId, Name: artist.name, Type: 'MusicArtist' },
    title: t.title(artist.name),
    description: t.with(similar.slice(0, 3).map((entry) => entry.Name).filter(Boolean)),
    tracks,
  }
}
