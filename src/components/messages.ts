import { defineMessages } from '@/lib/i18n'

export const shellMessages = defineMessages({
  de: {
    back: 'Zurück',
    home: 'Start',
    watchlist: 'Watchlist',
    downloads: 'Downloads',
    profile: 'Profil',
    settings: 'Einstellungen',
    history: 'Verlauf',
    wrapped: 'Wrapped',
    administration: 'Administration',
    lumioSettings: 'Lumio-Einstellungen',
    dashboard: 'Jellyfin-Dashboard',
    metadata: 'Metadaten',
    quickConnect: 'Quick Connect',
    appSettings: 'App-Einstellungen',
    switchServer: 'Server oder Konto wechseln',
    logout: 'Abmelden',
    theme: 'Design',
    themeSystem: 'Wie das Gerät',
    themeDark: 'Dunkel',
    themeLight: 'Hell',
    search: 'Suchen',
    library: 'Bibliothek',
    menu: 'Menü',
    viewProfile: 'Profil ansehen',
    tabs: 'Hauptnavigation',
    apps: 'Apps',
    getApp: 'App herunterladen',
  },
  en: {
    back: 'Back',
    home: 'Home',
    watchlist: 'Watchlist',
    downloads: 'Downloads',
    profile: 'Profile',
    settings: 'Settings',
    history: 'History',
    wrapped: 'Wrapped',
    administration: 'Administration',
    lumioSettings: 'Lumio settings',
    dashboard: 'Jellyfin-Dashboard',
    metadata: 'Metadata',
    quickConnect: 'Quick Connect',
    appSettings: 'App settings',
    switchServer: 'Switch server or account',
    logout: 'Sign out',
    theme: 'Theme',
    themeSystem: 'Match device',
    themeDark: 'Dark',
    themeLight: 'Light',
    search: 'Search',
    library: 'Library',
    menu: 'Menu',
    viewProfile: 'View profile',
    tabs: 'Main navigation',
    apps: 'Apps',
    getApp: 'Download the app',
  },
})

export const errorMessages = defineMessages({
  de: { title: 'Etwas ist schiefgelaufen', reload: 'Neu laden' },
  en: { title: 'Something went wrong', reload: 'Reload' },
})

export const notFoundMessages = defineMessages({
  de: { title: 'Seite nicht gefunden', home: 'Zur Startseite' },
  en: { title: 'Page not found', home: 'Go to Home' },
})

export const expandingSearchMessages = defineMessages({
  de: { close: 'Suche schließen' },
  en: { close: 'Close search' },
})

export const codeInputMessages = defineMessages({
  de: { digit: (position: number, length: number) => `Ziffer ${position} von ${length}` },
  en: { digit: (position: number, length: number) => `Digit ${position} of ${length}` },
})

/** For the generated shadcn components in ui/. */
export const uiMessages = defineMessages({
  de: { close: 'Schließen' },
  en: { close: 'Close' },
})
