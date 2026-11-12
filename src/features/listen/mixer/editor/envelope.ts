import type { PreviewSource } from '../preview'

/**
 * A song's waveform in bands, fine enough for the editor's visualizer (100 frames a second, where the analysis has 10):
 * the peak level per frame of the whole signal and of its bass (< 200 Hz), mids and highs (> 2 kHz), each relative to
 * its loudest frame, as the analysis' curves are. Worked out from the audio the preview has loaded, by the browser's own
 * filters (offline, a fraction of real time).
 */
export interface Envelope {
  frameRate: number
  /** Track seconds of the last frame's end (the audio loaded so far). */
  duration: number
  energy: number[]
  bands: { low: number[]; mid: number[]; high: number[] }
}

const FRAME_RATE = 100

/** Peak per frame of a signal, scaled to its loudest frame. */
function peaks(signal: Float32Array, hop: number): number[] {
  const frames = Math.floor(signal.length / hop)
  const out = new Array<number>(frames)
  let top = 0
  for (let f = 0; f < frames; f++) {
    let peak = 0
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const v = Math.abs(signal[i]!)
      if (v > peak) peak = v
    }
    out[f] = peak
    if (peak > top) top = peak
  }
  if (top > 0) for (let f = 0; f < frames; f++) out[f]! /= top
  return out
}

/** One band of the mono signal through the browser's biquads. */
async function band(mono: Float32Array, sampleRate: number, filters: Array<{ type: BiquadFilterType; frequency: number }>): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, mono.length, sampleRate)
  const buffer = ctx.createBuffer(1, mono.length, sampleRate)
  buffer.copyToChannel(mono as Float32Array<ArrayBuffer>, 0)
  const source = new AudioBufferSourceNode(ctx, { buffer })
  let node: AudioNode = source
  for (const filter of filters) {
    const biquad = new BiquadFilterNode(ctx, { type: filter.type, frequency: filter.frequency, Q: Math.SQRT1_2 })
    node.connect(biquad)
    node = biquad
  }
  node.connect(ctx.destination)
  source.start()
  return (await ctx.startRendering()).getChannelData(0)
}

/** The envelope of a loaded stretch of a song (its frames start at the song's 0 s; earlier audio isn't drawn). */
export async function envelopeOf(source: PreviewSource): Promise<Envelope> {
  const channels = source.channels
  const length = channels[0]?.length ?? 0
  const mono = new Float32Array(length)
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i]! += channel[i]! / channels.length
  const hop = Math.max(1, Math.round(source.sampleRate / FRAME_RATE))
  const [low, mid, high] = await Promise.all([
    band(mono, source.sampleRate, [{ type: 'lowpass', frequency: 200 }]),
    band(mono, source.sampleRate, [
      { type: 'highpass', frequency: 200 },
      { type: 'lowpass', frequency: 2000 },
    ]),
    band(mono, source.sampleRate, [{ type: 'highpass', frequency: 2000 }]),
  ])
  // Frames are counted from the song's start: a stretch starting later is padded with silence before it.
  const lead = Math.round(source.origin * FRAME_RATE)
  const pad = (values: number[]) => [...new Array<number>(Math.max(0, lead)).fill(0), ...values]
  return {
    frameRate: source.sampleRate / hop,
    duration: source.origin + length / source.sampleRate,
    energy: pad(peaks(mono, hop)),
    bands: { low: pad(peaks(low, hop)), mid: pad(peaks(mid, hop)), high: pad(peaks(high, hop)) },
  }
}
