/**
 * Finding a short recording inside a longer stretch of the same audio: normalized cross-correlation via FFT, with the
 * peak refined between samples. Used to learn exactly which sample of a decoded slice an <audio> element is playing
 * (the slice's start as Jellyfin cut it may be off by an unknown amount). Pure; no Web Audio.
 */

/** In-place iterative radix-2 FFT (`inverse` without the 1/N scaling). */
function fft(re: Float64Array, im: Float64Array, inverse = false) {
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
    const angle = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let start = 0; start < n; start += size) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < size / 2; k++) {
        const a = start + k
        const b = a + size / 2
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
}

export interface Match {
  /** Index in `haystack` where `needle` starts (fractional). */
  offset: number
  /** Normalized correlation at the match (1: identical shape). */
  score: number
}

/**
 * Where `needle` lies in `haystack`, searching start indices from `from` to `to`. Null when the range holds no full
 * match (outside the haystack).
 */
export function locate(needle: Float32Array, haystack: Float32Array, from: number, to: number): Match | null {
  const length = needle.length
  const first = Math.max(0, Math.floor(from))
  const last = Math.min(haystack.length - length, Math.ceil(to))
  if (last < first || length === 0) return null
  const span = last - first + length
  let size = 1
  while (size < span + length) size <<= 1
  const aRe = new Float64Array(size)
  const aIm = new Float64Array(size)
  const bRe = new Float64Array(size)
  const bIm = new Float64Array(size)
  let needleEnergy = 0
  for (let i = 0; i < length; i++) {
    aRe[i] = needle[i]!
    needleEnergy += needle[i]! ** 2
  }
  for (let i = 0; i < span; i++) bRe[i] = haystack[first + i]!
  fft(aRe, aIm)
  fft(bRe, bIm)
  // conj(A) · B: the correlation of the needle against every shift of the haystack.
  for (let i = 0; i < size; i++) {
    const re = aRe[i]! * bRe[i]! + aIm[i]! * bIm[i]!
    const im = aRe[i]! * bIm[i]! - aIm[i]! * bRe[i]!
    aRe[i] = re
    aIm[i] = im
  }
  fft(aRe, aIm, true)
  // Each shift's haystack energy (running sum), for the normalization.
  const prefix = new Float64Array(span + 1)
  for (let i = 0; i < span; i++) prefix[i + 1] = prefix[i]! + haystack[first + i]! ** 2
  const scores = new Float64Array(last - first + 1)
  let best = 0
  for (let k = 0; k < scores.length; k++) {
    const energy = prefix[k + length]! - prefix[k]!
    scores[k] = energy > 0 && needleEnergy > 0 ? aRe[k]! / size / Math.sqrt(energy * needleEnergy) : 0
    if (scores[k]! > scores[best]!) best = k
  }
  // A parabola through the peak and its neighbours puts it between samples.
  let fraction = 0
  if (best > 0 && best < scores.length - 1) {
    const left = scores[best - 1]!
    const middle = scores[best]!
    const right = scores[best + 1]!
    const curve = left - 2 * middle + right
    if (curve < 0) fraction = (0.5 * (left - right)) / curve
  }
  return { offset: first + best + fraction, score: scores[best]! }
}

/** The mean of a slice's channels (what the correlation runs on). */
export function mono(channels: Float32Array[], from = 0, to = channels[0]?.length ?? 0) {
  const out = new Float32Array(Math.max(0, to - from))
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] = out[i]! + channel[from + i]! / channels.length
  return out
}
