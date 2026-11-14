/**
 * Decoded stretches of a track for a transition's buffer decks (../mixer/buffer-deck.ts): only the part a deck
 * plays, at the context's sample rate.
 *
 * - Streamed: Jellyfin cuts the track from a start time and sends it as WAV (16-bit PCM). Only as many bytes as
 *   needed are read; the rest of the response is cancelled. Where its cut really starts may be off by an unknown
 *   amount, so the player calibrates every slice against what its <audio> element plays (`start` is corrected then).
 * - Downloaded or cached (a blob): decoded whole once (the browser can't decode a part of a compressed file), the
 *   stretch copied out, the rest dropped right away.
 */

export interface Slice {
  /** One per channel (two), at `sampleRate`. */
  channels: Float32Array<ArrayBuffer>[]
  /** Track position of the first sample (seconds). */
  start: number
  sampleRate: number
}

/** WAV header fields and where the PCM starts, once enough of the stream has arrived; null until then. */
function parseHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
  if (bytes.length < 12) return null
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('Not a WAV stream')
  let at = 12
  let format: { channels: number; sampleRate: number; bits: number; float: boolean } | null = null
  while (at + 8 <= bytes.length) {
    const id = text(at)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ') {
      if (at + 8 + 16 > bytes.length) return null
      const code = view.getUint16(at + 8, true)
      format = { channels: view.getUint16(at + 10, true), sampleRate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true), float: code === 3 }
    } else if (id === 'data') {
      if (!format) throw new Error('WAV without a format')
      return { ...format, dataStart: at + 8 }
    }
    // A streamed WAV may give odd sizes for chunks it can't know yet; only `data` is assumed to run to the end.
    at += 8 + size + (size % 2)
  }
  return null
}

/** Converts interleaved PCM to channels (two: a mono stream is doubled). */
function toChannels(pcm: DataView, format: { channels: number; bits: number; float: boolean }, frames: number) {
  const out = [new Float32Array(frames), new Float32Array(frames)]
  const bytes = format.bits / 8
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const offset = (i * format.channels + Math.min(c, format.channels - 1)) * bytes
      let value: number
      if (format.float) value = pcm.getFloat32(offset, true)
      else if (bytes === 2) value = pcm.getInt16(offset, true) / 32768
      else if (bytes === 3) value = ((pcm.getUint8(offset) | (pcm.getUint8(offset + 1) << 8) | (pcm.getInt8(offset + 2) << 16)) / 8388608)
      else value = pcm.getInt32(offset, true) / 2147483648
      out[c]![i] = value
    }
  }
  return out
}

/** Channels at another sample rate (the context's), through an OfflineAudioContext. */
async function resample(channels: Float32Array<ArrayBuffer>[], from: number, to: number) {
  if (from === to) return channels
  const source = new AudioBuffer({ numberOfChannels: 2, length: channels[0]!.length, sampleRate: from })
  channels.forEach((channel, c) => source.copyToChannel(channel, c))
  const ctx = new OfflineAudioContext(2, Math.ceil((channels[0]!.length * to) / from), to)
  const node = new AudioBufferSourceNode(ctx, { buffer: source })
  node.connect(ctx.destination)
  node.start()
  const rendered = await ctx.startRendering()
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()]
}

/**
 * Reads `seconds` of a WAV stream that starts at track position `start` (as Jellyfin was asked to cut it), and stops
 * the download there.
 */
export async function streamSlice(url: string, start: number, seconds: number, sampleRate: number, signal?: AbortSignal): Promise<Slice> {
  const abort = new AbortController()
  const stop = () => abort.abort()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const response = await fetch(url, { signal: abort.signal })
    if (!response.ok || !response.body) throw new Error(`Slice not available (${response.status})`)
    const reader = response.body.getReader()
    let data = new Uint8Array(0)
    let header: ReturnType<typeof parseHeader> = null
    let needed = Infinity
    while (data.length < needed) {
      const { done, value } = await reader.read()
      if (done) break
      const next = new Uint8Array(data.length + value.length)
      next.set(data)
      next.set(value, data.length)
      data = next
      header ??= parseHeader(data)
      if (header) needed = header.dataStart + Math.ceil(seconds * header.sampleRate) * header.channels * (header.bits / 8)
    }
    void reader.cancel().catch(() => undefined)
    if (!header) throw new Error('No WAV header')
    const frameBytes = header.channels * (header.bits / 8)
    const frames = Math.floor((data.length - header.dataStart) / frameBytes)
    const channels = toChannels(new DataView(data.buffer, header.dataStart, frames * frameBytes), header, frames)
    return { channels: await resample(channels, header.sampleRate, sampleRate), start, sampleRate }
  } finally {
    stop()
    signal?.removeEventListener('abort', stop)
  }
}

/** The stretch [from, to] (track seconds) of a downloaded or cached track (a blob URL), decoded at the context's rate. */
export async function blobSlice(url: string, from: number, to: number, ctx: BaseAudioContext): Promise<Slice> {
  const decoded = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer())
  const first = Math.max(0, Math.floor(from * decoded.sampleRate))
  const last = Math.min(decoded.length, Math.ceil(to * decoded.sampleRate))
  const channels = [0, 1].map((c) => decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1)).slice(first, last))
  return { channels, start: first / decoded.sampleRate, sampleRate: decoded.sampleRate }
}
