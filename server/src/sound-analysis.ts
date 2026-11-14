/**
 * What a song sounds like, measured from a short excerpt (mono 16-bit PCM WAV, about 45 seconds from a third into the
 * song, as Jellyfin transcodes it): tempo, how clear the beat is, key and mode, loudness, dynamics, brightness and
 * how busy it is. The mood mixes are made from these (with tags and the listener's habits). Plain arithmetic, no
 * dependencies, so the same code runs on the server and, for testing, in a browser.
 */
export interface SoundFeatures {
  /** The format of these numbers (raised when the analysis changes, so songs are measured again). */
  v: number
  /** Beats per minute (60–200), the most likely of the tempos found. */
  bpm: number
  /** How clear and regular the beat is (0–1): high for dance music, low for ambient or free time. */
  pulse: number
  /** Key: pitch class 0–11 (0 = C) and major or minor, with how clearly (the profile's correlation, 0–1). */
  key: number
  minor: boolean
  keyClarity: number
  /** Loudness: RMS in dBFS (about -30 quiet to -6 loud). */
  loudness: number
  /** How much the loudness moves (dB, standard deviation of 0.5 s blocks): high for quiet-loud music. */
  dynamics: number
  /** Spectral centroid (Hz): how bright it sounds. */
  brightness: number
  /** Onsets per second: how busy it is. */
  onsets: number
}

export const SOUND_VERSION = 1

/** Krumhansl–Kessler key profiles (major and minor), from C. */
export const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
export const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** The samples of a 16-bit PCM WAV (mono, or the first channel), with its sample rate; streaming WAVs (no sizes) too. */
export function readWav(bytes: Uint8Array): { samples: Float32Array; rate: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
  if (bytes.length < 44 || text(0) !== 'RIFF' || text(8) !== 'WAVE') return null
  let at = 12
  let rate = 0
  let channels = 1
  let bits = 16
  while (at + 8 <= bytes.length) {
    const id = text(at)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ') {
      channels = view.getUint16(at + 10, true)
      rate = view.getUint32(at + 12, true)
      bits = view.getUint16(at + 22, true)
    } else if (id === 'data') {
      if (bits !== 16 || !rate) return null
      const start = at + 8
      // A streamed WAV doesn't know its length (0 or 0xFFFFFFFF): the data goes to the end.
      const end = size && size !== 0xffffffff ? Math.min(bytes.length, start + size) : bytes.length
      const frames = Math.floor((end - start) / (2 * channels))
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) samples[i] = view.getInt16(start + i * 2 * channels, true) / 32768
      return { samples, rate }
    }
    at += 8 + size + (size % 2)
  }
  return null
}

/**
 * The twiddle factors of each FFT stage, made once per stage size (the same values the butterflies would compute, so the
 * results don't change, only the time: long analyses run tens of thousands of transforms).
 */
const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>()

function twiddlesOf(size: number) {
  let table = twiddles.get(size)
  if (!table) {
    const step = (-2 * Math.PI) / size
    table = { cos: new Float64Array(size / 2), sin: new Float64Array(size / 2) }
    for (let k = 0; k < size / 2; k++) {
      table.cos[k] = Math.cos(step * k)
      table.sin[k] = Math.sin(step * k)
    }
    twiddles.set(size, table)
  }
  return table
}

/** In-place radix-2 FFT (re, im of a power-of-two length). */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const { cos: cosines, sin: sines } = twiddlesOf(size)
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const cos = cosines[k]!
        const sin = sines[k]!
        const a = start + k
        const b = a + size / 2
        const tre = re[b]! * cos - im[b]! * sin
        const tim = re[b]! * sin + im[b]! * cos
        re[b] = re[a]! - tre
        im[b] = im[a]! - tim
        re[a] = re[a]! + tre
        im[a] = im[a]! + tim
      }
    }
  }
}

/**
 * Magnitude spectra of windowed frames (Hann), `size` long, every `hop` samples. The yielded array is reused for the
 * next frame: copy what has to outlive it.
 */
export function* spectra(samples: Float32Array, size: number, hop: number) {
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size))
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const magnitudes = new Float64Array(size / 2 + 1)
  for (let start = 0; start + size <= samples.length; start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = samples[start + i]! * window[i]!
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k <= size / 2; k++) magnitudes[k] = Math.hypot(re[k]!, im[k]!)
    yield magnitudes
  }
}

