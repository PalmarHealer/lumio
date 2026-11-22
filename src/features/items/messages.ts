import { defineMessages } from '@/lib/i18n'

export const detailMessages = defineMessages({
  de: {
    similar: 'Ähnliche Titel',
    seriesRow: (name: string) => `Reihe: ${name}`,
    version: 'Fassung',
    seriesPart: (part: number, total: number, name: string) => `Teil ${part} von ${total} der Reihe ${name}`,
    loadFailed: 'Eintrag konnte nicht geladen werden.',
    director: 'Regie',
    cast: 'Besetzung',
    guestStars: 'Gastauftritte',
    watched: 'Gesehen',
    markWatched: 'Als gesehen markieren',
    onWatchlist: 'Auf der Watchlist',
    watchlist: 'Watchlist',
    tracks: 'Kapitel & Titel',
    listened: 'Gehört',
    disc: (n: number) => `CD ${n}`,
    albums: 'Alben',
    albumCount: (n: number) => (n === 1 ? '1 Album' : `${n} Alben`),
    appearsOn: 'Mitwirkend bei',
    topTracks: 'Beliebte Titel',
    artist: 'Künstler',
    episodes: (n: number) => (n === 1 ? '1 Folge' : `${n} Folgen`),
  },
  en: {
    similar: 'More like this',
    seriesRow: (name: string) => `The ${name} series`,
    version: 'Version',
    seriesPart: (part: number, total: number, name: string) => `Part ${part} of ${total} in the ${name} series`,
    loadFailed: 'This title could not be loaded.',
    director: 'Director',
    cast: 'Cast',
    guestStars: 'Guest stars',
    watched: 'Watched',
    markWatched: 'Mark as watched',
    onWatchlist: 'On your watchlist',
    watchlist: 'Watchlist',
    tracks: 'Chapters & tracks',
    listened: 'Played',
    disc: (n: number) => `Disc ${n}`,
    albums: 'Albums',
    albumCount: (n: number) => (n === 1 ? '1 album' : `${n} albums`),
    appearsOn: 'Appears on',
    topTracks: 'Popular tracks',
    artist: 'Artist',
    episodes: (n: number) => (n === 1 ? '1 episode' : `${n} episodes`),
  },
})

export const playMessages = defineMessages({
  de: { play: 'Abspielen', resume: 'Fortsetzen', special: 'Special' },
  en: { play: 'Play', resume: 'Continue', special: 'Special' },
})

export const trackPickerMessages = defineMessages({
  de: { off: 'Aus', video: 'Video', language: 'Sprache', subtitles: 'Untertitel' },
  en: { off: 'Off', video: 'Video', language: 'Language', subtitles: 'Subtitles' },
})

export const episodeActionMessages = defineMessages({
  de: {
    markWatched: 'Als gesehen markieren',
    markUnwatched: 'Als nicht gesehen markieren',
    resetProgress: 'Fortschritt zurücksetzen',
    fileInfo: 'Dateiinfo',
    noInfo: 'Zu dieser Folge gibt es keine Dateiinformationen.',
    video: 'Video',
    audio: 'Ton',
    subtitles: 'Untertitel',
    file: 'Datei',
    none: 'Keine',
  },
  en: {
    markWatched: 'Mark as watched',
    markUnwatched: 'Mark as unwatched',
    resetProgress: 'Reset progress',
    fileInfo: 'File info',
    noInfo: 'There is no file information for this episode.',
    video: 'Video',
    audio: 'Audio',
    subtitles: 'Subtitles',
    file: 'File',
    none: 'None',
  },
})
