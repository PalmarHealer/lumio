import type { Track } from './music-catalog.ts'
import type { Store } from './store.ts'
import { artistIdsOf } from './taste-model.ts'

/**
 * What the server measured about the songs (tempo, key, loudness …, see sound-analysis.ts) and the Last.fm tags of
 * songs and artists, for the mood, tag and daylist mixes. Songs get measured by an administrator's run and whenever
 * someone plays them, so the data fills in over time; everything built on it works with what's there.
 */
export interface SoundFeatures {
  bpm: number
  pulse: number
  key: number
  minor: boolean
  keyClarity: number
  loudness: number
  dynamics: number
  brightness: number
  onsets: number
}

export interface SoundData {
  features: (track: Track) => SoundFeatures | null
  /** A song's own tags and its artists' (lower case). */
  tags: (track: Track) => { own: string[]; artists: string[] }
  /** An artist's tags. */
  artistTags: (id: string) => string[]
  /** How many songs are measured. */
  measured: number
}

export function soundData(store: Store): SoundData {
  const tracks = new Map<string, { features: SoundFeatures | null; tags: string[] }>()
  let measured = 0
  for (const entry of store.trackSounds()) {
    const features = (entry.data as SoundFeatures | null) ?? null
    if (features) measured++
    tracks.set(entry.id, { features, tags: entry.tags })
  }
  const artists = new Map(Object.entries(store.artistTags()).map(([id, entry]) => [id, entry.tags]))
  const songTags = new WeakMap<Track, { own: string[]; artists: string[] }>()
  return {
    features: (track) => tracks.get(track.Id)?.features ?? null,
    tags: (track) => {
      let tags = songTags.get(track)
      if (!tags) {
        tags = { own: tracks.get(track.Id)?.tags ?? [], artists: [...new Set(artistIdsOf(track).flatMap((id) => artists.get(id) ?? []))] }
        songTags.set(track, tags)
      }
      return tags
    },
    artistTags: (id) => artists.get(id) ?? [],
    measured,
  }
}
