import '@fontsource/figtree/latin-600.css'
import '@fontsource/figtree/latin-700.css'
import '@fontsource/figtree/latin-900.css'
import '@fontsource/archivo-black/latin-400.css'

/**
 * The covers of the official playlists, drawn on a canvas after the "Cover-Werkstatt" designs: one style per kind of
 * playlist, so a kind looks like one series and the kinds look different from each other.
 * - Genre mixes: "Mix", a pattern of rings, octagons, arcs or capsules in the accent colour, the title at the bottom
 *   beside an accent bar.
 * - "This is …": "Foto", the artist's photo filling the cover, the name in slanted accent bars.
 * - Moods: "Stimmung", soft lights on a dark ground with grain, in the mood's own colours.
 * - Made for you (on repeat, rewind, discoveries, …): "Emblem", a flat colour with one sign of its own per playlist.
 * - The daylist: a sky in the colours of the hour, with sun or moon over a horizon.
 * Colours and pattern follow from the playlist's slug, so each playlist keeps its look.
 * Everything is laid out on a 1080 × 1080 grid and scaled to the canvas.
 */
export type CoverStyle = 'mix' | 'foto' | 'stimmung' | 'block' | 'emblem' | 'daylist'

export interface CoverSpec {
  style: CoverStyle
  seed: string
  title: string
  subtitle?: string
  /** One letter in a corner dot: the platform's mark. */
  mark?: string
  /** The platform account's picture, filling the corner dot instead of the letter. */
  markImage?: HTMLImageElement | null
  photo?: HTMLImageElement | null
  /** Emblem: which sign (the playlist's kind); Stimmung: which mood (its slug) picks the colours. */
  motif?: string
}

const S = 1080
const FIGTREE = '"Figtree", sans-serif'
const TITLE_FONT = { mix: FIGTREE, stimmung: FIGTREE, emblem: FIGTREE, daylist: FIGTREE, foto: '"Archivo Black", "Arial Black", sans-serif', block: '"Archivo Black", "Arial Black", sans-serif' }
const TITLE_WEIGHT = { mix: 900, stimmung: 900, emblem: 900, daylist: 900, foto: 400, block: 400 }
const SUB_FONT = '"Figtree", sans-serif'

interface Palette {
  bg: string
  bg2: string
  accent: string
  ink: string
}

