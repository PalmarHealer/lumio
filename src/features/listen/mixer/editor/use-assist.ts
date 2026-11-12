import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { checkTransition, type CheckIssue, type Suggestions } from '../editor-checks'
import type { MixStyle, TrackMix, Transition } from '../types'
import type { SuggestAnswer, SuggestRequest } from './suggest-worker'

/**
 * The editor's assistance: the planner's live checks of the transition as edited (a few milliseconds each, run on a
 * deferred copy so dragging stays smooth) and its suggestions for the pair (planned once, in a worker).
 */
export function useChecks(transition: Transition, aMix: TrackMix | null, bMix: TrackMix | null): CheckIssue[] {
  const deferred = useDeferredValue(transition)
  return useMemo(() => {
    try {
      return checkTransition(deferred, aMix, bMix)
    } catch {
      return []
    }
  }, [deferred, aMix, bMix])
}

export function useSuggestions(aMix: TrackMix | null, bMix: TrackMix | null, ids: { from: string; to: string }, style: MixStyle): Suggestions | null {
  const [found, setFound] = useState<Suggestions | null>(null)
  const { from, to } = ids
  useEffect(() => {
    const worker = new Worker(new URL('./suggest-worker.ts', import.meta.url), { type: 'module' })
    const ask = 1
    worker.onmessage = (event: MessageEvent<SuggestAnswer>) => {
      if (event.data.ask === ask && 'suggestions' in event.data) setFound(event.data.suggestions)
    }
    const request: SuggestRequest = { ask, aMix, bMix, ids: { from, to }, style }
    worker.postMessage(request)
    return () => worker.terminate()
  }, [aMix, bMix, from, to, style])
  return found
}
