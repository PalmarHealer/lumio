// Synthetic TrackMix fixtures (a steady grid, simple sections, vocals and energy from a few options) and an independent
// invariant checker for the planner's transitions. No real-song analyses: those come from a user's own library.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { deckPosition, rateAt } from '../timeline.ts'

export { deckPosition }

export interface FixtureOptions {
  bpm?: number
  duration?: number
  key?: number
  minor?: boolean
  keyClarity?: number
  bpmConfidence?: number
  introBars?: number
  outroBars?: number
  firstBeat?: number
  vocals?: Array<[number, number]>
  vocalSource?: 'lyrics' | 'audio' | 'none'
  drops?: number[]
  chorus?: Array<[number, number]>
  cuesIn?: number[]
  cuesOut?: number[]
  fadeOut?: number
  loudness?: number
  /** Attack clarity: one value for all phrases, a function of the phrase start, or null for an analysis without it. */
  clarity?: number | ((t: number) => number) | null
}

export function fixture(o: FixtureOptions = {}) {
  const bpm = o.bpm ?? 124
  const duration = o.duration ?? 210
  const period = 60 / bpm
  const first = o.firstBeat ?? 0.2
  const beats: number[] = []
  for (let t = first; t < duration - 0.05; t += period) beats.push(Math.round(t * 1000) / 1000)
  const downbeats = beats.filter((_, i) => i % 4 === 0)
  const phrases = downbeats.filter((_, i) => i % 8 === 0)
  const introEnd = downbeats[(o.introBars ?? 16)] ?? 0
  const outroIdx = Math.max(0, downbeats.length - (o.outroBars ?? 16))
  const outroStart = downbeats[outroIdx] ?? duration
  const frameRate = 10
  const frames = Math.round(duration * frameRate)
  const fade = o.fadeOut ?? 0
  const drops = o.drops ?? []
  const chorus = o.chorus ?? []
  const energy: number[] = []
  for (let i = 0; i < frames; i++) {
    const t = i / frameRate
    let e = t < introEnd ? 0.45 : t >= outroStart ? 0.45 : 0.75
    if (chorus.some(([s, f]) => t >= s && t < f)) e = 1
    if (drops.some((d) => t >= d && t < d + 30)) e = 1
    if (fade > 0 && t > duration - fade) e *= Math.max(0, (duration - t) / fade)
    if (t < first) e = 0
    energy.push(Math.round(e * 1000) / 1000)
  }
  const sections: Array<{ start: number; end: number; kind: string; group: number; energy: number }> = [
    { start: 0, end: introEnd, kind: 'intro', group: 0, energy: 0.45 },
  ]
  let cursor = introEnd
  for (const [s, f] of chorus) {
    if (s > cursor) sections.push({ start: cursor, end: s, kind: 'verse', group: 1, energy: 0.75 })
    sections.push({ start: s, end: f, kind: 'chorus', group: 2, energy: 1 })
    cursor = f
  }
  for (const d of drops) {
    if (d > cursor) sections.push({ start: cursor, end: d, kind: 'build', group: 3, energy: 0.7 })
    sections.push({ start: d, end: d + 30, kind: 'drop', group: 4, energy: 1 })
    cursor = d + 30
  }
  if (outroStart > cursor) sections.push({ start: cursor, end: outroStart, kind: 'verse', group: 1, energy: 0.75 })
  sections.push({ start: outroStart, end: duration, kind: 'outro', group: 5, energy: 0.45 })
  return {
    v: 1,
    duration,
    bpm,
    bpmConfidence: o.bpmConfidence ?? 0.9,
    beats,
    downbeats,
    phrases,
    ...(o.clarity === null ? {} : { phraseClarity: phrases.map((t) => (typeof o.clarity === 'function' ? o.clarity(t) : (o.clarity ?? 0.9))) }),
    key: o.key ?? 9,
    minor: o.minor ?? true,
    keyClarity: o.keyClarity ?? 0.8,
    loudness: o.loudness ?? -9,
    frameRate,
    energy,
    bands: { low: energy, mid: energy, high: energy },
    sections,
    drops,
    vocals: (o.vocals ?? [[introEnd, outroStart]]).map(([start, end]) => ({ start, end })),
    vocalSource: o.vocalSource ?? 'lyrics',
    introEnd,
    outroStart,
    cuesIn: o.cuesIn ?? [introEnd],
    cuesOut: o.cuesOut ?? [outroStart],
  } as any
}