const PALETTES: Record<CoverStyle, Palette[]> = {
  mix: [
    { bg: '#5e1238', bg2: '#000000', accent: '#ff3d9a', ink: '#ffffff' },
    { bg: '#5a2d05', bg2: '#000000', accent: '#f08a1c', ink: '#ffffff' },
    { bg: '#24107e', bg2: '#000000', accent: '#8f7dff', ink: '#ffffff' },
    { bg: '#0b4733', bg2: '#000000', accent: '#2fd28a', ink: '#ffffff' },
    { bg: '#0f3563', bg2: '#000000', accent: '#4aa8ff', ink: '#ffffff' },
    { bg: '#5f1010', bg2: '#000000', accent: '#ff5a4a', ink: '#ffffff' },
    { bg: '#4d4708', bg2: '#000000', accent: '#e8d630', ink: '#ffffff' },
    { bg: '#183b44', bg2: '#000000', accent: '#5fd6e6', ink: '#ffffff' },
  ],
  stimmung: [
    { bg: '#07080c', bg2: '#cfc3ff', accent: '#3a5a8c', ink: '#ffffff' },
    { bg: '#0b0706', bg2: '#ffb37a', accent: '#a33a2c', ink: '#ffffff' },
    { bg: '#050a08', bg2: '#b7ffd9', accent: '#1f6b55', ink: '#ffffff' },
    { bg: '#0a0610', bg2: '#ff8fd1', accent: '#5a2a8c', ink: '#ffffff' },
    { bg: '#0a0a06', bg2: '#fff2a8', accent: '#7a5a12', ink: '#ffffff' },
    { bg: '#06090f', bg2: '#9fe4ff', accent: '#1a3f7a', ink: '#ffffff' },
  ],
  block: [
    { bg: '#3a3a40', bg2: '#8a8f99', accent: '#19e68c', ink: '#0d0d0d' },
    { bg: '#2b2a5a', bg2: '#8c86c9', accent: '#ff4fa3', ink: '#ffffff' },
    { bg: '#4a3020', bg2: '#c9946a', accent: '#ffe14d', ink: '#121212' },
    { bg: '#17363f', bg2: '#7fb3bf', accent: '#ff6a2c', ink: '#ffffff' },
    { bg: '#262626', bg2: '#777777', accent: '#e9e4d8', ink: '#111111' },
  ],
  foto: [
    { bg: '#3a4a5e', bg2: '#c2a68a', accent: '#3b2bdc', ink: '#ffffff' },
    { bg: '#2d2d2d', bg2: '#8a8a8a', accent: '#e8152f', ink: '#ffffff' },
    { bg: '#3f2a4a', bg2: '#e6a6b6', accent: '#ffd400', ink: '#111111' },
    { bg: '#1d3b2f', bg2: '#a8c49a', accent: '#111111', ink: '#ffffff' },
    { bg: '#4a2c1a', bg2: '#e0b07a', accent: '#ff5a1f', ink: '#ffffff' },
  ],
  emblem: [{ bg: '#2b2a8c', bg2: '#1a1760', accent: '#ff4fa3', ink: '#ffffff' }],
  daylist: [{ bg: '#0b1026', bg2: '#2b2f77', accent: '#fff3b0', ink: '#ffffff' }],
}
/** The moods' own lights, so "Sad" never looks like "Good vibes". */
const MOOD_PALETTES: Record<string, Palette> = {
  'mood-upbeat': { bg: '#0c0903', bg2: '#fff09a', accent: '#c9860c', ink: '#ffffff' },
  'mood-cozy': { bg: '#0d0705', bg2: '#ffc79a', accent: '#8f3d18', ink: '#ffffff' },
  'mood-motivation': { bg: '#0d0405', bg2: '#ff9a6a', accent: '#b5121f', ink: '#ffffff' },
  'mood-running': { bg: '#040b06', bg2: '#d2ff7a', accent: '#1f7a3c', ink: '#ffffff' },
  'mood-sad': { bg: '#05070f', bg2: '#bccbff', accent: '#25408c', ink: '#ffffff' },
}
/** Each Made-for-you playlist's colours: ground (bg → bg2), the sign's gradient (accent → glyph2), the title. */
const EMBLEMS: Record<string, Palette & { glyph2: string }> = {
  month: { bg: '#3524b8', bg2: '#1c1470', accent: '#ff5fa8', glyph2: '#ff9a3c', ink: '#ffffff' },
  rediscover: { bg: '#7a1fd1', bg2: '#3d0f80', accent: '#ff4f8b', glyph2: '#ffb3d0', ink: '#ffffff' },
  top: { bg: '#0f7a5c', bg2: '#06402f', accent: '#c6ff4d', glyph2: '#3ee6a0', ink: '#ffffff' },
  discover: { bg: '#f0561e', bg2: '#a3200f', accent: '#fff4d6', glyph2: '#ffd36b', ink: '#ffffff' },
  radar: { bg: '#0c2f66', bg2: '#05132e', accent: '#5ff2ff', glyph2: '#2b8cff', ink: '#ffffff' },
  phase: { bg: '#3a0d5c', bg2: '#12051f', accent: '#ff3dbb', glyph2: '#ff9ae0', ink: '#ffffff' },
  new: { bg: '#ffd23f', bg2: '#f59a12', accent: '#1a1206', glyph2: '#5a3a08', ink: '#1a1206' },
}
const PATTERNS = ['ringe', 'achtecke', 'boegen', 'kapseln', 'gemischt'] as const
type Pattern = (typeof PATTERNS)[number]

// ---- helpers ----

