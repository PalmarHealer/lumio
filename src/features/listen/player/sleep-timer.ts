import { useSyncExternalStore } from 'react'

/**
 * The sleep timer: Listen pauses after some minutes, or once the track playing has ended. Only for this tab and this
 * session; the music player hands in how to pause (`setSleepHandler`) and asks at a track's end (`stopsAfterTrack`).
 */
export interface SleepTimer {
  /** When it pauses (ms since epoch), or null. */
  endsAt: number | null
  /** Pauses when the current track has ended. */
  endOfTrack: boolean
}

let timer: SleepTimer = { endsAt: null, endOfTrack: false }
let timeout: number | undefined
let pause: () => void = () => undefined
const listeners = new Set<() => void>()

function set(next: SleepTimer) {
  timer = next
  for (const listener of listeners) listener()
}

export function setSleepHandler(next: () => void) {
  pause = next
}

/** Pauses after `minutes`, at the end of the track (`'track'`), or switches the timer off (null). */
export function setSleepTimer(choice: number | 'track' | null) {
  window.clearTimeout(timeout)
  if (choice === null) return set({ endsAt: null, endOfTrack: false })
  if (choice === 'track') return set({ endsAt: null, endOfTrack: true })
  const endsAt = Date.now() + choice * 60_000
  timeout = window.setTimeout(() => {
    set({ endsAt: null, endOfTrack: false })
    pause()
  }, choice * 60_000)
  set({ endsAt, endOfTrack: false })
}

/** At a track's end: whether to stop here (and the timer is done then). */
export function stopsAfterTrack() {
  if (!timer.endOfTrack) return false
  set({ endsAt: null, endOfTrack: false })
  return true
}

/** Whether it pauses at the end of the track (without using the timer up, unlike `stopsAfterTrack`). */
export const sleepsAfterTrack = () => timer.endOfTrack

export function useSleepTimer(): SleepTimer {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => timer,
  )
}