/** Pearson correlation of two equally long lists (0 when either is flat). */
export function pearson(a: number[], b: number[]) {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb)
    da += (a[i]! - ma) ** 2
    db += (b[i]! - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

export function analyzeSound(samples: Float32Array, rate: number): SoundFeatures | null {
  // The first half second can hold the transcoder's start; too little left says nothing.
  const audio = samples.subarray(Math.floor(rate / 2))
  if (audio.length < rate * 10) return null

  // Loudness and dynamics.
  let power = 0
  for (const sample of audio) power += sample * sample
  const rms = Math.sqrt(power / audio.length)
  if (rms < 1e-4) return null
  const block = Math.floor(rate / 2)
  const blocks: number[] = []
  for (let start = 0; start + block <= audio.length; start += block) {
    let sum = 0
    for (let i = start; i < start + block; i++) sum += audio[i]! * audio[i]!
    blocks.push(10 * Math.log10(sum / block + 1e-12))
  }
  const blockMean = blocks.reduce((sum, value) => sum + value, 0) / blocks.length
  const dynamics = Math.sqrt(blocks.reduce((sum, value) => sum + (value - blockMean) ** 2, 0) / blocks.length)

  // Onsets (spectral flux) and brightness, on short frames.
  const size = 1024
  const hop = 256
  const frameRate = rate / hop
  const flux: number[] = []
  let previous: Float64Array | null = null
  let centroidSum = 0
  let centroidWeight = 0
  for (const magnitudes of spectra(audio, size, hop)) {
    const logs = magnitudes.map((value) => Math.log1p(100 * value))
    let rise = 0
    if (previous) for (let k = 1; k < logs.length; k++) rise += Math.max(0, logs[k]! - previous[k]!)
    flux.push(rise)
    previous = logs
    let weighted = 0
    let total = 0
    for (let k = 1; k < magnitudes.length; k++) {
      weighted += ((k * rate) / size) * magnitudes[k]!
      total += magnitudes[k]!
    }
    if (total > 0) {
      centroidSum += weighted
      centroidWeight += total
    }
  }
  // The onset strength above its local average (about half a second), half-wave rectified.
  const span = Math.round(frameRate / 4)
  const envelope = flux.map((value, i) => {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - span); j <= Math.min(flux.length - 1, i + span); j++) {
      sum += flux[j]!
      count++
    }
    return Math.max(0, value - sum / count)
  })
  // Onsets: peaks of the envelope clearly above its typical level.
  const sorted = [...envelope].sort((a, b) => a - b)
  const threshold = sorted[Math.floor(sorted.length * 0.85)]! || 1e-9
  let onsetCount = 0
  for (let i = 1; i < envelope.length - 1; i++) if (envelope[i]! > threshold && envelope[i]! >= envelope[i - 1]! && envelope[i]! > envelope[i + 1]!) onsetCount++

  // Tempo: autocorrelation of the envelope over 60–200 BPM, leaning towards 120 (people tap around there).
  const acf = (lag: number) => {
    let sum = 0
    for (let i = 0; i + lag < envelope.length; i++) sum += envelope[i]! * envelope[i + lag]!
    return sum / (envelope.length - lag)
  }
  const zero = acf(0) || 1e-12
  let best = { bpm: 120, score: -Infinity, strength: 0 }
  const minLag = Math.floor((60 * frameRate) / 200)
  const maxLag = Math.ceil((60 * frameRate) / 60)
  const values = new Map<number, number>()
  for (let lag = minLag; lag <= maxLag + 1; lag++) values.set(lag, acf(lag))
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    const value = values.get(lag)!
    if (value < values.get(lag - 1)! || value < values.get(lag + 1)!) continue
    // Parabolic interpolation between the lags around the peak, for a finer tempo.
    const left = values.get(lag - 1)!
    const right = values.get(lag + 1)!
    const shift = (left - right) / (2 * (left - 2 * value + right) || 1)
    const bpm = (60 * frameRate) / (lag + (Number.isFinite(shift) ? Math.max(-0.5, Math.min(0.5, shift)) : 0))
    // A real beat has its bars (twice the lag) and its eighths (half of it) too; a triplet ghost lacks the eighths.
    const half = lag / 2 >= 2 ? acf(Math.round(lag / 2)) : 0
    const score = (value + 0.5 * acf(lag * 2) + 0.5 * half) * Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.75) ** 2)
    if (score > best.score) best = { bpm, score, strength: value / zero }
  }

  // Key: a chroma profile on long frames (fine pitch), matched to the Krumhansl–Kessler key profiles.
  // Each note (C2–C7) takes its strongest bin, so no pitch class weighs more for having more bins; each frame counts
  // alike (relative to its loudest note), and the background between notes is taken off.
  const chroma = new Array(12).fill(0) as number[]
  const longSize = 4096
  const binOf = (midi: number) => (440 * 2 ** ((midi - 69) / 12) * longSize) / rate
  for (const magnitudes of spectra(audio, longSize, longSize / 2)) {
    const notes: number[] = []
    for (let midi = 36; midi <= 96; midi++) {
      let peak = 0
      for (let k = Math.ceil(binOf(midi - 0.5)); k < binOf(midi + 0.5) && k < magnitudes.length; k++) peak = Math.max(peak, magnitudes[k]!)
      notes.push(peak)
    }
    const max = Math.max(...notes)
    if (max <= 1e-6) continue
    const floor = [...notes].sort((a, b) => a - b)[Math.floor(notes.length / 2)]!
    notes.forEach((value, i) => (chroma[(36 + i) % 12] += Math.max(0, value - floor) / max))
  }
  const keys: Array<{ key: number; minor: boolean; r: number }> = []
  for (let key = 0; key < 12; key++) {
    const rotated = chroma.map((_, i) => chroma[(i + key) % 12]!)
    keys.push({ key, minor: false, r: pearson(rotated, MAJOR) }, { key, minor: true, r: pearson(rotated, MINOR) })
  }
  keys.sort((a, b) => b.r - a.r)
  const top = keys[0]!

  const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
  return {
    v: SOUND_VERSION,
    bpm: round(best.bpm, 1),
    pulse: round(Math.max(0, Math.min(1, best.strength)), 3),
    key: top.key,
    minor: top.minor,
    keyClarity: round(Math.max(0, top.r), 3),
    loudness: round(20 * Math.log10(rms), 1),
    dynamics: round(dynamics, 2),
    brightness: Math.round(centroidWeight ? centroidSum / centroidWeight : 0),
    onsets: round(onsetCount / (audio.length / rate), 2),
  }
}
