import { IconPlayerPlay, IconPlayerStop, IconSearch, IconX } from '@tabler/icons-react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUserViews } from '@/features/home/queries'
import { useItem, useMergedGenres } from '@/features/items/queries'
import { useArtistDirectory } from '@/features/listen/credits'
import { Section, SettingsPage, SwitchField } from '@/features/settings/fields'
import { lumioGet, lumioSend } from '@/features/social/social'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { useLumioConfig } from './branding'
import { LanguageDialog, useLocalizedChanged, type AdminLocalized } from './language-dialog'
import { ArtistMetadataDialog, TrackMetadataDialog, type TrackCredits, type TrackMetaInfo } from './metadata-dialogs'
import { useIsAdmin, useSaveConfig } from './use-admin-config'
import { hasService, ownKey } from '@/lib/services'
import { usePublicConfig } from '@/lib/public-config'
import { toast } from 'sonner'

const messages = defineMessages({
  de: {
    title: 'Metadaten',
    description:
      'Lumio ergänzt die Bibliothek um Angaben von außen. Was gespielt oder geöffnet wird, schlägt Lumio von selbst nach; hier lässt sich alles auf einmal erledigen. Die Aufgaben laufen auf dem Lumio-Server weiter, auch wenn du die Seite verlässt.',
    adminOnly: 'Nur für Administrator*innen.',
    libraries: 'Musikbibliotheken',
    exclusions: 'Ausschließen',
    exclusionsHint:
      'Songs dieser Künstler*innen oder Genres schlägt Lumio nie nach, weder in den Aufgaben noch beim Abspielen. Gut für Hörspiele oder Hörbücher in der Musikbibliothek.',
    excludedArtists: 'Künstler*innen',
    excludedGenres: 'Genres',
    addArtist: 'Künstler*in hinzufügen …',
    addGenre: 'Genre hinzufügen …',
    removeExclusion: (name: string) => `${name} wieder einbeziehen`,
    noExclusions: 'Keine',
    librariesHint: 'Welche Bibliotheken die Aufgaben durchgehen. Hörspiele oder Hörbücher etwa lassen sich ausschließen.',
    credits: 'Songinfos und Künstler*innen',
    creditsHint:
      'Schlägt jeden Song auf MusicBrainz nach, der noch nicht nachgeschlagen wurde: Gastkünstler*innen, die in den Datei-Tags fehlen, Songwriter*innen, Produktion, Label und Verlag. Etwa drei Sekunden pro Song (MusicBrainz erlaubt einen Abruf pro Sekunde).',
    creditsStart: 'Songs ergänzen',
    artists: 'Künstler*innen-Infos',
    artistsHint:
      'Lädt für alle Künstler*innen vorab, was Lumio zu ihnen zeigt: Beschreibung (Last.fm, Epidemic Sound), Fotos, beliebte Songs, ähnliche Künstler*innen und Links. Danach erscheinen Künstlerseiten sofort. Etwa fünf Sekunden pro Künstler*in.',
    artistsStart: 'Infos vorladen',
    sound: 'Klang und Tags',
    soundHint:
      'Misst jeden Song (Tempo, Tonart, Dur oder Moll, Energie, Dynamik, Helligkeit) an einem Ausschnitt, den Jellyfin kurz umwandelt, und holt die Tags von Song und Künstler*innen von Last.fm. Daraus entstehen die Stimmungs- und Tag-Mixe. Etwa zwei Sekunden pro Song; gespielte Songs werden auch so nach und nach gemessen.',
    soundStart: 'Songs messen',
    lyrics: 'Liedtext-Suche',
    lyricsHint:
      'Legt die Liedtexte aller Songs in Meilisearch ab, damit die Suche Songs auch über eine Zeile ihres Textes findet: was Jellyfin hat (eingebettet, .lrc-Dateien, Lyrics-Plugins) und was Lumio von außerhalb gespeichert hat. Songs ohne Liedtext werden übersprungen; gespielte Songs kommen auch so nach und nach dazu. Braucht MEILI_URL und MEILI_KEY am Lumio-Server.',
    lyricsStart: 'Liedtexte aufnehmen',
    stop: 'Anhalten',
    progress: (done: number, total: number) => `${done} von ${total}`,
    found: (found: number, failed: number) => `${found} mit Ergebnis${failed ? `, ${failed} fehlgeschlagen` : ''}`,
    finished: (when: string) => `Zuletzt beendet: ${when}`,
    nothing: 'Nichts mehr zu tun.',
    unavailable: 'Der Lumio-Server ist nicht erreichbar.',
    remaining: (minutes: number) => (minutes < 1 ? 'noch unter einer Minute' : `noch etwa ${minutes} Min.`),
    failedTitle: (n: number) => `Fehlgeschlagen (${n})`,
    failedHint: 'Hier hat ein Dienst nicht geantwortet. Diese Einträge werden beim nächsten Durchlauf erneut versucht; ein Klick zeigt Details.',
    missingTitle: (n: number) => `Songs nicht gefunden (${n})`,
    missingHint:
      'Für diese Songs gibt es auf MusicBrainz keine Aufnahme mit gleichem Titel, Künstler*in und ähnlicher Länge. Ein Klick öffnet die Suche, um die richtige Aufnahme von Hand zuzuordnen oder die Angaben selbst einzutragen.',
    lookedUp: (when: string) => `nachgeschlagen ${when}`,
    browse: 'Metadaten durchsuchen',
    browseHint: 'Alle nachgeschlagenen Songs. Ein Klick öffnet die Angaben zum Prüfen und Bearbeiten.',
    browseSearch: 'Titel, Künstler*in, Album oder Mitwirkende',
    browseCount: (n: number) => (n === 1 ? '1 Song' : `${n} Songs`),
    more: 'Mehr laden',
    noCredits: 'nicht gefunden',
    edited: 'von Hand',
    videoLibraries: 'Film- und Serienbibliotheken',
    videoLibrariesHint: 'Welche Bibliotheken die Aufgabe für zwei Sprachen durchgeht.',
    languages: 'Filme und Serien in zwei Sprachen',
    languagesHint:
      'Erkennt, ob Titel und Beschreibung in Jellyfin deutsch oder englisch sind (an Wörtern, die es nur in einer der Sprachen gibt), und holt die andere Sprache von TMDb, dazu Poster und Logos mit Schrift in der anderen Sprache. Lumio zeigt dann die Sprache der Oberfläche. Neue Titel werden auch beim Öffnen ergänzt. Etwa eine Sekunde pro Film, einige pro Serie.',
    languagesStart: 'Sprachen ergänzen',
    noTmdb: 'Ohne TMDb-Schlüssel (TMDB_API_KEY am Lumio-Server) werden die Texte nur eingeordnet; die andere Sprache kommt nach, sobald es einen gibt.',
    review: 'Sprachen prüfen',
    reviewHint:
      'Was die Aufgabe gefunden hat. Bei „unklar“ kommen Wörter beider Sprachen vor oder zu wenige; Lumio zeigt dort den Jellyfin-Text. Ein Klick öffnet Texte und Sprache zum Festlegen.',
    reviewSearch: 'Titel oder Serie',
    labelFilter: (label: string) => ({ unclear: 'Unklar', de: 'Deutsch', en: 'Englisch', none: 'Ohne Text', all: 'Alle' })[label] ?? label,
    setLabel: (language: string) => `Der Jellyfin-Text ist ${language}`,
    labelSaved: 'Festgelegt; die andere Sprache wird ergänzt.',
    labelFailed: 'Das hat nicht geklappt.',
    titleCount: (n: number) => (n === 1 ? '1 Eintrag' : `${n} Einträge`),
    typeName: (type: string) => ({ Movie: 'Film', Series: 'Serie', Season: 'Staffel', Episode: 'Folge' })[type] ?? type,
  },
  en: {
    title: 'Metadata',
    description:
      'Lumio adds information from outside to the library. What plays or is opened is looked up on its own; here everything can be done at once. The tasks keep running on the Lumio server when you leave this page.',
    adminOnly: 'Administrators only.',
    libraries: 'Music libraries',
    exclusions: 'Leave out',
    exclusionsHint: "Lumio never looks up songs by these artists or in these genres, in the tasks or while they play. Handy for audio plays or audiobooks in the music library.",
    excludedArtists: 'Artists',
    excludedGenres: 'Genres',
    addArtist: 'Add artist …',
    addGenre: 'Add genre …',
    removeExclusion: (name: string) => `Include ${name} again`,
    noExclusions: 'None',
    librariesHint: 'Which libraries the tasks go through. Audio plays or audiobooks, say, can be left out.',
    credits: 'Song credits and artists',
    creditsHint:
      "Looks up every song on MusicBrainz that wasn't yet: featured artists missing from the file tags, songwriters, production, label and publisher. About three seconds a song (MusicBrainz allows one call a second).",
    creditsStart: 'Fill in songs',
    artists: 'Artist information',
    artistsHint:
      'Fetches ahead what Lumio shows about every artist: biography (Last.fm, Epidemic Sound), photos, popular songs, similar artists and links. Artist pages then open at once. About five seconds an artist.',
    artistsStart: 'Fetch information',
    sound: 'Sound and tags',
    soundHint:
      'Measures every song (tempo, key, major or minor, energy, dynamics, brightness) from an excerpt Jellyfin briefly transcodes, and fetches the song\'s and artists\' tags from Last.fm. The mood and tag mixes are made from these. About two seconds a song; songs that are played get measured bit by bit anyway.',
    soundStart: 'Measure songs',
    lyrics: 'Lyrics search',
    lyricsHint:
      'Puts every song\'s lyrics into Meilisearch, so the search also finds songs by a line of their lyrics: what Jellyfin has (embedded, .lrc files, lyrics plugins) and what Lumio kept from outside. Songs without lyrics are skipped; songs that are played get added bit by bit anyway. Needs MEILI_URL and MEILI_KEY on the Lumio server.',
    lyricsStart: 'Add lyrics',
    stop: 'Stop',
    progress: (done: number, total: number) => `${done} of ${total}`,
    found: (found: number, failed: number) => `${found} with results${failed ? `, ${failed} failed` : ''}`,
    finished: (when: string) => `Last finished: ${when}`,
    nothing: 'Nothing left to do.',
    unavailable: "The Lumio server can't be reached.",
    remaining: (minutes: number) => (minutes < 1 ? 'under a minute left' : `about ${minutes} min left`),
    failedTitle: (n: number) => `Failed (${n})`,
    failedHint: "A service didn't answer for these. They are tried again on the next run; click one for details.",
    missingTitle: (n: number) => `Songs not found (${n})`,
    missingHint:
      'MusicBrainz has no recording with the same title, artist and a similar length for these songs. Click one to search for the right recording and match it by hand, or to enter the credits yourself.',
    lookedUp: (when: string) => `looked up ${when}`,
    browse: 'Browse metadata',
    browseHint: 'Every song looked up. Click one to check and edit what is known.',
    browseSearch: 'Title, artist, album or credits',
    browseCount: (n: number) => (n === 1 ? '1 song' : `${n} songs`),
    more: 'Load more',
    noCredits: 'not found',
    edited: 'by hand',
    videoLibraries: 'Film and series libraries',
    videoLibrariesHint: 'Which libraries the two-language task goes through.',
    languages: 'Films and series in two languages',
    languagesHint:
      "Finds out whether Jellyfin's titles and overviews are German or English (by words only one of the languages has) and fetches the other language from TMDb, along with posters and logos with writing in the other language. Lumio then shows the interface language. New titles are also filled in when opened. About a second a film, a few for a series.",
    languagesStart: 'Fill in languages',
    noTmdb: 'Without a TMDb key (TMDB_API_KEY on the Lumio server) the texts are only labelled; the other language follows once there is one.',
    review: 'Check languages',
    reviewHint:
      'What the task found. "Unclear" means words of both languages, or too few; Lumio shows the Jellyfin text there. Click one to open its texts and set the language.',
    reviewSearch: 'Title or series',
    labelFilter: (label: string) => ({ unclear: 'Unclear', de: 'German', en: 'English', none: 'No text', all: 'All' })[label] ?? label,
    setLabel: (language: string) => `Jellyfin's text is ${language}`,
    labelSaved: 'Set; the other language is being filled in.',
    labelFailed: "That didn't work.",
    titleCount: (n: number) => (n === 1 ? '1 entry' : `${n} entries`),
    typeName: (type: string) => ({ Movie: 'Film', Series: 'Series', Season: 'Season', Episode: 'Episode' })[type] ?? type,
  },
})