function hash(value: string) {
  let h = 0
  for (const char of value) h = (Math.imul(h, 31) + char.charCodeAt(0)) | 0
  return Math.abs(h)
}
function rgb(color: string) {
  const n = parseInt(color.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function hex(channels: number[]) {
  return `#${channels.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}
function mix(a: string, b: string, t: number) {
  const A = rgb(a)
  const B = rgb(b)
  return hex(A.map((v, i) => v + (B[i]! - v) * t))
}
function rgba(color: string, alpha: number) {
  const [r, g, b] = rgb(color)
  return `rgba(${r},${g},${b},${alpha})`
}
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100000) / 100000
  }
}

function setFont(ctx: CanvasRenderingContext2D, family: string, weight: number, size: number, track = -0.03) {
  ctx.font = `${weight} ${size}px ${family}`
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${track * size}px`
}

/** The biggest size (down to `min`) at which the text wraps into the box. */
function fit(ctx: CanvasRenderingContext2D, text: string, family: string, weight: number, maxW: number, maxH: number, max: number, min: number, lineHeight: number) {
  let result = { size: min, lines: [text] }
  for (let size = max; size >= min; size -= 2) {
    setFont(ctx, family, weight, size)
    const lines: string[] = []
    let ok = true
    let line = ''
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width <= maxW) line = next
      else {
        if (line) lines.push(line)
        line = word
        if (ctx.measureText(word).width > maxW) ok = false
      }
    }
    lines.push(line)
    result = { size, lines }
    if (ok && lines.length * size * lineHeight <= maxH) return result
  }
  return result
}

/** Draws a line, squeezed sideways if it is still too wide at the smallest size. */
function fillLine(ctx: CanvasRenderingContext2D, line: string, x: number, y: number, maxW: number) {
  const width = ctx.measureText(line).width
  if (width <= maxW) return ctx.fillText(line, x, y)
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(maxW / width, 1)
  ctx.fillText(line, 0, 0)
  ctx.restore()
}

let noise: HTMLCanvasElement | null = null
function grain(ctx: CanvasRenderingContext2D, alpha: number) {
  if (!noise) {
    noise = document.createElement('canvas')
    noise.width = noise.height = 180
    const g = noise.getContext('2d')!
    const data = g.createImageData(180, 180)
    for (let i = 0; i < data.data.length; i += 4) {
      const v = Math.random() * 255
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v
      data.data[i + 3] = 255
    }
    g.putImageData(data, 0, 0)
  }
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = 'overlay'
  ctx.fillStyle = ctx.createPattern(noise, 'repeat')!
  ctx.fillRect(0, 0, S, S)
  ctx.restore()
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, rgba(color, alpha))
  g.addColorStop(0.55, rgba(color, alpha * 0.45))
  g.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(x - r, y - r, r * 2, r * 2)
}

/** The photo filling a box (cropped to cover it), or a soft gradient in the palette while there is none. */
function photo(ctx: CanvasRenderingContext2D, image: HTMLImageElement | null | undefined, p: Palette, seed: number, x: number, y: number, w: number, h: number) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  if (image?.naturalWidth) {
    const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight)
    const dw = image.naturalWidth * scale
    const dh = image.naturalHeight * scale
    // Faces sit in the upper part of artist photos: crop from a fifth down rather than the middle.
    ctx.drawImage(image, x - (dw - w) / 2, y - (dh - h) * 0.2, dw, dh)
  } else {
    const g = ctx.createLinearGradient(x, y, x + w, y + h)
    g.addColorStop(0, p.bg)
    g.addColorStop(1, p.bg2)
    ctx.fillStyle = g
    ctx.fillRect(x, y, w, h)
    const r = rng(seed + 99)
    for (let i = 0; i < 4; i++) glow(ctx, x + r() * w, y + r() * h, (0.3 + r() * 0.4) * Math.max(w, h), i % 2 ? p.bg2 : mix(p.bg, '#ffffff', 0.25), 0.55)
  }
  ctx.restore()
}

function cornerMark(ctx: CanvasRenderingContext2D, text: string | undefined, image: HTMLImageElement | null | undefined, x: number, y: number, fill: string, ink: string) {
  const r = S * 0.034
  if (image?.naturalWidth) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.clip()
    const scale = (2 * r) / Math.min(image.naturalWidth, image.naturalHeight)
    ctx.drawImage(image, x - (image.naturalWidth * scale) / 2, y - (image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale)
    ctx.restore()
    return
  }
  if (!text) return
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  setFont(ctx, SUB_FONT, 900, r * 1.15, 0)
  ctx.fillText(text.slice(0, 1).toUpperCase(), x, y + r * 0.05)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function shape(ctx: CanvasRenderingContext2D, type: Exclude<Pattern, 'gemischt'>, r: number) {
  ctx.beginPath()
  if (type === 'ringe') ctx.arc(0, 0, r, 0, Math.PI * 2)
  else if (type === 'achtecke') {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
    }
    ctx.closePath()
  } else if (type === 'boegen') ctx.arc(0, r * 0.3, r, Math.PI, 0)
  else {
    ctx.moveTo(-r * 0.95, 0)
    ctx.lineTo(r * 0.95, 0)
  }
  ctx.stroke()
}

