import type { Api } from '@jellyfin/sdk'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getLocale, type Locale } from '@/lib/i18n'
import { addLyricsProvider, type LyricsProvider } from '@/features/listen/player/lyrics-providers'
import type { PluginEntry } from './lumio-config'

/**
 * Plugin runtime. Admins add plugins (ES modules, by URL or as stored code) in the settings; every user's Lumio loads
 * the enabled ones. A plugin module exports `setup(lumio)` (default or named) and uses the API below to add to,
 * change or remove parts of the UI. Everything a plugin registers is undone when it is disabled or removed.
 *
 *   export default function setup(lumio) {
 *     lumio.addNavLink({ id: 'requests', label: 'Wünsche', href: 'https://requests.example.com', external: true })
 *     lumio.hide('header:cast')
 *     lumio.addSlot('item:bottom', (element, { item }) => { element.textContent = item.Name })
 *     lumio.transform('homeRows', (rows) => rows.filter((row) => row.id !== 'latest'))
 *   }
 */

type Dispose = () => void

/** Places in the UI where plugins can render their own content. */
export type SlotName = 'header:start' | 'header:end' | 'home:top' | 'home:bottom' | 'item:actions' | 'item:bottom' | 'player:overlay'

/**
 * Built-in parts plugins can remove: 'header:search', 'header:syncplay', 'header:cast', 'nav:<library id>',
 * 'home:<row id>' (see the home page's row ids), 'item:ratings', 'item:links', 'player:stats', ...
 */
export type HideTarget = string

export interface PluginNavLink {
  id: string
  label: string
  href: string
  /** Opens in a new tab (other sites). */
  external?: boolean
}

export interface PluginMenuItem {
  id: string
  label: string
  href?: string
  onClick?: () => void
}

/** A page of the settings, added by a plugin (served at /settings/plugin/<id>, listed in the settings' navigation). */
export interface PluginSettingsPage {
  id: string
  label: string
  /** Listed under "Administration", for administrators only. */
  admin?: boolean
  render: SlotRenderer
}

export interface PluginRoute {
  /** Served at /plugin/<path>. */
  path: string
  title?: string
  render: SlotRenderer
}

export type SlotRenderer = (element: HTMLElement, context: Record<string, unknown>) => void | Dispose

export type PluginEvent = 'navigate' | 'item' | 'playback:start' | 'playback:stop'

export interface JellyfinContext {
  api: Api
  serverUrl: string
  userId: string
  accessToken: string
  isAdmin: boolean
}

export interface LumioPluginApi {
  version: 1
  /** The signed-in session, or null on the login page. */
  readonly jellyfin: JellyfinContext | null
  readonly locale: Locale
  addStyle(css: string): Dispose
  addNavLink(link: PluginNavLink): Dispose
  addMenuItem(item: PluginMenuItem): Dispose
  addSlot(slot: SlotName, render: SlotRenderer): Dispose
  addRoute(route: PluginRoute): Dispose
  /** A page of the settings (e.g. an admin tool), listed in their navigation. */
  addSettingsPage(page: PluginSettingsPage): Dispose
  hide(target: HideTarget): Dispose
  /**
   * A source of song lyrics, asked (after Jellyfin and lrclib) about songs that have none yet; what it finds is kept
   * on the Lumio server, so it is asked once per song.
   */
  addLyricsProvider(provider: LyricsProvider): Dispose
  /** Changes data before it is shown, e.g. 'homeRows' (the rows of the home page). */
  transform<T>(name: string, fn: (value: T, context?: Record<string, unknown>) => T): Dispose
  on(event: PluginEvent, handler: (payload: unknown) => void): Dispose
  navigate(path: string): void
}

// ---------- registry ----------

interface Registry {
  navLinks: PluginNavLink[]
  menuItems: PluginMenuItem[]
  slots: Array<{ key: number; slot: SlotName; render: SlotRenderer }>
  routes: PluginRoute[]
  settingsPages: PluginSettingsPage[]
  hidden: string[]
  /** Bumped when transforms change, so users of them re-render. */
  transformVersion: number
}

