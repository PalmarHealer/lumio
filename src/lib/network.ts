import { useSyncExternalStore } from 'react'

/**
 * Whether Lumio is offline: the browser says so, or the media server can't be reached. Songs and videos that need the
 * network are greyed out and skipped meanwhile.
 *
 * The browser's own signal isn't enough: "online" only means a network is there, and some browsers (Firefox's offline
 * mode in its developer tools, for one) don't report the change at all. So a small ping to the server decides: every
 * 30 seconds while online, every 5 while offline (so coming back shows quickly), and at once when the browser reports a
 * change, the tab comes back to the front or a request failed without an answer. Any answer of the server means it is
 * reachable; requests that get through say so too.
 */
let browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine
let serverReachable = true
const listeners = new Set<() => void>()

/** The server's ping address (set while signed in), and the next scheduled check. */
let pingUrl: string | null = null
let timer: number | undefined
let probing = false

const ONLINE_CHECK_MS = 30_000
const OFFLINE_CHECK_MS = 5_000
// Mobile data can be slow (a weak signal, a train): a ping that takes long is still an answer, and a single lost one
// doesn't mean offline. Only two failed in a row (or the browser itself) switch to offline.
const PING_TIMEOUT_MS = 15_000
const FAILED_PINGS_FOR_OFFLINE = 2
let failedPings = 0

function emit() {
  for (const listener of listeners) listener()
}

function set(next: { browser?: boolean; server?: boolean }) {
  const before = isOffline()
  if (next.browser !== undefined) browserOnline = next.browser
  if (next.server !== undefined) serverReachable = next.server
  if (isOffline() !== before) emit()
}

function schedule(delay = isOffline() || failedPings > 0 ? OFFLINE_CHECK_MS : ONLINE_CHECK_MS) {
  if (typeof window === 'undefined') return
  window.clearTimeout(timer)
  if (pingUrl) timer = window.setTimeout(() => void probe(), delay)
}

/** Asks the server whether it is there; its answer (any answer) decides, whatever the browser thinks. */
async function probe() {
  if (!pingUrl || probing) return
  probing = true
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
  try {
    const response = await fetch(pingUrl, { cache: 'no-store', signal: controller.signal })
    // A server error (a proxy without its upstream) isn't the server.
    if (response.status >= 500) set({ server: false })
    else {
      failedPings = 0
      set({ browser: true, server: true })
    }
  } catch {
    failedPings++
    if (failedPings >= FAILED_PINGS_FOR_OFFLINE || !navigator.onLine) set({ server: false })
  } finally {
    window.clearTimeout(timeout)
    probing = false
    schedule()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    set({ browser: true })
    void probe()
  })
  window.addEventListener('offline', () => {
    set({ browser: false })
    schedule()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probe()
  })
  window.addEventListener('focus', () => void probe())
}

/** Set while signed in: where the server answers its ping (null signed out). Checks right away. */
export function setReachabilityProbe(url: string | null) {
  pingUrl = url
  if (url) void probe()
  else window.clearTimeout(timer)
}

/** Checks now (a request failed without an answer, the live connection dropped). */
export function checkReachability() {
  void probe()
}

/** Told by the requests to the media server: one got an answer (true), or failed without one (false). */
export function markServerReachable(reachable: boolean) {
  if (reachable) {
    failedPings = 0
    set({ server: true })
  } else {
    set({ server: false })
    schedule(OFFLINE_CHECK_MS)
  }
}

export const isOffline = () => !browserOnline || !serverReachable

export function useOffline() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isOffline,
  )
}

// ---- Wi-Fi or mobile data (Settings: a quality of its own on mobile data, downloads only over Wi-Fi) ----

interface NetworkInformation extends EventTarget {
  type?: string
}

const connectionInfo = () => (typeof navigator === 'undefined' ? undefined : (navigator as { connection?: NetworkInformation }).connection)

/**
 * Whether this device tells what kind of network it is on. Chrome on Android (and the Android app's WebView) does;
 * desktop browsers, Firefox and Safari don't, so the mobile-data settings only show where they can work.
 */
export const networkTypeKnown = () => typeof connectionInfo()?.type === 'string'

/** On mobile data right now (false where it can't be told). */
export const onCellular = () => connectionInfo()?.type === 'cellular'

let wifiOnlyDownloads = false
const downloadListeners = new Set<() => void>()

/** Set from the settings: downloads (and preparing episodes) wait for Wi-Fi. */
export function setWifiOnlyDownloads(on: boolean) {
  if (on === wifiOnlyDownloads) return
  wifiOnlyDownloads = on
  for (const listener of downloadListeners) listener()
}

/** Downloads have to wait: only over Wi-Fi is set and this is mobile data. */
export const downloadsWaitForWifi = () => wifiOnlyDownloads && onCellular()

/** Called when downloads may go on again or have to stop (the network changed, the setting changed). */
export function onDownloadsAllowedChange(listener: () => void) {
  downloadListeners.add(listener)
  return () => {
    downloadListeners.delete(listener)
  }
}

connectionInfo()?.addEventListener('change', () => {
  for (const listener of downloadListeners) listener()
})

/** Whether this is mobile data, following changes. */
export function useCellular() {
  return useSyncExternalStore(
    (listener) => {
      const info = connectionInfo()
      info?.addEventListener('change', listener)
      return () => info?.removeEventListener('change', listener)
    },
    onCellular,
    () => false,
  )
}
