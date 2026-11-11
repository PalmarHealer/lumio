import { MAJOR, MINOR, fft, pearson } from './sound-analysis.ts'

/**
 * What a whole song does over time, for the mixer (DJ) mode: its beat grid (beats, bars, phrases), how loud each band
 * is from moment to moment, its structure (intro, verses, choruses, drops, breaks, outro), where it is sung, and the
 * moments a DJ would bring it in or take it out. Measured once per song from the whole track and kept on the server:
 * a 16-bit PCM WAV as Jellyfin transcodes it, stereo at 11 kHz (everything measured here lives below 5.5 kHz; the
 * stereo image helps find the voice; a 4-minute song is about 10 MB, analysed in one to three seconds). Plain
 * arithmetic, no dependencies, like sound-analysis.ts.
 *
 * The steps, in order:
 * 1. Short spectra (93 ms, 23 ms apart): onset strength (spectral flux), band energies, a timbre vector, and the vocal
 *    band's power in the stereo centre and at the sides; long spectra (370 ms) for chroma (which notes sound).
 * 2. Tempo from the onset strength's autocorrelation, then beats by dynamic programming (Ellis 2007): beats sit on
 *    strong onsets and keep a steady distance, but may follow the music where it drifts.
 * 3. Bars: the beat that starts a bar has the chord changes (bar against bar), the kick (on its half of the bar), the
 *    section changes and, with lyrics, the sung lines (on it or its pickup); a Viterbi pass over the beats keeps a
 *    steady 4/4 count and skips only for long, clear evidence. Where the count stays unclear (weak evidence, or the
 *    lines disagree), bpmConfidence is lowered rather than the guess trusted.
 * 4. Phrases: 8-bar groups (sometimes 4 or 16) whose starts line up with where the sound changes (novelty of the
 *    bar-by-bar self-similarity).
 * 5. Structure: phrases that sound alike (chroma and timbre along the self-similarity's diagonals) form groups; the
 *    repeated loud group (with lyrics: the one sung in the lines that come back) is the chorus, a bass and energy jump
 *    after a build-up is a drop, quiet bass-less stretches are breaks.
 * 6. Vocals: synced lyrics, placed on the audio (they may belong to another version) and checked (they may belong to
 *    another song). Without lyrics there are none: the audio alone doesn't tell singing apart reliably enough.
 * 7. Cue points: phrase starts ranked as entries (the beat is in, no line is cut) and exits (after the last chorus,
 *    between lines).
 */

// ---- the contract (an identical copy of src/features/listen/mixer/types.ts: the server can't import from src/) ----

/** Raised when the analysis changes, so songs are analysed again. */
export const MIX_VERSION = 3

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'drop' | 'build' | 'break' | 'outro' | 'other'

export interface MixSection {
  start: number
  end: number
  kind: SectionKind
  /** Sections that sound alike (self-similarity) share a group number; repeated groups hint the chorus. */
  group: number
  /** Mean energy of the section (0–1, relative to the track's loudest). */
  energy: number
}

/** What the Lumio server measured over a whole song, for planning and drawing transitions. */
export interface TrackMix {
  v: number
  /** Length of the analysed audio. */
  duration: number
  /** Global tempo (60–200 BPM) and how sure the analysis is of it and of the beat grid (0–1). */
  bpm: number
  bpmConfidence: number
  /** Beat times (seconds, 3 decimals), following the music (not a rigid grid), on the audible attacks. */
  beats: number[]
  /** The beats that start a bar (a subset of `beats`). */
  downbeats: number[]
  /** Phrase starts: downbeats where an 8-bar (sometimes 4/16) phrase begins, usually where sections change. */
  phrases: number[]
  /**
   * Per phrase (same index as `phrases`, each up to the next phrase or the end): how clearly its beats are heard as
   * attacks (0–1, the share of beats with a clear onset on the grid). Beatmatching over a phrase with unclear attacks
   * can't be trusted to line up audibly.
   */
  phraseClarity: number[]
  /**
   * Per bar (same index as `downbeats`, each up to the next downbeat or the end): the same measure for that bar's beats
   * alone. Lets a beatmatch use the clear bars of a phrase that is unclear elsewhere. Empty in analyses made before it.
   */
  barClarity: number[]
  /**
   * Per phrase (same index as `phrases`): what it plays harmonically, as 12 values (pitch classes from C, 0–1, the
   * strongest 1). Taken from the melody's range (C3–C6) with short transients (drums) held out, so phrases with similar
   * melodies and chords have similar profiles (cosine). Empty in analyses made before it.
   */
  phraseChroma: number[][]
  /** Key as pitch class 0–11 (0 = C), major/minor, and how clear (0–1). */
  key: number
  minor: boolean
  keyClarity: number
  /** Whole-track RMS loudness in dBFS. */
  loudness: number
  /** Frames per second of the curves below (10). */
  frameRate: number
  /** Overall energy per frame (0–1, relative to the track's loudest frame). */
  energy: number[]
  /** Band energy per frame (0–1 each, relative to the band's loudest): low < 200 Hz, mid 200–2000 Hz, high > 2000 Hz. */
  bands: { low: number[]; mid: number[]; high: number[] }
  /** The song's structure, in order, covering the whole track. */
  sections: MixSection[]
  /** Drop moments (a phrase start where bass and energy jump after a build-up). */
  drops: number[]
  /**
   * Stretches with singing, padded for safety ("never two vocals at once" may rely on them): synced lyrics give only
   * line starts, and their timing may be off. Lyrics kept where they were timed (offset 0) are padded by one beat (at
   * least 0.5 s) each side; lyrics the analysis had to move (another version) by 2 s each side, the measured placement
   * error. A line's end isn't known: it ends 0.15 s before the next line, at most as long as its words take (about 3 a
   * second, at least 1.5 s) and at most 1.25 times the song's median line distance (2–8 s); stretches that touch after
   * padding are merged.
   */
  vocals: Array<{ start: number; end: number }>
  /** Where `vocals` came from: synced lyrics aligned to the audio, an estimate from the audio, or nothing found. */
  vocalSource: 'lyrics' | 'audio' | 'none'
  /** First phrase where the song is fully "in" (beat and bass), and where it starts to wind down after its last chorus/drop. */
  introEnd: number
  outroStart: number
  /** Good moments to bring this song in / take it out (phrase starts, best first). */
  cuesIn: number[]
  cuesOut: number[]
}

/** A synced lyrics line: when it starts (seconds) and what is sung. When it ends isn't known. */
export interface LyricLine {
  time: number
  text: string
}

/**
 * Every channel of a 16-bit PCM WAV, with its sample rate (streaming WAVs without sizes too). readWav in
 * sound-analysis.ts gives only the first channel; the mix analysis wants the stereo image as well.
 */
export function readWavChannels(bytes: Uint8Array): { channels: Float32Array[]; rate: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
  if (bytes.length < 44 || text(0) !== 'RIFF' || text(8) !== 'WAVE') return null
  let at = 12
  let rate = 0
  let count = 1
  let bits = 16
  while (at + 8 <= bytes.length) {
    const id = text(at)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ') {
      count = view.getUint16(at + 10, true)
      rate = view.getUint32(at + 12, true)
      bits = view.getUint16(at + 22, true)
    } else if (id === 'data') {
      if (bits !== 16 || !rate || count < 1) return null
      const start = at + 8
      // A streamed WAV doesn't know its length (0 or 0xFFFFFFFF): the data goes to the end.
      const end = size && size !== 0xffffffff ? Math.min(bytes.length, start + size) : bytes.length
      const frames = Math.floor((end - start) / (2 * count))
      const channels = Array.from({ length: count }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) channels[c]![i] = view.getInt16(start + (i * count + c) * 2, true) / 32768
      return { channels, rate }
    }
    at += 8 + size + (size % 2)
  }
  return null
}

// ---- small helpers ----

const CURVE_RATE = 10
/**
 * How far a beat lies after the flux frame it was found on (seconds): the flux peaks a frame before the attack. Measured
 * on synthetic drum tracks (23 ms at every tempo) and confirmed on real songs against a fine energy envelope.
 */
const BEAT_DELAY = 0.023
const BAND_LOW = 200
const BAND_HIGH = 2000

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits
const mean = (values: ArrayLike<number>, from = 0, to = values.length) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += values[i]!
  return to > from ? sum / (to - from) : 0
}
const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}
const quantile = (values: ArrayLike<number>, q: number) => {
  if (!values.length) return 0
  const sorted = Array.from(values).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!
}
/** Values as standard scores (0 mean, unit deviation); a flat list stays 0. */
const zscores = (values: ArrayLike<number>) => {
  const m = mean(values)
  let variance = 0
  for (let i = 0; i < values.length; i++) variance += (values[i]! - m) ** 2
  const sd = Math.sqrt(variance / Math.max(1, values.length)) || 1
  return Array.from(values, (value) => (value - m) / sd)
}
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
/** A moving average over `radius` values each side (edges average what is there). */
const smooth = (values: ArrayLike<number>, radius: number) => {
  const out = new Float64Array(values.length)
  let sum = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius)
    const to = Math.min(values.length - 1, i + radius)
    while (hi < to) sum += values[++hi]!
    while (lo < from) sum -= values[lo++]!
    out[i] = sum / (hi - lo + 1)
  }
  return out
}
// ---- 1. spectra ----

interface ShortSpectra {
  /** Frames per second and the time of frame i's centre. */
  rate: number
  time: (frame: number) => number
  count: number
  /** Spectral flux (log magnitude rise), whole spectrum and below 200 Hz (kick and bass notes). */
  flux: Float64Array
  lowFlux: Float64Array
  /** Power per band (low / mid / high, see the contract). */
  low: Float64Array
  mid: Float64Array
  high: Float64Array
  /** Timbre: cepstral coefficients 1–12 of log-spaced band energies (the spectrum's shape without its loudness). */
  timbre: Float32Array
  /** Power in the vocal band (300–3000 Hz) of the mono mix (the stereo centre), and of the stereo sides (null: mono). */
  centre: Float64Array
  side: Float64Array | null
}

const TIMBRE_BANDS = 20
const TIMBRE_COEFFS = 12

