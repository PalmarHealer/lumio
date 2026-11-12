/**
 * The stem lanes' live approximation ("Tier A" smart filters): a deck's sound split, sample by sample and without
 * latency, into drums, voice, and the rest, which add up to the input again. Real stems are better; this needs no
 * separation beforehand and costs little (a few hundred operations per sample).
 *
 * - Drums: what starts suddenly. Per band (below 150 Hz: kick; 150 Hz–4 kHz: snare, claps; above: hats) the band's
 *   power over the last few ms against the last tens of ms: 2 dB more marks an attack, 6 dB a full one, and the band
 *   counts as drums while that lasts and a short release after. A steady sound's power doesn't move, so it gives none;
 *   a drum's decaying tail stays with the rest, and any sharp attack (a pluck, a piano note's start) counts as drums.
 * - Voice: of what is left, the centre (left and right alike) in the voice's range (200 Hz–6 kHz): the centre minus
 *   what lies below and above the range, so a centred voice cancels to about −25 dB whatever the filters' phase. An
 *   octave of the range that holds about as much side as centre (a wide instrument) is given back to the rest (its
 *   band-pass taken out of the voice again, by how much more side than centre it holds there); a centred instrument
 *   counts as voice too.
 * - Instrumental: the rest, without its bass (below 150 Hz: the bass stays on the EQ's low lane and always plays).
 *
 * `StemSplit` is self-contained (no imports, no closures, no class fields that compile to helpers): the AudioWorklet's
 * source is made from its text (`stemsProcessorSource`), and node tests run it directly.
 */

export class StemSplit {
  declare state: Float64Array
  declare coefficients: number[][]
  declare fast: Float64Array
  declare slow: Float64Array
  declare mask: Float64Array
  declare attackSlow: number[]
  declare releaseEnv: number[]
  declare releaseMask: number[]
  declare envMid: Float64Array
  declare envSide: Float64Array
  declare voiceAttack: number
  declare voiceRelease: number
  declare lp: number
  declare hp: number
  declare bp: number

