import type { Transition } from '../types.ts'
import { LANES, laneKeys, laneValue, xOf, type Axis, type Column, type Deck, type LaneParam } from './timeline-math.ts'

/**
 * Drawing the editor's canvases. The timeline is a dark studio surface in both themes (the band colours need it): the
 * overlap is a lighter card, the rest of each song dimmed, as in the user's reference (Spotify's mix editor).
 */

export const STUDIO = {
  surface: '#141414',
  card: '#242424',
  grid: 'rgba(255,255,255,0.07)',
  bar: 'rgba(255,255,255,0.16)',
  label: 'rgba(255,255,255,0.72)',
  /** Bands, outermost first: bass, mids, highs. */
  low: '#2440c8',
  mid: '#c47a35',
  high: '#f4e4cc',
  vocal: '#ff6fb5',
  /** Overlaid curves: volume, bass, highs. */
  gain: '#38bdf8',
  lowCurve: '#f472d0',
  highCurve: '#facc15',
  handle: '#ffffff',
}

/** The lane colours (one per parameter, the same for both decks). */
export const LANE_COLOR: Record<LaneParam, string> = {
  gain: STUDIO.gain,
  low: STUDIO.lowCurve,
  mid: '#fb923c',
  high: STUDIO.highCurve,
  filter: '#a78bfa',
  reverb: '#5eead4',
  rate: '#f87171',
  drums: '#fbbf24',
  vocals: STUDIO.vocal,
  instrumental: '#86efac',
}

/** A canvas sized for its CSS box at the screen's pixel density; returns its 2D context scaled to CSS pixels. */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
  }
  const g = canvas.getContext('2d')!
  g.setTransform(ratio, 0, 0, ratio, 0, 0)
  g.clearRect(0, 0, width, height)
  return g
}

export interface DeckDrawing {
  deck: Deck
  columns: Array<Column | null>
  /** What the deck leaves out (A's cut end, B's skipped start), drawn faintly. */
  ghost: Array<Column | null>
  /** Bar and beat lines (transition time). */
  bars: number[]
  /** Phrase starts (transition time), drawn stronger. */
  phrases: number[]
}

/**
 * One deck's half of the visualizer: its waveform in band colours as heard (its volume and EQ lanes applied), singing
 * underlined, bar lines, and its volume / bass / highs curves on top.
 */