interface Failure {
  id: string
  title: string
  artist?: string
  album?: string
  albumId?: string
  error: string
}

interface JobState {
  running: boolean
  total: number
  done: number
  found: number
  failed: number
  startedAt?: number
  finishedAt?: number
  error?: string
  failures: Failure[]
}

interface Stored {
  id: string
  at: number
  meta: TrackMetaInfo | null
  data?: TrackCredits | null
}

type JobName = 'credits' | 'artists' | 'languages' | 'sound' | 'lyrics'

/** What the popup shows: a song's metadata, an artist whose information failed, or a film's or series' texts. */
type Opened =
  | { kind: 'track'; id: string; meta: TrackMetaInfo; error?: string }
  | { kind: 'artist'; id: string; name: string; error?: string }
  | { kind: 'title'; id: string }

/**
 * A list of names to leave out, as removable chips, with a field that suggests from what the library has (Enter, or
 * picking a suggestion, adds).
 */
function ExclusionPicker({
  id,
  label,
  placeholder,
  values,
  options,
  disabled,
  onChange,
}: {
  id: string
  label: string
  placeholder: string
  values: string[]
  options: string[]
  disabled?: boolean
  onChange: (values: string[]) => void
}) {
  const t = useMessages(messages)
  const [draft, setDraft] = useState('')
  const add = (value: string) => {
    const name = options.find((option) => option.toLocaleLowerCase() === value.trim().toLocaleLowerCase()) ?? value.trim()
    if (name && !values.includes(name)) onChange([...values, name])
    setDraft('')
  }
  return (
    <div className="space-y-2 p-4">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.length === 0 && <span className="text-sm text-muted-foreground">{t.noExclusions}</span>}
        {values.map((value) => (
          <span key={value} className="flex items-center gap-1 rounded-full bg-muted py-1 pl-3 pr-1 text-sm">
            {value}
            <button
              type="button"
              disabled={disabled}
              aria-label={t.removeExclusion(value)}
              title={t.removeExclusion(value)}
              onClick={() => onChange(values.filter((entry) => entry !== value))}
              className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <IconX className="size-3.5" />
            </button>
          </span>
        ))}
      </div>
      <Input
        list={`${id}-options`}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          const value = event.target.value
          // Picking a suggestion adds it at once.
          if (options.includes(value)) add(value)
          else setDraft(value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft.trim()) {
            event.preventDefault()
            add(draft)
          }
        }}
        className="max-w-sm"
      />
      <datalist id={`${id}-options`}>
        {options
          .filter((option) => !values.includes(option))
          .map((option) => (
            <option key={option} value={option} />
          ))}
      </datalist>
    </div>
  )
}

