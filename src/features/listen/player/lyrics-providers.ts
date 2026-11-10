/**
 * Where lyrics come from when Jellyfin has none: lrclib built in, then whatever plugins add
 * (`lumio.addLyricsProvider`). What a provider finds is kept on the Lumio server for everyone, so a provider is asked
 * about a song once and its lyrics stay even when the provider stops working.
 */

/** The song a provider is asked about. */
export interface LyricsTrack {
  /** The Jellyfin item id. */
  id: string
  title: string
  /** The track's artists, main artist first. */
  artists: string[]
  album?: string
  albumArtist?: string
  /** Seconds. */
  duration: number
  musicBrainzTrackId?: string
  isrc?: string
}

/** What a provider found: an LRC text (synced) or plain text; synced is used when both are given. */
export interface FoundLyrics {
  lrc?: string | null
  plain?: string | null
}

export interface LyricsProvider {
  /** Unique, stays the same across versions (it's kept as the lyrics' source). */
  id: string
  /** Shown under the lyrics ("Lyrics from …"). */
  name: string
  /** The song's lyrics, or null when the provider has none. Throwing counts as none. */
  find(track: LyricsTrack): Promise<FoundLyrics | null | undefined>
}

let providers: LyricsProvider[] = []

/** Adds a provider after the ones there are; returns a function that takes it out again. */
export function addLyricsProvider(provider: LyricsProvider): () => void {
  providers = [...providers, provider]
  return () => {
    providers = providers.filter((candidate) => candidate !== provider)
  }
}

export const lyricsProviders = () => providers

const BUILT_IN_NAMES: Record<string, string> = { jellyfin: 'Jellyfin', lrclib: 'LRCLIB' }

/** The name to credit for lyrics from this source (a plugin's provider that is gone now goes by its id). */
export const lyricsSourceName = (source: string) => BUILT_IN_NAMES[source] ?? providers.find((provider) => provider.id === source)?.name ?? source