function shortSpectra(samples: Float32Array, rate: number, sides: Float32Array | null): ShortSpectra {
  // About 93 ms windows every 23 ms whatever the sample rate (1024 / 256 at 11025 Hz).
  const size = 2 ** Math.round(Math.log2(rate * 0.093))
  const hop = size / 4
  const count = Math.max(0, Math.floor((samples.length - size) / hop) + 1)
  const bins = size / 2 + 1
  const binHz = rate / size
  const lowEnd = Math.round(BAND_LOW / binHz)
  const midEnd = Math.round(BAND_HIGH / binHz)
  const vocalFrom = Math.round(300 / binHz)
  const vocalTo = Math.min(bins - 1, Math.round(3000 / binHz))
  // Log-spaced bands from 60 Hz to Nyquist (or 5 kHz) for the timbre.
  const top = Math.min(rate / 2, 5000)
  const edges = Array.from({ length: TIMBRE_BANDS + 1 }, (_, i) => Math.max(1, Math.round((60 * (top / 60) ** (i / TIMBRE_BANDS)) / binHz)))
  const dct = Array.from({ length: TIMBRE_COEFFS }, (_, c) => Float64Array.from({ length: TIMBRE_BANDS }, (_, b) => Math.cos((Math.PI * (c + 1) * (b + 0.5)) / TIMBRE_BANDS)))

  const result: ShortSpectra = {
    rate: rate / hop,
    time: (frame) => (frame * hop + size / 2) / rate,
    count,
    flux: new Float64Array(count),
    lowFlux: new Float64Array(count),
    low: new Float64Array(count),
    mid: new Float64Array(count),
    high: new Float64Array(count),
    timbre: new Float32Array(count * TIMBRE_COEFFS),
    centre: new Float64Array(count),
    side: sides ? new Float64Array(count) : null,
  }
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size))
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const sideRe = new Float64Array(size)
  const sideIm = new Float64Array(size)
  const logs = new Float64Array(bins)
  const previous = new Float64Array(bins)
  const bandLogs = new Float64Array(TIMBRE_BANDS)
  for (let frame = 0; frame < count; frame++) {
    const start = frame * hop
    for (let i = 0; i < size; i++) {
      re[i] = samples[start + i]! * window[i]!
      im[i] = 0
    }
    fft(re, im)
    let rise = 0
    let lowRise = 0
    let low = 0
    let mid = 0
    let high = 0
    for (let k = 1; k < bins; k++) {
      const power = re[k]! * re[k]! + im[k]! * im[k]!
      const magnitude = Math.sqrt(power)
      logs[k] = Math.log1p(100 * magnitude)
      if (frame) {
        const up = Math.max(0, logs[k]! - previous[k]!)
        rise += up
        if (k <= lowEnd) lowRise += up
      }
      if (k < lowEnd) low += power
      else if (k < midEnd) mid += power
      else high += power
      if (k >= vocalFrom && k < vocalTo) result.centre[frame] += power
    }
    previous.set(logs)
    if (sides && result.side) {
      for (let i = 0; i < size; i++) {
        sideRe[i] = sides[start + i]! * window[i]!
        sideIm[i] = 0
      }
      fft(sideRe, sideIm)
      let side = 0
      for (let k = vocalFrom; k < vocalTo; k++) side += sideRe[k]! * sideRe[k]! + sideIm[k]! * sideIm[k]!
      result.side[frame] = side
    }
    result.flux[frame] = rise
    result.lowFlux[frame] = lowRise
    result.low[frame] = low
    result.mid[frame] = mid
    result.high[frame] = high
    for (let b = 0; b < TIMBRE_BANDS; b++) {
      let sum = 0
      for (let k = edges[b]!; k < Math.max(edges[b]! + 1, edges[b + 1]!); k++) sum += re[k]! * re[k]! + im[k]! * im[k]!
      bandLogs[b] = Math.log(sum + 1e-9)
    }
    for (let c = 0; c < TIMBRE_COEFFS; c++) {
      let sum = 0
      for (let b = 0; b < TIMBRE_BANDS; b++) sum += dct[c]![b]! * bandLogs[b]!
      result.timbre[frame * TIMBRE_COEFFS + c] = sum / TIMBRE_BANDS
    }
  }
  return result
}

interface Chroma {
  rate: number
  time: (frame: number) => number
  count: number
  /** 12 values per frame, relative to the frame's loudest note. */
  frames: Float32Array
  /** Summed over the track, for the key. */
  total: number[]
  /** The same per frame from the melody's range only (C3–C6), for comparing phrases' melodies. */
  melody: Float32Array
}

/** Which notes sound (C2–C7 folded into 12 pitch classes), on long frames for fine pitch, as sound-analysis.ts does. */
function chromagram(samples: Float32Array, rate: number): Chroma {
  const size = 2 ** Math.round(Math.log2(rate * 0.37))
  const hop = size / 4
  const count = Math.max(0, Math.floor((samples.length - size) / hop) + 1)
  const frames = new Float32Array(count * 12)
  const melody = new Float32Array(count * 12)
  const total = new Array(12).fill(0) as number[]
  const binOf = (midi: number) => (440 * 2 ** ((midi - 69) / 12) * size) / rate
  const ranges = Array.from({ length: 61 }, (_, i) => [Math.ceil(binOf(36 + i - 0.5)), binOf(36 + i + 0.5)] as const)
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size))
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const notes = new Float64Array(61)
  const sorted = new Float64Array(61)
  for (let frame = 0; frame < count; frame++) {
    const start = frame * hop
    for (let i = 0; i < size; i++) {
      re[i] = samples[start + i]! * window[i]!
      im[i] = 0
    }
    fft(re, im)
    let max = 0
    for (let n = 0; n < 61; n++) {
      let peak = 0
      const [from, to] = ranges[n]!
      for (let k = from; k < to && k <= size / 2; k++) peak = Math.max(peak, Math.hypot(re[k]!, im[k]!))
      notes[n] = peak
      max = Math.max(max, peak)
    }
    if (max <= 1e-6) continue
    // Each note relative to the frame's loudest, the background between notes taken off.
    sorted.set(notes)
    sorted.sort()
    const floor = sorted[30]!
    for (let n = 0; n < 61; n++) {
      const value = Math.max(0, notes[n]! - floor) / max
      frames[frame * 12 + ((36 + n) % 12)] += value
      total[(36 + n) % 12] += value
      if (n >= 12 && n <= 48) melody[frame * 12 + ((36 + n) % 12)] += value
    }
  }
  return { rate: rate / hop, time: (frame) => (frame * hop + size / 2) / rate, count, frames, total, melody }
}

// ---- 2. tempo and beats ----

/** Onset strength: the flux above its local average (about half a second), half-wave rectified, in standard units. */
function onsetEnvelope(flux: Float64Array, frameRate: number) {
  const local = smooth(flux, Math.round(frameRate / 4))
  const envelope = Float64Array.from(flux, (value, i) => Math.max(0, value - local[i]!))
  let variance = 0
  for (const value of envelope) variance += value * value
  const sd = Math.sqrt(variance / Math.max(1, envelope.length)) || 1
  for (let i = 0; i < envelope.length; i++) envelope[i] = envelope[i]! / sd
  return envelope
}

interface Tempo {
  /** Beat period in frames (fractional). */
  period: number
  /** The normalised autocorrelation at that period (how periodic the onsets are, about 0.05 free time to 0.5 dance). */
  strength: number
  /** Share of the song's (non-silent) 8-second windows whose own tempo agrees (same, half or double). */
  stability: number
}

const TEMPO_CENTRE = 115

/** The most likely beat period of an onset envelope, over 60–200 BPM, leaning towards 115 BPM as listeners do. */
function estimateTempo(envelope: Float64Array, frameRate: number): Tempo {
  const minLag = Math.floor((60 * frameRate) / 200)
  const maxLag = Math.ceil((60 * frameRate) / 60)
  const lags = 4 * maxLag + 2
  const windowLength = Math.round(8 * frameRate)
  const step = Math.round(frameRate)
  const total = new Float64Array(lags)
  const local: Float64Array[] = []
  for (let start = 0; start + windowLength <= envelope.length || (start === 0 && envelope.length > lags); start += step) {
    const end = Math.min(envelope.length, start + windowLength)
    const acf = new Float64Array(lags)
    for (let lag = 0; lag < lags; lag++) {
      let sum = 0
      for (let i = start; i + lag < end; i++) sum += envelope[i]! * envelope[i + lag]!
      acf[lag] = sum / Math.max(1, end - start - lag)
    }
    if (acf[0]! < 0.05) continue
    for (let lag = 1; lag < lags; lag++) acf[lag] = acf[lag]! / acf[0]!
    acf[0] = 1
    local.push(acf)
    for (let lag = 0; lag < lags; lag++) total[lag] += acf[lag]!
    if (end === envelope.length) break
  }
  if (!local.length) return { period: (60 * frameRate) / 120, strength: 0, stability: 0 }
  for (let lag = 0; lag < lags; lag++) total[lag] = total[lag]! / local.length

  const pick = (acf: Float64Array) => {
    const at = (lag: number) => {
      const i = Math.floor(lag)
      const f = lag - i
      return i + 1 < acf.length ? acf[i]! * (1 - f) + acf[i + 1]! * f : 0
    }
    let best = { period: (60 * frameRate) / 120, score: -Infinity, value: 0 }
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      const value = acf[lag]!
      if (value < acf[lag - 1]! || value < acf[lag + 1]!) continue
      // Parabolic interpolation between the lags around the peak, for a finer tempo.
      const left = acf[lag - 1]!
      const right = acf[lag + 1]!
      const shift = (left - right) / (2 * (left - 2 * value + right) || 1)
      const period = lag + (Number.isFinite(shift) ? clamp(shift, -0.5, 0.5) : 0)
      const bpm = (60 * frameRate) / period
      // A real beat repeats: its multiples (2, 3, 4 beats) are periodic too, which a dotted or triplet figure's period
      // (1.5 beats) only partly is; and it has its eighths (half the period). Weighted towards 115 BPM, as people tap.
      const multiples = (value + at(period * 2) / 2 + at(period * 3) / 3 + at(period * 4) / 4) / (1 + 1 / 2 + 1 / 3 + 1 / 4)
      const score = (multiples + 0.5 * (period / 2 >= 2 ? at(period / 2) : 0)) * Math.exp(-0.5 * Math.log2(bpm / TEMPO_CENTRE) ** 2)
      if (score > best.score) best = { period, score, value }
    }
    return best
  }
  const global = pick(total)
  // How many windows hear the same tempo (or its half or double): low for free time, rubato and tempo changes.
  let agree = 0
  for (const acf of local) {
    const own = pick(acf).period
    const ratio = own / global.period
    if ([0.5, 1, 2].some((multiple) => Math.abs(ratio / multiple - 1) < 0.04)) agree++
  }
  return { period: global.period, strength: global.value, stability: agree / local.length }
}

/**
 * The audible onsets at millisecond resolution, for putting the beats on them: the samples band-passed to 40–4000 Hz
 * (Butterworth high- and low-pass sections, run forwards and backwards so nothing is delayed), their RMS per
 * millisecond in log, averaged over 10 ms, and how much that rises from one millisecond to the next.
 */
function fineOnsets(samples: Float32Array, rate: number, low = 40, high = 4000): { rise: Float32Array; step: number } {
  const filtered = Float32Array.from(samples)
  const pass = (kind: 'low' | 'high', frequency: number) => {
    const w = (2 * Math.PI * frequency) / rate
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
    const cos = Math.cos(w)
    const a0 = 1 + alpha
    const b0 = (kind === 'low' ? (1 - cos) / 2 : (1 + cos) / 2) / a0
    const b1 = (kind === 'low' ? 1 - cos : -(1 + cos)) / a0
    const b2 = b0
    const a1 = (-2 * cos) / a0
    const a2 = (1 - alpha) / a0
    for (const backwards of [false, true]) {
      let x1 = 0
      let x2 = 0
      let y1 = 0
      let y2 = 0
      for (let n = 0; n < filtered.length; n++) {
        const i = backwards ? filtered.length - 1 - n : n
        const x = filtered[i]!
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        filtered[i] = y
      }
    }
  }
  // Each pass twice: fourth-order slopes (eighth with the backward runs), as a broadband onset measure usually has.
  pass('high', low)
  pass('high', low)
  if (rate / 2 > high * 1.1) {
    pass('low', high)
    pass('low', high)
  }
  const hop = Math.max(1, Math.round(rate / 1000))
  const count = Math.floor(filtered.length / hop)
  const level = new Float64Array(count)
  for (let k = 0; k < count; k++) {
    let sum = 0
    for (let i = k * hop; i < (k + 1) * hop; i++) sum += filtered[i]! * filtered[i]!
    level[k] = Math.log(Math.sqrt(sum / hop) + 1e-7)
  }
  // The mean of the 10 ms around each millisecond (5 before, 4 after).
  const averaged = new Float64Array(count)
  for (let k = 0; k < count; k++) {
    let sum = 0
    for (let j = k - 5; j <= k + 4; j++) sum += j >= 0 && j < count ? level[j]! : 0
    averaged[k] = sum / 10
  }
  const rise = new Float32Array(count)
  for (let k = 1; k < count; k++) rise[k] = Math.max(0, averaged[k]! - averaged[k - 1]!)
  return { rise, step: hop / rate }
}