// ---- the styles ----

function drawMix(ctx: CanvasRenderingContext2D, spec: CoverSpec, p: Palette, seed: number) {
  const g = ctx.createLinearGradient(S, 0, 0, S)
  g.addColorStop(0, mix(p.bg, p.accent, 0.18))
  g.addColorStop(1, mix(p.bg, '#000000', 0.45))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)

  const r = rng(seed)
  const pattern = PATTERNS[seed % PATTERNS.length]!
  const types = ['ringe', 'achtecke', 'boegen', 'kapseln'] as const
  ctx.save()
  ctx.strokeStyle = p.accent
  ctx.lineWidth = S * 0.058
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.translate(S * (0.6 + r() * 0.12), S * (0.1 + r() * 0.1))
  ctx.rotate(-0.75 + r() * 0.3)
  const spacing = S * 0.3
  for (let i = -3; i <= 3; i++)
    for (let j = -3; j <= 3; j++) {
      ctx.save()
      ctx.translate(i * spacing + (j % 2) * spacing * 0.5, j * spacing * 0.9)
      const type = pattern === 'gemischt' ? types[Math.abs(i * 3 + j * 5 + seed) % 4]! : pattern
      ctx.rotate(type === 'kapseln' || type === 'boegen' ? ((i + j) % 2) * (Math.PI / 2) : 0)
      shape(ctx, type, S * 0.095)
      ctx.restore()
    }
  ctx.restore()

  const dark = mix(p.bg, '#000000', 0.35)
  const fade = ctx.createLinearGradient(0, S, S * 0.72, S * 0.18)
  fade.addColorStop(0, rgba(dark, 0.97))
  fade.addColorStop(0.42, rgba(dark, 0.75))
  fade.addColorStop(1, rgba(dark, 0))
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, S, S)

  const family = TITLE_FONT.mix
  const weight = TITLE_WEIGHT.mix
  const x = S * 0.12
  const bottom = S * 0.9
  const lineHeight = 1
  const fitted = fit(ctx, spec.title, family, weight, S * 0.78, S * 0.25, 104, 48, lineHeight)
  setFont(ctx, family, weight, fitted.size)
  ctx.fillStyle = p.ink
  const lh = fitted.size * lineHeight
  fitted.lines.forEach((line, i) => fillLine(ctx, line, x, bottom - (fitted.lines.length - 1 - i) * lh, S * 0.78))
  const top = bottom - (fitted.lines.length - 1) * lh - fitted.size * 0.74
  ctx.fillStyle = p.accent
  ctx.fillRect(S * 0.065, top, S * 0.022, bottom - top)
  if (spec.subtitle) {
    setFont(ctx, SUB_FONT, 700, 38, 0)
    ctx.fillStyle = rgba(p.ink, 0.72)
    fillLine(ctx, spec.subtitle, x, top - S * 0.03, S * 0.78)
  }
  cornerMark(ctx, spec.mark, spec.markImage, S * 0.075, S * 0.075, p.ink, p.bg)
}

