import { IconBadgeCc, IconCards, IconChartBar, IconCpu, IconDatabase, IconDeviceDesktop, IconHome, IconInfoCircle, IconKeyboard, IconLayoutDashboard, IconLock, IconMovie, IconMusic, IconPalette, IconPlug, IconPuzzle, IconTags, IconUserCircle } from '@tabler/icons-react'
import { inMode, useAppMode } from '@/lib/app-mode'
import { inCapacitor } from '@/lib/capacitor'
import { desktop } from '@/lib/desktop'
import { defineMessages, useMessages } from '@/lib/i18n'
import { useUserConfiguration } from './use-user-configuration'
import { usePluginRegistry } from '@/features/admin/plugins'

const labels = defineMessages({
  de: {
    profile: 'Konto',
    privacy: 'Privatsphäre',
    playback: 'Video',
    subtitles: 'Untertitel',
    music: 'Musik',
    home: 'Startseite',
    interface: 'Oberfläche',
    controls: 'Steuerung',
    downloads: 'Speicher & Downloads',
    app: 'App',
    about: 'Über Lumio',
    display: 'Darstellung',
    branding: 'Branding',
    plugins: 'Plugins',
    metadata: 'Metadaten',
    stats: 'Wiedergabe-Statistik',
    stemWorkers: 'Stem-Worker',
    groupAccount: 'Du',
    groupPlayback: 'Wiedergabe',
    groupLumio: 'Lumio',
    groupDevice: 'Dieses Gerät',
    groupAdmin: 'Administration',
  },
  en: {
    profile: 'Account',
    privacy: 'Privacy',
    playback: 'Video',
    subtitles: 'Subtitles',
    music: 'Music',
    home: 'Home',
    interface: 'Interface',
    controls: 'Controls',
    downloads: 'Storage & downloads',
    app: 'App',
    about: 'About Lumio',
    display: 'Display',
    branding: 'Branding',
    plugins: 'Plugins',
    metadata: 'Metadata',
    stats: 'Playback statistics',
    stemWorkers: 'Stem workers',
    groupAccount: 'You',
    groupPlayback: 'Playback',
    groupLumio: 'Lumio',
    groupDevice: 'This device',
    groupAdmin: 'Administration',
  },
})

export type SettingsGroup = 'account' | 'playback' | 'lumio' | 'device' | 'admin'

export const SETTINGS_GROUPS: SettingsGroup[] = ['account', 'playback', 'lumio', 'device', 'admin']

const PAGES = [
  { key: 'profile', to: '/settings/profile', icon: IconUserCircle, group: 'account' },
  { key: 'privacy', to: '/settings/privacy', icon: IconLock, group: 'account' },
  { key: 'playback', to: '/settings/playback', icon: IconMovie, group: 'playback' },
  { key: 'subtitles', to: '/settings/subtitles', icon: IconBadgeCc, group: 'playback' },
  { key: 'music', to: '/settings/music', icon: IconMusic, group: 'playback' },
  { key: 'home', to: '/settings/home', icon: IconHome, group: 'lumio' },
  { key: 'interface', to: '/settings/interface', icon: IconLayoutDashboard, group: 'lumio' },
  { key: 'controls', to: '/settings/controls', icon: IconKeyboard, group: 'lumio' },
  { key: 'downloads', to: '/settings/downloads', icon: IconDatabase, group: 'device' },
  // In Lumio's apps their own settings; in a browser only what this version is.
  { key: 'app', to: '/settings/app', icon: IconDeviceDesktop, group: 'device' },
  // Server-wide, for administrators only.
  { key: 'display', to: '/settings/display', icon: IconCards, group: 'admin' },
  { key: 'branding', to: '/settings/branding', icon: IconPalette, group: 'admin' },
  { key: 'plugins', to: '/settings/plugins', icon: IconPuzzle, group: 'admin' },
  { key: 'metadata', to: '/settings/metadata', icon: IconTags, group: 'admin' },
  { key: 'stats', to: '/settings/stats', icon: IconChartBar, group: 'admin' },
  { key: 'stemWorkers', to: '/settings/stem-workers', icon: IconCpu, group: 'admin' },
] as const

/** Whether Lumio runs as one of its own apps (Android, desktop) rather than in a browser. */
export const inLumioApp = () => inCapacitor() || !!desktop()

export interface SettingsPageLink {
  key: string
  icon: typeof IconPlug
  to: string
  group: SettingsGroup
  admin: boolean
  label: string
}

/** The settings sub-pages, shared by the side navigation, the phone's list and the search. */
export function useSettingsPages(): SettingsPageLink[] {
  const names = useMessages(labels)
  const isAdmin = !!useUserConfiguration().data?.Policy?.IsAdministrator
  // Settings open inside whichever app is in use (/settings in Watch, /listen/settings in Listen).
  const mode = useAppMode()
  const app = inLumioApp()
  const builtIn = PAGES.filter((page) => page.group !== 'admin' || isAdmin).map((page) => ({
    key: page.key as string,
    icon: (page.key === 'app' && !app ? IconInfoCircle : page.icon) as typeof IconPlug,
    to: inMode(mode, page.to),
    group: page.group as SettingsGroup,
    admin: page.group === 'admin',
    label: page.key === 'app' && !app ? names.about : names[page.key],
  }))
  // In Listen, music comes before video.
  if (mode === 'listen') {
    const music = builtIn.findIndex((page) => page.key === 'music')
    const video = builtIn.findIndex((page) => page.key === 'playback')
    builtIn.splice(video, 0, ...builtIn.splice(music, 1))
  }
  // Pages plugins add (admin tools listed under "Administration").
  const fromPlugins = usePluginRegistry()
    .settingsPages.filter((page) => !page.admin || isAdmin)
    .map((page) => ({
      key: `plugin:${page.id}`,
      icon: IconPlug,
      to: inMode(mode, `/settings/plugin/${page.id}`),
      group: (page.admin ? 'admin' : 'lumio') as SettingsGroup,
      admin: !!page.admin,
      label: page.label,
    }))
  return [...builtIn, ...fromPlugins]
}

/** The headings of the groups. */
export function useGroupNames(): Record<SettingsGroup, string> {
  const names = useMessages(labels)
  return { account: names.groupAccount, playback: names.groupPlayback, lumio: names.groupLumio, device: names.groupDevice, admin: names.groupAdmin }
}
