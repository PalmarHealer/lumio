import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { jellyfin } from '@/lib/jellyfin'
import { music } from '../../player/music-player'
import { createTransitionPreview, type PreviewSource, type TransitionPreview } from '../preview'
import { laneReach, rateAdvance } from '../timeline'
import type { Transition } from '../types'
import { loadDeckAudio, sourceEnd } from './audio'
import { POST_ROLL, PRE_ROLL } from './timeline-math'

/** Extra audio read past what the transition reaches now, so small edits don't need more. */
const MARGIN_S = 20

/** How far into each song the transition (with its pre- and post-roll) reaches. */
function reach(transition: Transition) {
  const end = transition.length + POST_ROLL
  return {
    a: laneReach({ start: transition.aOut, path: transition.pathA ?? [] }, rateAdvance(transition.rateA ?? [], 0, end)),
    b: laneReach({ start: transition.bIn, path: transition.pathB ?? [] }, rateAdvance(transition.rateB ?? [], transition.bAt, end)),
  }
}

export type PreviewStatus = 'loading' | 'ready' | 'failed'

export interface PreviewControls {
  status: PreviewStatus
  playing: boolean
  /** Transition time being heard (moves while playing). */
  position: number
  /** Plays (from `from`, else where it is); the audio clock is started here, in the click that asked for it. */
  play: (from?: number) => void
  pause: () => void
  seek: (t: number) => void
  scrub: (t: number) => void
  setLoop: (region: { from: number; to: number } | null) => void
  /** The audio loaded for each deck (for drawing it finer than the analysis). */
  sources: { a: PreviewSource | null; b: PreviewSource | null }
}

/**
 * The editor's live preview (../preview.ts): loads both songs' audio from their start up to where the transition needs
 * them, plays the transition as edited, follows every edit (more audio is read when an edit reaches further), and
 * reports the position.
 */
export function useTransitionPreview(options: { fromId: string; toId: string; transition: Transition | null; aDuration: number; bDuration: number }): PreviewControls {
  const { fromId, toId, transition, aDuration, bDuration } = options
  const { api, session } = useAuthedSession()
  const [status, setStatus] = useState<PreviewStatus>('loading')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [sources, setSources] = useState<{ a: PreviewSource | null; b: PreviewSource | null }>({ a: null, b: null })
  const preview = useRef<TransitionPreview | null>(null)
  const context = useRef<AudioContext | null>(null)
  const loaded = useRef({ a: 0, b: 0 })
  const latest = useRef(transition)
  latest.current = transition
  const ready = !!transition

  useEffect(() => {
    if (!ready || !api) return
    const abort = new AbortController()
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    context.current = ctx
    let unsubscribe = () => {}
    let disposed = false
    const start = latest.current!
    const needed = reach(start)
    const common = { api, userId: session.userId, accessToken: session.accessToken, deviceId: jellyfin.deviceInfo.id, context: ctx, signal: abort.signal }
    setStatus('loading')
    void (async () => {
      try {
        const [a, b] = await Promise.all([
          loadDeckAudio({ ...common, id: fromId, until: Math.min(aDuration || Infinity, needed.a + MARGIN_S) }),
          loadDeckAudio({ ...common, id: toId, until: Math.min(bDuration || Infinity, needed.b + MARGIN_S) }),
        ])
        if (disposed) return
        loaded.current = { a: sourceEnd(a), b: sourceEnd(b) }
        setSources({ a, b })
        const created = await createTransitionPreview({ a, b, transition: latest.current ?? start, preRoll: PRE_ROLL, postRoll: POST_ROLL, context: ctx })
        if (disposed) return created.dispose()
        preview.current = created
        unsubscribe = created.onPosition((t, isPlaying) => {
          setPosition(t)
          setPlaying(isPlaying)
        })
        setStatus('ready')
      } catch {
        if (!disposed) setStatus('failed')
      }
    })()
    return () => {
      disposed = true
      abort.abort()
      unsubscribe()
      preview.current?.dispose()
      preview.current = null
      void ctx.close().catch(() => undefined)
      context.current = null
    }
    // Loaded once per pair; edits go to the preview below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fromId, toId, api])

  // Every edit: the preview plays it from the current moment; an edit reaching past the audio read so far reads more.
  useEffect(() => {
    const current = preview.current
    if (!current || !transition || status !== 'ready') return
    current.setTransition(transition)
    const needed = reach(transition)
    const ctx = context.current
    if (!ctx || !api) return
    for (const deck of ['a', 'b'] as const) {
      const duration = deck === 'a' ? aDuration : bDuration
      if (needed[deck] <= loaded.current[deck] - 1 || loaded.current[deck] >= duration - 0.5) continue
      const until = Math.min(duration || Infinity, needed[deck] + MARGIN_S)
      loaded.current[deck] = until
      void loadDeckAudio({ api, userId: session.userId, accessToken: session.accessToken, deviceId: jellyfin.deviceInfo.id, context: ctx, id: deck === 'a' ? fromId : toId, until })
        .then(async (source) => {
          await current.setSource(deck, source)
          setSources((before) => ({ ...before, [deck]: source }))
        })
        .catch(() => undefined)
    }
  }, [transition, status, api, session.userId, session.accessToken, fromId, toId, aDuration, bDuration])

  // Stable functions (they only use refs), so effects can depend on them.
  const controls = useMemo(
    () => ({
      play: (from?: number) => {
        // Not over the song the player is playing.
        if (music.isLoaded()) music.pause()
        void context.current?.resume().catch(() => undefined)
        preview.current?.play(from)
      },
      pause: () => preview.current?.pause(),
      seek: (t: number) => {
        preview.current?.seek(t)
        setPosition(t)
      },
      scrub: (t: number) => {
        void context.current?.resume().catch(() => undefined)
        preview.current?.scrub(t)
        setPosition(t)
      },
      setLoop: (region: { from: number; to: number } | null) => preview.current?.setLoop(region),
    }),
    [],
  )
  return { status, playing, position, sources, ...controls }
}