function drawStimmung(ctx: CanvasRenderingContext2D, spec: CoverSpec, p: Palette, seed: number) {
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, S, S)
  const r = rng(seed)
  glow(ctx, S * (0.55 + r() * 0.4), S * r() * 0.3, S * (0.55 + r() * 0.25), p.accent, 0.85)
  glow(ctx, S * (0.6 + r() * 0.35), S * (0.05 + r() * 0.2), S * (0.22 + r() * 0.12), p.bg2, 0.7)
  glow(ctx, S * r() * 0.4, S * (0.5 + r() * 0.4), S * (0.4 + r() * 0.2), mix(p.accent, p.bg, 0.4), 0.45)
  const vignette = ctx.createRadialGradient(S * 0.5, S * 0.45, S * 0.3, S * 0.5, S * 0.5, S * 0.85)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,.55)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, S, S)
  grain(ctx, 0.16)

  const family = TITLE_FONT.stimmung
  const weight = TITLE_WEIGHT.stimmung
  const x = S * 0.09
  const bottom = S * 0.9
  const fitted = fit(ctx, spec.title, family, weight, S * 0.82, S * 0.36, 118, 48, 1)
  setFont(ctx, family, weight, fitted.size)
  ctx.fillStyle = p.ink
  const lh = fitted.size
  fitted.lines.forEach((line, i) => fillLine(ctx, line, x, bottom - (fitted.lines.length - 1 - i) * lh, S * 0.82))
  if (spec.subtitle) {
    const top = bottom - (fitted.lines.length - 1) * lh - fitted.size * 0.74
    setFont(ctx, SUB_FONT, 600, 36, 0)
    ctx.fillStyle = rgba(p.ink, 0.6)
    fillLine(ctx, spec.subtitle, x, top - S * 0.035, S * 0.82)
  }
  cornerMark(ctx, spec.mark, spec.markImage, S * 0.075, S * 0.075, p.ink, p.bg)
}

function drawFoto(ctx: CanvasRenderingContext2D, spec: CoverSpec, p: Palette, seed: number) {
  photo(ctx, spec.photo, p, seed, 0, 0, S, S)
  const shade = ctx.createLinearGradient(0, S * 0.45, 0, S)
  shade.addColorStop(0, 'rgba(0,0,0,0)')
  shade.addColorStop(1, 'rgba(0,0,0,.5)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, S, S)
  grain(ctx, 0.1)

  const family = TITLE_FONT.foto
  const weight = TITLE_WEIGHT.foto
  const skew = -0.16
  const x = S * 0.1
  const pad = S * 0.025
  const title = spec.title.toUpperCase()
  const fitted = fit(ctx, title, family, weight, S * 0.74, S * 0.3, 128, 56, 1.08)
  const lh = fitted.size * 1.12
  const y = S * 0.9 - (fitted.lines.length - 1) * lh
  const bar = (text: string, size: number, yy: number, font: string, fontWeight: number, background: string, ink: string) => {
    ctx.save()
    ctx.translate(x, yy)
    ctx.transform(1, 0, skew, 1, 0, 0)
    setFont(ctx, font, fontWeight, size)
    const width = Math.min(ctx.measureText(text).width, S * 0.8)
    ctx.fillStyle = background
    ctx.fillRect(-pad, -size * 0.86, width + pad * 2, size * 1.08)
    ctx.fillStyle = ink
    fillLine(ctx, text, 0, 0, S * 0.8)
    ctx.restore()
  }
  if (spec.subtitle) {
    const size = Math.round(fitted.size * 0.52)
    bar(spec.subtitle.toUpperCase(), size, y - fitted.size * 0.86 - size * 0.42, SUB_FONT, 900, '#ffffff', '#111111')
  }
  fitted.lines.forEach((line, i) => bar(line, fitted.size, y + i * lh, family, weight, p.accent, p.ink))
  cornerMark(ctx, spec.mark, spec.markImage, S * 0.075, S * 0.075, '#ffffff', '#111111')
}

/** Block: a band of colour on top with the title set large, the picture (the chart's number one) below. */
function drawBlock(ctx: CanvasRenderingContext2D, spec: CoverSpec, p: Palette, seed: number) {
  const band = S * 0.44
  photo(ctx, spec.photo, p, seed, 0, band, S, S - band)
  grain(ctx, 0.1)
  ctx.fillStyle = p.accent
  ctx.fillRect(0, 0, S, band)
  const family = TITLE_FONT.block
  const weight = TITLE_WEIGHT.block
  const x = S * 0.07
  const lineHeight = 0.95
  const fitted = fit(ctx, spec.title.toUpperCase(), family, weight, S * 0.86, band - S * (spec.subtitle ? 0.2 : 0.13), 210, 64, lineHeight)
  setFont(ctx, family, weight, fitted.size)
  ctx.fillStyle = p.ink
  const lh = fitted.size * lineHeight
  const top = S * 0.065 + fitted.size * 0.84
  fitted.lines.forEach((line, i) => fillLine(ctx, line, x, top + i * lh, S * 0.86))
  if (spec.subtitle) {
    setFont(ctx, SUB_FONT, 700, 38, 0)
    ctx.fillStyle = rgba(p.ink, 0.8)
    fillLine(ctx, spec.subtitle.toUpperCase(), x, band - S * 0.05, S * 0.86)
  }
  cornerMark(ctx, spec.mark, spec.markImage, S * 0.93, S * 0.075, p.ink, p.accent)
}

/** The title at the bottom left, a smaller line above it; shared by Emblem and the daylist. */
function bottomTitle(ctx: CanvasRenderingContext2D, spec: CoverSpec, ink: string, max: number, maxH: number, shadow = false) {
  const x = S * 0.09
  const bottom = S * 0.9
  const fitted = fit(ctx, spec.title, FIGTREE, 900, S * 0.82, maxH, max, 48, 1)
  ctx.save()
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,.35)'
    ctx.shadowBlur = S * 0.03
  }
  setFont(ctx, FIGTREE, 900, fitted.size)
  ctx.fillStyle = ink
  const lh = fitted.size
  fitted.lines.forEach((line, i) => fillLine(ctx, line, x, bottom - (fitted.lines.length - 1 - i) * lh, S * 0.82))
  if (spec.subtitle) {
    const top = bottom - (fitted.lines.length - 1) * lh - fitted.size * 0.74
    setFont(ctx, SUB_FONT, 700, 36, 0)
    ctx.fillStyle = rgba(ink, 0.7)
    fillLine(ctx, spec.subtitle, x, top - S * 0.035, S * 0.82)
  }
  ctx.restore()
}

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(size, 0)
  ctx.lineTo(-size * 0.6, -size * 0.85)
  ctx.lineTo(-size * 0.6, size * 0.85)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.quadraticCurveTo(x, y, x, y + r)
  ctx.quadraticCurveTo(x, y, x - r, y)
  ctx.quadraticCurveTo(x, y, x, y - r)
  ctx.fill()
}

