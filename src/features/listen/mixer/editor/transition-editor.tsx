import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronDown,
  IconChevronRight,
  IconAlertTriangle,
  IconFocusCentered,
  IconRestore,
  IconSparkles,
  IconSquare,
  IconLoader2,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRepeat,
  IconMagnet,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { defineMessages, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { CheckIssue, CheckKind, SuggestedPoint, Suggestions } from '../editor-checks'
import { finalizeTransition } from '../planner'
import type { TrackMix, Transition } from '../types'
import { drawCard, drawDeck, drawLane, laneValueAtY, laneY, LANE_COLOR, prepareCanvas, STUDIO } from './draw'
import {
  addKey,
  axisWidth,
  deckColumns,
  deckTrack,
  laneKeys,
  laneValue,
  marksInTime,
  moveBStart,
  moveKey,
  overlapBars,
  POST_ROLL,
  PRE_ROLL,
  removeKey,
  setLength,
  slipDeck,
  snap,
  tOf,
  withLaneKeys,
  xOf,
  type Axis,
  type Deck,
  type LaneParam,
} from './timeline-math'
import { useHistory } from './use-history'
import { useChecks } from './use-assist'
import type { PreviewControls } from './use-preview'

const GROUP_NAMES: Record<'de' | 'en', Record<string, string>> = {
  de: { level: 'Pegel & EQ', effects: 'Filter & Hall', tempo: 'Tempo', stems: 'Smarte Filter' },
  en: { level: 'Level & EQ', effects: 'Filter & reverb', tempo: 'Tempo', stems: 'Smart filters' },
}

const PARAM_NAMES: Record<'de' | 'en', Record<LaneParam, string>> = {
  de: {
    gain: 'Lautstärke',
    low: 'Bass',
    mid: 'Mitten',
    high: 'Höhen',
    filter: 'Filter',
    reverb: 'Hall',
    rate: 'Tempo',
    drums: 'Drums',
    vocals: 'Stimme',
    instrumental: 'Instrumental',
  },
  en: {
    gain: 'Volume',
    low: 'Bass',
    mid: 'Mids',
    high: 'Highs',
    filter: 'Filter',
    reverb: 'Reverb',
    rate: 'Tempo',
    drums: 'Drums',
    vocals: 'Voice',
    instrumental: 'Instrumental',
  },
}

const CHECK_NAMES: Record<'de' | 'en', Record<CheckKind, string>> = {
  de: {
    voices: 'Zwei Stimmen',
    basslines: 'Zwei Basslines',
    keyClash: 'Tonarten reiben',
    energyJump: 'Energiesprung',
    notReady: 'B nicht ganz da',
    bandBack: 'A kommt zurück',
    flamRisk: 'Beats flammen',
    beatsApart: 'Beats laufen weg',
    lineCut: 'Zeile abgeschnitten',
  },
  en: {
    voices: 'Two voices',
    basslines: 'Two basslines',
    keyClash: 'Keys clash',
    energyJump: 'Energy jump',
    notReady: 'B not fully in',
    bandBack: 'A comes back',
    flamRisk: 'Beats flam',
    beatsApart: 'Beats drift',
    lineCut: 'Line cut off',
  },
}

const messages = defineMessages({
  de: {
    play: 'Abspielen',
    pause: 'Pausieren',
    loop: 'Übergang in Schleife',
    audioLoading: 'Audio wird geladen',
    audioFailed: 'Audio nicht verfügbar',
    starts: 'Vorschläge',
    startsHint: 'Neu anfangen mit …',
    startInitial: 'Ausgangspunkt (wie gespeichert oder automatisch)',
    startBlank: 'Leer (beide Songs unverändert)',
    startsLoading: 'Vorschläge werden berechnet …',
    startsNone: 'Ohne Analyse keine Vorschläge',
    hints: 'Hinweise',
    check: (kind: CheckKind) => CHECK_NAMES.de[kind],
    undo: 'Rückgängig',
    redo: 'Wiederholen',
    snap: 'Am Takt einrasten',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    toOverlap: 'Zum Übergang',
    bars: (n: number) => (n === 1 ? '1 Takt' : `${n} Takte`),
    group: (id: string) => GROUP_NAMES.de[id] ?? id,
    param: (param: LaneParam) => PARAM_NAMES.de[param],
    hint: 'Klick setzt die Abspielposition. Auf eine Kurve klicken fügt einen Punkt hinzu, ziehen verschiebt ihn, Entf oder Rechtsklick löscht ihn.',
    deleteKey: 'Punkt löschen',
  },
  en: {
    play: 'Play',
    pause: 'Pause',
    loop: 'Loop the transition',
    audioLoading: 'Loading audio',
    audioFailed: 'Audio unavailable',
    starts: 'Suggestions',
    startsHint: 'Start over with …',
    startInitial: 'Starting point (as saved, or automatic)',
    startBlank: 'Blank (both songs as they are)',
    startsLoading: 'Working out suggestions …',
    startsNone: 'No suggestions without an analysis',
    hints: 'Hints',
    check: (kind: CheckKind) => CHECK_NAMES.en[kind],
    undo: 'Undo',
    redo: 'Redo',
    snap: 'Snap to the beat',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    toOverlap: 'To the transition',
    bars: (n: number) => (n === 1 ? '1 bar' : `${n} bars`),
    group: (id: string) => GROUP_NAMES.en[id] ?? id,
    param: (param: LaneParam) => PARAM_NAMES.en[param],
    hint: 'A click sets the playhead. Click a curve to add a point, drag to move it, Delete or right-click removes it.',
    deleteKey: 'Delete point',
  },
})

/** The label column beside the timeline (narrower on small screens). */
const LABEL_WIDE = 140
const LABEL_NARROW = 84
/** Each deck's half of the visualizer, and a lane row. */
const DECK_H = 170
const LANE_H = 52
/** The checks' row. */
const HINTS_H = 28
const HINT_ROW_H = 22
/** Handles: drawn 16–18 px wide, grabbed within 14 px (a 28 px target). */
const GRAB_PX = 14
/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_PX = 4
/** Holding a point this long without moving deletes it (touch). */
const LONG_PRESS_MS = 550
/** The widest the timeline gets (canvas size). */
const MAX_WIDTH = 12_000
/** Below this many pixels a second the view starts on the transition rather than showing all of it. */
const MIN_FIT = 25

const GROUPS: Array<{ id: string; params: LaneParam[] }> = [
  { id: 'level', params: ['gain', 'low', 'mid', 'high'] },
  { id: 'effects', params: ['filter', 'reverb'] },
  { id: 'tempo', params: ['rate'] },
  { id: 'stems', params: ['drums', 'vocals', 'instrumental'] },
]

export interface TransitionEditorProps {
  initial: Transition
  aMix: TrackMix | null
  bMix: TrackMix | null
  aTitle: string
  bTitle: string
  /** Song lengths (seconds), for keeping the transition inside both songs. */
  aDuration: number
  bDuration: number
  /** Reports the transition as edited (each finished gesture). */
  onChange?: (transition: Transition) => void
  /** Reports every change, also while dragging (the preview follows it). */
  onLive?: (transition: Transition) => void
  /** Playback (the preview of the transition as edited); without it the playhead only moves on clicks. */
  preview?: PreviewControls
  /** The planner's suggestions for the pair (starting points, out and in points), once worked out. */
  suggestions?: Suggestions | null
}

type Gesture =
  | { kind: 'pending'; x: number; t: number; deck: Deck; start: Transition }
  | { kind: 'slip'; x: number; deck: Deck; start: Transition }
  | { kind: 'bAt' | 'length'; start: Transition }
  | { kind: 'key'; deck: Deck; param: LaneParam; index: number; start: Transition; x: number; y: number; moved: boolean; timer: number }
  | { kind: 'scrub' }

/**
 * The transition editor's timeline: a big two-deck visualizer (A on top, B below, band-coloured waveforms as heard,
 * bar grid, the overlap as a card with its bar count) and automation lanes below it, one row per parameter and deck, in
 * collapsible groups. A click anywhere sets the playhead; no gesture needs a double click.
 */
export function TransitionEditor({ initial, aMix, bMix, aTitle, bTitle, aDuration, bDuration, onChange, onLive, preview, suggestions }: TransitionEditorProps) {
  const t = useMessages(messages)
  const history = useHistory(initial)
  const transition = history.value
  const [playhead, setPlayhead] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [snapOn, setSnapOn] = useState(true)
  const [selected, setSelected] = useState<{ deck: Deck; param: LaneParam; index: number } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ effects: true, tempo: true, stems: true })
  const scroller = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState(1000)
  const gesture = useRef<Gesture | null>(null)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Playback moves the playhead; a click here moves it at once.
  const shownPlayhead = preview?.status === 'ready' ? preview.position : playhead
  const [looping, setLooping] = useState(false)
  const issues = useChecks(transition, aMix, bMix)
  // The kinds found, warnings first.
  const issueKinds = [...new Set([...issues].sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'warn' ? -1 : 1)).map((issue) => issue.kind))]
  /** The hint picked on the timeline (its message shows under it). */
  const [hint, setHint] = useState<CheckIssue | null>(null)

  useEffect(() => onLive?.(transition), [transition, onLive])
  // The loop is the transition with a little on either side; it follows edits of its length.
  const loopFrom = Math.min(0, transition.bAt) - 2
  const loopTo = transition.length + 2
  const setLoop = preview?.setLoop
  const previewReady = preview?.status === 'ready'
  useEffect(() => {
    if (previewReady) setLoop?.(looping ? { from: loopFrom, to: loopTo } : null)
  }, [looping, loopFrom, loopTo, setLoop, previewReady])
  const finalize = (next: Transition) => finalizeTransition(next, aDuration, bDuration)
  const commit = (before: Transition, after: Transition) => {
    const done = finalize(after)
    history.commit(before, done)
    onChange?.(done)
  }

  const span = transition.length + PRE_ROLL + POST_ROLL
  const LABEL_W = viewport < 720 ? LABEL_NARROW : LABEL_WIDE
  // The whole stretch with its lead-in and run-out when it fits readably; else the transition itself (scroll for more).
  const room = viewport - LABEL_W - 8
  const fitsWhole = room / span >= MIN_FIT
  const fit = fitsWhole ? room / span : Math.max(4, room / (transition.length + 4))
  const pxPerSecond = Math.min(fit * zoom, MAX_WIDTH / span)
  const axis: Axis = useMemo(() => ({ from: -PRE_ROLL, to: transition.length + POST_ROLL, pxPerSecond }), [transition.length, pxPerSecond])
  const width = axisWidth(axis)

  // Where each deck is, column by column, and its grid in transition time.
  const decks = useMemo(() => {
    const make = (deck: Deck, mix: TrackMix | null) => {
      const positions = deckTrack(transition, deck, axis)
      const phraseSet = new Set(mix?.phrases ?? [])
      const downbeats = mix ? marksInTime(axis, positions, mix.downbeats) : []
      return {
        deck,
        positions,
        columns: deckColumns(mix, positions),
        ghost: deckColumns(mix, deckTrack(transition, deck, axis, true)),
        beats: mix ? marksInTime(axis, positions, mix.beats) : [],
        bars: downbeats,
        phrases: mix ? marksInTime(axis, positions, mix.downbeats.filter((d) => phraseSet.has(d))) : [],
      }
    }
    return { a: make('a', aMix), b: make('b', bMix) }
  }, [transition, axis, aMix, bMix])
  const bars = overlapBars(transition, decks.a.bars, decks.b.bars)

  /** Where to snap a time: beats of both decks (bars with Shift). */
  const snapTime = (time: number, bars: boolean, free: boolean) => {
    if (!snapOn || free) return time
    const grid = bars ? [...decks.a.bars, ...decks.b.bars] : [...decks.a.beats, ...decks.b.beats]
    return snap(time, grid, 10 / axis.pxPerSecond)
  }
  /** A deck's beat (seconds), for slipping it by whole beats. */
  const beatOf = (deck: Deck) => {
    const mix = deck === 'a' ? aMix : bMix
    return mix?.bpm ? 60 / mix.bpm : 0.5
  }

  const seek = (time: number, scrubbing = false) => {
    const clamped = Math.min(axis.to, Math.max(axis.from, time))
    setPlayhead(clamped)
    if (scrubbing) preview?.scrub(clamped)
    else preview?.seek(clamped)
  }
  const togglePlay = () => {
    if (!preview || preview.status !== 'ready') return
    if (preview.playing) preview.pause()
    else preview.play(shownPlayhead >= axis.to - 0.05 ? axis.from : undefined)
  }

  // ---- the visualizer ----

  const visualizer = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = visualizer.current
    if (!canvas) return
    const g = prepareCanvas(canvas, width, DECK_H * 2)
    g.fillStyle = STUDIO.surface
    g.fillRect(0, 0, width, DECK_H * 2)
    drawCard(g, axis, transition, DECK_H * 2)
    drawDeck(g, axis, transition, { deck: 'a', columns: decks.a.columns, ghost: decks.a.ghost, bars: decks.a.bars, phrases: decks.a.phrases }, 0, DECK_H)
    drawDeck(g, axis, transition, { deck: 'b', columns: decks.b.columns, ghost: decks.b.ghost, bars: decks.b.bars, phrases: decks.b.phrases }, DECK_H, DECK_H)
    // B's entry and A's end, as handles.
    const handle = (x: number, top: number, height: number) => {
      g.fillStyle = 'rgba(255,255,255,0.85)'
      g.fillRect(Math.round(x) - 1, top, 2, height)
      g.beginPath()
      g.roundRect(Math.round(x) - 8, top + height / 2 - 18, 16, 36, 6)
      g.fill()
      g.fillStyle = STUDIO.surface
      for (const dy of [-6, 0, 6]) g.fillRect(Math.round(x) - 4, top + height / 2 + dy, 8, 1.5)
    }
    handle(xOf(axis, transition.bAt), DECK_H + 4, DECK_H - 8)
    handle(xOf(axis, transition.length), 4, DECK_H - 8)
    // The planner's good spots: where A can go out (on A, at the top) and B come in (on B, at the bottom).
    const spots = (points: SuggestedPoint[], positions: ReadonlyArray<number | null>, top: boolean) => {
      g.font = '600 11px system-ui, sans-serif'
      // The best six spots, left to right; a label only where the one before leaves room (the marks always show).
      const marks = points
        .slice(0, 6)
        .flatMap((point) => marksInTime(axis, positions, [point.at]).map((time) => ({ x: Math.round(xOf(axis, time)), label: point.label })))
        .sort((p, q) => p.x - q.x)
      let free = -Infinity
      const y = top ? 6 : DECK_H * 2 - 6
      for (const { x, label } of marks) {
        g.fillStyle = STUDIO.highCurve
        g.beginPath()
        g.moveTo(x - 5, y)
        g.lineTo(x + 5, y)
        g.lineTo(x, top ? y + 7 : y - 7)
        g.fill()
        if (x + 7 < free) continue
        g.fillStyle = 'rgba(250,204,21,0.85)'
        g.fillText(label, x + 7, top ? y + 9 : y - 2)
        free = x + 7 + g.measureText(label).width + 8
      }
    }
    if (suggestions) {
      // A as if it played on past its end.
      spots(suggestions.outPoints, deckTrack({ ...transition, length: Infinity }, 'a', axis), true)
      // B as if it had been playing all along (its material where it is now), so in points before its entry show too.
      spots(suggestions.inPoints, deckTrack({ ...transition, bAt: axis.from, bIn: transition.bIn + (axis.from - transition.bAt) }, 'b', axis), false)
    }
  }, [axis, transition, decks, width, suggestions])

  const local = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  const onVisualizerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const { x, y } = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    const deck: Deck = y < DECK_H ? 'a' : 'b'
    if (deck === 'b' && Math.abs(x - xOf(axis, transition.bAt)) <= GRAB_PX) gesture.current = { kind: 'bAt', start: transition }
    else if (deck === 'a' && Math.abs(x - xOf(axis, transition.length)) <= GRAB_PX) gesture.current = { kind: 'length', start: transition }
    else gesture.current = { kind: 'pending', x, t: tOf(axis, x), deck, start: transition }
  }
  const onVisualizerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current
    if (!current) return
    const { x } = local(event)
    const time = tOf(axis, x)
    if (current.kind === 'bAt') history.set(moveBStart(current.start, snapTime(time, event.shiftKey, event.altKey)))
    else if (current.kind === 'length') history.set(setLength(current.start, snapTime(time, event.shiftKey, event.altKey)))
    else if (current.kind === 'pending' && Math.abs(x - current.x) > DRAG_PX) gesture.current = { kind: 'slip', x: current.x, deck: current.deck, start: current.start }
    if (gesture.current?.kind === 'slip') {
      const slip = gesture.current
      // Dragging the waveform right brings earlier material to each moment.
      let delta = -(x - slip.x) / axis.pxPerSecond
      if (snapOn && !event.altKey) {
        const step = beatOf(slip.deck) * (event.shiftKey ? 4 : 1)
        delta = Math.round(delta / step) * step
        // A good spot of the planner's wins when it is close: A going out there, B coming in there.
        const points = slip.deck === 'a' ? suggestions?.outPoints : suggestions?.inPoints
        const anchor = slip.deck === 'a' ? slip.start.aOut : slip.start.bIn
        const near = points?.find((point) => Math.abs(point.at - (anchor - (x - slip.x) / axis.pxPerSecond)) * axis.pxPerSecond <= 12)
        if (near) delta = near.at - anchor
      }
      history.set(slipDeck(slip.start, slip.deck, delta))
    }
  }
  const onVisualizerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current
    gesture.current = null
    if (!current) return
    if (current.kind === 'pending') seek(current.t)
    else if (current.kind !== 'scrub' && current.kind !== 'key') commit(current.start, transition)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // ---- the lanes ----

  const keyAt = (deck: Deck, param: LaneParam, x: number, y: number) => {
    const keys = laneKeys(transition, deck, param)
    let best = -1
    let distance = GRAB_PX
    keys.forEach((key, i) => {
      const d = Math.hypot(xOf(axis, key.t) - x, laneY(param, key.v, LANE_H) - y)
      if (d <= distance) {
        distance = d
        best = i
      }
    })
    return best
  }

  const deleteKey = (deck: Deck, param: LaneParam, index: number) => {
    const before = transition
    commit(before, withLaneKeys(before, deck, param, removeKey(laneKeys(before, deck, param), index)))
    setSelected(null)
  }

  const onLaneDown = (event: ReactPointerEvent<HTMLCanvasElement>, deck: Deck, param: LaneParam) => {
    if (event.button !== 0) return
    const { x, y } = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    const time = tOf(axis, x)
    let index = keyAt(deck, param, x, y)
    let start = transition
    if (index < 0 && Math.abs(laneY(param, laneValue(transition, deck, param, time), LANE_H) - y) <= 8) {
      // A click on the curve adds a point there, on the curve (so nothing changes until it is dragged).
      const added = addKey(laneKeys(transition, deck, param), param, snapTime(time, false, event.altKey), laneValue(transition, deck, param, time), { from: 0, to: transition.length })
      const next = withLaneKeys(transition, deck, param, added.keys)
      history.commit(transition, next)
      start = next
      index = added.index
    }
    if (index < 0) {
      gesture.current = { kind: 'scrub' }
      setSelected(null)
      seek(time)
      return
    }
    setSelected({ deck, param, index })
    const timer = window.setTimeout(() => {
      const current = gesture.current
      if (current?.kind === 'key' && !current.moved) {
        gesture.current = null
        deleteKey(deck, param, index)
      }
    }, LONG_PRESS_MS)
    gesture.current = { kind: 'key', deck, param, index, start, x, y, moved: false, timer }
  }
  const onLaneMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current
    if (!current) return
    const { x, y } = local(event)
    if (current.kind === 'scrub') return seek(tOf(axis, x), true)
    if (current.kind !== 'key') return
    if (!current.moved && Math.hypot(x - current.x, y - current.y) <= DRAG_PX) return
    if (!current.moved) window.clearTimeout(current.timer)
    current.moved = true
    const keys = laneKeys(current.start, current.deck, current.param)
    const time = snapTime(tOf(axis, x), event.shiftKey, event.altKey)
    history.set(withLaneKeys(current.start, current.deck, current.param, moveKey(keys, current.param, current.index, time, laneValueAtY(current.param, y, LANE_H))))
  }
  const onLaneUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current
    gesture.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (current?.kind !== 'key') return
    window.clearTimeout(current.timer)
    if (current.moved) commit(current.start, transition)
  }
  const onLaneMenu = (event: React.MouseEvent<HTMLCanvasElement>, deck: Deck, param: LaneParam) => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = keyAt(deck, param, event.clientX - box.left, event.clientY - box.top)
    if (index < 0) return
    event.preventDefault()
    deleteKey(deck, param, index)
  }

  // Keyboard: Delete removes the selected point, Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        togglePlay()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault()
        deleteKey(selected.deck, selected.param, selected.index)
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) history.redo()
        else history.undo()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        history.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** Starts over from another transition (a suggestion, blank, the original): one undoable step. */
  const startFrom = (start: Transition) => {
    const next = finalize({ ...start, custom: true })
    history.replace(next)
    onChange?.(next)
    setSelected(null)
  }

  // When the view starts on the transition (a narrow screen), it is scrolled there.
  useEffect(() => {
    if (!fitsWhole && scroller.current) scroller.current.scrollLeft = Math.max(0, xOf(axis, -2))
    // Only when the way the view fits changes, not on every zoom or edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitsWhole])

  const toOverlap = () => {
    const element = scroller.current
    if (element) element.scrollTo({ left: Math.max(0, xOf(axis, 0) - 40), behavior: 'smooth' })
  }

  const rows = GROUPS.flatMap((group) => (collapsed[group.id] ? [] : group.params.flatMap((param) => (['a', 'b'] as const).map((deck) => ({ group: group.id, param, deck })))))
  const contentWidth = LABEL_W + width

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="icon"
          className="mr-1 rounded-full"
          aria-label={preview?.playing ? t.pause : t.play}
          title={preview?.status === 'failed' ? t.audioFailed : preview?.playing ? t.pause : t.play}
          disabled={preview?.status !== 'ready'}
          onClick={togglePlay}
        >
          {preview?.status === 'loading' ? <IconLoader2 className="animate-spin" /> : preview?.playing ? <IconPlayerPauseFilled /> : <IconPlayerPlayFilled />}
        </Button>
        <Button variant={looping ? 'secondary' : 'ghost'} size="icon" aria-label={t.loop} title={t.loop} aria-pressed={looping} disabled={preview?.status !== 'ready'} onClick={() => setLooping(!looping)}>
          <IconRepeat />
        </Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <Button variant="ghost" size="icon" aria-label={t.undo} title={t.undo} disabled={!history.canUndo} onClick={history.undo}>
          <IconArrowBackUp />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t.redo} title={t.redo} disabled={!history.canRedo} onClick={history.redo}>
          <IconArrowForwardUp />
        </Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <Button variant={snapOn ? 'secondary' : 'ghost'} size="icon" aria-label={t.snap} title={t.snap} aria-pressed={snapOn} onClick={() => setSnapOn(!snapOn)}>
          <IconMagnet />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t.zoomOut} title={t.zoomOut} disabled={zoom <= 1} onClick={() => setZoom(Math.max(1, zoom / 1.5))}>
          <IconZoomOut />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t.zoomIn} title={t.zoomIn} disabled={pxPerSecond * span >= MAX_WIDTH} onClick={() => setZoom(zoom * 1.5)}>
          <IconZoomIn />
        </Button>
        <Button variant="ghost" size="sm" onClick={toOverlap}>
          <IconFocusCentered /> {t.toOverlap}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
            <IconSparkles /> {t.starts}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-96">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t.startsHint}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => startFrom(initial)}>
                <IconRestore /> {t.startInitial}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startFrom(blank(transition))}>
                <IconSquare /> {t.startBlank}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {suggestions === undefined || suggestions === null ? (
              <DropdownMenuItem disabled>
                <IconLoader2 className="animate-spin" /> {t.startsLoading}
              </DropdownMenuItem>
            ) : suggestions.presets.length === 0 ? (
              <DropdownMenuItem disabled>{t.startsNone}</DropdownMenuItem>
            ) : (
              suggestions.presets.map((preset) => (
                <DropdownMenuItem key={preset.id} onClick={() => startFrom(preset.transition)}>
                  <IconSparkles /> <span className="whitespace-normal">{preset.label}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {preview?.status === 'loading' ? `${t.audioLoading} · ` : preview?.status === 'failed' ? `${t.audioFailed} · ` : ''}
          {clock(shownPlayhead)}
        </span>
      </div>

      <div ref={scroller} className="relative overflow-x-auto overflow-y-hidden rounded-xl" style={{ background: STUDIO.surface }}>
        <div className="relative" style={{ width: contentWidth }}>
          {/* The two decks. */}
          <div className="flex">
            <div className="sticky left-0 z-10 flex shrink-0 flex-col" style={{ width: LABEL_W, background: STUDIO.surface }}>
              {(['a', 'b'] as const).map((deck) => (
                <div key={deck} className="flex flex-col justify-center gap-1 px-3" style={{ height: DECK_H }}>
                  <span className="grid size-6 place-items-center rounded-md text-xs font-bold" style={{ background: deck === 'a' ? STUDIO.mid : STUDIO.low, color: '#fff' }}>
                    {deck.toUpperCase()}
                  </span>
                  <span className="line-clamp-2 text-xs font-medium" style={{ color: STUDIO.label }}>
                    {deck === 'a' ? aTitle : bTitle}
                  </span>
                </div>
              ))}
            </div>
            <div className="relative">
              <canvas
                ref={visualizer}
                style={{ width, height: DECK_H * 2, touchAction: 'none' }}
                className="block cursor-grab active:cursor-grabbing"
                onPointerDown={onVisualizerDown}
                onPointerMove={onVisualizerMove}
                onPointerUp={onVisualizerUp}
                onPointerCancel={() => (gesture.current = null)}
              />
              {/* Play, in the middle of the transition (as in the reference). */}
              {preview?.status === 'ready' && (
                <button
                  type="button"
                  aria-label={preview.playing ? t.pause : t.play}
                  onClick={togglePlay}
                  className="absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/65 text-white outline-none backdrop-blur hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ left: (xOf(axis, 0) + xOf(axis, transition.length)) / 2, top: DECK_H }}
                >
                  {preview.playing ? <IconPlayerPauseFilled className="size-5" /> : <IconPlayerPlayFilled className="size-5 translate-x-px" />}
                </button>
              )}
              {bars > 0 && (
                <span
                  className="pointer-events-none absolute -translate-x-1/2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-semibold text-white tabular-nums"
                  style={{ left: (xOf(axis, transition.bAt) + xOf(axis, transition.length)) / 2, bottom: 8 }}
                >
                  {t.bars(bars)}
                </span>
              )}
            </div>
          </div>

          {/* The planner's checks, one row per kind, where they apply: a click jumps there and says what it is. */}
          <div className="flex border-t border-white/5">
            <div className="sticky left-0 z-10 flex shrink-0 items-center gap-2 px-3 text-xs font-semibold uppercase tracking-wide" style={{ width: LABEL_W, height: HINTS_H, background: STUDIO.surface, color: STUDIO.label }}>
              {t.hints}
              <span className={cn('rounded px-1.5 py-0.5 tabular-nums normal-case', issues.some((issue) => issue.severity === 'warn') ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10')}>
                {issues.length}
              </span>
            </div>
            <div style={{ width, height: HINTS_H }} />
          </div>
          {issueKinds.map((kind) => (
            <div key={kind} className="flex">
              <div className="sticky left-0 z-10 flex shrink-0 items-center px-3 text-xs" style={{ width: LABEL_W, height: HINT_ROW_H, background: STUDIO.surface, color: STUDIO.label }}>
                <span className="truncate">{t.check(kind)}</span>
              </div>
              <div className="relative" style={{ width, height: HINT_ROW_H }}>
                {issues
                  .filter((issue) => issue.kind === kind)
                  .map((issue, i) => (
                    <button
                      key={`${issue.from}-${i}`}
                      type="button"
                      title={issue.message}
                      aria-label={issue.message}
                      onClick={() => {
                        setHint(issue)
                        seek(issue.from)
                      }}
                      className={cn(
                        'absolute top-1 h-3.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        issue.severity === 'warn' ? 'bg-amber-400/80 hover:bg-amber-300' : 'bg-sky-400/60 hover:bg-sky-300',
                        hint === issue && 'ring-2 ring-white',
                      )}
                      style={{ left: xOf(axis, issue.from), width: Math.max(8, xOf(axis, issue.to) - xOf(axis, issue.from)) }}
                    />
                  ))}
              </div>
            </div>
          ))}

          {/* The lanes. */}
          {GROUPS.map((group) => (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => setCollapsed({ ...collapsed, [group.id]: !collapsed[group.id] })}
                aria-expanded={!collapsed[group.id]}
                className="sticky left-0 z-10 flex h-8 items-center gap-1.5 px-3 text-xs font-semibold uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ color: STUDIO.label, background: STUDIO.surface, width: LABEL_W }}
              >
                {collapsed[group.id] ? <IconChevronRight className="size-4" /> : <IconChevronDown className="size-4" />}
                {t.group(group.id)}
              </button>
              {rows
                .filter((row) => row.group === group.id)
                .map((row) => (
                  <div key={`${row.param}-${row.deck}`} className="flex border-t border-white/5">
                    <div className="sticky left-0 z-10 flex shrink-0 items-center gap-2 px-3 text-xs" style={{ width: LABEL_W, height: LANE_H, background: STUDIO.surface, color: STUDIO.label }}>
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: LANE_COLOR[row.param] }} />
                      <span className="truncate">{t.param(row.param)}</span>
                      <span className="ml-auto font-bold opacity-70">{row.deck.toUpperCase()}</span>
                    </div>
                    <LaneCanvas
                      axis={axis}
                      width={width}
                      transition={transition}
                      deck={row.deck}
                      param={row.param}
                      selected={selected?.deck === row.deck && selected.param === row.param ? selected.index : null}
                      onPointerDown={(event) => onLaneDown(event, row.deck, row.param)}
                      onPointerMove={onLaneMove}
                      onPointerUp={onLaneUp}
                      onContextMenu={(event) => onLaneMenu(event, row.deck, row.param)}
                    />
                  </div>
                ))}
            </div>
          ))}

          {/* The playhead, through the decks and the lanes. */}
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-listen" style={{ left: LABEL_W + xOf(axis, shownPlayhead) - 1 }} />
        </div>
      </div>
      {hint ? (
        <p className={cn('flex items-center gap-2 text-sm', hint.severity === 'warn' ? 'text-amber-500' : 'text-sky-500')}>
          <IconAlertTriangle className="size-4 shrink-0" /> {clock(hint.from)}: {hint.message}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t.hint}</p>
      )}
    </div>
  )
}

function LaneCanvas({
  axis,
  width,
  transition,
  deck,
  param,
  selected,
  ...handlers
}: {
  axis: Axis
  width: number
  transition: Transition
  deck: Deck
  param: LaneParam
  selected: number | null
  onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  onContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!canvas.current) return
    const g = prepareCanvas(canvas.current, width, LANE_H)
    drawLane(g, axis, transition, deck, param, width, LANE_H, selected)
  }, [axis, width, transition, deck, param, selected])
  return <canvas ref={canvas} style={{ width, height: LANE_H, touchAction: 'none' }} className={cn('block cursor-crosshair')} {...handlers} />
}

/** The same timing with no automation, effects or tempo changes: both songs as they are, to build from scratch. */
function blank(transition: Transition): Transition {
  const still = () => ({ gain: [], low: [], mid: [], high: [], filter: [] })
  return { ...transition, a: still(), b: still(), effects: [], rateA: [], rateB: [] }
}

/** Transition time as "−0:04,2" / "0:12,8". */
function clock(seconds: number) {
  const sign = seconds < 0 ? '−' : ''
  const s = Math.abs(seconds)
  return `${sign}${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`
}
