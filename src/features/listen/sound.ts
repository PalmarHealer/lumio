import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import type { QueryClient } from '@tanstack/react-query'
import { lumioGet } from '@/features/social/social'
import { artistIdsOf, type LumioGet } from './taste-model'

/**
 * What the Lumio server measured about the songs (tempo, key, loudness …, see server/src/sound-analysis.ts) and the
 * Last.fm tags of songs and artists. Songs get measured by an administrator's run and whenever someone plays them, so
 * the data fills in over time; everything built on it works with what's there.
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
  features: (track: BaseItemDto) => SoundFeatures | null
  /** A song's own tags and its artists' (lower case). */
  tags: (track: BaseItemDto) => { own: string[]; artists: string[] }
  /** An artist's tags. */
  artistTags: (id: string) => string[]
  /** How many songs are measured. */
  measured: number
}

type Raw = { tracks: Record<string, [number[] | null, string[]]>; artists: Record<string, string[]> }

/** The measurements, fresh for an hour (they grow as songs get measured); fails without a connection yet (not kept). */
export function soundQuery(get: LumioGet = lumioGet) {
  return {
    queryKey: ['music-sound'],
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<Raw | null> => {
      const response = await get('/music/sound').catch(() => undefined)
      if (response === null) throw new Error('Not connected')
      return response?.ok ? ((await response.json()) as Raw) : null
    },
  }
}

export async function fetchSound(queryClient: QueryClient, get?: LumioGet): Promise<SoundData> {
  return soundData(await queryClient.fetchQuery(soundQuery(get)).catch(() => null))
}

export function soundData(raw: Raw | null): SoundData {
  const tracks = raw?.tracks ?? {}
  const artists = raw?.artists ?? {}
  const parsed = new Map<string, SoundFeatures | null>()
  return {
    features: (track) => {
      const id = track.Id ?? ''
      if (parsed.has(id)) return parsed.get(id)!
      const f = tracks[id]?.[0]
      const features = f
        ? { bpm: f[0]!, pulse: f[1]!, key: f[2]!, minor: f[3] === 1, keyClarity: f[4]!, loudness: f[5]!, dynamics: f[6]!, brightness: f[7]!, onsets: f[8]! }
        : null
      parsed.set(id, features)
      return features
    },
    tags: (track) => ({ own: tracks[track.Id ?? '']?.[1] ?? [], artists: [...new Set(artistIdsOf(track).flatMap((id) => artists[id] ?? []))] }),
    artistTags: (id) => artists[id] ?? [],
    measured: Object.values(tracks).filter((entry) => entry[0]).length,
  }
}
