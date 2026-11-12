import { useEffect, useMemo, useRef, useState } from 'react'
import { loadStem, mixSources, preheat, stemStatus, useMixMode, type StemWindowStatus } from '../mixmode/mix-mode'
import { covered, transitionWindows, type Window } from '../mixmode/windows'
import { useStableLumioFetch } from '../queries'
import type { Transition } from '../types'
import type { PreviewControls } from './use-preview'

/** Per deck: the live approximation, real stems on their way, real stems playing, or separating them failed. */
export type DeckStems = 'approx' | 'loading' | 'ready' | 'failed'

/** While stems are on their way, the server is asked this often. */
const POLL_MS = 5_000

/** The separated window of a song covering a stretch, if there is one (any state). */
const windowFor = (windows: StemWindowStatus[] | undefined, need: Window) => windows?.find((w) => covered([w.window], need.start, need.end))

/**
 * The editor's real stems in Mix-Modus: for the stretches of both songs the transition plays, asks the server for them
 * (when the playlist's pre-heat didn't cover them, e.g. after the transition was moved), waits for them, loads the four
 * stems of each deck's window and hands them to the preview (vocals, drums, and bass with the rest as the
 * instrumental). Outside Mix-Modus both decks stay approximated.
 */
export function useDeckStems(options: { playlistId: string; from: string; to: string; transition: Transition | null; preview: PreviewControls }): { a: DeckStems; b: DeckStems } {
  const { playlistId, from, to, transition, preview } = options
  const mode = useMixMode(playlistId)
  const on = mode?.phase === 'on'
  const lumioFetch = useStableLumioFetch()
  const [state, setState] = useState<{ a: DeckStems; b: DeckStems }>({ a: 'approx', b: 'approx' })
  // The windows needed, rounded to whole seconds so small edits don't ask again.
  const needed = useMemo(() => {
    if (!transition) return null
    const w = transitionWindows(transition)
    const round = (x: Window) => ({ start: Math.floor(x.start), end: Math.ceil(x.end) })
    return { a: round(w.a), b: round(w.b) }
  }, [transition])
  const neededKey = needed ? `${needed.a.start}-${needed.a.end}|${needed.b.start}-${needed.b.end}` : ''
  const ready = preview.status === 'ready'
  const setStems = preview.setStems
  /** Which window each deck's stems were loaded from (not loaded twice). */
  const loaded = useRef<{ a: string | null; b: string | null }>({ a: null, b: null })

  useEffect(() => {
    if (!on || !needed || !ready) {
      // A new preview (another pair, a reload) starts without stems.
      if (!ready) loaded.current = { a: null, b: null }
      setState({ a: 'approx', b: 'approx' })
      return
    }
    let stopped = false
    let timer = 0
    let asked = false
    const decode = new OfflineAudioContext(2, 1, 44_100)
    const check = async () => {
      let status: Record<string, StemWindowStatus[]>
      try {
        status = await stemStatus(lumioFetch, [from, to])
      } catch {
        if (!stopped) timer = window.setTimeout(() => void check(), POLL_MS)
        return
      }
      if (stopped) return
      const decks = { a: { id: from, need: needed.a }, b: { id: to, need: needed.b } }
      // Stretches no window covers yet are asked for (once per check run).
      const missing = (['a', 'b'] as const).filter((deck) => !windowFor(status[decks[deck].id], decks[deck].need))
      if (missing.length && !asked) {
        asked = true
        await preheat(
          lumioFetch,
          playlistId,
          missing.map((deck) => ({ id: decks[deck].id, windows: [decks[deck].need] })),
        )
      }
      let waiting = false
      for (const deck of ['a', 'b'] as const) {
        const window = windowFor(status[decks[deck].id], decks[deck].need)
        if (!window || window.state === 'queued' || window.state === 'running' || window.state === 'missing') {
          waiting = true
          setState((before) => ({ ...before, [deck]: 'loading' }))
          continue
        }
        if (window.state === 'failed') {
          setState((before) => ({ ...before, [deck]: 'failed' }))
          continue
        }
        if (loaded.current[deck] === window.window.id) {
          setState((before) => ({ ...before, [deck]: 'ready' }))
          continue
        }
        setState((before) => ({ ...before, [deck]: 'loading' }))
        try {
          const [vocals, drums, bass, other] = await Promise.all(
            (['vocals', 'drums', 'bass', 'other'] as const).map((stem) => loadStem(lumioFetch, decks[deck].id, window.window, stem, decode)),
          )
          if (stopped) return
          await setStems(deck, { vocals, drums, instrumental: mixSources(bass!, other!) })
          loaded.current[deck] = window.window.id
          setState((before) => ({ ...before, [deck]: 'ready' }))
        } catch {
          setState((before) => ({ ...before, [deck]: 'failed' }))
        }
      }
      if (waiting && !stopped) timer = window.setTimeout(() => void check(), POLL_MS)
    }
    void check()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
    // `needed` is followed through its key (the whole seconds it covers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, neededKey, ready, from, to, playlistId, lumioFetch, setStems])

  return state
}