let registry: Registry = { navLinks: [], menuItems: [], slots: [], routes: [], settingsPages: [], hidden: [], transformVersion: 0 }
const listeners = new Set<() => void>()
const transforms = new Map<string, Array<(value: unknown, context?: Record<string, unknown>) => unknown>>()
const eventHandlers = new Map<PluginEvent, Set<(payload: unknown) => void>>()
let nextKey = 1

function update(change: (current: Registry) => Registry) {
  registry = change(registry)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePluginRegistry() {
  return useSyncExternalStore(subscribe, () => registry)
}

/** Whether a plugin removed this built-in part. */
export function useHidden(target: HideTarget) {
  return usePluginRegistry().hidden.includes(target)
}

/** Runs `value` through the plugins' transforms of that name (re-render with usePluginRegistry to follow changes). */
export function applyTransforms<T>(name: string, value: T, context?: Record<string, unknown>): T {
  let result: unknown = value
  for (const fn of transforms.get(name) ?? []) {
    try {
      result = fn(result, context)
    } catch (error) {
      console.error(`Plugin transform "${name}" failed`, error)
    }
  }
  return result as T
}

export function emitPluginEvent(event: PluginEvent, payload: unknown) {
  for (const handler of eventHandlers.get(event) ?? []) {
    try {
      handler(payload)
    } catch (error) {
      console.error(`Plugin handler for "${event}" failed`, error)
    }
  }
}

// ---------- host context (set by the app) ----------

let jellyfin: JellyfinContext | null = null
let navigateTo: (path: string) => void = (path) => window.location.assign(path)

export function setPluginHost(context: { jellyfin: JellyfinContext | null; navigate: (path: string) => void }) {
  jellyfin = context.jellyfin
  navigateTo = context.navigate
}

// ---------- loading ----------

function createApi(disposers: Dispose[]): LumioPluginApi {
  const track = (dispose: Dispose): Dispose => {
    let done = false
    const once = () => {
      if (done) return
      done = true
      dispose()
    }
    disposers.push(once)
    return once
  }
  const remove = <T,>(list: T[], entry: T) => list.filter((candidate) => candidate !== entry)

  return {
    version: 1,
    get jellyfin() {
      return jellyfin
    },
    get locale() {
      return getLocale()
    },
    addStyle(css) {
      const style = document.createElement('style')
      style.dataset.lumioPlugin = ''
      style.textContent = css
      document.head.append(style)
      return track(() => style.remove())
    },
    addNavLink(link) {
      update((current) => ({ ...current, navLinks: [...current.navLinks, link] }))
      return track(() => update((current) => ({ ...current, navLinks: remove(current.navLinks, link) })))
    },
    addMenuItem(item) {
      update((current) => ({ ...current, menuItems: [...current.menuItems, item] }))
      return track(() => update((current) => ({ ...current, menuItems: remove(current.menuItems, item) })))
    },
    addSlot(slot, render) {
      const entry = { key: nextKey++, slot, render }
      update((current) => ({ ...current, slots: [...current.slots, entry] }))
      return track(() => update((current) => ({ ...current, slots: remove(current.slots, entry) })))
    },
    addSettingsPage(page) {
      update((current) => ({ ...current, settingsPages: [...current.settingsPages, page] }))
      return track(() => update((current) => ({ ...current, settingsPages: remove(current.settingsPages, page) })))
    },
    addRoute(route) {
      const entry = { ...route, path: route.path.replace(/^\/+|\/+$/g, '') }
      update((current) => ({ ...current, routes: [...current.routes, entry] }))
      return track(() => update((current) => ({ ...current, routes: remove(current.routes, entry) })))
    },
    hide(target) {
      update((current) => ({ ...current, hidden: [...current.hidden, target] }))
      return track(() =>
        update((current) => {
          // Remove one occurrence: two plugins may hide the same thing.
          const index = current.hidden.indexOf(target)
          return index < 0 ? current : { ...current, hidden: current.hidden.filter((_, i) => i !== index) }
        }),
      )
    },
    addLyricsProvider(provider) {
      return track(addLyricsProvider(provider))
    },
    transform(name, fn) {
      const generic = fn as (value: unknown, context?: Record<string, unknown>) => unknown
      transforms.set(name, [...(transforms.get(name) ?? []), generic])
      update((current) => ({ ...current, transformVersion: current.transformVersion + 1 }))
      return track(() => {
        transforms.set(name, (transforms.get(name) ?? []).filter((candidate) => candidate !== generic))
        update((current) => ({ ...current, transformVersion: current.transformVersion + 1 }))
      })
    },
    on(event, handler) {
      const handlers = eventHandlers.get(event) ?? new Set()
      handlers.add(handler)
      eventHandlers.set(event, handlers)
      return track(() => handlers.delete(handler))
    },
    navigate(path) {
      navigateTo(path)
    },
  }
}

const loaded = new Map<string, { signature: string; disposers: Dispose[] }>()

const signatureOf = (plugin: PluginEntry) => JSON.stringify(plugin.source)

async function importPlugin(plugin: PluginEntry): Promise<Record<string, unknown>> {
  if (plugin.source.type === 'url') return (await import(/* @vite-ignore */ plugin.source.url)) as Record<string, unknown>
  const url = URL.createObjectURL(new Blob([plugin.source.code], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>
  } finally {
    URL.revokeObjectURL(url)
  }
}

function unload(id: string) {
  const entry = loaded.get(id)
  if (!entry) return
  loaded.delete(id)
  for (const dispose of entry.disposers.reverse()) {
    try {
      dispose()
    } catch (error) {
      console.error(`Unloading plugin "${id}" failed`, error)
    }
  }
}

/** Brings the running plugins in line with the config: loads new/changed enabled ones, unloads the rest. */
export async function syncPlugins(plugins: PluginEntry[]) {
  const wanted = new Map(plugins.filter((plugin) => plugin.enabled).map((plugin) => [plugin.id, plugin]))
  for (const [id, entry] of loaded) {
    const plugin = wanted.get(id)
    if (!plugin || signatureOf(plugin) !== entry.signature) unload(id)
  }
  for (const plugin of wanted.values()) {
    if (loaded.has(plugin.id)) continue
    const disposers: Dispose[] = []
    loaded.set(plugin.id, { signature: signatureOf(plugin), disposers })
    try {
      const module = await importPlugin(plugin)
      const setup = (module.default ?? module.setup) as ((api: LumioPluginApi) => void | Dispose | Promise<void | Dispose>) | undefined
      if (typeof setup !== 'function') throw new Error('The module exports no setup function')
      const cleanup = await setup(createApi(disposers))
      if (typeof cleanup === 'function') disposers.push(cleanup)
    } catch (error) {
      console.error(`Plugin "${plugin.name}" could not be loaded`, error)
      unload(plugin.id)
    }
  }
}

// ---------- rendering ----------

/** Renders the plugin contributions for one slot; `context` is passed to them (e.g. the item on the item page). */
export function PluginSlot({ name, context = {}, className }: { name: SlotName; context?: Record<string, unknown>; className?: string }) {
  const entries = usePluginRegistry().slots.filter((entry) => entry.slot === name)
  if (entries.length === 0) return null
  return (
    <div data-plugin-slot={name} className={className}>
      {entries.map((entry) => (
        <SlotHost key={entry.key} render={entry.render} context={context} />
      ))}
    </div>
  )
}

function SlotHost({ render, context }: { render: SlotRenderer; context: Record<string, unknown> }) {
  const element = useRef<HTMLDivElement>(null)
  // Re-rendered when the context changes (e.g. another item); compared by its JSON-free identity keys.
  const contextKey = Object.entries(context)
    .map(([key, value]) => `${key}:${typeof value === 'object' && value && 'Id' in value ? String((value as { Id?: unknown }).Id) : String(value)}`)
    .join('|')
  useEffect(() => {
    const host = element.current
    if (!host) return
    let cleanup: void | Dispose
    try {
      cleanup = render(host, context)
    } catch (error) {
      console.error('Plugin slot failed', error)
    }
    return () => {
      if (typeof cleanup === 'function') cleanup()
      host.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, contextKey])
  return <div ref={element} />
}
