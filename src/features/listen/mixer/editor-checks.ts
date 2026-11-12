/**
 * The transition editor's assistance: live checks of a transition as the user edits it (the planner's rules as
 * located, never-blocking warnings) and suggestions to start from (A-out / B-in points, loops, the planner's variants).
 * Pure functions: no DOM, safe in a worker. `checkTransition` is cheap enough to run on every edit (a few ms);
 * `suggestions` plans variants (tens to hundreds of ms): call it once per pair, or in a worker.
 */
import { floorIndex, periodAt, prepareTrack, spanAt, type PreparedTrack } from './analysis.ts'
import { harmonicScore } from './camelot.ts'
import { planVariants, plannerRules as R, sampleShape } from './planner.ts'
import { valueAt } from './presets.ts'
import { deckPosition, rateAt } from './timeline.ts'
import type { Keyframe, MixStyle, TrackMix, Transition } from './types.ts'

export type CheckKind = 'voices' | 'basslines' | 'keyClash' | 'energyJump' | 'notReady' | 'bandBack' | 'flamRisk' | 'beatsApart' | 'lineCut'

export interface CheckIssue {
  kind: CheckKind
  /** 'warn': heard as a mistake by most listeners; 'info': worth a listen (an estimate, or a matter of taste). */
  severity: 'info' | 'warn'
  /** Where, in transition time (seconds), for a marker on the timeline. */
  from: number
  to: number
  /** The deck whose lane it belongs to, when one. */
  deck?: 'a' | 'b'
  /** A short German description for the marker's tooltip. */
  message: string
}

/** Below this, a run of a condition is too short to mention (seconds). */
const MIN_RUN = 0.15
/** Gaps up to this join two runs into one (seconds). */
const JOIN = 0.12

const seconds = (s: number) => `${s.toFixed(1).replace('.', ',')} s`
const lane = (curve: Keyframe[] | undefined, t: number) => (curve && curve.length > 0 ? Math.min(1, Math.max(0, valueAt(curve, t, 1))) : 1)

/** Runs of consecutive samples where `test` holds, as [from, to] in transition time; short gaps joined. */
function runs(count: number, dt: number, test: (i: number) => boolean, minimum = MIN_RUN): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < count; i++) {
    if (test(i)) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0) {
      out.push([start * dt, i * dt])
      start = -1
    }
  }
  if (start >= 0) out.push([start * dt, count * dt])
  const joined: Array<[number, number]> = []
  for (const run of out) {
    const last = joined[joined.length - 1]
    if (last && run[0] - last[1] <= JOIN) last[1] = run[1]
    else joined.push([run[0], run[1]])
  }
  return joined.filter(([from, to]) => to - from >= minimum)
}

/** Where a track's beat grid places `pos`: the fraction of a beat after the beat before it (NaN off the grid). */
function beatPhase(track: PreparedTrack, pos: number) {
  const k = floorIndex(track.beats, pos)
  if (k < 0 || k + 1 >= track.beats.length) return NaN
  return (pos - track.beats[k]) / (track.beats[k + 1] - track.beats[k])
}

/** A track's level over a stretch, against its loudness (as the planner's handover checks). */
function levelOver(track: PreparedTrack, from: number, to: number) {
  const mean = track.energyBetween(track.start, track.end)
  return mean > 0 ? (track.level * track.energyBetween(from, to)) / mean : track.level
}

/**
 * The planner's rules on a transition as edited, each finding located on the timeline: two voices at once, two
 * basslines, clashing keys over each other, an energy jump (B against A's body level, so a song that just ends soft
 * isn't held against B), B not in full before A leaves, A's bands coming back up, beats that can flam or run apart, and
 * a line cut off or entered in the middle. Empty when there's nothing to say (or no analysis to judge by).
 */
