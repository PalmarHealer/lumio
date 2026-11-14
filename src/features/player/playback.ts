import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models'
import { getMediaInfoApi } from '@jellyfin/sdk/lib/utils/api/media-info-api'
import type { Api } from '@jellyfin/sdk'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { streamingMaxBitrate, type LocalSettings } from '@/features/settings/local-settings'
import { useLocale } from '@/lib/i18n'
import { audioLabel, labelStreams, subtitleLabel } from '@/lib/track-labels'
import { cachedVideo } from './video-cache'
import { buildDeviceProfile } from './device-profile'

export interface StreamOption {
  index: number
  title: string
  /** Subtitle delivered as a WebVTT file the browser can show without re-encoding. */
  url?: string
  language?: string
}

export interface Playback {
  url: string
  /** HLS playlist (needs hls.js outside Safari). */
  hls: boolean
  /** A progressive transcode starts at StartTimeTicks, so its own clock begins at 0. HLS playlists always span the whole item. */
  transcoded: boolean
  mediaSourceId: string
  playSessionId: string
  /**
   * The source's audio and subtitle streams. They are labelled in render (`useStreamOptions`), not here, so the labels
   * follow the language without a new request.
   */
  streams: MediaStream[]
  /** Subtitles delivered as WebVTT files, by stream index. */
  subtitleUrls: Record<number, string>
  /** Audio track and subtitle (-1 = none) the server chose or the user asked for. */
  audioIndex?: number
  subtitleIndex: number
  /** The active subtitle is drawn into the video by the server, so changing it needs a new stream. */
  burnedInSubtitle: boolean
  /** Subtitle indexes that are burned in (everything that is not a WebVTT file). */
  encodedSubtitles: number[]
  /** Technical details for the statistics overlay. */
  stats: PlaybackStats
}

export interface PlaybackStats {
  container?: string
  /** Source bitrate in bit/s. */
  bitrate?: number
  videoCodec?: string
  /** SDR, HDR10, DOVI, ... */
  videoRange?: string
  width?: number
  height?: number
  audioCodec?: string
  audioChannels?: number
  /** Set when the server transcodes: what it converts to and why. */
  transcode?: { videoCodec?: string; audioCodec?: string; container?: string; reasons: string[] }
  /** Played from the copy stored in the browser (downloaded ahead). */
  offline?: boolean
}

/** Reads the target formats and the reasons out of the server's transcoding URL. */
function transcodeStats(url: string | null | undefined): PlaybackStats['transcode'] {
  if (!url) return undefined
  const params = new URL(url, 'http://local').searchParams
  const read = (name: string) => params.get(name) ?? params.get(name.charAt(0).toLowerCase() + name.slice(1)) ?? undefined
  return {
    videoCodec: read('VideoCodec'),
    audioCodec: read('AudioCodec'),
    container: read('SegmentContainer') ?? read('Container'),
    reasons: (read('TranscodeReasons') ?? '').split(',').filter(Boolean),
  }
}

export interface PlaybackChoice {
  startTicks: number
  /** `undefined` lets the server pick from the user's language preferences. */
  audio?: number
  subtitle?: number
  maxBitrate?: number
  /** Upper limit for transcoded audio channels; unset = automatic. */
  maxAudioChannels?: number
  /** Streams even though a stored copy exists (another quality was picked in the player). */
  stream?: boolean
  /** The file (or its remux) failed to play here: the server converts it, neither played nor copied as it is. */
  transcode?: boolean
}

/**
 * The choice a fresh player starts with: device defaults from the settings, optional track picks from the URL.
 * Shared with preloading the next episode, whose cache entry must match exactly what the player will request.
 */
export function initialChoice(
  settings: Pick<LocalSettings, 'maxBitrate' | 'maxBitrateCellular' | 'maxAudioChannels'>,
  startTicks: number,
  audio?: number,
  subtitle?: number,
): PlaybackChoice {
  return {
    startTicks,
    audio,
    subtitle,
    maxBitrate: streamingMaxBitrate(settings) ?? undefined,
    maxAudioChannels: settings.maxAudioChannels > 0 ? settings.maxAudioChannels : undefined,
  }
}