/**
 * Puts the beats on the audible onsets. The beat tracker's frames are 23 ms apart and its flux reacts to the whole
 * spectrum; what a listener (and a beatmatch) hears is the broadband attack. Each beat's strongest attack within
 * ±50 ms gives a correction; the corrections are smoothed with a median over two bars (8 beats), so a fill or an
 * off-beat hi-hat can't pull single beats, and beats without a clear attack take their neighbours' correction.
 */
/**
 * Where the beats' attack lies, as the ear and a beatmatch hear it over a stretch rather than beat by beat: for each
 * beat, the onset rise averaged over the 8 beats around it (two bars), from `around` seconds before to after each.
 * Single attacks scatter where a sidechained synth or a pad fills the spectrum; their average still peaks where the
 * beat's attack is. Returns per beat where that peak lies (seconds from the beat), how much it stands out (0–1: the
 * peak over the average's median, relative to the peak), and the strongest other peak more than 15 ms from it
 * (relative to the peak: high when two moments compete for the attack).
 */
function beatProfiles(beats: number[], onsets: { rise: Float32Array; step: number }, around = 0.05) {
  const { rise, step } = onsets
  const reach = Math.round(around / step)
  const width = 2 * reach + 1
  return beats.map((_, i) => {
    const profile = new Float64Array(width)
    let count = 0
    for (let k = Math.max(0, i - 4); k < Math.min(beats.length, i + 4); k++) {
      const centre = Math.round(beats[k]! / step)
      if (centre - reach < 0 || centre + reach >= rise.length) continue
      for (let j = 0; j < width; j++) profile[j] += rise[centre - reach + j]!
      count++
    }
    if (!count) return { shift: 0, prominence: 0, rival: 1 }
    let at = 0
    for (let j = 1; j < width; j++) if (profile[j]! > profile[at]!) at = j
    const peak = profile[at]!
    let rival = 0
    const apart = Math.round(0.015 / step)
    for (let j = 1; j < width - 1; j++) {
      if (Math.abs(j - at) > apart && profile[j]! >= profile[j - 1]! && profile[j]! >= profile[j + 1]!) rival = Math.max(rival, profile[j]!)
    }
    return { shift: (at - reach) * step, prominence: peak > 0 ? (peak - median(Array.from(profile))) / peak : 0, rival: peak > 0 ? rival / peak : 1 }
  })
}

/**
 * Puts the beats on the audible onsets. The beat tracker's frames are 23 ms apart and its flux reacts to the whole
 * spectrum; what a listener (and a beatmatch) hears is the broadband attack. Each beat moves to the peak of the attacks
 * averaged over the two bars around it (see beatProfiles) where that peak stands out; elsewhere it takes the nearest
 * such correction. The correction changes by at most 6 ms from one beat to the next (both ways, averaged): where the
 * attacks change character (a build into a drop) the beats glide over instead of one bar coming out short.
 */
function onAudibleOnsets(beats: number[], onsets: { rise: Float32Array; step: number }, accents?: { rise: Float32Array; step: number }): number[] {
  const profiles = beatProfiles(beats, onsets)
  // Where the broadband attacks compete (two peaks, as under a pumping synth), the snares, claps and hats (`accents`,
  // 1.5–5 kHz) often still mark the beat unambiguously: then they decide.
  const accented = accents ? beatProfiles(beats, accents) : null
  const decided = profiles.map((profile, i) => {
    if (profile.prominence >= 0.5 && profile.rival < 0.75) return profile.shift
    const accent = accented?.[i]
    if (accent && accent.prominence >= 0.5 && accent.rival < 0.75) return accent.shift
    return profile.prominence >= 0.5 ? profile.shift : NaN
  })
  const known = decided.flatMap((shift, i) => (Number.isNaN(shift) ? [] : [i]))
  const overall = known.length ? median(known.map((i) => decided[i]!)) : 0
  let next = 0
  const corrections = beats.map((_, i) => {
    if (!Number.isNaN(decided[i]!)) return decided[i]!
    while (next < known.length - 1 && known[next + 1]! <= i) next++
    const nearest = [known[next], known[next + 1]].filter((k): k is number => k !== undefined).sort((x, y) => Math.abs(x - i) - Math.abs(y - i))[0]
    return nearest === undefined ? overall : decided[nearest]!
  })
  const limit = 0.006
  const forward = [...corrections]
  for (let i = 1; i < forward.length; i++) forward[i] = clamp(forward[i]!, forward[i - 1]! - limit, forward[i - 1]! + limit)
  const backward = [...corrections]
  for (let i = backward.length - 2; i >= 0; i--) backward[i] = clamp(backward[i]!, backward[i + 1]! - limit, backward[i + 1]! + limit)
  return beats.map((time, i) => time + (forward[i]! + backward[i]!) / 2)
}

/**
 * Stretches where the beats still sit consistently off the attacks after the refinement (whose moves are capped at
 * 50 ms from the tracker): at least 8 beats in a row whose two-bar averaged attack profile, looked at wider (up to
 * 150 ms or 30 % of a beat each side, so the next 16th isn't reached), has one clear peak (prominence ≥ 0.6, no rival
 * ≥ 75 %) more than 25 ms from the beat, all within 15 ms of the stretch's median. Returns the stretches with that
 * median offset.
 */
function driftedStretches(beats: number[], onsets: { rise: Float32Array; step: number }) {
  if (beats.length < 8) return []
  const gap = median(beats.slice(1).map((time, i) => time - beats[i]!))
  const profiles = beatProfiles(beats, onsets, Math.min(0.15, 0.3 * gap))
  const offset = profiles.map((profile) => (profile.prominence >= 0.6 && profile.rival < 0.75 && Math.abs(profile.shift) > 0.025 ? profile.shift : NaN))
  const stretches: Array<{ from: number; to: number; shift: number }> = []
  for (let i = 0; i < beats.length; ) {
    if (Number.isNaN(offset[i]!)) {
      i++
      continue
    }
    let j = i + 1
    while (j < beats.length && !Number.isNaN(offset[j]!) && Math.abs(offset[j]! - median(offset.slice(i, j))) <= 0.015) j++
    const shift = median(offset.slice(i, j))
    if (j - i >= 8 && offset.slice(i, j).every((value) => Math.abs(value - shift) <= 0.015)) stretches.push({ from: i, to: j, shift })
    i = j
  }
  return stretches
}

/**
 * Moves drifted stretches (see driftedStretches) onto their attacks: the stretch's offset, eased in and out at up to
 * 25 ms a beat (so the bars around it stay within a few percent), on top of the per-beat refinement.
 */
function reanchor(beats: number[], stretches: Array<{ from: number; to: number; shift: number }>) {
  if (!stretches.length) return beats
  const target = new Array(beats.length).fill(0) as number[]
  for (const stretch of stretches) for (let i = stretch.from; i < stretch.to; i++) target[i] = stretch.shift
  const limit = 0.025
  const forward = [...target]
  for (let i = 1; i < forward.length; i++) forward[i] = clamp(forward[i]!, forward[i - 1]! - limit, forward[i - 1]! + limit)
  const backward = [...target]
  for (let i = backward.length - 2; i >= 0; i--) backward[i] = clamp(backward[i]!, backward[i + 1]! - limit, backward[i + 1]! + limit)
  // The stretches themselves move fully; around them the two easings meet.
  return beats.map((time, i) => time + (target[i] ? target[i]! : (forward[i]! + backward[i]!) / 2))
}

/**
 * Evens out stretches where the tracker squeezed or stretched beats while the music kept its tempo: 4 gaps in a row
 * whose mean is more than 5 % off the steady tempo around them, or 8 more than 3 % (the 16 gaps each side vary under
 * 3 %, and the tempo before and after agrees within 2 %). Syncopated stabs or a riff ahead of the beat (an intro) can pull the
 * tracker's beats that way. The stretch is laid out again with as many even beats as the steady tempo fits between
 * its ends (a beat the tracker added or dropped is undone); the onset refinement then puts them on the attacks.
 */
function steadyBeats(beats: number[]): number[] {
  if (beats.length < 24) return beats
  const gaps = beats.slice(1).map((time, i) => time - beats[i]!)
  const bad = new Array(gaps.length).fill(false) as boolean[]
  const reference = new Array(gaps.length).fill(0) as number[]
  // Four gaps more than 5 % off, or eight gaps more than 3 % off (a slower smear that adds up just as much).
  for (const [width, limit] of [[4, 0.05], [8, 0.03]] as const) {
    for (let i = 0; i + width <= gaps.length; i++) {
      const before = gaps.slice(Math.max(0, i - 16), i)
      const after = gaps.slice(i + width, i + width + 16)
      if (before.length < 6 || after.length < 6) continue
      const around = [...before, ...after]
      const ref = median(around)
      if (median(around.map((gap) => Math.abs(gap - ref))) / ref > 0.03) continue
      if (Math.abs(median(before) / median(after) - 1) > 0.02) continue
      if (Math.abs(mean(gaps.slice(i, i + width)) / ref - 1) > limit) {
        for (let k = i; k < i + width; k++) {
          bad[k] = true
          reference[k] = ref
        }
      }
    }
  }
  let out = [...beats]
  for (let i = gaps.length - 1; i >= 0; ) {
    if (!bad[i]) {
      i--
      continue
    }
    let j = i
    while (j > 0 && bad[j - 1]) j--
    // Gaps j..i are off: beats j..i+1 bound the stretch.
    const ref = median(reference.slice(j, i + 1))
    const start = out[j]!
    const end = out[i + 1]!
    const span = (end - start) / ref
    const whole = Math.round(span)
    if (Math.abs(span - whole) > 0.25 && j <= 16) {
      // Not a whole number of beats: the tracker changed phase across it (an intro's syncopation pulled it onto the
      // off-beats). A short stretch at the start (up to 16 beats) takes the steady grid that follows, counted back.
      const first = out[0]! - ref / 2
      const before: number[] = []
      for (let time = end - ref; time >= Math.max(0, first); time -= ref) before.unshift(time)
      out = [...before, ...out.slice(i + 1)]
    } else if (Math.abs(span - whole) > 0.25 && out.length - 1 - (i + 1) <= 16) {
      // The same at the end: the steady grid before it, counted on.
      const last = out[out.length - 1]! + ref / 2
      const after: number[] = []
      for (let time = start + ref; time <= last; time += ref) after.push(time)
      out = [...out.slice(0, j + 1), ...after]
    } else {
      const count = Math.max(1, whole)
      const even = Array.from({ length: count - 1 }, (_, k) => start + ((end - start) * (k + 1)) / count)
      out = [...out.slice(0, j + 1), ...even, ...out.slice(i + 1)]
    }
    i = j - 1
  }
  return out
}

/**
 * Beats by dynamic programming (Ellis 2007, as librosa does it): every frame's best score is its onset strength plus
 * the best earlier beat's score, less a penalty for a gap unlike the period (log-squared, so the beat may drift a little
 * with the music but not jump). The chain is read back from the last strong frame; weak beats at the ends (silence,
 * a fade) are dropped.
 */
