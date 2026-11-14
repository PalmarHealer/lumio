import type { Api } from '@jellyfin/sdk'
import { downloadedAudioUrl } from '../../player/downloads'
import { blobSlice, streamSlice } from '../../player/slices'
import type { PreviewSource } from '../preview'

/**
 * The songs' audio for the editor's preview. Both are read from their start, so sample 0 is the song's 0 s exactly, as
 * in the analysis (Jellyfin's cut at a start time may be off by an unknown amount, which the player calibrates against
 * its <audio> element; the editor has none to calibrate with). A downloaded song is decoded from the device.
 * Only as much as the transition needs is read: up to `until` seconds (the rest of the response is cancelled).
 */
export async function loadDeckAudio(options: {
  api: Api
  userId: string
  accessToken: string
  deviceId: string
  id: string
  until: number
  context: BaseAudioContext
  signal?: AbortSignal
}): Promise<PreviewSource> {
  const { api, userId, accessToken, deviceId, id, until, context, signal } = options
  const downloaded = await downloadedAudioUrl(id)
  if (downloaded) {
    try {
      const slice = await blobSlice(downloaded, 0, until, context)
      return { channels: slice.channels, origin: slice.start, sampleRate: slice.sampleRate }
    } finally {
      // The object URL is a whole song held in memory: let it go once decoded (or not).
      URL.revokeObjectURL(downloaded)
    }
  }
  const params = new URLSearchParams({
    UserId: userId,
    DeviceId: deviceId,
    AudioCodec: 'pcm_s16le',
    AudioSampleRate: String(context.sampleRate),
    AudioChannels: '2',
    Static: 'false',
    PlaySessionId: crypto.randomUUID(),
    ApiKey: accessToken,
  })
  const slice = await streamSlice(`${api.basePath}/Audio/${id}/stream.wav?${params}`, 0, until, context.sampleRate, signal)
  return { channels: slice.channels, origin: slice.start, sampleRate: slice.sampleRate }
}

/** The end of the audio a source holds (track seconds). */
export const sourceEnd = (source: PreviewSource) => source.origin + (source.channels[0]?.length ?? 0) / source.sampleRate