/** The sign of one Made-for-you playlist, centred on (cx, cy), in a gradient from `a` to `b`. */
function glyph(ctx: CanvasRenderingContext2D, motif: string, cx: number, cy: number, a: string, b: string, seed: number) {
  const R = S * 0.25
  const paint = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
  paint.addColorStop(0, a)
  paint.addColorStop(1, b)
  ctx.save()
  ctx.strokeStyle = ctx.fillStyle = paint
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const r = rng(seed)
  if (motif === 'month') {
    // Two interlocked loops: the songs that keep coming round.
    const d = S * 0.075
    const rr = S * 0.15
    ctx.lineWidth = S * 0.07
    const c1 = [cx - d, cy + d] as const
    const c2 = [cx + d, cy - d] as const
    const ring = (c: readonly [number, number], from = 0, to = Math.PI * 2) => {
      ctx.beginPath()
      ctx.arc(c[0], c[1], rr, from, to)
      ctx.stroke()
    }
    ring(c1)
    ring(c2)
    // Back over the second loop where they cross, so they interlock.
    const h = Math.sqrt(rr * rr - 2 * d * d) / Math.SQRT2
    const angle = Math.atan2(cy - h - c1[1], cx + h - c1[0])
    ctx.lineCap = 'butt'
    ring(c1, angle - 0.4, angle + 0.4)
  } else if (motif === 'rediscover') {
    // Two arrows chasing round a circle, backwards: rewind.
    const rr = S * 0.17
    ctx.lineWidth = S * 0.06
    for (const start of [0.35, Math.PI + 0.35]) {
      const end = start + Math.PI - 0.95
      ctx.beginPath()
      ctx.arc(cx, cy, rr, end, start, true)
      ctx.stroke()
      arrowHead(ctx, cx + Math.cos(start) * rr, cy + Math.sin(start) * rr, start - Math.PI / 2, S * 0.065)
    }
  } else if (motif === 'top') {
    // Equaliser bars: what plays all day.
    const heights = [0.5, 0.82, 0.62, 1, 0.7].map((v) => v * (0.85 + r() * 0.15))
    const w = S * 0.068
    const gap = S * 0.04
    const total = heights.length * w + (heights.length - 1) * gap
    heights.forEach((v, i) => {
      const h = v * S * 0.42
      const x = cx - total / 2 + i * (w + gap)
      ctx.beginPath()
      ctx.roundRect(x, cy + S * 0.2 - h, w, h, w / 2)
      ctx.fill()
    })
  } else if (motif === 'discover') {
    // Sparkles: something new found.
    sparkle(ctx, cx - S * 0.03, cy + S * 0.02, S * 0.2)
    sparkle(ctx, cx + S * 0.19, cy - S * 0.16, S * 0.075)
    sparkle(ctx, cx + S * 0.17, cy + S * 0.17, S * 0.045)
  } else if (motif === 'radar') {
    // A radar sweep with blips: what has turned up.
    const rr = S * 0.22
    if ('createConicGradient' in ctx) {
      const sweep = ctx.createConicGradient(-Math.PI / 2 - 1.3, cx, cy)
      sweep.addColorStop(0, rgba(a, 0))
      sweep.addColorStop(1.3 / (Math.PI * 2), rgba(a, 0.55))
      sweep.addColorStop(1.3 / (Math.PI * 2) + 0.001, rgba(a, 0))
      ctx.fillStyle = sweep
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.lineWidth = S * 0.016
    for (const f of [1, 0.66, 0.33]) {
      ctx.beginPath()
      ctx.arc(cx, cy, rr * f, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.lineWidth = S * 0.022
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx, cy - rr)
    ctx.stroke()
    ctx.fillStyle = a
    ctx.shadowColor = a
    ctx.shadowBlur = S * 0.03
    for (let i = 0; i < 3; i++) {
      const angle = -Math.PI / 2 - 0.25 - r() * 1.1
      const dist = rr * (0.3 + r() * 0.6)
      ctx.beginPath()
      ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, S * (0.014 + r() * 0.01), 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (motif === 'phase') {
    // Glowing rings round a core: a time capsule.
    ctx.shadowColor = a
    ctx.shadowBlur = S * 0.04
    for (let i = 5; i >= 1; i--) {
      ctx.globalAlpha = 0.35 + (5 - i) * 0.13
      ctx.lineWidth = S * (0.012 + (5 - i) * 0.004)
      ctx.beginPath()
      ctx.arc(cx, cy, S * 0.045 * i, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(cx, cy, S * 0.025, 0, Math.PI * 2)
    ctx.fill()
  } else {
    // A burst: fresh in.
    const points = 12
    ctx.beginPath()
    for (let i = 0; i < points * 2; i++) {
      const angle = (i * Math.PI) / points - Math.PI / 2
      const dist = i % 2 ? S * 0.14 : S * 0.21
      ctx.lineTo(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist)
    }
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

/** Emblem: a flat colour with the playlist's own sign above the title, like Spotify's own mixes. */
function drawEmblem(ctx: CanvasRenderingContext2D, spec: CoverSpec, _p: Palette, seed: number) {
  const motif = spec.motif && EMBLEMS[spec.motif] ? spec.motif : 'new'
  const e = EMBLEMS[motif]!
  const g = ctx.createLinearGradient(0, 0, S, S)
  g.addColorStop(0, e.bg)
  g.addColorStop(1, e.bg2)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  glow(ctx, S * 0.5, S * 0.38, S * 0.45, mix(e.bg, '#ffffff', 0.25), 0.35)
  glyph(ctx, motif, S * 0.5, S * 0.38, e.accent, e.glyph2, seed)
  grain(ctx, 0.08)
  bottomTitle(ctx, spec, e.ink, 96, S * 0.22)
  cornerMark(ctx, spec.mark, spec.markImage, S * 0.075, S * 0.075, e.ink, e.bg)
}

/** The sky at an hour: top and bottom colour, the sun's (or moon's) colour and height, and whether it is night. */
function skyAt(hour: number) {
  if (hour >= 5 && hour < 11) return { top: '#ff6f61', bottom: '#ffc36b', sun: '#fff4c2', sunY: 0.5, night: false }
  if (hour >= 11 && hour < 17) return { top: '#1565c0', bottom: '#33b6d9', sun: '#fff6cf', sunY: 0.24, night: false }
  if (hour >= 17 && hour < 22) return { top: '#2b1055', bottom: '#e0476b', sun: '#ffb35c', sunY: 0.56, night: false }
  return { top: '#070b1f', bottom: '#2a2f78', sun: '#eef0ff', sunY: 0.26, night: true }
}

/** The daylist: a sky in the colours of the hour, sun or moon over rolling hills. */
function drawDaylist(ctx: CanvasRenderingContext2D, spec: CoverSpec, _p: Palette, seed: number) {
  const sky = skyAt(new Date().getHours())
  const r = rng(seed)
  const g = ctx.createLinearGradient(0, 0, 0, S)
  g.addColorStop(0, sky.top)
  g.addColorStop(1, sky.bottom)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  if (sky.night)
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rgba('#ffffff', 0.3 + r() * 0.6)
      ctx.beginPath()
      ctx.arc(r() * S, r() * S * 0.6, S * (0.002 + r() * 0.004), 0, Math.PI * 2)
      ctx.fill()
    }
  const sx = S * (0.6 + r() * 0.15)
  const sy = S * sky.sunY
  const sr = S * 0.12
  glow(ctx, sx, sy, sr * 3.2, sky.sun, 0.45)
  ctx.save()
  if (sky.night) {
    // The moon: the sun with a bite taken out, so the sky shows through.
    ctx.beginPath()
    ctx.rect(0, 0, S, S)
    ctx.arc(sx + sr * 0.45, sy - sr * 0.3, sr * 0.88, 0, Math.PI * 2)
    ctx.clip('evenodd')
  }
  ctx.fillStyle = sky.sun
  ctx.beginPath()
  ctx.arc(sx, sy, sr, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  // Three hills, each darker and nearer.
  for (let layer = 0; layer < 3; layer++) {
    const base = S * (0.62 + layer * 0.1)
    const amp = S * (0.04 + r() * 0.03)
    const phase = r() * Math.PI * 2
    const freq = 1.2 + r() * 1.2
    ctx.fillStyle = rgba(mix(sky.bottom, '#000000', 0.35 + layer * 0.2), 0.75 + layer * 0.08)
    ctx.beginPath()
    ctx.moveTo(0, S)
    for (let x = 0; x <= S; x += S / 40) ctx.lineTo(x, base + Math.sin((x / S) * Math.PI * freq + phase) * amp)
    ctx.lineTo(S, S)
    ctx.closePath()
    ctx.fill()
  }
  grain(ctx, 0.12)
  bottomTitle(ctx, spec, '#ffffff', 112, S * 0.34, true)
  cornerMark(ctx, spec.mark, spec.markImage, S * 0.075, S * 0.075, '#ffffff', sky.top)
}

const DRAW: Record<CoverStyle, typeof drawMix> = { mix: drawMix, stimmung: drawStimmung, foto: drawFoto, block: drawBlock, emblem: drawEmblem, daylist: drawDaylist }

/** Draws the cover into a canvas of any size. */
export function drawCover(canvas: HTMLCanvasElement, spec: CoverSpec) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const seed = hash(spec.seed)
  const palettes = PALETTES[spec.style]
  const palette = (spec.style === 'stimmung' && spec.motif && MOOD_PALETTES[spec.motif]) || palettes[seed % palettes.length]!
  ctx.setTransform(canvas.width / S, 0, 0, canvas.width / S, 0, 0)
  ctx.clearRect(0, 0, S, S)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1
  DRAW[spec.style](ctx, spec, palette, seed)
}

/** The cover fonts, loaded before the first drawing (otherwise the canvas falls back to a system font). */
let fontsReady: Promise<unknown> | undefined
export function coverFontsReady() {
  fontsReady ??= Promise.allSettled([
    document.fonts.load(`900 64px "Figtree"`),
    document.fonts.load(`700 40px "Figtree"`),
    document.fonts.load(`600 40px "Figtree"`),
    document.fonts.load(`400 64px "Archivo Black"`),
  ])
  return fontsReady
}
