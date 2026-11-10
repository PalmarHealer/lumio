import { defineMessages } from '@/lib/i18n'

export const searchMessages = defineMessages({
  de: {
    search: 'Suche',
    searchShortcut: 'Suche (/)',
    placeholder: 'Suchen …',
    placeholderListen: 'Was möchtest du hören?',
    pagePlaceholder: 'Filme, Serien, Hörbücher durchsuchen …',
    close: 'Suche schließen',
    hint: 'Tippe, um die gesamte Bibliothek zu durchsuchen.',
    searching: 'Suche …',
    noResults: (term: string) => `Keine Treffer für „${term}“.`,
    showAll: (term: string) => `Alle Ergebnisse für „${term}“ anzeigen`,
    podcast: 'Podcast',
    results: 'Suchergebnisse',
    inLyrics: 'In Liedtexten',
    foundInLyrics: 'Im Liedtext gefunden',
    recent: 'Letzte Suchanfragen',
    removeRecent: (name: string) => `„${name}“ aus den letzten Suchanfragen entfernen`,
    play: (name: string) => `${name} abspielen`,
    pause: (name: string) => `${name} pausieren`,
    more: (name: string) => `Weitere Optionen für ${name}`,
  },
  en: {
    search: 'Search',
    searchShortcut: 'Search (/)',
    placeholder: 'Search …',
    placeholderListen: 'What do you want to listen to?',
    pagePlaceholder: 'Search movies, shows, audiobooks …',
    close: 'Close search',
    hint: 'Start typing to search your whole library.',
    searching: 'Searching …',
    noResults: (term: string) => `No results for “${term}”.`,
    showAll: (term: string) => `Show all results for “${term}”`,
    podcast: 'Podcast',
    results: 'Search results',
    inLyrics: 'In lyrics',
    foundInLyrics: 'Found in lyrics',
    recent: 'Recent searches',
    removeRecent: (name: string) => `Remove “${name}” from recent searches`,
    play: (name: string) => `Play ${name}`,
    pause: (name: string) => `Pause ${name}`,
    more: (name: string) => `More options for ${name}`,
  },
})

/** Singular item types, shown next to each result in the header search. */
export const typeLabels = defineMessages({
  de: { Movie: 'Film', Series: 'Serie', Episode: 'Folge', MusicAlbum: 'Album', Audio: 'Titel', BoxSet: 'Sammlung', Book: 'Buch', MusicArtist: 'Künstler', Playlist: 'Playlist', AudioBook: 'Hörbuch' },
  en: { Movie: 'Movie', Series: 'Show', Episode: 'Episode', MusicAlbum: 'Album', Audio: 'Track', BoxSet: 'Collection', Book: 'Book', MusicArtist: 'Artist', Playlist: 'Playlist', AudioBook: 'Audiobook' },
})

/** Row titles of the search page, one per item type. */
export const groupTitles = defineMessages({
  de: {
    Movie: 'Filme',
    Series: 'Serien',
    BoxSet: 'Sammlungen',
    Episode: 'Folgen',
    MusicAlbum: 'Alben & Hörbücher',
    Audio: 'Titel & Kapitel',
    Book: 'Bücher',
    MusicArtist: 'Künstler',
    Playlist: 'Playlists',
  },
  en: {
    Movie: 'Movies',
    Series: 'Shows',
    BoxSet: 'Collections',
    Episode: 'Episodes',
    MusicAlbum: 'Albums & Audiobooks',
    Audio: 'Tracks & Chapters',
    Book: 'Books',
    MusicArtist: 'Artists',
    Playlist: 'Playlists',
  },
})
