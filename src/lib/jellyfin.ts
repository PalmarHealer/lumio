import { Jellyfin, type Api } from '@jellyfin/sdk'

const DEVICE_ID_KEY = 'lumio.deviceId'

function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/** The browser this tab runs in. */
export function browserName() {
  const agent = navigator.userAgent
  if (/Edg\//.test(agent)) return 'Edge'
  if (/OPR\//.test(agent)) return 'Opera'
  if (/SamsungBrowser\//.test(agent)) return 'Samsung Internet'
  if (/Firefox\/|FxiOS\//.test(agent)) return 'Firefox'
  if (/Chrome\/|CriOS\//.test(agent)) return 'Chrome'
  if (/Safari\//.test(agent)) return 'Safari'
  return 'Browser'
}

// Like other clients, the device is named after what it is (the browser); "Lumio" shows up as the application name.
export const jellyfin = new Jellyfin({
  clientInfo: { name: 'Lumio', version: '0.1.0' },
  deviceInfo: { name: browserName(), id: getDeviceId() },
})

/** The media server: as set at build time; "/" means this very address (Lumio in front of Jellyfin, see the server's proxy). */
export const DEFAULT_SERVER_URL = (() => {
  const configured = import.meta.env.VITE_JELLYFIN_URL ?? ''
  return configured.trim() === '/' && typeof window !== 'undefined' ? window.location.origin : configured
})()

/**
 * The server address as a session keeps it: always absolute and without a trailing slash. "" or "/" is this very
 * address (Lumio in front of Jellyfin); a relative one would break everything that needs a whole URL (the socket).
 */
export function absoluteServerUrl(serverUrl: string) {
  const value = serverUrl.trim()
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || !/^https?:$/.test(window.location.protocol)) return value.replace(/\/+$/, '')
  return new URL(value || '/', window.location.origin).href.replace(/\/+$/, '')
}

export function createApi(serverUrl: string, accessToken?: string): Api {
  return jellyfin.createApi(serverUrl.replace(/\/+$/, ''), accessToken)
}
