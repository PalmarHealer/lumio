import { analyzeSound, readWav, type SoundFeatures } from './sound-analysis.ts'

/**
 * Measuring songs and fetching their tags, for the mood and tag mixes:
 * - The sound: Jellyfin transcodes about 45 seconds from a third into the song to a small mono WAV (11 kHz), which
 *   sound-analysis.ts measures. About a megabyte and a second per song.
 * - Tags: Last.fm's top tags of the song and of its artists (moods, scenes, "queer", "female vocalists" …).
 */
const EXCERPT_BYTES = 1_000_000
const RATE = 11025

export interface SoundTrack {
  Id: string
  Name?: string
  RunTimeTicks?: number
  Artists?: string[]
  AlbumArtist?: string
  ArtistItems?: Array<{ Id?: string; Name?: string }>
  AlbumArtists?: Array<{ Id?: string; Name?: string }>
}

/** Measures a song from its excerpt; null when it can't be (too short, silent, not decodable). */
export async function measureTrack(jellyfinUrl: string, token: string, track: SoundTrack): Promise<SoundFeatures | null> {
  const start = track.RunTimeTicks && track.RunTimeTicks > 90 * 10_000_000 ? Math.floor(track.RunTimeTicks * 0.3) : 0
  const params = new URLSearchParams({ AudioCodec: 'pcm_s16le', AudioSampleRate: String(RATE), AudioChannels: '1', MaxAudioChannels: '1', StartTimeTicks: String(start) })
  const controller = new AbortController()
  const response = await fetch(`${jellyfinUrl}/Audio/${track.Id}/stream.wav?${params}`, {
    headers: { Authorization: `MediaBrowser Token="${token}"` },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`Jellyfin ${response.status}`)
  const parts: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (size < EXCERPT_BYTES) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.length
    }
  } finally {
    // Enough read: Jellyfin stops transcoding the rest.
    controller.abort()
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  const wav = readWav(bytes)
  return wav ? analyzeSound(wav.samples, wav.rate) : null
}

type Lastfm = (params: Record<string, string>) => Promise<unknown>

/** Tags used at least `min` (of 100) on Last.fm, lower case, most used first. */
function tagsOf(data: unknown, min: number) {
  const tags = (data as { toptags?: { tag?: Array<{ name?: string; count?: number | string }> } } | null)?.toptags?.tag ?? []
  return tags
    .filter((tag) => tag.name && Number(tag.count ?? 0) >= min)
    .map((tag) => tag.name!.trim().toLowerCase())
    .filter((name, i, all) => name && all.indexOf(name) === i)
    .slice(0, 20)
}

export async function trackTags(lastfm: Lastfm, track: SoundTrack) {
  const artist = track.Artists?.[0] ?? track.AlbumArtist
  if (!artist || !track.Name) return []
  return tagsOf(await lastfm({ method: 'track.gettoptags', artist, track: track.Name }), 5)
}

export async function artistTags(lastfm: Lastfm, name: string) {
  return tagsOf(await lastfm({ method: 'artist.gettoptags', artist: name }), 10)
}

/** A song's artists (its own and the album's) with ids. */
export function artistsOfTrack(track: SoundTrack) {
  const seen = new Map<string, string>()
  for (const artist of [...(track.ArtistItems ?? []), ...(track.AlbumArtists ?? [])]) if (artist.Id && artist.Name && !seen.has(artist.Id)) seen.set(artist.Id, artist.Name)
  return [...seen].map(([id, name]) => ({ id, name }))
}