function trackBeats(envelope: Float64Array, period: number): number[] {
  const count = envelope.length
  if (count < period * 4) return []
  const tightness = 400
  const score = new Float64Array(count)
  const back = new Int32Array(count).fill(-1)
  const from = Math.round(2 * period)
  const to = Math.max(1, Math.round(period / 2))
  for (let t = 0; t < count; t++) {
    let best = -Infinity
    let at = -1
    for (let tau = Math.max(0, t - from); tau <= t - to; tau++) {
      const value = score[tau]! - tightness * Math.log((t - tau) / period) ** 2
      if (value > best) {
        best = value
        at = tau
      }
    }
    score[t] = envelope[t]! + (at >= 0 ? best : 0)
    back[t] = at
  }
  // The last beat: the last local maximum of the score that is above half the typical maximum.
  const peaks: number[] = []
  for (let t = 1; t < count - 1; t++) if (score[t]! > score[t - 1]! && score[t]! >= score[t + 1]!) peaks.push(t)
  if (!peaks.length) return []
  const typical = median(peaks.map((t) => score[t]!))
  let last = peaks[peaks.length - 1]!
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (score[peaks[i]!]! >= 0.5 * typical) {
      last = peaks[i]!
      break
    }
  }
  const beats: number[] = []
  for (let t = last; t >= 0; t = back[t]!) beats.unshift(t)
  // Trim weak beats at both ends (smoothed onset strength under half its root mean square).
  const strength = beats.map((t) => {
    let sum = 0
    for (let i = -2; i <= 2; i++) sum += (envelope[t + i] ?? 0) * (0.5 + 0.5 * Math.cos((Math.PI * i) / 3))
    return sum
  })
  const threshold = 0.5 * Math.sqrt(mean(strength.map((value) => value * value)))
  let first = 0
  let end = beats.length
  while (first < end && strength[first]! < threshold) first++
  while (end > first && strength[end - 1]! < threshold) end--
  return beats.slice(first, end)
}

// ---- 3. bars ----

/**
 * Which beats start a bar (4/4): a Viterbi pass over the beats with the position in the bar as its state. A downbeat
 * is where chords change, the kick lands and sections begin; the count runs on steadily, and only a clear, lasting
 * reason (a 2/4 bar, a beat the tracker missed) makes it skip.
 */
function findDownbeats(beatStrength: number[]): number[] {
  const count = beatStrength.length
  if (!count) return []
  const states = 4
  const jump = 15
  let scores = [beatStrength[0]!, 0, 0, 0]
  const back: Int8Array[] = []
  for (let k = 1; k < count; k++) {
    const next = new Array(states).fill(-Infinity) as number[]
    const from = new Int8Array(states)
    for (let to = 0; to < states; to++) {
      for (let s = 0; s < states; s++) {
        const value = scores[s]! - ((s + 1) % states === to ? 0 : jump)
        if (value > next[to]!) {
          next[to] = value
          from[to] = s
        }
      }
      if (to === 0) next[0] = next[0]! + beatStrength[k]!
    }
    back.push(from)
    scores = next
  }
  let state = scores.indexOf(Math.max(...scores))
  const positions = new Array(count).fill(0) as number[]
  for (let k = count - 1; k >= 0; k--) {
    positions[k] = state
    if (k) state = back[k - 1]![state]!
  }
  return positions.flatMap((position, k) => (position === 0 ? [k] : []))
}

// ---- helpers over spans of frames ----

/** Mean of a per-frame curve between two times. */
function spanMean(curve: ArrayLike<number>, frameRate: number, offset: number, start: number, end: number) {
  const from = clamp(Math.floor((start - offset) * frameRate), 0, curve.length)
  const to = clamp(Math.ceil((end - offset) * frameRate), from + 1, curve.length)
  return from < curve.length ? mean(curve, from, to) : 0
}

/** Mean vector of `width`-long frames between two frame indices. */
function spanVector(frames: Float32Array, width: number, from: number, to: number) {
  const out = new Float64Array(width)
  const count = Math.max(0, to - from)
  for (let f = from; f < to; f++) for (let c = 0; c < width; c++) out[c] += frames[f * width + c]!
  if (count) for (let c = 0; c < width; c++) out[c] = out[c]! / count
  return out
}

// ---- 4. self-similarity, novelty, phrases ----

/** Bar-by-bar similarity: harmony (chroma) and sound (timbre, loudness, bass) alike, each 0–1. */
function similarityMatrix(chroma: Float64Array[], timbre: Float64Array[]) {
  const count = chroma.length
  const matrix = Array.from({ length: count }, () => new Float64Array(count))
  for (let i = 0; i < count; i++) {
    for (let j = i; j < count; j++) {
      const value = 0.5 * cosine(chroma[i]!, chroma[j]!) + 0.5 * (0.5 + 0.5 * cosine(timbre[i]!, timbre[j]!))
      matrix[i]![j] = value
      matrix[j]![i] = value
    }
  }
  return matrix
}

/** Foote novelty: a checkerboard kernel (Gaussian tapered, `half` bars each side) slid along the diagonal. */
function novelty(matrix: Float64Array[], half: number) {
  const count = matrix.length
  const out = new Float64Array(count + 1)
  for (let j = 1; j < count; j++) {
    let sum = 0
    let weight = 0
    for (let a = -half; a < half; a++) {
      for (let b = -half; b < half; b++) {
        const i1 = j + a
        const i2 = j + b
        if (i1 < 0 || i2 < 0 || i1 >= count || i2 >= count) continue
        const taper = Math.exp(-(((a + 0.5) / half) ** 2 + ((b + 0.5) / half) ** 2) * 2)
        const sign = a < 0 === b < 0 ? 1 : -1
        sum += sign * taper * matrix[i1]![i2]!
        weight += taper
      }
    }
    out[j] = weight ? sum / weight : 0
  }
  return out
}

/** How a phrase length is liked: 8 bars is the norm, 16 and 4 common, other lengths only where the music says so. */
const PHRASE_COST: Record<number, number> = { 8: 0, 16: -0.6, 4: -0.8, 12: -1.6, 2: -2.2, 6: -2.2 }

/**
 * Phrase starts (bar indices) by dynamic programming over the bars: each start earns the novelty there, each phrase
 * pays for an unusual length. The first phrase may be any length up to 8 (a pickup, a short intro); the last one ends
 * where the bars do.
 */
function findPhrases(boundary: number[], bars: number) {
  if (bars <= 0) return [0]
  const best = new Float64Array(bars + 1).fill(-Infinity)
  const back = new Int32Array(bars + 1).fill(-1)
  best[0] = 0
  for (let j = 1; j <= bars; j++) {
    const reward = j < bars ? boundary[j]! : 0
    for (const [length, cost] of Object.entries(PHRASE_COST)) {
      const i = j - Number(length)
      if (i >= 0 && best[i]! + cost + reward > best[j]!) {
        best[j] = best[i]! + cost + reward
        back[j] = i
      }
    }
    // A first phrase of any length up to 8 (or a last one of any length up to 16).
    if (j <= 8 && -1 + reward > best[j]!) {
      best[j] = -1 + reward
      back[j] = 0
    }
    if (j === bars) {
      for (let i = Math.max(0, bars - 16); i < bars; i++) {
        if (best[i]! > -Infinity && best[i]! - 0.5 > best[j]!) {
          best[j] = best[i]! - 0.5
          back[j] = i
        }
      }
    }
  }
  const starts: number[] = []
  for (let j = back[bars]!; j >= 0; j = j === 0 ? -1 : back[j]!) starts.unshift(j)
  if (starts[0] !== 0) starts.unshift(0)
  return [...new Set(starts)]
}

// ---- 6. vocals ----

/**
 * Where a voice seems to be, per curve frame (standard units), from a stereo track: the vocal band's (300–3000 Hz)
 * power in the middle of the stereo image against its power at the sides. Lead vocals are mixed to the centre, most
 * instruments are spread; so the ratio rises where someone sings. Null for mono tracks (no sides to compare with).
 * Measured against synced lyrics it separates sung from unsung moments clearly better than chance (area under the
 * curve about 0.75) but not reliably enough to stand alone: it places lyrics, it doesn't replace them.
 */
function vocalActivity(spectra: ShortSpectra, frames: number): Float64Array | null {
  const { centre, side } = spectra
  if (!side) return null
  let centreTotal = 0
  let sideTotal = 0
  for (let i = 0; i < spectra.count; i++) {
    centreTotal += centre[i]!
    sideTotal += side[i]!
  }
  // (Almost) nothing at the sides: a mono recording in a stereo file.
  if (sideTotal < centreTotal * 0.005) return null
  const out = new Float64Array(frames)
  const counts = new Float64Array(frames)
  for (let i = 0; i < spectra.count; i++) {
    const f = Math.min(frames - 1, Math.floor(spectra.time(i) * CURVE_RATE))
    out[f] += Math.log(centre[i]! + 1e-9) - Math.log(side[i]! + 1e-9)
    counts[f]++
  }
  for (let f = 0; f < frames; f++) out[f] = counts[f] ? out[f]! / counts[f]! : f ? out[f - 1]! : 0
  return Float64Array.from(zscores(smooth(out, CURVE_RATE / 2)))
}

/**
 * Sung stretches from synced lyrics. A line's end isn't known: it runs until shortly before the next line, at most as
 * long as its words take (about 3 a second, at least 1.5 s) and at most 1.25 times the song's typical line (the median
 * distance between line starts, within 2–8 s), so a last line before a long instrumental doesn't swallow it.
 */