export function checkTransition(t: Transition, aMix: TrackMix | null, bMix: TrackMix | null): CheckIssue[] {
  const a = prepareTrack(aMix)
  const b = prepareTrack(bMix)
  if (!a || !b || !(t.length > 0)) return []
  const s = sampleShape(t.a, t.b, t.length)
  const { dt } = s
  const count = s.gainA.length
  if (!(dt > 0) || count < 2) return []
  const issues: CheckIssue[] = []
  const beatA = 60 / (t.tempo?.a || R.DEFAULT_TEMPO)

  // Per sample: both decks' positions (null before B starts) and the stem lanes.
  const posA = new Float64Array(count)
  const posB = new Float64Array(count)
  const hasB = new Uint8Array(count)
  const stems = (deck: 'a' | 'b', key: 'drums' | 'vocals' | 'instrumental', time: number) => lane(t[deck][key], time)
  for (let i = 0; i < count; i++) {
    const time = i * dt
    posA[i] = deckPosition(t, 'a', time) ?? NaN
    const pb = deckPosition(t, 'b', time)
    hasB[i] = pb === null || time < t.bAt ? 0 : 1
    posB[i] = pb ?? NaN
  }
  const voiceA = (i: number) => s.voiceA[i] * stems('a', 'vocals', i * dt)
  const voiceB = (i: number) => s.voiceB[i] * stems('b', 'vocals', i * dt)
  const accentA = (i: number) => s.accentA[i] * stems('a', 'drums', i * dt)
  const accentB = (i: number) => s.accentB[i] * stems('b', 'drums', i * dt)
  const kickA = (i: number) => s.passA.low[i] * stems('a', 'drums', i * dt)
  const kickB = (i: number) => s.passB.low[i] * stems('b', 'drums', i * dt)

  // Two voices at once (each heard, each where its song sings).
  const assumed = a.vocalsAssumed || b.vocalsAssumed
  for (const [from, to] of runs(count, dt, (i) => hasB[i] === 1 && voiceA(i) > R.VOICE_HEARD && voiceB(i) > R.VOICE_HEARD && !!spanAt(a.vocals, posA[i]) && !!spanAt(b.vocals, posB[i])))
    issues.push({ kind: 'voices', severity: assumed ? 'info' : 'warn', from, to, message: `Zwei Stimmen gleichzeitig (${seconds(to - from)})${assumed ? ', Gesang vermutet' : ''}` })

  // Two basslines (where the songs carry a bass there).
  for (const [from, to] of runs(count, dt, (i) => hasB[i] === 1 && s.passA.low[i] * a.bandsAt(posA[i]).low > 0.5 && s.passB.low[i] * b.bandsAt(posB[i]).low > 0.5, 0.1))
    issues.push({ kind: 'basslines', severity: 'warn', from, to, message: `Zwei Basslines übereinander (${seconds(to - from)})` })

  // Clashing keys: both decks' tonal parts (chords, leads, voices) heard together for more than a beat.
  if (harmonicScore(a, b) < R.KEY_CLASH && Math.min(a.keyClarity, b.keyClarity) >= 0.3) {
    const tonal = (pass: typeof s.passA, i: number, other: number) => Math.max(pass.mid[i], 0.5 * pass.high[i]) * other
    for (const [from, to] of runs(count, dt, (i) => hasB[i] === 1 && tonal(s.passA, i, stems('a', 'instrumental', i * dt)) > 0.3 && tonal(s.passB, i, stems('b', 'instrumental', i * dt)) > 0.3, beatA))
      issues.push({ kind: 'keyClash', severity: 'warn', from, to, message: `Tonarten beißen sich (${seconds(to - from)})` })
  }

  // A's exit: the last moment any of A's bands is heard.
  let exit = -1
  for (let i = 0; i < count; i++) if (Math.max(s.passA.low[i], s.passA.mid[i], s.passA.high[i]) >= R.BEAT_HEARD) exit = i
  const aGone = Math.min(t.length, s.aGone)

  // Energy jump: B over the 3 s after A is gone against A. A rise counts against the louder of A's body (intro and
  // outro aside) and A over the 3 s before B came in, so a song that just ends soft isn't held against B; a drop
  // against the softer of the two.
  {
    const bodyA = levelOver(a, a.introEnd, a.outroStart > a.introEnd ? a.outroStart : a.end)
    const atA = deckPosition(t, 'a', Math.max(t.bAt, s.bHere)) ?? t.aOut
    const preA = levelOver(a, atA - 3, atA)
    const pb = deckPosition(t, 'b', aGone)
    const after = pb === null ? 0 : levelOver(b, pb, pb + 3)
    const to = Math.min(t.length, aGone + 3)
    if (bodyA > 0 && preA > 0 && after > 0) {
      const rise = 20 * Math.log10(after / Math.max(bodyA, preA))
      const drop = 20 * Math.log10(Math.min(bodyA, preA) / after)
      if (rise > R.MAX_RISE_DB) issues.push({ kind: 'energyJump', severity: 'warn', from: aGone, to, deck: 'b', message: `B ist ${rise.toFixed(1).replace('.', ',')} dB lauter als A` })
      else if (drop > 9) issues.push({ kind: 'energyJump', severity: 'warn', from: aGone, to, deck: 'b', message: `Energie bricht ein (${drop.toFixed(1).replace('.', ',')} dB leiser als A)` })
    }
  }

  // B in full (volume and every band) over the 2 beats before A's last sound, in a blend (both decks loud together for
  // a bar or more; fades and echoes hand over differently).
  let together = 0
  for (let i = 0; i < count; i++) if (hasB[i] === 1 && s.gainA[i] >= 0.5 && s.gainB[i] >= 0.5) together += dt
  if (exit > 0 && together >= 4 * beatA) {
    const from = Math.max(0, exit - Math.round((2 * beatA) / dt))
    let ready = true
    // (B's mids and highs may still be held back while A's carry them: B held under a low-pass opens as A's accents
    // end. Missing is where neither deck carries them.)
    let thin = 0
    for (let i = from; i <= exit && ready; i++) {
      const upper = Math.max(Math.min(s.passB.mid[i], s.passB.high[i]), Math.min(s.passA.mid[i], s.passA.high[i]))
      if (s.gainB[i] < 0.9 || s.passB.low[i] < 0.8) ready = false
      if (upper < 0.5) thin += dt
    }
    if (thin > beatA / 2) ready = false
    if (!ready) issues.push({ kind: 'notReady', severity: 'info', from: from * dt, to: exit * dt, deck: 'b', message: 'B ist noch nicht voll da, wenn A geht' })
  }

  // A's bands come back up after going down (A only ever goes out), and B dips after it was in full.
  for (const band of ['low', 'mid', 'high'] as const) {
    let least = Infinity
    for (let i = 0; i < count; i++) {
      const v = s.passA[band][i]
      if (v < least) least = v
      else if (v - least > 0.25 && least < 0.6) {
        const names = { low: 'Bass', mid: 'Mitten', high: 'Höhen' }
        issues.push({ kind: 'bandBack', severity: 'info', from: i * dt, to: Math.min(t.length, i * dt + beatA), deck: 'a', message: `A: ${names[band]} kommen wieder hoch` })
        break
      }
    }
  }

  // Beats: where both decks' beats are heard, their tempos must meet and their beats line up; on bars without clear
  // attacks they may flam.
  // (Tempos from each song's own grid where it plays, times its rate: a song's global BPM may not hold everywhere.)
  const tempoApart = (i: number) => {
    const time = i * dt
    const ta = (60 / periodAt(a, posA[i])) * rateAt(t.rateA, time)
    const tb = (60 / periodAt(b, posB[i])) * rateAt(t.rateB, time)
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false
    return Math.min(...[1, 2, 0.5].map((m) => Math.abs((tb * m) / ta - 1))) > 0.02
  }
  const beatsHeard = (i: number) => hasB[i] === 1 && (accentA(i) >= R.BEAT_HEARD || kickA(i) >= R.KICK_HEARD) && (accentB(i) >= R.BEAT_HEARD || kickB(i) >= R.KICK_HEARD)
  for (const [from, to] of runs(count, dt, (i) => beatsHeard(i) && tempoApart(i), beatA))
    issues.push({ kind: 'beatsApart', severity: 'warn', from, to, message: `Tempi passen nicht, die Beats laufen auseinander (${seconds(to - from)})` })
  {
    // Phase: how far B's beats sit from A's (in A's seconds), median over the samples where both are heard.
    const offsets: number[] = []
    for (let i = 0; i < count; i++) {
      if (!beatsHeard(i) || tempoApart(i)) continue
      const pa = beatPhase(a, posA[i])
      const pb = beatPhase(b, posB[i])
      if (!Number.isFinite(pa) || !Number.isFinite(pb)) continue
      let d = (pb - pa) % 1
      if (d > 0.5) d -= 1
      if (d < -0.5) d += 1
      offsets.push(Math.abs(d) * beatA)
    }
    if (offsets.length * dt >= beatA) {
      offsets.sort((x, y) => x - y)
      const median = offsets[offsets.length >> 1]
      if (median > 0.025) {
        const both = runs(count, dt, beatsHeard, beatA)
        const span = both.length > 0 ? both[0] : [t.bAt, t.length]
        issues.push({ kind: 'beatsApart', severity: 'warn', from: span[0], to: span[1], message: `Beats versetzt (${Math.round(median * 1000)} ms)` })
      }
    }
  }
  const scattered = (track: PreparedTrack, pos: number, level: number) => {
    const c = track.clarityBetween(pos, pos + 0.01)
    return Number.isFinite(c) && c <= R.SCATTERED && level >= R.BEAT_HEARD
  }
  const flam = (i: number) => {
    if (hasB[i] !== 1) return false
    const la = accentA(i)
    const lb = accentB(i)
    const fa = scattered(a, posA[i], la)
    const fb = scattered(b, posB[i], lb)
    const heardA = la >= (fb ? R.ACCENT_FAINT : R.BEAT_HEARD)
    const heardB = lb >= (fa ? R.ACCENT_FAINT : R.BEAT_HEARD)
    if (heardA && heardB && Math.min(a.clarityBetween(posA[i], posA[i] + 0.01), b.clarityBetween(posB[i], posB[i] + 0.01)) < R.MIN_VERIFIABLE) return true
    return kickA(i) >= R.KICK_HEARD && kickB(i) >= R.KICK_HEARD && Math.min(a.kickClarityBetween(posA[i], posA[i] + 0.01), b.kickClarityBetween(posB[i], posB[i] + 0.01)) < R.MIN_VERIFIABLE
  }
  for (const [from, to] of runs(count, dt, flam, beatA / 2))
    issues.push({ kind: 'flamRisk', severity: 'info', from, to, message: 'Beats ohne klare Schläge: können flammen (Hi-Hats/Snare eines Decks leiser machen)' })

  // A gone in the middle of a line; B heard from the middle of one.
  {
    const at = deckPosition(t, 'a', aGone)
    const line = at === null ? undefined : spanAt(a.vocals, at)
    // (A matter of taste: a cut on a drop masks it.)
    if (at !== null && line && line.end - at > 0.3 && at - line.start > 0.3)
      issues.push({ kind: 'lineCut', severity: 'info', from: Math.max(0, aGone - 0.5), to: aGone, deck: 'a', message: 'A geht mitten in einer Gesangszeile' })
    // B entered on a sung line's middle, its voice heard: a warning unless B comes in filtered (a tease under A).
    const bHere = Math.max(t.bAt, s.bHere)
    const pos = deckPosition(t, 'b', bHere)
    const lines = Array.isArray(b.mix.lines) && b.mix.vocalSource === 'lyrics' ? b.mix.lines : []
    const inLine = pos !== null && lines.find((l) => pos > Math.max(l.time, l.wordTimes?.[0] ?? l.time) + 0.15 && pos < l.end)
    if (inLine) {
      const filtered = Math.abs(valueAt(t.b.filter, bHere, 0)) >= 0.4
      issues.push({ kind: 'lineCut', severity: filtered ? 'info' : 'warn', from: bHere, to: Math.min(t.length, bHere + 0.5), deck: 'b', message: 'B setzt mitten in einer Gesangszeile ein' })
    }
  }
  return issues.sort((x, y) => x.from - y.from)
}