/** Quality steps of the player menu; the one without a bitrate is the original. */
export const QUALITY_OPTIONS: Array<{ resolution?: string; bitrate?: number }> = [
  {},
  { resolution: '1080p', bitrate: 20_000_000 },
  { resolution: '720p', bitrate: 8_000_000 },
  { resolution: '480p', bitrate: 3_000_000 },
  { resolution: '360p', bitrate: 1_500_000 },
]

function withApiKey(path: string, token: string) {
  return `${path}${path.includes('?') ? '&' : '?'}ApiKey=${encodeURIComponent(token)}`
}

function describeStreams(playback: Playback) {
  const { streams, subtitleUrls } = playback
  const keep = [playback.audioIndex, playback.subtitleIndex]
  const byIndex = new Map(streams.map((stream) => [stream.Index, stream]))
  const audio = labelStreams(streams.filter((stream) => stream.Type === 'Audio'), audioLabel, keep).map(
    ({ index, label }): StreamOption => ({ index, title: label, language: byIndex.get(index)?.Language ?? undefined }),
  )
  const subtitles = labelStreams(streams.filter((stream) => stream.Type === 'Subtitle'), subtitleLabel, keep).map(
    ({ index, label }): StreamOption => ({ index, title: label, language: byIndex.get(index)?.Language ?? undefined, url: subtitleUrls[index] }),
  )
  return { audio, subtitles }
}

/** The audio and subtitle choices of a playback, labelled in the active language. */
export function useStreamOptions(playback: Playback | undefined): { audio: StreamOption[]; subtitles: StreamOption[] } {
  const locale = useLocale()
  // The labels read the language themselves; `locale` only tells the memo when to compute them again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (playback ? describeStreams(playback) : { audio: [], subtitles: [] }), [playback, locale])
}

export function usePlayback(itemId: string, isAudio: boolean, choice: PlaybackChoice, enabled: boolean) {
  const { api, session } = useAuthedSession()
  // Not kept once the player is gone: a PlaySessionId belongs to one playback. (A prefetch for the next episode sets
  // its own, longer lifetime until this player picks the entry up.)
  return useQuery({ ...playbackOptions(api, session, itemId, isAudio, choice), enabled, gcTime: 0 })
}