/** The music libraries the tasks can go through (not films or series). */
const MUSIC_TYPES = new Set(['music', 'audiobooks', 'books', 'musicvideos', 'mixed'])
/** The libraries the two-language task can go through. */
const VIDEO_TYPES = new Set(['movies', 'tvshows', 'mixed'])

/** An entry in the lists; opens its popup. */
function EntryRow({ title, line, onClick }: { title?: string; line?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="block w-full px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
      <p className="truncate text-sm font-medium">{title || '—'}</p>
      {line && <p className="truncate text-xs text-muted-foreground">{line}</p>}
    </button>
  )
}

/** A stored song; names from Jellyfin for those looked up before Lumio kept them. */
function StoredRow({ song, note, onOpen }: { song: Stored; note: string; onOpen: (opened: Opened) => void }) {
  const item = useItem(song.id, !song.meta?.title).data
  const meta: TrackMetaInfo = song.meta?.title
    ? song.meta
    : { title: item?.Name ?? undefined, artist: item?.Artists?.[0], album: item?.Album ?? undefined, albumId: item?.AlbumId ?? undefined }
  return <EntryRow title={meta.title} line={[meta.artist, meta.album, note].filter(Boolean).join(' · ')} onClick={() => onOpen({ kind: 'track', id: song.id, meta })} />
}