  constructor(sampleRate: number) {
    /** TPT state-variable filter coefficients [k, a1, a2, a3] for a cutoff (Butterworth Q, or `q`). */
    const svf = (frequency: number, q = Math.SQRT1_2) => {
      const g = Math.tan((Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate)
      const k = 1 / q
      const a1 = 1 / (1 + g * (g + k))
      return [k, a1, g * a1, g * g * a1]
    }
    const coefficient = (seconds: number) => 1 - Math.exp(-1 / (seconds * sampleRate))
    // 0: 150 Hz (drum bands, bass), 1: 4 kHz (drum bands), 2: 200 Hz and 3: 6 kHz (the voice range), 4–8: its octaves'
    // band-passes (one octave wide).
    this.coefficients = [svf(150), svf(4000), svf(200), svf(6000), ...[280, 560, 1130, 2260, 4500].map((f) => svf(f, Math.SQRT2))]
    // Two states per filter: 0–3 mid's drum bands, 4–11 each channel's (4 + 4c), 12–15 the voice range, 16–35 the mid's
    // octaves (two band-passes in a row each: steeper), 36–55 the side's, 56–75 the octaves taken back out of the voice.
    this.state = new Float64Array(76)
    this.fast = new Float64Array(3)
    this.slow = new Float64Array(3)
    this.mask = new Float64Array(3)
    // Power over the last few ms (fast) and tens of ms (slow), per band.
    this.attackSlow = [coefficient(0.1), coefficient(0.08), coefficient(0.05)]
    this.releaseEnv = [coefficient(0.008), coefficient(0.003), coefficient(0.001)]
    this.releaseMask = [coefficient(0.04), coefficient(0.02), coefficient(0.015)]
    this.envMid = new Float64Array(5)
    this.envSide = new Float64Array(5)
    this.voiceAttack = coefficient(0.01)
    this.voiceRelease = coefficient(0.15)
    this.lp = 0
    this.hp = 0
    this.bp = 0
  }

  /** One TPT SVF step (filter `f`, state slots `at`, `at + 1`): leaves the low-pass and high-pass of `x` in `lp`, `hp`. */
  step(f: number, at: number, x: number) {
    const c = this.coefficients[f]!
    const s = this.state
    const v3 = x - s[at + 1]!
    const v1 = c[1]! * s[at]! + c[2]! * v3
    const v2 = s[at + 1]! + c[2]! * s[at]! + c[3]! * v3
    s[at] = 2 * v1 - s[at]!
    s[at + 1] = 2 * v2 - s[at + 1]!
    this.lp = v2
    this.hp = x - c[0]! * v1 - v2
    this.bp = c[0]! * v1
  }


  /**
   * Splits `n` frames of `left`/`right` and writes `drums·D + vocals·V + instrumental·I + bass` to `outLeft`/`outRight`
   * (each gain an array of one value or of `n`). With all three at 1 the output is the input (to rounding).
   */
  run(left: Float32Array, right: Float32Array, outLeft: Float32Array, outRight: Float32Array, drums: Float32Array, vocals: Float32Array, instrumental: Float32Array, n: number) {
    for (let i = 0; i < n; i++) {
      const l = left[i]!
      const r = right[i]!
      const gd = drums.length > 1 ? drums[i]! : drums[0]!
      const gv = vocals.length > 1 ? vocals[i]! : vocals[0]!
      const gi = instrumental.length > 1 ? instrumental[i]! : instrumental[0]!
      // Attacks, on the mid signal's three bands.
      const m = (l + r) / 2
      this.step(0, 0, m)
      const mLow = this.lp
      this.step(1, 2, m)
      const mHigh = this.hp
      for (let b = 0; b < 3; b++) {
        const x = b === 0 ? mLow : b === 2 ? mHigh : m - mLow - mHigh
        this.fast[b] = this.fast[b]! + this.releaseEnv[b]! * (x * x - this.fast[b]!)
        this.slow[b] = this.slow[b]! + this.attackSlow[b]! * (x * x - this.slow[b]!)
      }
      // A band only a thousandth of the others' power doesn't count (its ratio is noise).
      const floor = 1e-3 * (this.slow[0]! + this.slow[1]! + this.slow[2]!) + 1e-12
      for (let b = 0; b < 3; b++) {
        const rise = 10 * Math.log10((this.fast[b]! + floor) / (this.slow[b]! + floor))
        const target = Math.max(0, Math.min(1, (rise - 2) / 4))
        this.mask[b] = target > this.mask[b]! ? target : this.mask[b]! + this.releaseMask[b]! * (target - this.mask[b]!)
      }
      // Each channel's bands; drums = the bands under their masks.
      this.step(0, 4, l)
      const lLow = this.lp
      this.step(1, 6, l)
      const lHigh = this.hp
      this.step(0, 8, r)
      const rLow = this.lp
      this.step(1, 10, r)
      const rHigh = this.hp
      const dL = this.mask[0]! * lLow + this.mask[1]! * (l - lLow - lHigh) + this.mask[2]! * lHigh
      const dR = this.mask[0]! * rLow + this.mask[1]! * (r - rLow - rHigh) + this.mask[2]! * rHigh
      const xL = l - dL
      const xR = r - dR
      // Voice: the centre of the rest in the voice's range, less the octaves that are wide.
      const mid = (xL + xR) / 2
      const side = (xL - xR) / 2
      this.step(2, 12, mid)
      let range = mid - this.lp
      this.step(3, 14, mid)
      range -= this.hp
      let v = range
      for (let o = 0; o < 5; o++) {
        this.step(4 + o, 16 + 4 * o, mid)
        this.step(4 + o, 18 + 4 * o, this.bp)
        const am = Math.abs(this.bp)
        this.step(4 + o, 36 + 4 * o, side)
        this.step(4 + o, 38 + 4 * o, this.bp)
        const as = Math.abs(this.bp)
        this.envMid[o] = this.envMid[o]! + (am > this.envMid[o]! ? this.voiceAttack : this.voiceRelease) * (am - this.envMid[o]!)
        this.envSide[o] = this.envSide[o]! + (as > this.envSide[o]! ? this.voiceAttack : this.voiceRelease) * (as - this.envSide[o]!)
        // 1 where the octave holds three times as much centre as side or more, 0 where as much side as centre.
        const weight = Math.max(0, Math.min(1, (this.envMid[o]! / (this.envSide[o]! + 1e-9) - 1) / 2))
        this.step(4 + o, 56 + 4 * o, range)
        this.step(4 + o, 58 + 4 * o, this.bp)
        v -= (1 - weight) * this.bp
      }
      // The rest's bass (what of the low band isn't an attack) always plays.
      const bassL = (1 - this.mask[0]!) * lLow
      const bassR = (1 - this.mask[0]!) * rLow
      outLeft[i] = gd * dL + gv * v + gi * (xL - v - bassL) + bassL
      outRight[i] = gd * dR + gv * v + gi * (xR - v - bassR) + bassR
    }
  }
}

/** The AudioWorklet module source: `StemSplit` behind three a-rate gains (drums, vocals, instrumental, 0–1). */
export const stemsProcessorSource = () => `
const StemSplit = ${StemSplit.toString()}
class LumioStems extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['drums', 'vocals', 'instrumental'].map((name) => ({ name, defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' }))
  }
  constructor() {
    super()
    this.split = new StemSplit(sampleRate)
    this.silence = new Float32Array(128)
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    const n = output[0].length
    const left = input && input[0] ? input[0] : this.silence
    const right = input && input[1] ? input[1] : left
    this.split.run(left, right, output[0], output[1] || output[0], parameters.drums, parameters.vocals, parameters.instrumental, n)
    return true
  }
}
registerProcessor('lumio-stems', LumioStems)
`