/** Stream info for one playback; shared by the player and by preloading the next episode, so both hit one cache entry. */
export function playbackOptions(
  api: Api,
  session: { userId: string; accessToken: string },
  itemId: string,
  isAudio: boolean,
  choice: PlaybackChoice,
) {
  return queryOptions({
    queryKey: ['playback', itemId, choice],
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<Playback> => {
      // An episode stored ahead plays from the browser (instant, offline), unless another audio track is asked for.
      const stored = isAudio || choice.stream || choice.transcode ? null : await cachedVideo(itemId)
      if (stored && (choice.audio == null || choice.audio === stored.audioIndex)) {
        const subtitles = Object.keys(stored.subtitleUrls).map(Number)
        return {
          url: stored.url,
          hls: false,
          transcoded: false,
          mediaSourceId: itemId,
          playSessionId: crypto.randomUUID(),
          // Every audio track is offered (the others stream, online); the stored subtitles only.
          streams: stored.streams.filter((stream) => stream.Type === 'Audio' || (stream.Type === 'Subtitle' && subtitles.includes(stream.Index!))),
          subtitleUrls: stored.subtitleUrls,
          audioIndex: stored.audioIndex,
          subtitleIndex: choice.subtitle != null && subtitles.includes(choice.subtitle) ? choice.subtitle : -1,
          encodedSubtitles: [],
          burnedInSubtitle: false,
          stats: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', offline: true },
        }
      }
      const profile = buildDeviceProfile(choice.maxAudioChannels)
      const request = async (enableDirectPlay: boolean) =>
        (
          await getMediaInfoApi(api).getPostedPlaybackInfo({
            itemId,
            playbackInfoDto: {
              UserId: session.userId,
              // Without a media source id the server ignores AudioStreamIndex/SubtitleStreamIndex and always builds the
              // stream with the file's default tracks. A plain item has one source, sharing the item's id.
              MediaSourceId: itemId,
              StartTimeTicks: choice.startTicks || undefined,
              AudioStreamIndex: choice.audio,
              SubtitleStreamIndex: choice.subtitle,
              MaxStreamingBitrate: choice.maxBitrate,
              MaxAudioChannels: choice.maxAudioChannels,
              DeviceProfile: profile,
              EnableDirectPlay: enableDirectPlay && !choice.transcode,
              EnableDirectStream: !choice.transcode,
              EnableTranscoding: true,
              AutoOpenLiveStream: true,
            },
          })
        ).data

      let info = await request(true)
      let source = info.MediaSources?.[0]
      if (!source?.Id || !info.PlaySessionId) throw new Error('No playable media source')

      // A browser can only direct-play the file's first audio track; any other track needs the server to remux.
      const firstAudio = source.MediaStreams?.find((stream) => stream.Type === 'Audio')?.Index
      const wantedAudio = choice.audio ?? source.DefaultAudioStreamIndex
      if (source.SupportsDirectPlay && wantedAudio != null && firstAudio != null && wantedAudio !== firstAudio) {
        info = await request(false)
        source = info.MediaSources?.[0]
        if (!source?.Id || !info.PlaySessionId) throw new Error('No playable media source')
      }

      const base = api.basePath
      const subtitleIndex = choice.subtitle ?? source.DefaultSubtitleStreamIndex ?? -1
      const streams = (source.MediaStreams ?? []).filter((stream) => stream.Type === 'Audio' || stream.Type === 'Subtitle')
      const subtitleUrls: Record<number, string> = {}
      for (const stream of streams) {
        if (stream.Type === 'Subtitle' && stream.Index != null && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
          subtitleUrls[stream.Index] = withApiKey(`${base}${stream.DeliveryUrl}`, session.accessToken)
        }
      }
      const encodedSubtitles = (source.MediaStreams ?? [])
        .filter((stream) => stream.Type === 'Subtitle' && stream.DeliveryMethod !== 'External')
        .map((stream) => stream.Index!)
      const videoStream = source.MediaStreams?.find((stream) => stream.Type === 'Video')
      const audioStream = source.MediaStreams?.find((stream) => stream.Type === 'Audio' && stream.Index === wantedAudio)
      const stats: PlaybackStats = {
        container: source.Container ?? undefined,
        bitrate: source.Bitrate ?? undefined,
        videoCodec: videoStream?.Codec ?? undefined,
        videoRange: videoStream?.VideoRangeType ?? videoStream?.VideoRange ?? undefined,
        width: videoStream?.Width ?? undefined,
        height: videoStream?.Height ?? undefined,
        audioCodec: audioStream?.Codec ?? undefined,
        audioChannels: audioStream?.Channels ?? undefined,
        transcode: source.SupportsDirectPlay ? undefined : transcodeStats(source.TranscodingUrl),
      }
      const common = {
        stats,
        mediaSourceId: source.Id,
        playSessionId: info.PlaySessionId,
        streams,
        subtitleUrls,
        audioIndex: wantedAudio ?? undefined,
        subtitleIndex,
        encodedSubtitles,
        burnedInSubtitle: !!source.TranscodingUrl?.toLowerCase().includes('subtitlemethod=encode'),
      }

      if (source.SupportsDirectPlay) {
        const params = new URLSearchParams({ static: 'true', mediaSourceId: source.Id, playSessionId: info.PlaySessionId })
        const kind = isAudio ? 'Audio' : 'Videos'
        return { ...common, url: withApiKey(`${base}/${kind}/${itemId}/stream?${params}`, session.accessToken), hls: false, transcoded: false }
      }
      if (!source.TranscodingUrl) throw new Error('Server offered neither direct play nor transcoding')
      return { ...common, url: `${base}${source.TranscodingUrl}`, hls: source.TranscodingSubProtocol === 'hls', transcoded: true }
    },
  })
}
