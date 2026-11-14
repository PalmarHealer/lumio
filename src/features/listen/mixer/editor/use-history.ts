import { useCallback, useState } from 'react'

interface State<T> {
  value: T
  past: T[]
  future: T[]
}

/**
 * An edited value with undo and redo. `set` changes it without a step (while dragging); `commit` closes a step: the value
 * before the gesture goes onto the undo list (only when something changed).
 */
export function useHistory<T>(initial: T, limit = 200) {
  const [state, setState] = useState<State<T>>({ value: initial, past: [], future: [] })

  const set = useCallback((value: T) => setState((s) => ({ ...s, value })), [])
  const commit = useCallback(
    (before: T, after?: T) =>
      setState((s) => {
        const value = after === undefined ? s.value : after
        if (JSON.stringify(before) === JSON.stringify(value)) return { ...s, value }
        return { value, past: [...s.past.slice(-(limit - 1)), before], future: [] }
      }),
    [limit],
  )
  const undo = useCallback(
    () =>
      setState((s) => (s.past.length ? { value: s.past[s.past.length - 1]!, past: s.past.slice(0, -1), future: [s.value, ...s.future] } : s)),
    [],
  )
  const redo = useCallback(() => setState((s) => (s.future.length ? { value: s.future[0]!, past: [...s.past, s.value], future: s.future.slice(1) } : s)), [])
  /** Starts over from `start` (another suggestion): one undoable step. */
  const replace = useCallback((start: T) => setState((s) => ({ value: start, past: [...s.past.slice(-(limit - 1)), s.value], future: [] })), [limit])

  return { value: state.value, set, commit, undo, redo, replace, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }
}
