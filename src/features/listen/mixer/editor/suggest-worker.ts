import { suggestions, type Suggestions } from '../editor-checks.ts'
import type { MixStyle, TrackMix } from '../types.ts'

/**
 * The planner's suggestions for a pair (its variants as starting points, out and in points, loops) off the main thread:
 * planning the variants takes up to a few hundred milliseconds.
 */

export interface SuggestRequest {
  ask: number
  aMix: TrackMix | null
  bMix: TrackMix | null
  ids: { from: string; to: string }
  style: MixStyle
}

export type SuggestAnswer = { ask: number; suggestions: Suggestions } | { ask: number; failed: true }

const scope = self as unknown as { onmessage: ((event: MessageEvent<SuggestRequest>) => void) | null; postMessage: (message: SuggestAnswer) => void }

scope.onmessage = (event) => {
  const { ask, aMix, bMix, ids, style } = event.data
  try {
    scope.postMessage({ ask, suggestions: suggestions(aMix, bMix, ids, style) })
  } catch {
    scope.postMessage({ ask, failed: true })
  }
}