export function drawDeck(g: CanvasRenderingContext2D, axis: Axis, transition: Transition, drawing: DeckDrawing, top: number, height: number) {
  const width = drawing.columns.length
  const middle = top + height / 2
  const reach = height / 2 - 10
  const inside = (t: number) => t >= 0 && t <= transition.length

  // Bar lines first (under the waveform).
  for (const t of drawing.bars) {
    const x = Math.round(xOf(axis, t)) + 0.5
    g.fillStyle = STUDIO.grid
    g.fillRect(x, top + 4, 1, height - 8)
  }
  for (const t of drawing.phrases) {
    const x = Math.round(xOf(axis, t)) + 0.5
    g.fillStyle = STUDIO.bar
    g.fillRect(x, top + 4, 1, height - 8)
  }

  // Left out: plain and faint.
  g.globalAlpha = 0.16
  for (let x = 0; x < drawing.ghost.length; x++) {
    const column = drawing.ghost[x]
    if (!column) continue
    const total = Math.min(1, column.energy) * reach
    g.fillStyle = STUDIO.high
    g.fillRect(x, middle - total, 1, total * 2)
  }
  g.globalAlpha = 1

  for (let x = 0; x < width; x++) {
    const column = drawing.columns[x]
    if (!column) continue
    const t = axis.from + (x + 0.5) / axis.pxPerSecond
    const deck = drawing.deck
    const eqLow = laneValue(transition, deck, 'low', t)
    const eqMid = laneValue(transition, deck, 'mid', t)
    const eqHigh = laneValue(transition, deck, 'high', t)
    // Outside the transition the deck plays as is.
    const level = inside(t) ? laneValue(transition, deck, 'gain', t) : 1
    const l = column.low * (inside(t) ? eqLow : 1)
    const m = column.mid * (inside(t) ? eqMid : 1)
    const h = column.high * (inside(t) ? eqHigh : 1)
    const sum = column.low + column.mid + column.high || 1
    const total = Math.min(1, column.energy * level * ((l + m + h) / sum)) * reach
    if (total <= 0.2) continue
    const share = l + m + h || 1
    g.globalAlpha = inside(t) ? 1 : 0.38
    g.fillStyle = STUDIO.low
    g.fillRect(x, middle - total, 1, total * 2)
    const midPart = total * ((m + h) / share)
    g.fillStyle = STUDIO.mid
    g.fillRect(x, middle - midPart, 1, midPart * 2)
    const highPart = total * (h / share)
    g.fillStyle = STUDIO.high
    g.fillRect(x, middle - highPart, 1, highPart * 2)
    if (column.vocal) {
      g.fillStyle = STUDIO.vocal
      g.fillRect(x, top + height - 4, 1, 3)
    }
  }
  g.globalAlpha = 1

  // Volume, bass and highs over the transition (top of the half = 1).
  const curve = (param: LaneParam, color: string) => {
    if (!laneKeys(transition, drawing.deck, param).length) return
    g.strokeStyle = color
    g.lineWidth = 2
    g.beginPath()
    const from = Math.max(0, Math.floor(xOf(axis, 0)))
    const to = Math.min(width, Math.ceil(xOf(axis, transition.length)))
    for (let x = from; x <= to; x++) {
      const t = axis.from + x / axis.pxPerSecond
      const y = top + height - 6 - laneValue(transition, drawing.deck, param, t) * (height - 12)
      if (x === from) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
  }
  curve('high', STUDIO.highCurve)
  curve('low', STUDIO.lowCurve)
  curve('gain', STUDIO.gain)
}

/** The transition as a card behind both decks: from its start (A at `aOut`) to A's end. */
export function drawCard(g: CanvasRenderingContext2D, axis: Axis, transition: Transition, height: number) {
  const x0 = xOf(axis, 0)
  const x1 = xOf(axis, transition.length)
  g.fillStyle = STUDIO.card
  g.beginPath()
  g.roundRect(x0, 2, Math.max(2, x1 - x0), height - 4, 12)
  g.fill()
}

/** One lane row: its curve over the whole axis, the neutral line, and its keyframes as handles. */
export function drawLane(
  g: CanvasRenderingContext2D,
  axis: Axis,
  transition: Transition,
  deck: Deck,
  param: LaneParam,
  width: number,
  height: number,
  selected: number | null,
) {
  const spec = LANES[param]
  const yOf = (v: number) => height - 8 - ((v - spec.min) / (spec.max - spec.min)) * (height - 16)
  // The transition's span, lighter.
  g.fillStyle = 'rgba(255,255,255,0.035)'
  g.fillRect(xOf(axis, 0), 0, xOf(axis, transition.length) - xOf(axis, 0), height)
  // Neutral line.
  g.fillStyle = 'rgba(255,255,255,0.10)'
  g.fillRect(0, Math.round(yOf(spec.neutral)) + 0.5, width, 1)
  const keys = laneKeys(transition, deck, param)
  const color = LANE_COLOR[param]
  g.strokeStyle = color
  g.globalAlpha = keys.length ? 1 : 0.35
  g.lineWidth = 2
  g.beginPath()
  for (let x = 0; x <= width; x += 2) {
    const y = yOf(laneValue(transition, deck, param, axis.from + x / axis.pxPerSecond))
    if (x === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke()
  g.globalAlpha = 1
  keys.forEach((key, i) => {
    const x = xOf(axis, key.t)
    const y = yOf(key.v)
    g.beginPath()
    g.arc(x, y, i === selected ? 9 : 8, 0, Math.PI * 2)
    g.fillStyle = i === selected ? STUDIO.handle : color
    g.fill()
    g.lineWidth = 2
    g.strokeStyle = i === selected ? color : STUDIO.surface
    g.stroke()
  })
}

/** The y of a value in a lane row (the same mapping as `drawLane`). */
export function laneY(param: LaneParam, value: number, height: number) {
  const spec = LANES[param]
  return height - 8 - ((value - spec.min) / (spec.max - spec.min)) * (height - 16)
}

/** The value at y in a lane row. */
export function laneValueAtY(param: LaneParam, y: number, height: number) {
  const spec = LANES[param]
  return spec.min + ((height - 8 - y) / (height - 16)) * (spec.max - spec.min)
}