export function lyricStretches(lines: LyricLine[]): Array<{ start: number; end: number }> {
  const sung = lines
    .filter((line) => Number.isFinite(line.time) && line.time >= 0)
    .sort((a, b) => a.time - b.time)
    .map((line) => ({ time: line.time, words: (line.text.match(/[\p{L}\p{N}']+/gu) ?? []).length }))
  const gaps = sung.flatMap((line, i) => (line.words && sung[i + 1] && sung[i + 1]!.time - line.time < 12 ? [sung[i + 1]!.time - line.time] : []))
  const longest = clamp(1.25 * (gaps.length ? median(gaps) : 4), 2, 8)
  const stretches: Array<{ start: number; end: number }> = []
  for (let i = 0; i < sung.length; i++) {
    const line = sung[i]!
    // Empty lines (and "♪") mark instrumental parts.
    if (!line.words) continue
    const next = sung[i + 1]?.time ?? Infinity
    // About 3 words a second, at least a second and a half, at most 8.
    const takes = Math.min(longest, clamp(0.8 + line.words * 0.35, 1.5, 8))
    const end = Math.min(next - 0.15, line.time + takes)
    if (end <= line.time) continue
    const previous = stretches[stretches.length - 1]
    if (previous && line.time - previous.end < 1.2) previous.end = Math.max(previous.end, end)
    else stretches.push({ start: line.time, end })
  }
  return stretches
}

/**
 * How the lyrics' sung stretches, moved by a number of frames, correlate with the vocal activity (Pearson over the
 * song's frames; outside the stretches: not sung). The activity is in standard units already (mean 0, deviation 1),
 * which leaves this.
 */
function sungCorrelation(stretches: Array<{ start: number; end: number }>, activity: Float64Array) {
  const rate = CURVE_RATE
  const frames = activity.length
  const span = Math.ceil(stretches[stretches.length - 1]!.end * rate) + 1
  const lyric = new Uint8Array(span)
  for (const stretch of stretches) for (let f = Math.max(0, Math.floor(stretch.start * rate)); f < Math.min(span, Math.ceil(stretch.end * rate)); f++) lyric[f] = 1
  return (shift: number) => {
    let sum = 0
    let count = 0
    for (let f = Math.max(0, shift); f < Math.min(frames, span + shift); f++) {
      if (lyric[f - shift]) {
        sum += activity[f]!
        count++
      }
    }
    const share = count / frames
    return share > 0 && share < 1 ? sum / frames / Math.sqrt(share * (1 - share)) : 0
  }
}

/** Where lyrics might belong on the audio: an offset (seconds) and how well the sung stretches fit there (0–1). */
interface Placement {
  offset: number
  fit: number
}

/**
 * Where lyrics might belong on the audio: staying where they are, and the offsets (up to a quarter of the song, at
 * most a minute, either way; the lyrics must stay within the song) at which their sung stretches correlate best with
 * the vocal activity, best first and at least 3 seconds apart. Empty when they can't fit in the song at all. Without
 * a stereo image (no activity) only staying is offered.
 */
function lyricsPlacements(stretches: Array<{ start: number; end: number }>, activity: Float64Array | null, duration: number): Placement[] {
  const first = stretches[0]!.start
  const last = stretches[stretches.length - 1]!.end
  if (last - first > duration + 2) return []
  const rate = CURVE_RATE
  const fits = (shift: number) => first + shift / rate > -1 && last + shift / rate < duration + 2
  if (!activity) return fits(0) ? [{ offset: 0, fit: 0 }] : []
  const reach = Math.round(Math.min(60, duration / 4) * rate)
  const correlation = sungCorrelation(stretches, activity)
  const shifts: number[] = []
  for (let shift = -reach; shift <= reach; shift++) if (fits(shift)) shifts.push(shift)
  const scores = shifts.map(correlation)
  const placements: Placement[] = fits(0) ? [{ offset: 0, fit: correlation(0) }] : []
  // The best local maxima, each at least 3 seconds from the ones taken.
  const peaks = shifts.map((shift, i) => ({ shift, value: scores[i]! })).filter((_, i) => (i === 0 || scores[i]! >= scores[i - 1]!) && (i === scores.length - 1 || scores[i]! >= scores[i + 1]!))
  peaks.sort((a, b) => b.value - a.value)
  for (const peak of peaks) {
    if (placements.length >= 4) break
    if (placements.every((placement) => Math.abs(placement.offset * rate - peak.shift) > 3 * rate)) placements.push({ offset: peak.shift / rate, fit: peak.value })
  }
  return placements
}

/**
 * Whether lyrics belong to this song at all: lines with the same words (the chorus) should sound alike where they are
 * sung, more than lines with different words do. That difference is compared with the same lines' words shuffled (a
 * fixed shuffle, so the answer is always the same) as a standard score; null when too few lines repeat to tell.
 * Lyrics of another song repeat where this one doesn't, and score around 0; this song's lyrics score 3 to 17.
 */
function repetitionScore(lines: LyricLine[], offset: number, sound: (time: number) => Float64Array | null): number | null {
  const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const vectors: Float64Array[] = []
  const texts: string[] = []
  for (const line of lines) {
    const text = normal(line.text)
    const vector = text ? sound(line.time + offset) : null
    if (!vector) continue
    vectors.push(vector)
    texts.push(text)
  }
  if (vectors.length < 6) return null
  const count = vectors.length
  const similarity = vectors.map((a) => Float64Array.from(vectors, (b) => cosine(a, b)))
  const difference = (order: string[]) => {
    let same = 0
    let sameCount = 0
    let other = 0
    let otherCount = 0
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (order[i] === order[j]) {
          same += similarity[i]![j]!
          sameCount++
        } else {
          other += similarity[i]![j]!
          otherCount++
        }
      }
    }
    return sameCount >= 3 && otherCount ? same / sameCount - other / otherCount : null
  }
  const real = difference(texts)
  if (real === null) return null
  let seed = 12345
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const nulls: number[] = []
  for (let round = 0; round < 100; round++) {
    const shuffled = [...texts]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    const value = difference(shuffled)
    if (value !== null) nulls.push(value)
  }
  if (nulls.length < 20) return null
  const m = mean(nulls)
  const sd = Math.sqrt(mean(nulls.map((value) => (value - m) ** 2))) || 1e-9
  return (real - m) / sd
}

// ---- the analysis ----

/**
 * Analyses a whole song: its samples at `rate`, mono or as stereo channels (left, right; the stereo image helps find
 * the voice), with its synced lyrics when there are any. Null when there is too little (under 20 seconds) or only
 * silence.
 */
export function analyzeMix(audio: Float32Array | Float32Array[], rate: number, lyrics?: LyricLine[]): TrackMix | null {
  const channels = audio instanceof Float32Array ? [audio] : audio
  if (!channels.length || channels.some((channel) => channel.length !== channels[0]!.length)) return null
  // Everything but the voice is measured on the mono mix (the centre); the sides only for the voice.
  // (Plain loops: from() over a typed array would first make a list of every sample on the heap.)
  let samples = channels[0]!
  let sides: Float32Array | null = null
  if (channels.length >= 2) {
    const [left, right] = [channels[0]!, channels[1]!]
    samples = new Float32Array(left.length)
    sides = new Float32Array(left.length)
    for (let i = 0; i < left.length; i++) {
      samples[i] = (left[i]! + right[i]!) / 2
      sides[i] = (left[i]! - right[i]!) / 2
    }
  }
  const duration = samples.length / rate
  if (duration < 20) return null
  let power = 0
  for (const sample of samples) power += sample * sample
  const rms = Math.sqrt(power / samples.length)
  if (rms < 1e-4) return null

  // ---- 1. spectra and curves ----
  const spectra = shortSpectra(samples, rate, sides)
  const chroma = chromagram(samples, rate)
  const frameRate = spectra.rate
  const firstTime = spectra.time(0)

  // The curves at 10 frames a second: energy from the samples themselves, bands from the spectra (amplitude, the
  // square root of the power, so quiet parts still show).
  // As many frames as the duration given out (rounded to 10 ms) holds, so the curves and `duration` agree.
  const curveFrames = Math.ceil(round(duration, 2) * CURVE_RATE - 1e-6)
  const energyCurve = new Float64Array(curveFrames)
  const blockSize = rate / CURVE_RATE
  for (let f = 0; f < curveFrames; f++) {
    const from = Math.floor(f * blockSize)
    const to = Math.min(samples.length, Math.floor((f + 1) * blockSize))
    let sum = 0
    for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!
    energyCurve[f] = to > from ? Math.sqrt(sum / (to - from)) : 0
  }
  const bandCurve = (band: Float64Array) => {
    const out = new Float64Array(curveFrames)
    const counts = new Float64Array(curveFrames)
    for (let i = 0; i < spectra.count; i++) {
      const f = Math.min(curveFrames - 1, Math.floor(spectra.time(i) * CURVE_RATE))
      out[f] += band[i]!
      counts[f]++
    }
    for (let f = 0; f < curveFrames; f++) out[f] = counts[f] ? Math.sqrt(out[f]! / counts[f]!) : f ? out[f - 1]! : 0
    // Frames before the first spectrum's centre take the first value.
    const firstFull = counts.findIndex((value) => value > 0)
    for (let f = 0; f < firstFull; f++) out[f] = out[firstFull]!
    return out
  }
  const lowCurve = bandCurve(spectra.low)
  const midCurve = bandCurve(spectra.mid)
  const highCurve = bandCurve(spectra.high)
  const normalised = (curve: Float64Array) => {
    let max = 0
    for (const value of curve) max = Math.max(max, value)
    return Array.from(curve, (value) => (max ? round(value / max) : 0))
  }
  const energy = normalised(energyCurve)
  const bands = { low: normalised(lowCurve), mid: normalised(midCurve), high: normalised(highCurve) }
  // For decisions: levels relative to the loud parts of the song (its 95th percentile), so one peak doesn't skew them.
  const relative = (curve: Float64Array) => {
    const top = quantile(curve, 0.95) || 1
    return Float64Array.from(curve, (value) => value / top)
  }
  const level = relative(energyCurve)
  const lowLevel = relative(lowCurve)
  const highLevel = relative(highCurve)
  const levelAt = (curve: Float64Array, start: number, end: number) => spanMean(curve, CURVE_RATE, 0, start, end)

  // ---- 2. tempo and beats ----
  const envelope = onsetEnvelope(spectra.flux, frameRate)
  const lowEnvelope = onsetEnvelope(spectra.lowFlux, frameRate)
  const tempo = estimateTempo(envelope, frameRate)
  const beatFrames = trackBeats(envelope, tempo.period)
  // Between frames: the onset peak's top by parabolic interpolation (frames are 23 ms apart); squeezed or stretched
  // stretches evened out (see steadyBeats); then onto the audible attacks.
  const rawBeats = beatFrames.map((frame) => {
    const left = envelope[frame - 1] ?? 0
    const centre = envelope[frame]!
    const right = envelope[frame + 1] ?? 0
    const curvature = left - 2 * centre + right
    const shift = centre >= left && centre >= right && curvature < 0 ? clamp((left - right) / (2 * curvature), -0.5, 0.5) : 0
    return spectra.time(frame + shift) + BEAT_DELAY
  })
  const trackedBeats = steadyBeats(rawBeats)
  // Twice: the second pass looks around the corrected beats (a large first correction leaves attacks at the window's
  // edge out of the first look).
  const onsets = fineOnsets(samples, rate)
  // (Never more than 50 ms from where the tracker put them, in all, except where a whole stretch drifted off its
  // attacks: there it is re-anchored first, and the refinement works from there.)
  const accents = fineOnsets(samples, rate, 1500, 5000)
  const refined = onAudibleOnsets(onAudibleOnsets(trackedBeats, onsets, accents), onsets, accents).map((time, i) => clamp(time, trackedBeats[i]! - 0.05, trackedBeats[i]! + 0.05))
  const drifted = driftedStretches(refined, onsets)
  const anchored = reanchor(refined, drifted)
  const beats = drifted.length ? onAudibleOnsets(anchored, onsets, accents).map((time, i) => clamp(time, anchored[i]! - 0.05, anchored[i]! + 0.05)) : refined
  // The tempo the beats keep: a line through beat number and time (robust to a drifting or missed beat in between).
  let bpm = (60 * frameRate) / tempo.period
  if (beats.length >= 8) {
    const gaps = beats.slice(1).map((time, i) => time - beats[i]!)
    const typical = median(gaps)
    const steady = gaps.filter((gap) => Math.abs(gap / typical - 1) < 0.1)
    if (steady.length >= gaps.length * 0.6) {
      // Least squares over the beats, numbered by how many typical gaps lie between them (a missed beat counts two).
      const index = [0]
      for (const gap of gaps) index.push(index[index.length - 1]! + Math.max(1, Math.round(gap / typical)))
      const mi = mean(index)
      const mt = mean(beats)
      let num = 0
      let den = 0
      for (let i = 0; i < beats.length; i++) {
        num += (index[i]! - mi) * (beats[i]! - mt)
        den += (index[i]! - mi) ** 2
      }
      if (den > 0 && num > 0) bpm = 60 / (num / den)
    } else bpm = 60 / typical
  }
  while (bpm > 200) bpm /= 2
  while (bpm < 60) bpm *= 2
  // How sure: the beat is periodic, the same through the song, and the beats sit on onsets.
  const onBeat = beatFrames.length ? mean(beatFrames.map((frame) => Math.max(envelope[frame - 1] ?? 0, envelope[frame]!, envelope[frame + 1] ?? 0))) : 0
  const alignment = clamp((onBeat / (mean(envelope) || 1) - 1) / 4)
  const periodicity = clamp((tempo.strength - 0.15) / 0.35)
  const coverage = beats.length ? clamp((beats[beats.length - 1]! - beats[0]!) / duration / 0.7) : 0
  const tempoConfidence = Math.sqrt(periodicity * tempo.stability) * alignment * coverage

  // ---- 6 (before the bars: sung lines start them, and the structure uses them). vocals ----
  const spectraFrame = (time: number) => clamp(Math.round((time - firstTime) * frameRate), 0, spectra.count)
  // What a moment sounds like, for telling whether repeated lyrics lines sound alike: timbre and band levels over the
  // 2.5 seconds after it, each in standard units over the song.
  const soundDims = TIMBRE_COEFFS + 3
  const soundFrames = Float32Array.from({ length: spectra.count * soundDims }, (_, n) => {
    const frame = Math.floor(n / soundDims)
    const d = n % soundDims
    if (d < TIMBRE_COEFFS) return spectra.timbre[frame * TIMBRE_COEFFS + d]!
    const band = d === TIMBRE_COEFFS ? spectra.low : d === TIMBRE_COEFFS + 1 ? spectra.mid : spectra.high
    return Math.log(band[frame]! + 1e-9)
  })
  const soundMean = spanVector(soundFrames, soundDims, 0, spectra.count)
  const soundSd = new Float64Array(soundDims)
  for (let frame = 0; frame < spectra.count; frame++) for (let d = 0; d < soundDims; d++) soundSd[d] += (soundFrames[frame * soundDims + d]! - soundMean[d]!) ** 2
  for (let d = 0; d < soundDims; d++) soundSd[d] = Math.sqrt(soundSd[d]! / Math.max(1, spectra.count)) || 1
  const soundAt = (time: number) => {
    const from = spectraFrame(time)
    const to = spectraFrame(time + 2.5)
    if (time < 0 || to - from < frameRate) return null
    return spanVector(soundFrames, soundDims, from, to).map((value, d) => (value - soundMean[d]!) / soundSd[d]!)
  }
  const activity = vocalActivity(spectra, curveFrames)
  let vocals: Array<{ start: number; end: number }> = []
  /** The same stretches unpadded: for telling the structure (how much of a phrase is sung), where padding would blur it. */
  let sungStretches: Array<{ start: number; end: number }> = []
  let vocalSource: TrackMix['vocalSource'] = 'none'
  /** The sung lyrics lines at their aligned times, with how often their words come in the song (the chorus' often). */
  let lyricLines: Array<{ time: number; count: number }> = []
  const usable = (lyrics ?? []).filter((line) => Number.isFinite(line.time) && line.time >= 0 && typeof line.text === 'string').sort((a, b) => a.time - b.time)
  const stretches = lyricStretches(usable)
  if (usable.length >= 4 && stretches.length) {
    // Each place the lyrics might belong is scored by how well their repeated lines sound alike there and how well the
    // stretches fit the vocal activity; staying where they are gets a head start (synced lyrics are usually timed to
    // this very recording). Lyrics whose repeated lines don't sound alike anywhere belong to another song or version.
    // Lyrics without repeated lines can't be checked that way: they are kept where they are, unless the activity
    // clearly says otherwise.
    const placed = lyricsPlacements(stretches, activity, duration).map((placement) => {
      const repetition = repetitionScore(usable, placement.offset, soundAt)
      return { ...placement, repetition, score: (repetition ?? 0) + 10 * placement.fit + (placement.offset === 0 ? 1.5 : 0) }
    })
    placed.sort((a, b) => b.score - a.score)
    const stay = placed.find((placement) => placement.offset === 0)
    const best = placed[0]
    // Moving lyrics takes more than keeping them where they are: their repeated lines must sound clearly alike there,
    // and the vocal activity must agree it is a better place. When no placement shows repeated lines sounding alike
    // at all (a rap whose hook comes back over another beat), staying is fine if the stretches fit the activity well
    // right here and nowhere better. Thresholds from 11 songs, each with its own and every other one's lyrics.
    const stayFits = !!stay && stay.fit >= 0.3 && placed.every((placement) => placement.fit <= stay.fit + 0.02 && (placement.repetition ?? 0) < 2)
    let offset: number | null = null
    if (best && best.repetition === null) offset = stay && placed.every((placement) => placement.fit <= stay.fit + 0.1) ? 0 : null
    // Staying with moderate repetition evidence is fine too when staying is the best place on both counts (its
    // repeated lines sound most alike there, and its stretches fit the activity best there): a chorus sung once over
    // a breakdown and once over the drop sounds less alike, but nowhere else fits better.
    const stayBest = !!stay && stay.fit >= 0.2 && (stay.repetition ?? -Infinity) >= 3 && placed.every((placement) => placement.fit <= stay.fit && (placement.repetition ?? -Infinity) <= stay.repetition!)
    if (best && best.repetition === null) offset = stay && placed.every((placement) => placement.fit <= stay.fit + 0.1) ? 0 : null
    else if (best && best.offset === 0) offset = best.repetition! >= 4 || stayFits || stayBest ? 0 : null
    else if (best) offset = best.repetition! >= 5 && best.fit >= 0.2 && best.fit >= (stay?.fit ?? -1) + 0.08 ? best.offset : stayFits ? 0 : null
    if (offset !== null) {
      // Padded by how far they may be off (see TrackMix.vocals): a beat for lyrics kept where they were timed, two
      // seconds for lyrics that had to be moved; stretches that then touch are merged.
      const pad = offset === 0 ? Math.max(0.5, 60 / bpm) : 2
      sungStretches = stretches.map((stretch) => ({ start: clamp(stretch.start + offset, 0, duration), end: clamp(stretch.end + offset, 0, duration) }))
      vocals = []
      for (const stretch of stretches) {
        const start = clamp(stretch.start + offset - pad, 0, duration)
        const end = clamp(stretch.end + offset + pad, 0, duration)
        if (end - start <= 0.3) continue
        const previous = vocals[vocals.length - 1]
        if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
        else vocals.push({ start, end })
      }
      vocalSource = 'lyrics'
      // Counted without what is in brackets (backing vocals, ad-libs), so "Don't show up (don't show up)" is the line.
      const normal = (text: string) => text.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      const counts = new Map<string, number>()
      for (const line of usable) if (normal(line.text)) counts.set(normal(line.text), (counts.get(normal(line.text)) ?? 0) + 1)
      lyricLines = usable.filter((line) => normal(line.text)).map((line) => ({ time: line.time + offset, count: counts.get(normal(line.text))! }))
    }
  }
  // ---- 3. per beat: chroma, timbre, loudness; then the bars ----
  const beatPeriod = 60 / bpm
  const beatEnds = beats.map((time, i) => beats[i + 1] ?? time + beatPeriod)
  const chromaFrame = (time: number) => clamp(Math.round((time - chroma.time(0)) * chroma.rate), 0, chroma.count)
  const beatChroma = beats.map((time, i) => spanVector(chroma.frames, 12, chromaFrame(time), Math.max(chromaFrame(time) + 1, chromaFrame(beatEnds[i]!))))
  const beatLevel = beats.map((time, i) => levelAt(level, time, beatEnds[i]!))
  // Downbeat evidence per beat, each in standard units: chords changing (the bar after against the bar before: chords
  // change on beat 1 more than on beat 3; and the two beats around, which also catch a change on beat 3), the kick
  // (on 1 and 3, the snare on 2 and 4: this tells the half-bar), loudness changing, sections starting (novelty of the
  // beat-by-beat self-similarity, 4 bars each side), and sung lines starting (on or just before beat 1).
  const window = (from: number, to: number) => {
    const sum = new Float64Array(12)
    for (let k = Math.max(0, from); k < Math.min(beats.length, to); k++) for (let c = 0; c < 12; c++) sum[c] += beatChroma[k]![c]!
    return sum
  }
  const harmonyBar = beats.map((_, i) => (i < 4 || i + 4 > beats.length ? 0 : 1 - cosine(window(i - 4, i), window(i, i + 4))))
  const harmonyHalf = beats.map((_, i) => (i < 2 || i + 2 > beats.length ? 0 : 1 - cosine(window(i - 2, i), window(i, i + 2))))
  const kickAt = beats.map((time) => clamp(Math.round((time - BEAT_DELAY - firstTime) * frameRate), 1, envelope.length - 3)).map((frame) => Math.max(lowEnvelope[frame - 1] ?? 0, lowEnvelope[frame]!, lowEnvelope[frame + 1] ?? 0, lowEnvelope[frame + 2] ?? 0))
  // The kick tells only the half-bar: whether a beat is 1 or 3 rather than 2 or 4, not which of 1 and 3.
  const kick = beats.map((_, i) => (kickAt[i] ?? 0) + (kickAt[i + 2] ?? 0) - (kickAt[i + 1] ?? 0) - (kickAt[i + 3] ?? 0))
  const loudnessChange = beats.map((_, i) => Math.abs(Math.log((mean(beatLevel, i, Math.min(beats.length, i + 4)) + 0.01) / (mean(beatLevel, Math.max(0, i - 4), i) + 0.01))))
  const beatTimbre = beats.map((time, i) => spanVector(spectra.timbre, TIMBRE_COEFFS, spectraFrame(time), Math.max(spectraFrame(time) + 1, spectraFrame(beatEnds[i]!))))
  const timbreColumns = Array.from({ length: TIMBRE_COEFFS }, (_, d) => zscores(beatTimbre.map((vector) => vector[d]!)))
  const sectionChange = Array.from(novelty(similarityMatrix(beatChroma, beats.map((_, i) => Float64Array.from({ length: TIMBRE_COEFFS }, (_, d) => timbreColumns[d]![i]!))), 16)).slice(0, beats.length)
  // (on beat 1, or on the pickup the beat before it)
  const lineStarts = beats.map((time) => lyricLines.filter((line) => line.time >= time - 1.25 * beatPeriod && line.time < time + 0.25 * beatPeriod).length)
  const evidence = {
    harmonyBar: zscores(harmonyBar),
    harmonyHalf: zscores(harmonyHalf),
    kick: zscores(kick),
    loudness: zscores(loudnessChange),
    sections: zscores(sectionChange),
    lines: lyricLines.length ? zscores(lineStarts) : beats.map(() => 0),
  }
  const downbeatEvidence = beats.map((_, i) => evidence.harmonyBar[i]! + 0.5 * evidence.harmonyHalf[i]! + 0.6 * evidence.kick[i]! + 0.4 * evidence.loudness[i]! + 0.5 * evidence.sections[i]! + 0.5 * evidence.lines[i]!)
  const downbeatIndex = findDownbeats(downbeatEvidence)
  // How clear the bar count is: the evidence on the chosen beat 1 against the other beats (beat 3 above all, the
  // half-bar mistake), in standard units. Below half a unit the bars are a guess, and the beat grid's confidence
  // says so (to 50 % when there is no clear evidence at all).
  const positions = new Array(beats.length).fill(0) as number[]
  for (let k = 0, last = -1, next = 0; k < beats.length; k++) {
    if (downbeatIndex[next] === k) {
      last = k
      next++
    }
    positions[k] = last < 0 ? (((k - (downbeatIndex[0] ?? 0)) % 4) + 4) % 4 : (k - last) % 4
  }
  const profile = [0, 1, 2, 3].map((q) => mean(downbeatEvidence.filter((_, k) => positions[k] === q)))
  // Sung lines that mostly start on beat 2 or 3 (not on 1 or its pickup) contradict the count: then it stays a guess.
  const linesAt = [0, 1, 2, 3].map((q) => mean(evidence.lines.filter((_, k) => positions[k] === q)))
  const linesDisagree = lyricLines.length >= 16 && Math.max(linesAt[1]!, linesAt[2]!) >= 0.5 && Math.max(linesAt[1]!, linesAt[2]!) > Math.max(linesAt[0]!, linesAt[3]!) + 0.3
  const countClarity = linesDisagree ? 0.3 : clamp(Math.min(profile[0]! - Math.max(profile[1]!, profile[2]!, profile[3]!), profile[0]! - profile[2]!) / 0.5)
  const bpmConfidence = round(tempoConfidence * (0.5 + 0.5 * countClarity), 2)
  const downbeats = downbeatIndex.map((i) => beats[i]!)

  // ---- 4. per bar: features, self-similarity, novelty, phrases ----
  const barStarts = downbeats
  const barEnd = (b: number) => barStarts[b + 1] ?? Math.min(duration, barStarts[b]! + 4 * beatPeriod)
  const barCount = barStarts.length
  const barChroma: Float64Array[] = []
  const barTimbreRaw: Float64Array[] = []
  const barLevel: number[] = []
  const barLow: number[] = []
  const barHigh: number[] = []
  const barOnsets: number[] = []
  for (let b = 0; b < barCount; b++) {
    const start = barStarts[b]!
    const end = barEnd(b)
    const c = spanVector(chroma.frames, 12, chromaFrame(start), Math.max(chromaFrame(start) + 1, chromaFrame(end)))
    barChroma.push(c)
    barTimbreRaw.push(spanVector(spectra.timbre, TIMBRE_COEFFS, spectraFrame(start), Math.max(spectraFrame(start) + 1, spectraFrame(end))))
    barLevel.push(levelAt(level, start, end))
    barLow.push(levelAt(lowLevel, start, end))
    barHigh.push(levelAt(highLevel, start, end))
    barOnsets.push(spanMean(envelope, frameRate, firstTime, start, end))
  }
  // Timbre per dimension in standard units over the song, with loudness and bass as two more dimensions.
  const dims = TIMBRE_COEFFS + 2
  const columns = Array.from({ length: dims }, (_, d) =>
    zscores(d < TIMBRE_COEFFS ? barTimbreRaw.map((vector) => vector[d]!) : d === TIMBRE_COEFFS ? barLevel.map((value) => Math.log(value + 0.02)) : barLow.map((value) => Math.log(value + 0.02))),
  )
  const barTimbre = barStarts.map((_, b) => Float64Array.from({ length: dims }, (_, d) => columns[d]![b]!))
  const matrix = similarityMatrix(barChroma, barTimbre)
  const structural = novelty(matrix, 8)
  const loudnessStep = barStarts.map((_, b) => (b ? Math.abs(Math.log((mean(barLevel, b, Math.min(barCount, b + 2)) + 0.02) / (mean(barLevel, Math.max(0, b - 2), b) + 0.02))) : 0))
  const structuralZ = zscores(Array.from(structural).slice(0, barCount))
  const loudnessStepZ = zscores(loudnessStep)
  const boundary = barStarts.map((_, b) => clamp(structuralZ[b]! + 0.5 * loudnessStepZ[b]!, -1.5, 4))
  const phraseBars = barCount ? findPhrases(boundary, barCount) : []
  const phrases = phraseBars.map((b) => barStarts[b]!)
  const phraseEnd = (p: number) => (p + 1 < phraseBars.length ? barStarts[phraseBars[p + 1]!]! : duration)
  // How clearly each phrase's beats are heard as attacks: a beat counts when the attacks averaged over the two bars
  // around it (see beatProfiles, ±80 ms) form one peak that stands out (at least 0.6) within 12 ms of the grid, with no
  // other peak reaching 75 % of it, in the broadband attacks or in the snares, claps and hats (1.5–5 kHz), a rhythm a
  // DJ can lock onto. A wash, a pad, a riff without a beat, or a grid off the attacks scores low. (The kick band alone
  // isn't used: a bass line moving in the same band makes it ambiguous in most pop.)
  const unambiguous = (profile: { prominence: number; shift: number; rival: number }) => profile.prominence >= 0.6 && Math.abs(profile.shift) <= 0.012 && profile.rival < 0.75
  const accentClear = beatProfiles(beats, accents, 0.08).map(unambiguous)
  const beatClear = beatProfiles(beats, onsets, 0.08).map((profile, i) => unambiguous(profile) || accentClear[i]!)
  const phraseClarity = phrases.map((start, p) => {
    const end = phraseEnd(p)
    const inside = beats.flatMap((time, i) => (time >= start - 0.001 && time < end - 0.001 ? [beatClear[i]!] : []))
    return inside.length ? round(inside.filter(Boolean).length / inside.length, 2) : 0
  })
  const barClarity = downbeats.map((start, b) => {
    const end = downbeats[b + 1] ?? duration
    const inside = beats.flatMap((time, i) => (time >= start - 0.001 && time < end - 0.001 ? [beatClear[i]!] : []))
    return inside.length ? round(inside.filter(Boolean).length / inside.length, 2) : 0
  })
  // What each phrase plays, harmonically: the melody range's chroma (C3–C6, where voices and leads are), each pitch
  // class held to its median over half a second first (drum hits and other short transients drop out, held notes
  // stay), averaged over the phrase and scaled to its strongest pitch class.
  const held = new Float32Array(chroma.melody.length)
  const holdFrames = Math.max(1, Math.round(chroma.rate * 0.25))
  for (let c = 0; c < 12; c++) {
    for (let f = 0; f < chroma.count; f++) {
      const values: number[] = []
      for (let g = Math.max(0, f - holdFrames); g <= Math.min(chroma.count - 1, f + holdFrames); g++) values.push(chroma.melody[g * 12 + c]!)
      held[f * 12 + c] = median(values)
    }
  }
  const phraseChroma = phrases.map((start, p) => {
    const from = chromaFrame(start)
    const to = Math.max(from + 1, chromaFrame(phraseEnd(p)))
    const profile = spanVector(held, 12, from, Math.min(to, chroma.count))
    const max = Math.max(...profile)
    return Array.from(profile, (value) => (max > 0 ? round(value / max, 2) : 0))
  })
  const phraseLength = (p: number) => (p + 1 < phraseBars.length ? phraseBars[p + 1]! : barCount) - phraseBars[p]!

  const sungBetween = (start: number, end: number) => sungStretches.reduce((sum, stretch) => sum + Math.max(0, Math.min(end, stretch.end) - Math.max(start, stretch.start)), 0) / Math.max(0.001, end - start)
  const singingAt = (time: number) => vocals.some((stretch) => stretch.start < time && stretch.end > time)

  // ---- 5. structure ----
  // Phrase against phrase: the bars along the diagonal, so a repeated chorus matches bar by bar.
  const phraseCount = phraseBars.length
  const phraseSimilarity = Array.from({ length: phraseCount }, () => new Float64Array(phraseCount))
  for (let p = 0; p < phraseCount; p++) {
    for (let q = p; q < phraseCount; q++) {
      const length = Math.min(phraseLength(p), phraseLength(q))
      let sum = 0
      for (let k = 0; k < length; k++) sum += matrix[phraseBars[p]! + k]![phraseBars[q]! + k]!
      const value = length ? (sum / length) * Math.sqrt(length / Math.max(phraseLength(p), phraseLength(q))) : 0
      phraseSimilarity[p]![q] = value
      phraseSimilarity[q]![p] = value
    }
  }
  // Groups: average-linkage clustering of the phrases, joined while alike well above the song's usual likeness.
  const offDiagonal: number[] = []
  for (let p = 0; p < phraseCount; p++) for (let q = p + 1; q < phraseCount; q++) offDiagonal.push(phraseSimilarity[p]![q]!)
  const joinAt = Math.max(0.8, quantile(offDiagonal, 0.75))
  let clusters = Array.from({ length: phraseCount }, (_, p) => [p])
  for (;;) {
    let best = { a: -1, b: -1, value: -Infinity }
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let sum = 0
        for (const p of clusters[a]!) for (const q of clusters[b]!) sum += phraseSimilarity[p]![q]!
        const value = sum / (clusters[a]!.length * clusters[b]!.length)
        if (value > best.value) best = { a, b, value }
      }
    }
    if (best.a < 0 || best.value < joinAt) break
    clusters[best.a] = [...clusters[best.a]!, ...clusters[best.b]!]
    clusters = clusters.filter((_, i) => i !== best.b)
  }
  const label = new Array(phraseCount).fill(0) as number[]
  clusters.forEach((members, c) => members.forEach((p) => (label[p] = c)))

  // Per phrase: loudness, bass, highs, vocals, repeated lyrics.
  const phraseInfo = phraseBars.map((_, p) => {
    const start = phrases[p]!
    const end = phraseEnd(p)
    return {
      start,
      end,
      level: levelAt(level, start, end),
      low: levelAt(lowLevel, start, end),
      sung: sungBetween(start, end),
      // The share of its lines whose words come three times or more in the song: the chorus' lines.
      chorusLines: (() => {
        const lines = lyricLines.filter((line) => line.time >= start - 0.5 && line.time < end - 0.5)
        return lines.length >= 2 ? lines.filter((line) => line.count >= 3).length / lines.length : 0
      })(),
      occurrences: clusters[label[p]!]!.length,
    }
  })
  const loud = quantile(phraseInfo.map((info) => info.level), 0.75) || 1
  const typicalLow = quantile(phraseInfo.map((info) => info.low), 0.75) || 1

  // Drops: a phrase start where the song bursts into one of its loudest parts after a build-up. Two shapes:
  // - the dance-music drop: the bass was thinned out over the phrase before (a build: highs rising, rolls speeding up;
  //   or a breakdown) and jumps back with the loudness;
  // - the pop "vocal drop": the singing stops right there and an instrumental hook takes over, louder than the sung
  //   build before it (needs lyrics to know where the singing stops).
  const drops: number[] = []
  const dropPhrases = new Set<number>()
  // Only where there is a beat to drop into, and not where the singing simply goes on (a rap over a steady beat).
  for (let p = 1; p < phraseCount && bpmConfidence >= 0.4; p++) {
    if (phraseInfo[p]!.sung > 0.6 && phraseInfo[p - 1]!.sung > 0.6) continue
    const b = phraseBars[p]!
    const before = Math.max(0, b - 2)
    const after = Math.min(barCount, b + 2)
    if (after - b < 2 || b - before < 2) continue
    const lowBefore = mean(barLow, before, b)
    const lowAfter = mean(barLow, b, after)
    const levelBefore = mean(barLevel, before, b)
    const levelAfter = mean(barLevel, b, after)
    const buildFrom = phraseBars[p - 1]!
    const half = Math.max(1, Math.floor((b - buildFrom) / 2))
    const rising = mean(barHigh, b - half, b) - mean(barHigh, buildFrom, b - half) > 0.03 || mean(barOnsets, b - half, b) > 1.15 * mean(barOnsets, buildFrom, b - half)
    // The build's bass well under the drop's (not just a loud part that gets a little louder).
    const thinBass = mean(barLow, buildFrom, b) < 0.6 * mean(barLow, b, Math.min(barCount, b + 4))
    // A breakdown (the bass out for a phrase) only builds up to a drop after the song has been loud once; before
    // that, the bass coming in is the end of an intro, not a drop.
    const loudBefore = phraseBars.slice(0, p - 1).some((_, q) => mean(barLevel, phraseBars[q]!, phraseBars[q + 1]!) >= 0.85 * loud)
    const breakdown = mean(barLow, buildFrom, b) < 0.55 * typicalLow && loudBefore
    // Nor does a build in the first moments of a song: that is the intro bringing the beat in.
    const early = phrases[p]! < Math.max(20, 0.1 * duration)
    const bassDrop = ((rising && thinBass && !early) || breakdown) && lowAfter >= 0.75 * typicalLow && lowAfter > 1.8 * lowBefore && levelAfter > 1.15 * levelBefore && levelAfter >= 0.85 * loud
    const vocalDrop =
      vocalSource === 'lyrics' && !early && phraseInfo[p - 1]!.sung > 0.5 && phraseInfo[p]!.sung < 0.3 && phraseInfo[p]!.level >= loud && levelAfter > 1.1 * levelBefore && lowAfter >= 0.75 * typicalLow
    if (bassDrop || vocalDrop) {
      drops.push(phrases[p]!)
      dropPhrases.add(p)
    }
  }

  // Kinds per phrase.
  const kinds = new Array<SectionKind>(phraseCount).fill('other')
  // Chorus: the repeated group that is loudest (and, with lyrics, holds the repeated lines).
  const groupScores = clusters.map((members) => {
    const infos = members.map((p) => phraseInfo[p]!)
    return {
      members,
      repeated: members.length >= 2,
      level: mean(infos.map((info) => info.level)),
      lyrics: mean(infos.map((info) => info.chorusLines)),
      sung: mean(infos.map((info) => info.sung)),
    }
  })
  const chorusGroups = new Set<number>()
  const candidates = groupScores
    .map((group, c) => ({ c, score: group.level / loud + (vocalSource === 'lyrics' ? 0.6 * group.lyrics : 0) + 0.1 * Math.min(4, group.members.length) }))
    .filter(({ c }) => groupScores[c]!.repeated && groupScores[c]!.level >= 0.8 * loud && (vocalSource === 'none' || groupScores[c]!.sung > 0.15))
    .sort((a, b) => b.score - a.score)
  if (candidates.length) {
    chorusGroups.add(candidates[0]!.c)
    // A chorus in two halves: another repeated group as loud, always right after the first.
    for (const other of candidates.slice(1)) {
      const follows = groupScores[other.c]!.members.every((p) => p > 0 && chorusGroups.has(label[p - 1]!))
      if (follows && groupScores[other.c]!.level >= 0.9 * groupScores[candidates[0]!.c]!.level) chorusGroups.add(other.c)
    }
  }
  const lastDrop = (p: number) => {
    let q = p
    while (q > 0 && !dropPhrases.has(q)) q--
    return q
  }
  for (let p = 0; p < phraseCount; p++) {
    const info = phraseInfo[p]!
    // A phrase on a drop is a drop, also when the chorus is sung over it: `drops` and the section kinds agree.
    if (dropPhrases.has(p)) kinds[p] = 'drop'
    // A drop runs on through the next phrases as long as it stays as loud, up to 32 bars.
    else if (p > 0 && kinds[p - 1] === 'drop' && info.level >= 0.85 * loud && info.low >= 0.7 * typicalLow && phraseBars[p]! - phraseBars[lastDrop(p)]! < 32) kinds[p] = 'drop'
    else if (chorusGroups.has(label[p]!)) kinds[p] = 'chorus'
    // With lyrics, a phrase sung mostly in the chorus' lines is a chorus even when its sound differs (a last chorus
    // with more on top, a half-time one).
    else if (info.chorusLines >= 0.5 && info.sung > 0.3 && info.level >= 0.7 * loud) kinds[p] = 'chorus'
  }
  // A build: the phrase right before a drop when the bass is out or the highs rise.
  for (const p of dropPhrases) if (p > 0 && kinds[p - 1] !== 'drop' && kinds[p - 1] !== 'chorus') kinds[p - 1] = 'build'
  // Breaks: quiet, thin-bassed phrases in the middle.
  for (let p = 1; p < phraseCount - 1; p++) {
    const info = phraseInfo[p]!
    if (kinds[p] === 'other' && info.level < 0.6 * loud && info.low < 0.5 * typicalLow && info.sung < 0.3) kinds[p] = 'break'
  }
  // Where the song is fully in: the first phrase with the beat and the bass of its main parts (as loud and as busy as
  // they are, the bass nearly as strong), whether or not someone already sings over the sparser start. Without such a
  // phrase (free time, a quiet piece) its first chorus or drop, else its start.
  const typicalOnsets = median(phraseBars.map((b, p) => mean(barOnsets, b, phraseBars[p + 1] ?? barCount)))
  const fullyIn = (p: number) => {
    const info = phraseInfo[p]!
    const onsets = mean(barOnsets, phraseBars[p]!, phraseBars[p + 1] ?? barCount)
    return info.level >= 0.85 * loud && info.low >= 0.7 * typicalLow && onsets >= 0.7 * typicalOnsets
  }
  // A short pickup phrase only counts when the song stays in after it.
  const staysIn = (p: number) => fullyIn(p) && (phraseLength(p) >= 4 || p + 1 >= phraseCount || fullyIn(p + 1))
  let inPhrase = Array.from({ length: phraseCount }, (_, p) => p).find((p) => staysIn(p) || kinds[p] === 'chorus' || kinds[p] === 'drop')
  if (inPhrase === undefined) inPhrase = 0
  // Intro: the unsung phrases before that (a sung one is a verse over a sparse start); outro: see below.
  for (let p = 0; p < Math.min(inPhrase, phraseCount - 1); p++) if (phraseInfo[p]!.sung <= 0.2 && (kinds[p] === 'other' || kinds[p] === 'break')) kinds[p] = 'intro'
  const lastMain = (() => {
    for (let p = phraseCount - 1; p >= 0; p--) if (kinds[p] === 'chorus' || kinds[p] === 'drop') return p
    return -1
  })()
  // Outro: the trailing phrases after the last chorus or drop and after the last sung part of the song's body. A phrase
  // with singing (over 30 % of it sung) belongs to the body, unless it is a fade: the song's last phrase, quieter than
  // the one before and under 60 % of the loud parts (ad-libs over the fade-out).
  const isFade = (p: number) => p === phraseCount - 1 && p > 0 && phraseInfo[p]!.level < 0.6 * loud && phraseInfo[p]!.level < phraseInfo[p - 1]!.level
  let lastBody = lastMain
  for (let p = phraseCount - 1; p > lastMain; p--) {
    if (phraseInfo[p]!.sung > 0.3 && !isFade(p)) {
      lastBody = p
      break
    }
  }
  for (let p = phraseCount - 1; p > Math.max(0, lastBody) && kinds[p] !== 'intro'; p--) {
    const info = phraseInfo[p]!
    if (info.level < 0.85 * loud || info.sung <= 0.3 || isFade(p)) kinds[p] = 'outro'
    else break
  }
  // Verses: sung (or, without vocals, middling) phrases that are left.
  for (let p = 0; p < phraseCount; p++) {
    if (kinds[p] !== 'other') continue
    const info = phraseInfo[p]!
    if (vocalSource !== 'none' ? info.sung > 0.3 : info.occurrences >= 2 && info.level >= 0.5 * loud) kinds[p] = 'verse'
  }

  // Sections: runs of phrases of one kind (a new section where a drop or a new chorus starts, or a group repeats).
  const sectionRuns: Array<{ from: number; to: number }> = []
  for (let p = 0; p < phraseCount; p++) {
    const run = sectionRuns[sectionRuns.length - 1]
    const sameKind = run && kinds[run.from] === kinds[p]
    const restarts = dropPhrases.has(p) || (kinds[p] === 'chorus' && label[p] === label[run?.from ?? -1] && p !== run?.from)
    if (run && sameKind && !restarts) run.to = p
    else sectionRuns.push({ from: p, to: p })
  }
  const groupKeys = new Map<string, number>()
  const sections: MixSection[] = sectionRuns.map((run, i) => {
    const key = `${kinds[run.from]}:${label.slice(run.from, run.to + 1).join(',')}`
    if (!groupKeys.has(key)) groupKeys.set(key, groupKeys.size)
    const start = i === 0 ? 0 : phrases[run.from]!
    const end = i === sectionRuns.length - 1 ? duration : phrases[sectionRuns[i + 1]!.from]!
    return { start: round(start, 2), end: round(end, 2), kind: kinds[run.from]!, group: groupKeys.get(key)!, energy: round(spanMean(energy, CURVE_RATE, 0, start, end), 2) }
  })
  if (!sections.length) sections.push({ start: 0, end: round(duration, 2), kind: 'other', group: 0, energy: round(mean(energy), 2) })

  // ---- 7. intro end, outro start, cue points ----
  const introEnd = phraseCount ? phrases[inPhrase]! : beats[0] ?? 0
  const outroPhrase = kinds.findIndex((kind, p) => kind === 'outro' && kinds.slice(p).every((rest) => rest === 'outro'))
  // Where the song winds down: its outro; without one, the phrase after its body; when the body runs to the last
  // phrase, the first downbeat after its last sung line (unpadded) ends, else (no singing, or none left) that phrase.
  const lastSung = sungStretches.length ? sungStretches[sungStretches.length - 1]!.end : 0
  const afterSinging = sungStretches.length ? downbeats.find((time) => time >= lastSung && time < duration - 2) : undefined
  const outroStart =
    outroPhrase > 0
      ? phrases[outroPhrase]!
      : lastBody >= 0 && lastBody + 1 < phraseCount
        ? phrases[lastBody + 1]!
        : afterSinging ?? (phraseCount ? phrases[phraseCount - 1]! : duration)
  const beatIn = (start: number, end: number) => clamp(levelAt(lowLevel, start, end) / (0.6 * typicalLow)) * clamp(spanMean(envelope, frameRate, firstTime, start, end) / 0.6)
  // Entries: where B is best brought in during a mix. First where the song is fully in (its intro skipped; when it is
  // in from the start, that is the start), then its first chorus or drop and the next ones, then other section starts;
  // each better the clearer its beat and bass, never across a sung line, earlier rather than later. The start itself
  // only ranks by these same measures (a quiet intro rarely beats them).
  const scoredIn = phrases.map((start, p) => {
    const end = phraseEnd(p)
    let score = beatIn(start, end) * bpmConfidence
    if (p === inPhrase) score += 2
    if (kinds[p] === 'chorus' || kinds[p] === 'drop') score += 1.5 + (kinds.indexOf(kinds[p]!) === p ? 0.3 : 0)
    if (p > 0 && kinds[p] !== kinds[p - 1]) score += 0.5
    if (singingAt(start - 0.3)) score -= 1.5
    if (vocals.some((stretch) => stretch.start > start + 0.5 && stretch.start < start + (end - start) / 2)) score -= 0.5
    score -= start / duration
    return { time: start, score, ok: start <= 0.75 * duration }
  })
  // Exits: where A can start to leave. Best in the outro (from its start), right after a chorus or drop ends, and
  // where the next 8 seconds are instrumental; never across a sung line, nor so late that nothing is left to mix.
  const scoredOut = phrases.map((start, p) => {
    let score = 0.5 * (start / duration)
    if (start >= outroStart - 0.01) score += 2
    if (Math.abs(start - outroStart) < 0.01) score += 1
    if (p > 0 && (kinds[p - 1] === 'chorus' || kinds[p - 1] === 'drop') && kinds[p] !== kinds[p - 1]) score += 1.5
    // (Cue points go by the padded stretches: no line may be cut.)
    if (!vocals.some((stretch) => stretch.start < start + 8 && stretch.end > start)) score += 1
    if (singingAt(start - 0.3) || singingAt(start + 0.3)) score -= 2
    if (duration - start < 8) score -= 1.5
    return { time: start, score, ok: start >= 0.3 * duration && start < duration - 4 }
  })
  // Up to 8, best first; those scoring below 0 (a line cut, too late) only when nothing better is there (2 at least).
  const ranked = (list: Array<{ time: number; score: number; ok: boolean }>) => {
    const sorted = list.filter((entry) => entry.ok).sort((a, b) => b.score - a.score)
    return sorted
      .filter((entry, i) => entry.score >= 0 || i < 2)
      .slice(0, 8)
      .map((entry) => round(entry.time))
  }

  // ---- key and loudness ----
  const keys: Array<{ key: number; minor: boolean; r: number }> = []
  for (let key = 0; key < 12; key++) {
    const rotated = chroma.total.map((_, i) => chroma.total[(i + key) % 12]!)
    keys.push({ key, minor: false, r: pearson(rotated, MAJOR) }, { key, minor: true, r: pearson(rotated, MINOR) })
  }
  keys.sort((a, b) => b.r - a.r)
  const top = keys[0]!

  return {
    v: MIX_VERSION,
    duration: round(duration, 2),
    bpm: round(bpm, 1),
    bpmConfidence,
    beats: beats.map((time) => round(time)),
    downbeats: downbeats.map((time) => round(time)),
    phrases: phrases.map((time) => round(time)),
    phraseClarity,
    barClarity,
    phraseChroma,
    key: top.key,
    minor: top.minor,
    keyClarity: round(Math.max(0, top.r)),
    loudness: round(20 * Math.log10(rms), 1),
    frameRate: CURVE_RATE,
    energy,
    bands,
    sections,
    drops: drops.map((time) => round(time)),
    vocals: vocals.map((stretch) => ({ start: round(stretch.start, 2), end: round(stretch.end, 2) })),
    vocalSource,
    introEnd: round(introEnd),
    outroStart: round(outroStart),
    cuesIn: ranked(scoredIn),
    cuesOut: ranked(scoredOut),
  }
}