export interface SuggestedPoint {
  /** Track seconds. */
  at: number
  label: string
  /** How good a spot it is (0–1). */
  score: number
}

export interface SuggestedLoop {
  deck: 'a' | 'b'
  /** Track seconds, whole bars. */
  from: number
  to: number
  bars: number
  label: string
}

export interface Suggestions {
  /** Where A can go out (A's track seconds), best first. */
  outPoints: SuggestedPoint[]
  /** Where B can come in (B's track seconds), best first. */
  inPoints: SuggestedPoint[]
  /** Stretches that loop well: bars repeating the ones before them, or whole phrases without singing. */
  loops: SuggestedLoop[]
  /** The planner's variants as starting points ("Vorschläge"), best first. */
  presets: Array<{ id: string; label: string; transition: Transition }>
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function points(track: PreparedTrack, anchors: Array<{ t: number; bonus: number; drop: boolean; chorus: boolean }>, what: 'out' | 'in'): SuggestedPoint[] {
  const top = Math.max(0.0001, ...anchors.map((x) => x.bonus))
  return anchors
    .map((x) => {
      const kind = x.drop ? 'Drop' : x.chorus ? 'Refrain' : Math.abs(x.t - (what === 'out' ? track.outroStart : track.introEnd)) < 0.1 ? (what === 'out' ? 'Outro' : 'Ende Intro') : track.cuesIn.concat(track.cuesOut).some((c) => Math.abs(c - x.t) < 2 * track.period) ? 'Cue' : 'Phrase'
      const sings = spanAt(track.vocals, x.t + 0.05) ? 0.3 : 0
      return { at: x.t, label: `${kind} ${clock(x.t)}`, score: Math.max(0, Math.min(1, 0.5 + (0.5 * x.bonus) / top - sings)) }
    })
    .sort((p, q) => q.score - p.score || p.at - q.at)
}

function loops(track: PreparedTrack, deck: 'a' | 'b'): SuggestedLoop[] {
  const out: SuggestedLoop[] = []
  const bars = track.downbeats
  const repeat: unknown = track.mix.barRepeat
  // Bars that repeat the ones before them (a looped figure): runs of 2, 4 or 8 bars.
  if (Array.isArray(repeat)) {
    let start = -1
    for (let i = 0; i <= bars.length; i++) {
      const r = i < bars.length ? Number(repeat[i]) : 0
      if (r >= 0.85 && i < bars.length - 1) {
        if (start < 0) start = i
        continue
      }
      if (start >= 0) {
        const n = [8, 4, 2].find((k) => i - start >= k)
        if (n !== undefined && bars[start + n] !== undefined) out.push({ deck, from: bars[start], to: bars[start + n], bars: n, label: `${n}-Takt-Loop ${clock(bars[start])}` })
        start = -1
      }
    }
  }
  // Whole 4- and 8-bar phrases without singing, in the part of the song the deck plays in a transition.
  const zone = deck === 'a' ? [track.duration * 0.5, track.end] : [track.start, track.duration * 0.5]
  for (const p of track.phraseGrid) {
    if (p < zone[0] || p > zone[1]) continue
    const k = floorIndex(bars, p + 0.01)
    for (const n of [8, 4]) {
      const end = bars[k + n]
      if (end === undefined || end > track.end) continue
      if (track.sungSeconds(p, end) > 0.2) continue
      if (out.some((l) => Math.abs(l.from - p) < 0.1 && l.bars === n)) continue
      out.push({ deck, from: p, to: end, bars: n, label: `${n} Takte ohne Gesang ${clock(p)}` })
      break
    }
  }
  return out.sort((x, y) => x.from - y.from)
}

/**
 * What the editor offers to start from for A into B: A's out points and B's in points (the planner's anchors, labelled
 * and scored), loopable stretches on both decks, and the planner's variants as presets.
 */
export function suggestions(aMix: TrackMix | null, bMix: TrackMix | null, ids: { from: string; to: string }, style: MixStyle, opts: { count?: number } = {}): Suggestions {
  const a = prepareTrack(aMix)
  const b = prepareTrack(bMix)
  const presets = planVariants(aMix, bMix, ids, style, { count: opts.count ?? 4 }).map((v, i) => ({ id: `v${i + 1}`, label: v.label, transition: v.transition }))
  if (!a || !b) return { outPoints: [], inPoints: [], loops: [], presets }
  return {
    outPoints: points(a, R.outAnchors(a, style), 'out'),
    inPoints: points(b, R.inAnchors(b, style), 'in'),
    loops: [...loops(a, 'a'), ...loops(b, 'b')],
    presets,
  }
}
