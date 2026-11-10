import type { Api } from '@jellyfin/sdk'
import { getSystemApi } from '@jellyfin/sdk/lib/utils/api/system-api'

/**
 * Server-wide Lumio settings that admins manage (branding, theme, custom CSS, plugins).
 *
 * Jellyfin has no place for a web client's own settings, but its branding configuration is readable by everyone
 * (even before signing in, so the login page can be branded) and writable by admins only. Lumio's settings live in
 * there as one CSS comment appended to the "custom CSS" field: jellyfin-web, which also loads that field, sees nothing
 * but a comment, and the admin's own jellyfin-web CSS around it stays untouched.
 */
export interface LumioConfig {
  /** Replaces "Lumio" in the header, the login page and the browser tab. */
  appName?: string
  /** Data URL of the header/login logo (replaces the name text); for the dark look, or both when there is no light one. */
  logo?: string
  /** The logo for the light look (optional). */
  logoLight?: string
  /** Data URL of the browser tab icon; for dark, or both when there is no light one. */
  favicon?: string
  /** The tab icon for light browsers (optional). */
  faviconLight?: string
  /** Accent for buttons, highlights and focus rings, as #rrggbb. */
  primaryColor?: string
  /** CSS for Lumio only (unlike Jellyfin's custom CSS, which jellyfin-web loads too). */
  customCss?: string
  plugins?: PluginEntry[]
  /** Name and logo per app (Watch, Listen); each falls back to the overall name and logo. */
  modes?: Partial<Record<'watch' | 'listen', ModeBranding>>
  /** Where cards open the hover preview; everything not listed here does. */
  hoverPreview?: HoverPreviewRules
  /** Raised by an admin to make every device clear the app's cache (files, pictures, kept data) once. */
  cacheVersion?: number
  /** The player shows the title's backdrop until the video's first frame (as Jellyfin's apps do); on unless false. */
  playerLoadingArt?: boolean
  /** Whether the browser suggests Lumio's app on each system (a notice, and the profile menu's entry); on unless false. */
  appPromotion?: Partial<Record<'android' | 'windows' | 'linux', boolean>>
  /** Libraries the music metadata tasks leave out (e.g. audio plays); by id. */
  metadataExcludedLibraries?: string[]
  /** Artists (by name) whose songs are never looked up, by the tasks nor while they play. */
  metadataExcludedArtists?: string[]
  /** Genres whose songs and artists are never looked up. */
  metadataExcludedGenres?: string[]
  /** Film and series libraries the two-language task leaves out; by id. */
  languageExcludedLibraries?: string[]
}

export interface ModeBranding {
  /** Replaces the app's label ("Watch", "Listen") next to the name. */
  label?: string
  /** Data URL of a logo for this app; replaces name and label in its header. For dark, or both without a light one. */
  logo?: string
  /** This app's logo for the light look (optional). */
  logoLight?: string
  /** Listen only: picture of the platform's own account (owner of the official playlists); else its mark. */
  avatar?: string
  /** That picture for the light look (optional). */
  avatarLight?: string
  /** Shows only the app's label (with its switcher) in the header, without the instance's name. */
  hideName?: boolean
  /** This app's accent as #rrggbb (Watch: buttons and highlights; Listen: also its play buttons); else the overall one. */
  primaryColor?: string
}

export interface HoverPreviewRules {
  /** Item types (Jellyfin's `Type`, e.g. "MusicAlbum") whose cards never open a preview. */
  disabledTypes?: string[]
  /** Library ids whose titles never open a preview. */
  disabledLibraries?: string[]
}

export interface PluginEntry {
  id: string
  name: string
  enabled: boolean
  /** An ES module URL, or module code stored right here. */
  source: { type: 'url'; url: string } | { type: 'code'; code: string }
}

const MARKER = /\/\* lumio-config:v1:([A-Za-z0-9+/=]*) \*\//
const MARKER_GLOBAL = new RegExp(MARKER.source, 'g')

function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/** Lumio's settings out of Jellyfin's custom CSS; an empty config when there are none (or they are unreadable). */
export function parseConfig(customCss: string | null | undefined): LumioConfig {
  const match = customCss?.match(MARKER)
  if (!match?.[1]) return {}
  try {
    const parsed = JSON.parse(fromBase64(match[1])) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as LumioConfig) : {}
  } catch {
    return {}
  }
}

/** Jellyfin's custom CSS with Lumio's settings block replaced (or added, or removed when the config is empty). */
export function embedConfig(customCss: string | null | undefined, config: LumioConfig): string {
  const rest = (customCss ?? '').replace(MARKER_GLOBAL, '').trimEnd()
  const empty = Object.values(config).every((value) => value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
  if (empty) return rest
  const block = `/* lumio-config:v1:${toBase64(JSON.stringify(config))} */`
  return rest ? `${rest}\n\n${block}` : block
}

/** Reads the config without signing in (also used on the login page). */
export async function fetchConfig(serverUrl: string, signal?: AbortSignal): Promise<LumioConfig> {
  const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/Branding/Configuration`, { signal })
  if (!response.ok) throw new Error(`Branding request failed: ${response.status}`)
  const branding = (await response.json()) as { CustomCss?: string | null }
  return parseConfig(branding.CustomCss)
}

/** Writes the config into the server's branding configuration (admins only), keeping everything else in it. */
export async function saveConfig(api: Api, config: LumioConfig) {
  const system = getSystemApi(api)
  const { data } = await system.getNamedConfiguration({ key: 'branding' })
  const branding = data as unknown as Record<string, unknown>
  await system.updateNamedConfiguration({
    key: 'branding',
    body: { ...branding, CustomCss: embedConfig(branding.CustomCss as string | undefined, config) },
  })
}