function useJob(name: JobName, enabled: boolean) {
  return useQuery({
    queryKey: ['admin-job', name],
    enabled,
    // While it runs, the progress updates every few seconds.
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
    queryFn: async () => {
      const response = await lumioGet(`/admin/jobs/${name}`)
      if (!response?.ok) throw new Error('Unavailable')
      return (await response.json()) as JobState
    },
  })
}

/** One task: what it does, how far it is, start and stop, and what failed in its last run. */
function JobSection({
  name,
  title,
  hint,
  start,
  secondsEach,
  libraries,
  exclusions,
  onOpen,
}: {
  name: JobName
  title: string
  hint: string
  start: string
  secondsEach: number
  libraries: string[]
  /** Artists and genres the task leaves out. */
  exclusions: { excludeArtists: string[]; excludeGenres: string[] }
  onOpen: (opened: Opened) => void
}) {
  const t = useMessages(messages)
  const locale = getLocaleTag(useLocale())
  const client = useQueryClient()
  const state = useJob(name, true)
  const control = useMutation({
    mutationFn: async (method: 'POST' | 'DELETE') => {
      // The artist task asks Last.fm with the app's key, the language task TMDb, unless the server has its own.
      const keys = name === 'artists' || name === 'sound' ? { lastfmKey: ownKey('lastfm') } : name === 'languages' ? { tmdbKey: ownKey('tmdb') } : {}
      const body = method === 'POST' ? { libraries, ...exclusions, ...keys } : undefined
      const response = await lumioSend(method, `/admin/jobs/${name}`, body)
      if (!response?.ok) throw new Error('Unavailable')
      return (await response.json()) as JobState
    },
    onSuccess: (data) => client.setQueryData(['admin-job', name], data),
  })
  const job = state.data
  const share = job?.total ? Math.round((job.done / job.total) * 100) : 0
  const remaining = job?.running && job.total ? Math.round(((job.total - job.done) * secondsEach) / 60) : undefined
  return (
    <>
      <Section title={title} description={hint}>
        <div className="space-y-4 p-4">
          {state.isError && <p className="text-sm text-destructive">{t.unavailable}</p>}
          {job && (job.running || job.finishedAt) && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${job.total ? share : 100}%` }} />
              </div>
              <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                {job.total ? <span className="text-foreground">{t.progress(job.done, job.total)}</span> : !job.running && <span>{t.nothing}</span>}
                {job.total > 0 && <span>{t.found(job.found, job.failed)}</span>}
                {remaining !== undefined && <span>{t.remaining(remaining)}</span>}
                {!job.running && job.finishedAt && <span>{t.finished(new Date(job.finishedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }))}</span>}
              </p>
              {job.error && <p className="text-sm text-destructive">{job.error}</p>}
            </div>
          )}
          {job?.running ? (
            <Button variant="outline" disabled={control.isPending} onClick={() => control.mutate('DELETE')}>
              <IconPlayerStop /> {t.stop}
            </Button>
          ) : (
            <Button disabled={control.isPending || !job || !libraries.length} onClick={() => control.mutate('POST')}>
              <IconPlayerPlay /> {start}
            </Button>
          )}
        </div>
      </Section>
      {!!job?.failures.length && (
        <Section title={`${title}: ${t.failedTitle(job.failures.length)}`} description={t.failedHint}>
          <div className="max-h-80 divide-y overflow-y-auto">
            {job.failures.map((entry) => (
              <EntryRow
                key={entry.id}
                title={entry.title}
                line={[entry.artist, entry.album, entry.error].filter(Boolean).join(' · ')}
                onClick={() =>
                  onOpen(
                    name === 'artists'
                      ? { kind: 'artist', id: entry.id, name: entry.title, error: entry.error }
                      : name === 'languages'
                        ? { kind: 'title', id: entry.id }
                        : { kind: 'track', id: entry.id, meta: { title: entry.title, artist: entry.artist, album: entry.album, albumId: entry.albumId }, error: entry.error },
                  )
                }
              />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

/** Every looked-up song, searchable; each opens its metadata. */
function BrowseSection({ onOpen }: { onOpen: (opened: Opened) => void }) {
  const t = useMessages(messages)
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  // Searches once typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(term.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [term])
  const pages = useInfiniteQuery({
    queryKey: ['admin-credits', search],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const response = await lumioGet(`/admin/credits?${new URLSearchParams({ search, offset: String(pageParam) })}`)
      if (!response?.ok) throw new Error('Unavailable')
      return (await response.json()) as { total: number; rows: Stored[] }
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, page) => sum + page.rows.length, 0)
      return loaded < last.total ? loaded : undefined
    },
  })
  const rows = pages.data?.pages.flatMap((page) => page.rows) ?? []
  const total = pages.data?.pages[0]?.total
  return (
    <Section title={t.browse} description={t.browseHint}>
      <div className="flex items-center gap-3 border-b p-3">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={term} onChange={(event) => setTerm(event.target.value)} placeholder={t.browseSearch} aria-label={t.browseSearch} className="pl-8" />
        </div>
        {total !== undefined && <span className="shrink-0 text-sm text-muted-foreground">{t.browseCount(total)}</span>}
      </div>
      <div className="max-h-[32rem] divide-y overflow-y-auto">
        {rows.map((song) => (
          <StoredRow
            key={song.id}
            song={song}
            note={song.data === null ? t.noCredits : [song.meta?.edited || song.meta?.picked ? t.edited : '', song.data?.artists.length ? song.data.artists.join(', ') : ''].filter(Boolean).join(' · ')}
            onOpen={onOpen}
          />
        ))}
        {pages.hasNextPage && (
          <div className="p-3 text-center">
            <Button variant="ghost" size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {t.more}
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

type LabelFilter = 'unclear' | 'de' | 'en' | 'none' | 'all'

/**
 * An entry of the review list: opens its texts, and sets the language of Jellyfin's text in one click (the server then
 * fills in the other language from TMDb).
 */
function LabelledRow({ id, current, title, line, onClick }: { id: string; current: string; title: string; line: string; onClick: () => void }) {
  const t = useMessages(messages)
  const changed = useLocalizedChanged()
  const set = useMutation({
    mutationFn: async (label: 'de' | 'en') => {
      const response = await lumioSend('POST', `/admin/localized/${id}`, { label, tmdbKey: ownKey('tmdb') })
      if (!response?.ok) throw new Error('Failed')
      return (await response.json()) as AdminLocalized
    },
    onSuccess: (entry) => {
      toast.success(t.labelSaved)
      changed(id, entry)
    },
    onError: () => toast.error(t.labelFailed),
  })
  return (
    <div className="flex items-center gap-2 pr-3">
      <div className="min-w-0 flex-1">
        <EntryRow title={title} line={line} onClick={onClick} />
      </div>
      {(['de', 'en'] as const).map((label) => (
        <Button
          key={label}
          size="sm"
          variant={current === label ? 'default' : 'outline'}
          disabled={set.isPending}
          title={t.setLabel(t.labelFilter(label))}
          aria-label={t.setLabel(t.labelFilter(label))}
          onClick={() => set.mutate(label)}
        >
          {label.toUpperCase()}
        </Button>
      ))}
    </div>
  )
}

interface LocalizedRow {
  id: string
  label: 'de' | 'en' | 'unclear' | 'none'
  meta: { name: string; type: string; series?: string; year?: number; season?: number; episode?: number }
  at: number
}

/** The two-language entries by label (the unclear ones first), searchable; each opens its texts. */
function LanguageReviewSection({ running, onOpen }: { running: boolean; onOpen: (opened: Opened) => void }) {
  const t = useMessages(messages)
  const [label, setLabel] = useState<LabelFilter>('unclear')
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(term.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [term])
  const pages = useInfiniteQuery({
    queryKey: ['admin-localized', label, search],
    initialPageParam: 0,
    // Grows while the task runs.
    refetchInterval: running ? 10_000 : false,
    queryFn: async ({ pageParam }) => {
      const response = await lumioGet(`/admin/localized?${new URLSearchParams({ label: label === 'all' ? '' : label, search, offset: String(pageParam) })}`)
      if (!response?.ok) throw new Error('Unavailable')
      return (await response.json()) as { total: number; rows: LocalizedRow[]; counts: Partial<Record<LocalizedRow['label'], number>> }
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((sum, page) => sum + page.rows.length, 0)
      return loaded < last.total ? loaded : undefined
    },
  })
  const rows = pages.data?.pages.flatMap((page) => page.rows) ?? []
  const counts = pages.data?.pages[0]?.counts ?? {}
  const total = pages.data?.pages[0]?.total
  const all = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
  if (pages.isSuccess && !all) return null
  return (
    <Section title={t.review} description={t.reviewHint}>
      <div className="flex flex-wrap gap-2 border-b p-3">
        {(['unclear', 'de', 'en', 'none', 'all'] as const).map((value) => (
          <Button key={value} size="sm" variant={label === value ? 'default' : 'outline'} onClick={() => setLabel(value)}>
            {t.labelFilter(value)} ({value === 'all' ? all : (counts[value] ?? 0)})
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3 border-b p-3">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={term} onChange={(event) => setTerm(event.target.value)} placeholder={t.reviewSearch} aria-label={t.reviewSearch} className="pl-8" />
        </div>
        {total !== undefined && <span className="shrink-0 text-sm text-muted-foreground">{t.titleCount(total)}</span>}
      </div>
      <div className="max-h-[32rem] divide-y overflow-y-auto">
        {rows.map((row) => (
          <LabelledRow
            key={row.id}
            id={row.id}
            current={row.label}
            title={row.meta.name}
            line={[
              t.typeName(row.meta.type),
              row.meta.series,
              row.meta.season !== undefined && row.meta.episode !== undefined ? `S${row.meta.season} · E${row.meta.episode}` : undefined,
              row.meta.year,
              label === 'all' ? t.labelFilter(row.label) : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
            onClick={() => onOpen({ kind: 'title', id: row.id })}
          />
        ))}
        {pages.hasNextPage && (
          <div className="p-3 text-center">
            <Button variant="ghost" size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {t.more}
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

/** Administration: the tasks that fill in the library from outside (they run on the Lumio server), and their results. */
export function MetadataPage() {
  const t = useMessages(messages)
  const publicConfig = usePublicConfig().data
  const locale = getLocaleTag(useLocale())
  const isAdmin = useIsAdmin()
  const config = useLumioConfig().data ?? {}
  const save = useSaveConfig()
  const allViews = useUserViews().data ?? []
  const views = allViews.filter((view) => MUSIC_TYPES.has(view.CollectionType ?? 'mixed'))
  const videoViews = allViews.filter((view) => VIDEO_TYPES.has(view.CollectionType ?? 'mixed'))
  const videoExcluded = config.languageExcludedLibraries ?? []
  const videoLibraries = videoViews.filter((view) => !videoExcluded.includes(view.Id!)).map((view) => view.Id!)
  const languagesJob = useJob('languages', isAdmin)
  const excluded = config.metadataExcludedLibraries ?? []
  const libraries = views.filter((view) => !excluded.includes(view.Id!)).map((view) => view.Id!)
  const exclusions = { excludeArtists: config.metadataExcludedArtists ?? [], excludeGenres: config.metadataExcludedGenres ?? [] }
  const artistNames = [...(useArtistDirectory().data?.values() ?? [])].map((artist) => artist.name).sort((a, b) => a.localeCompare(b))
  const genreNames = (useMergedGenres(views).data ?? []).map((genre) => genre.Name ?? '').filter(Boolean)
  const [opened, setOpened] = useState<Opened | null>(null)
  const credits = useJob('credits', isAdmin)
  const missing = useQuery({
    queryKey: ['credits-missing'],
    enabled: isAdmin,
    // Grows while the songs are looked up.
    refetchInterval: () => (credits.data?.running ? 10_000 : false),
    queryFn: async () => {
      const response = await lumioGet('/admin/credits-missing')
      if (!response?.ok) throw new Error('Unavailable')
      return (await response.json()) as Stored[]
    },
  })

  if (!isAdmin) {
    return (
      <SettingsPage title={t.title}>
        <p className="text-sm text-muted-foreground">{t.adminOnly}</p>
      </SettingsPage>
    )
  }

  const toggleLibrary = (id: string, included: boolean) =>
    save.mutate((current) => {
      const list = new Set(current.metadataExcludedLibraries ?? [])
      if (included) list.delete(id)
      else list.add(id)
      return { ...current, metadataExcludedLibraries: [...list] }
    })

  return (
    <SettingsPage title={t.title} description={t.description}>
      <Section title={t.libraries} description={t.librariesHint}>
        {views.map((view) => (
          <SwitchField
            key={view.Id}
            id={`metadata-library-${view.Id}`}
            label={view.Name ?? ''}
            checked={!excluded.includes(view.Id!)}
            disabled={save.isPending}
            onChange={(included) => toggleLibrary(view.Id!, included)}
          />
        ))}
      </Section>

      <Section title={t.exclusions} description={t.exclusionsHint}>
        <ExclusionPicker
          id="metadata-artists"
          label={t.excludedArtists}
          placeholder={t.addArtist}
          values={exclusions.excludeArtists}
          options={artistNames}
          disabled={save.isPending}
          onChange={(values) => save.mutate((current) => ({ ...current, metadataExcludedArtists: values }))}
        />
        <ExclusionPicker
          id="metadata-genres"
          label={t.excludedGenres}
          placeholder={t.addGenre}
          values={exclusions.excludeGenres}
          options={genreNames}
          disabled={save.isPending}
          onChange={(values) => save.mutate((current) => ({ ...current, metadataExcludedGenres: values }))}
        />
      </Section>

      <JobSection name="credits" title={t.credits} hint={t.creditsHint} start={t.creditsStart} secondsEach={3} libraries={libraries} exclusions={exclusions} onOpen={setOpened} />
      {!!missing.data?.length && (
        <Section title={t.missingTitle(missing.data.length)} description={t.missingHint}>
          <div className="max-h-96 divide-y overflow-y-auto">
            {missing.data.map((song) => (
              <StoredRow key={song.id} song={song} note={t.lookedUp(new Date(song.at).toLocaleDateString(locale, { dateStyle: 'medium' }))} onOpen={setOpened} />
            ))}
          </div>
        </Section>
      )}
      <JobSection name="artists" title={t.artists} hint={t.artistsHint} start={t.artistsStart} secondsEach={5} libraries={libraries} exclusions={exclusions} onOpen={setOpened} />
      <JobSection name="sound" title={t.sound} hint={t.soundHint} start={t.soundStart} secondsEach={2} libraries={libraries} exclusions={exclusions} onOpen={setOpened} />
      {publicConfig?.lyricsSearch && (
        <JobSection name="lyrics" title={t.lyrics} hint={t.lyricsHint} start={t.lyricsStart} secondsEach={0.1} libraries={libraries} exclusions={exclusions} onOpen={setOpened} />
      )}

      <BrowseSection onOpen={setOpened} />

      <Section title={t.videoLibraries} description={t.videoLibrariesHint}>
        {videoViews.map((view) => (
          <SwitchField
            key={view.Id}
            id={`language-library-${view.Id}`}
            label={view.Name ?? ''}
            checked={!videoExcluded.includes(view.Id!)}
            disabled={save.isPending}
            onChange={(included) =>
              save.mutate((current) => {
                const list = new Set(current.languageExcludedLibraries ?? [])
                if (included) list.delete(view.Id!)
                else list.add(view.Id!)
                return { ...current, languageExcludedLibraries: [...list] }
              })
            }
          />
        ))}
      </Section>
      <JobSection
        name="languages"
        title={t.languages}
        hint={hasService('tmdb') ? t.languagesHint : `${t.languagesHint} ${t.noTmdb}`}
        start={t.languagesStart}
        secondsEach={1}
        libraries={videoLibraries}
        exclusions={exclusions}
        onOpen={setOpened}
      />
      <LanguageReviewSection running={!!languagesJob.data?.running} onOpen={setOpened} />

      <TrackMetadataDialog
        key={opened?.kind === 'track' ? opened.id : 'track'}
        id={opened?.kind === 'track' ? opened.id : null}
        meta={opened?.kind === 'track' ? opened.meta : {}}
        error={opened?.kind === 'track' ? opened.error : undefined}
        onClose={() => setOpened(null)}
      />
      <LanguageDialog id={opened?.kind === 'title' ? opened.id : null} onClose={() => setOpened(null)} />
      <ArtistMetadataDialog
        key={opened?.kind === 'artist' ? opened.id : 'artist'}
        id={opened?.kind === 'artist' ? opened.id : null}
        name={opened?.kind === 'artist' ? opened.name : ''}
        error={opened?.kind === 'artist' ? opened.error : undefined}
        onClose={() => setOpened(null)}
      />
    </SettingsPage>
  )
}