const at = (list: Array<{ t: number; v: number }>, t: number, d: number) => {
  if (!list || list.length === 0) return d
  if (t <= list[0].t) return list[0].v
  for (let i = 1; i < list.length; i++) {
    if (t <= list[i].t) {
      const p = list[i - 1]
      const q = list[i]
      return q.t === p.t ? q.v : p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t)
    }
  }
  return list[list.length - 1].v
}

const inside = (spans: Array<{ start: number; end: number }>, t: number) => spans.some((s) => t >= s.start && t < s.end)

/** Returns a list of violated invariants (empty = ok). */
export function check(tr: any, a: any, b: any, opts: { phrases?: boolean; beatsOnly?: boolean } = {}) {
  const errors: string[] = []
  const durA = Number.isFinite(a?.duration) ? a.duration : Infinity
  const durB = Number.isFinite(b?.duration) ? b.duration : Infinity
  for (const k of ['aOut', 'bAt', 'bIn', 'length', 'confidence']) if (!Number.isFinite(tr[k])) errors.push(`${k} not finite`)
  if (tr.v !== 2) errors.push(`v ${tr.v}`)
  if (tr.aOut < 0 || tr.aOut > durA) errors.push(`aOut ${tr.aOut} outside A (${durA})`)
  if ((deckPosition(tr, 'a', tr.length) ?? 0) > durA + 1e-3) errors.push(`A runs past its end`)
  if (tr.bIn < 0 || tr.bIn >= durB) errors.push(`bIn ${tr.bIn} outside B`)
  if (tr.bAt < 0 || tr.bAt > tr.length + 1e-9) errors.push(`bAt ${tr.bAt} outside [0, length]`)
  if (tr.length > 0 && (deckPosition(tr, 'b', tr.length) ?? 0) > durB + 1e-3) errors.push(`B runs past its end`)
  for (const [deck, path, start] of [['A', tr.pathA, tr.aOut], ['B', tr.pathB, tr.bIn]] as const) {
    if (path.length && Math.abs(path[0].from - start) > 0.002) errors.push(`path${deck} doesn't start at the deck's start`)
    let plays = 0, last = ''
    for (const seg of path) {
      if (!(seg.to > seg.from) || !Number.isInteger(seg.repeat) || seg.repeat < 1) errors.push(`path${deck} bad segment`)
      const key = `${seg.from}-${seg.to}`
      plays = key === last ? plays + seg.repeat : seg.repeat
      last = key
    }
    const loopSecs = Math.max(0, ...path.filter((s: any) => s.repeat > 1).map((s: any) => (s.to - s.from) * s.repeat))
    if (loopSecs > 16 * 4 * 60 / 60 * 1.1 && loopSecs > 40) errors.push(`path${deck} loops ${loopSecs.toFixed(1)} s`)
  }
  for (const [deck, curve] of [['A', tr.rateA], ['B', tr.rateB]] as const) {
    for (const k of curve) if (Math.abs(k.v - 1) > 0.0355) errors.push(`rate${deck} ${k.v} beyond 3.5 %`)
  }
  if (tr.rateB.length && tr.rateB[tr.rateB.length - 1].v !== 1) errors.push('rateB does not end at 1')
  if (tr.length > 0 && tr.rateA.length && tr.rateB.length) {
    // Beatmatched tempo during the overlap: A's and B's effective tempos meet (straight/half/double).
    const t = (tr.bAt + tr.length) / 2
    const ta = tr.tempo.a * rateAt(tr.rateA, t), tb = tr.tempo.b * rateAt(tr.rateB, t)
    if (Math.min(...[1, 2, 0.5].map((m) => Math.abs(tb * m / ta - 1))) > 0.02) errors.push(`tempos don't meet: ${ta.toFixed(2)} vs ${tb.toFixed(2)}`)
  }
  if (tr.length < 0) errors.push('negative length')
  if (tr.preset === 'auto') errors.push('unresolved auto')
  if (!tr.tempo || !(tr.tempo.a >= 30 && tr.tempo.a <= 300) || !(tr.tempo.b >= 30 && tr.tempo.b <= 300)) errors.push(`tempo ${JSON.stringify(tr.tempo)}`)
  for (const deck of ['a', 'b']) {
    for (const band of ['gain', 'low', 'mid', 'high', 'filter']) {
      const list = tr[deck][band]
      if (!Array.isArray(list)) { errors.push(`${deck}.${band} missing`); continue }
      for (let i = 0; i < list.length; i++) {
        const k = list[i]
        if (!(k.t >= 0 && k.t <= tr.length)) errors.push(`${deck}.${band} t ${k.t} outside [0, ${tr.length}]`)
        if (i > 0 && k.t < list[i - 1].t) errors.push(`${deck}.${band} not sorted`)
        const min = band === 'filter' ? -1 : 0
        if (!(k.v >= min && k.v <= 1)) errors.push(`${deck}.${band} value ${k.v}`)
      }
    }
  }
  // Sample: no two basslines, no two voices.
  let basses = 0
  let voices = 0
  const dt = 0.02
  for (let t = 0; t < tr.length; t += dt) {
    const ga = at(tr.a.gain, t, 1), gb = at(tr.b.gain, t, 1)
    const fa = at(tr.a.filter, t, 0), fb = at(tr.b.filter, t, 0)
    const la = ga * at(tr.a.low, t, 1) * (fa > 0.5 ? 0.3 : 1)
    const lb = gb * at(tr.b.low, t, 1) * (fb > 0.5 ? 0.3 : 1)
    if (la > 0.5 && lb > 0.5) basses += dt
    const va = ga * Math.max(at(tr.a.mid, t, 1), at(tr.a.high, t, 1)) * (Math.abs(fa) > 0.4 ? 1 - ((Math.abs(fa) - 0.4) / 0.6) * 0.7 : 1)
    const vb = gb * Math.max(at(tr.b.mid, t, 1), at(tr.b.high, t, 1)) * (Math.abs(fb) > 0.4 ? 1 - ((Math.abs(fb) - 0.4) / 0.6) * 0.7 : 1)
    const pb = deckPosition(tr, 'b', t)
    if (a && b && va > 0.3 && vb > 0.3 && pb !== null && inside(a.vocals ?? [], deckPosition(tr, 'a', t) ?? -1) && inside(b.vocals ?? [], pb)) voices += dt
  }
  // Loudness from what plays (energy rule): per band, both decks' power (gain × band × filter × the song's own band
  // energy at its position, relative to its loud parts, at its loudness) against the louder song's loud level.
  if (a?.bands && b?.bands && tr.length > 0) {
    const rel = (m: any, band: string) => { const l = [...m.bands[band]].sort((x: number, y: number) => x - y); return Math.max(0.05, l[Math.floor(l.length * 0.9)] ?? 1) }
    const lvl = (m: any) => 10 ** ((Number.isFinite(m.loudness) ? m.loudness : -14) / 20)
    const pass = (f: number, band: string) => f >= 0 ? (band === 'low' ? Math.max(0, 1 - f / 0.4) : band === 'mid' ? Math.max(0, Math.min(1, 1 - Math.max(0, f - 0.4) / 0.4)) : 1) : (band === 'high' ? Math.max(0, 1 + f / 0.4) : band === 'mid' ? Math.max(0, Math.min(1, 1 - Math.max(0, -f - 0.4) / 0.4)) : 1)
    const ref = Math.max(lvl(a), lvl(b)) ** 2
    const over: number[] = []
    let bassBoth = 0
    for (let t = tr.bAt; t < tr.length; t += 0.1) {
      const pa = deckPosition(tr, 'a', t), pb = deckPosition(tr, 'b', t)
      if (pa === null || pb === null) continue
      let worst = -99
      const e: any = {}
      for (const band of ['low', 'mid', 'high']) {
        const ea = Math.min(1.5, (a.bands[band][Math.round(pa * 10)] ?? 0) / rel(a, band)), eb = Math.min(1.5, (b.bands[band][Math.round(pb * 10)] ?? 0) / rel(b, band))
        const xa = at(tr.a.gain, t, 1) * at(tr.a[band], t, 1) * pass(at(tr.a.filter, t, 0), band) * ea, xb = at(tr.b.gain, t, 1) * at(tr.b[band], t, 1) * pass(at(tr.b.filter, t, 0), band) * eb
        e[band] = [xa, xb]
        worst = Math.max(worst, 10 * Math.log10(Math.max(1e-9, ((xa * lvl(a)) ** 2 + (xb * lvl(b)) ** 2) / Math.max(ref, (xa * lvl(a)) ** 2, (xb * lvl(b)) ** 2))))
      }
      over.push(worst)
      if (e.low[0] > 0.5 && e.low[1] > 0.5) bassBoth += 0.1
    }
    over.sort((x, y) => x - y)
    const p95 = over.length ? over[Math.floor(over.length * 0.95)] : -99
    if (p95 > 2.05) errors.push(`summed band energy +${p95.toFixed(2)} dB over the louder song's loud level`)
    if (bassBoth > 0.3) errors.push(`two basslines (material) for ${bassBoth.toFixed(2)} s`)
  }
  if (basses > 0.03 && !(a?.bands && b?.bands)) errors.push(`two basslines for ${basses.toFixed(2)} s`)
  if (a?.vocalSource !== 'none' && b?.vocalSource !== 'none' && voices > 0.15) errors.push(`two voices for ${voices.toFixed(2)} s`)
  if (opts.phrases) {
    const tol = 0.06
    const onA = (a.downbeats ?? []).some((d: number) => Math.abs(d - tr.aOut) < tol) || tr.preset === 'none'
    const onBeat = (a.beats ?? []).some((d: number) => Math.abs(d - tr.aOut) < tol)
    const beatOk = ['echoOut', 'fadeIn', 'fadeOut'].includes(tr.preset)
    if (!(onA || ((beatOk || opts.beatsOnly) && onBeat))) errors.push(`aOut ${tr.aOut} not on a downbeat of A`)
    // B's in point lined up: on one of B's beats (or 0 at its very start).
    let firstB = 0
    while (firstB < tr.length && at(tr.b.gain, firstB, 1) <= 0.05) firstB += 0.01
    const entry = deckPosition(tr, 'b', Math.max(firstB, tr.bAt)) ?? tr.bIn
    const onBeatB = (x: number) => (b.beats ?? []).some((d: number) => Math.abs(d - x) < tol + 0.02)
    const onB = tr.bIn < 0.4 || tr.bIn < (b.beats?.[0] ?? 0) || onBeatB(tr.bIn) || onBeatB(entry)
    if (!onB && tr.preset !== 'none') errors.push(`bIn ${tr.bIn} not on a beat of B`)
  }
  return errors
}

export function describe(tr: any) {
  const loops = [...tr.pathA, ...tr.pathB].filter((s: any) => s.repeat > 1).map((s: any) => `${s.repeat}x${(s.to - s.from).toFixed(1)}s`).join(',')
  const rA = tr.rateA.length ? tr.rateA[tr.rateA.length - 1].v : 1, rB = tr.rateB.length ? tr.rateB[0].v : 1
  return `${tr.style}/${tr.preset} aOut=${tr.aOut.toFixed(2)} bAt=${tr.bAt.toFixed(2)} bIn=${tr.bIn.toFixed(2)} len=${tr.length.toFixed(2)} rA=${rA} rB=${rB}${loops ? ' loops=' + loops : ''} conf=${tr.confidence}`
}
