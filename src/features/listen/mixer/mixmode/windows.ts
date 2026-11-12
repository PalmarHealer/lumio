import { deckPlan, trackSpan } from '../deck-schedule.ts'
import type { Transition } from '../types.ts'

/**
 * Which stretches of its songs a playlist in Mix-Modus asks stems for (the server separates windows of at most
 * `MAX_WINDOW` seconds, up to `MAX_WINDOWS` a song). Pure, so node can check it.
 *
 * Each song plays in two transitions: as B (coming in after the song before) and as A (going out into the next). Where
 * the pair has a stored transition, its windows are exactly the stretches it plays (with a margin); otherwise a
 * transition isn't planned yet, and the song's opening and closing stretch are taken, where transitions happen.
 */

export const MAX_WINDOW = 300
/** The server separates nothing past this far into a song (its MAX_SONG). */
export const MAX_SONG = 1200
export const MAX_WINDOWS = 8
/** Around what a stored transition plays (its pre- and post-roll in the editor, and a little more). */
const MARGIN_S = 10
/** Without a stored transition: a song's opening as B, its close as A. */
const OPENING_S = 75
const CLOSING_S = 90

export interface Window {
  start: number
  end: number
}

/** The stretch of A's and B's tracks a transition plays (with the margin), in track seconds. */
export function transitionWindows(transition: Transition): { a: Window; b: Window } {
  const a = trackSpan(deckPlan(transition, 'a'), 0, transition.length + 0.1)
  const b = trackSpan(deckPlan(transition, 'b'), transition.bAt, transition.length + 0.1)
  return {
    a: { start: Math.max(0, a.from - MARGIN_S), end: a.to + MARGIN_S },
    b: { start: Math.max(0, b.from - MARGIN_S), end: b.to + MARGIN_S },
  }
}

/**
 * Overlapping or touching windows joined, long ones cut into pieces the server takes (each shorter than `MAX_WINDOW`
 * even after rounding to milliseconds, none past `MAX_SONG`), at most `MAX_WINDOWS`.
 */
export function tidyWindows(windows: readonly Window[], duration: number): Window[] {
  const limit = Number.isFinite(duration) && duration > 0 ? Math.min(duration, MAX_SONG) : MAX_SONG
  const clamped = windows
    .map((w) => ({ start: Math.max(0, w.start), end: Math.min(limit, w.end) }))
    .filter((w) => w.end - w.start > 0.5)
    .sort((x, y) => x.start - y.start)
  const joined: Window[] = []
  for (const w of clamped) {
    const last = joined[joined.length - 1]
    if (last && w.start <= last.end + 1) last.end = Math.max(last.end, w.end)
    else joined.push({ ...w })
  }
  const pieces: Window[] = []
  for (const w of joined) {
    // Rounded first, then measured: a piece is never longer than the server allows (a millisecond to spare).
    for (let start = round(w.start); start < w.end - 0.5; start = round(start + MAX_WINDOW - 0.001)) {
      pieces.push({ start, end: Math.min(round(w.end), round(start + MAX_WINDOW - 0.001)) })
    }
  }
  return pieces.slice(0, MAX_WINDOWS)
}

const round = (x: number) => Math.round(x * 1000) / 1000

/**
 * The windows per song of a playlist in its order: from the stored transition of each neighbouring pair where there
 * is one, else the song's opening (as B) and close (as A).
 */
export function playlistWindows(
  order: readonly string[],
  stored: Readonly<Record<string, Transition | undefined>>,
  durations: Readonly<Record<string, number>>,
): Record<string, Window[]> {
  const wanted: Record<string, Window[]> = {}
  const add = (id: string, w: Window) => (wanted[id] ??= []).push(w)
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!
    const duration = durations[id] ?? 0
    const before = i > 0 ? stored[`${order[i - 1]}>${id}`] : undefined
    const after = i + 1 < order.length ? stored[`${id}>${order[i + 1]}`] : undefined
    if (i > 0) add(id, before ? transitionWindows(before).b : { start: 0, end: OPENING_S })
    if (i + 1 < order.length) add(id, after ? transitionWindows(after).a : { start: Math.max(0, duration - CLOSING_S), end: duration || CLOSING_S })
  }
  return Object.fromEntries(Object.entries(wanted).map(([id, windows]) => [id, tidyWindows(windows, durations[id] ?? 0)]))
}

/** Whether the windows cover [start, end] (each point inside one of them). */
export function covered(windows: readonly Window[], start: number, end: number): boolean {
  let at = start
  for (const w of [...windows].sort((x, y) => x.start - y.start)) {
    if (w.start > at + 0.01) break
    at = Math.max(at, w.end)
    if (at >= end - 0.01) return true
  }
  return at >= end - 0.01
}

/** Whether the server takes a window (it turns down a whole request for one it doesn't). */
export const validWindow = (w: Window) => w.start >= 0 && w.end > w.start && w.end - w.start <= MAX_WINDOW && w.end <= MAX_SONG

/**
 * One stretch the editor needs real stems for, as a window the server takes: inside the song and `MAX_SONG`, at most
 * `MAX_WINDOW` long (a longer reach keeps its start; the rest plays approximated).
 */
export function neededWindow(w: Window, duration: number): Window | null {
  const end = Math.min(w.end, Number.isFinite(duration) && duration > 0 ? duration : Infinity, MAX_SONG)
  const start = round(Math.max(0, w.start))
  const clamped = { start, end: Math.min(round(end), round(start + MAX_WINDOW - 0.001)) }
  return clamped.end - clamped.start > 0.5 ? clamped : null
}
