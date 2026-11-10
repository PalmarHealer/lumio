import { queryOptions, skipToken, useQuery } from '@tanstack/react-query'
import { applyCacheVersion } from '@/lib/app-cache'
import { useEffect, useSyncExternalStore } from 'react'
import { cacheBrand } from '@/lib/boot'
import { useLocation, useNavigate } from 'react-router'
import { useSession } from '@/features/auth/session'
import { userOptions } from '@/features/settings/use-user-configuration'
import { modeOf, type AppMode } from '@/lib/app-mode'
import { useTheme } from '@/lib/theme'
import { BUNDLED } from '@/lib/platform'
import { DEFAULT_SERVER_URL } from '@/lib/jellyfin'
import { fetchConfig, type LumioConfig } from './lumio-config'
import { emitPluginEvent, setPluginHost, syncPlugins } from './plugins'

export const DEFAULT_APP_NAME = 'Lumio'
const DEFAULT_FAVICON = '/favicon.svg'

/** The server whose branding applies: the signed-in one, or the default server on the login page. */
function useBrandingServer() {
  const { session } = useSession()
  return session?.serverUrl ?? import.meta.env.VITE_JELLYFIN_URL ?? ''
}

/**
 * Whether a server's plugins may run: they are code. On the web only the server this Lumio belongs to counts, not one
 * a visitor signs in to by address (its admin's code would run on this site, with its storage and others' sign-ins);
 * the apps belong to the server their user picked.
 */
function runsPluginsOf(serverUrl: string) {
  if (BUNDLED) return true
  const origin = URL.parse(serverUrl)?.origin
  return !!origin && (origin === window.location.origin || origin === URL.parse(DEFAULT_SERVER_URL)?.origin)
}

export const configOptions = (serverUrl: string) =>
  queryOptions({
    queryKey: ['lumio-config', serverUrl],
    enabled: !!serverUrl,
    staleTime: 5 * 60_000,
    // A server without (readable) branding just means the defaults.
    queryFn: ({ signal }) => fetchConfig(serverUrl, signal).catch((): LumioConfig => ({})),
  })

export function useLumioConfig() {
  return useQuery(configOptions(useBrandingServer()))
}

/** The apps' default labels; admins can replace them per app (branding → apps). */
export const DEFAULT_MODE_LABELS: Record<AppMode, string> = { watch: 'Watch', listen: 'Listen' }

/**
 * Name and logo to show (the admin's branding, or Lumio's own). With a mode, also that app's label ("Watch") and its
 * own logo where the admin set one.
 */
export function useBranding(mode?: AppMode) {
  const config = useLumioConfig().data ?? {}
  const own = mode ? config.modes?.[mode] : undefined
  // Each picture may come in a light version; one alone serves both looks.
  const light = useTheme() === 'light'
  return {
    appName: config.appName?.trim() || DEFAULT_APP_NAME,
    logo: (light && config.logoLight) || config.logo,
    modeLabel: mode ? own?.label?.trim() || DEFAULT_MODE_LABELS[mode] : undefined,
    modeLogo: (light && own?.logoLight) || own?.logo,
    /** The platform account's picture (Listen). */
    avatar: (light && own?.avatarLight) || own?.avatar,
    /** The header shows the app's label only, not the instance's name. */
    hideName: !!own?.hideName,
    config,
  }
}

const lightQuery = () => window.matchMedia('(prefers-color-scheme: light)')

/** Whether the device (and so the browser's tab bar) is set to light. */
function useLightBrowser() {
  return useSyncExternalStore(
    (listener) => {
      const query = lightQuery()
      query.addEventListener('change', listener)
      return () => query.removeEventListener('change', listener)
    },
    () => lightQuery().matches,
  )
}

/** Relative luminance of a #rrggbb color (0 = black, 1 = white). */
function luminance(hex: string) {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function styleElement(id: string) {
  let element = document.getElementById(id) as HTMLStyleElement | null
  if (!element) {
    element = document.createElement('style')
    element.id = id
    document.head.append(element)
  }
  return element
}

/**
 * Applies the server-wide branding (title, favicon, primary color, custom CSS) and runs the enabled plugins. Lives
 * inside the router so plugins can navigate.
 */
export function BrandingEffects() {
  const { pathname } = useLocation()
  const { appName, modeLabel, config } = useBranding(modeOf(pathname))
  const { session, api } = useSession()
  // Also runs on the login page, where there is no user yet.
  const user = useQuery(api && session ? userOptions(api, session.userId) : { queryKey: ['user', 'signed-out'], queryFn: skipToken })
  const navigate = useNavigate()

  // An admin asked every device to load everything fresh: done once per new version.
  useEffect(() => applyCacheVersion(config.cacheVersion), [config.cacheVersion])

  // "Lumio Listen" in the tab, so the two apps can be told apart there too.
  useEffect(() => {
    document.title = `${appName} ${modeLabel}`
  }, [appName, modeLabel])

  // The next start's boot screen shows this branding before anything has loaded.
  const loaded = useLumioConfig().isSuccess
  useEffect(() => {
    if (!loaded) return
    cacheBrand({
      appName: config.appName?.trim() || undefined,
      logo: config.logo,
      logoLight: config.logoLight,
      favicon: config.favicon,
      faviconLight: config.faviconLight,
      primaryColor: config.primaryColor,
    })
  }, [loaded, config.appName, config.logo, config.logoLight, config.favicon, config.faviconLight, config.primaryColor])

  // The tab sits in the browser's own bar, so its icon follows the device's look rather than the app's.
  const lightBrowser = useLightBrowser()
  const favicon = (lightBrowser && config.faviconLight) || config.favicon
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) return
    link.href = favicon || DEFAULT_FAVICON
    // A data URL may be any image type; the default is SVG.
    link.type = favicon ? (favicon.match(/^data:([^;,]+)/)?.[1] ?? '') : 'image/svg+xml'
  }, [favicon])

  const watchColor = config.modes?.watch?.primaryColor
  const listenColor = config.modes?.listen?.primaryColor
  useEffect(() => {
    const valid = (color: string | undefined): color is string => !!color && /^#[0-9a-f]{6}$/i.test(color)
    // Text on the color must stay readable: dark on light colors, white on dark ones.
    const on = (color: string) => (luminance(color) > 0.45 ? '#0a0a0a' : '#ffffff')
    const primary = (color: string) => `--primary: ${color}; --primary-foreground: ${on(color)}; --ring: ${color}; --sidebar-primary: ${color};`
    const listen = (color: string) => `--listen-accent: ${color}; --listen-accent-foreground: ${on(color)};`
    const rules: string[] = []
    // The overall color, for both apps (Listen's own accent follows too).
    if (valid(config.primaryColor)) rules.push(`:root, .dark { ${primary(config.primaryColor)} ${listen(config.primaryColor)} }`)
    // Each app's own, while it is shown (menus open in a portal outside the app's frame, hence on the whole page).
    if (valid(watchColor)) rules.push(`html:has([data-app-shell][data-mode='watch']) { ${primary(watchColor)} }`)
    if (valid(listenColor)) rules.push(`html:has([data-app-shell][data-mode='listen']) { ${primary(listenColor)} ${listen(listenColor)} }`)
    styleElement('lumio-brand-colors').textContent = rules.join('\n')
  }, [config.primaryColor, watchColor, listenColor])

  useEffect(() => {
    styleElement('lumio-custom-css').textContent = config.customCss ?? ''
  }, [config.customCss])

  const isAdmin = !!user.data?.Policy?.IsAdministrator
  useEffect(() => {
    setPluginHost({
      jellyfin:
        session && api
          ? { api, serverUrl: session.serverUrl, userId: session.userId, accessToken: session.accessToken, isAdmin }
          : null,
      navigate: (path) => void navigate(path),
    })
  }, [session, api, isAdmin, navigate])

  const brandingServer = useBrandingServer()
  useEffect(() => {
    void syncPlugins(runsPluginsOf(brandingServer) ? (config.plugins ?? []) : [])
  }, [config.plugins, brandingServer])

  const { search } = useLocation()
  useEffect(() => {
    emitPluginEvent('navigate', { pathname, search })
  }, [pathname, search])

  return null
}
