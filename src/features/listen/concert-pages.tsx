import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconCalendarPlus,
  IconChevronRight,
  IconCurrentLocation,
  IconMapPin,
  IconMicrophone2,
  IconRoute,
  IconSearch,
  IconTicket,
} from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useLibraryArtistsNamed } from '@/features/items/queries'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { titlePath } from '@/lib/item-links'
import { cn } from '@/lib/utils'
import {
  concertsAvailable,
  distanceKm,
  NEAR_KM,
  useArtistsConcerts,
  useConcert,
  useConcertLocation,
  useSetConcertLocation,
  useConcerts,
  useConcertSearch,
  usePlaceSearch,
  type Concert,
  type ConcertLocation,
} from './concerts'
import { sameName } from './external'
import { useFollowedArtists } from './playlists'
import { VenueMap } from './venue-map'

const messages = defineMessages({
  de: {
    concert: 'Konzert',
    concerts: 'Konzerte',
    tickets: 'Tickets',
    addToCalendar: 'In den Kalender',
    lineup: 'Line-up',
    inLibrary: 'In deiner Bibliothek',
    headliner: 'Headliner',
    venue: 'Veranstaltungsort',
    directions: 'Route planen',
    details: 'Details',
    price: (from: string, to?: string) => (to ? `${from} – ${to}` : `ab ${from}`),
    presale: (date: string) => `Vorverkauf ab ${date}`,
    seatmap: 'Saalplan',
    moreBy: (name: string) => `Weitere Konzerte von ${name}`,
    status: (code: string): string => ({ cancelled: 'Abgesagt', postponed: 'Verschoben', rescheduled: 'Neuer Termin', offsale: 'Kein Verkauf' })[code] ?? '',
    notFound: 'Dieses Konzert wurde nicht gefunden.',
    unavailable: 'Für Konzerte braucht der Lumio-Server einen Ticketmaster-Schlüssel (TICKETMASTER_API_KEY).',
    searchPlaceholder: 'Nach Künstler, Ort oder Festival suchen',
    nearYou: 'In deiner Nähe',
    nearPlace: (place: string) => `In der Nähe von ${place}`,
    fromLibrary: 'Künstler aus deiner Bibliothek',
    followed: 'Von Künstlern, denen du folgst',
    results: (term: string) => `Konzerte für „${term}“`,
    noResults: 'Keine kommenden Konzerte gefunden.',
    setLocation: 'Standort festlegen',
    changeLocation: 'Ändern',
    locationHint: 'Lege fest, wo du bist, um Konzerte in deiner Nähe zu sehen. Der Ort gilt für dein Konto auf allen Geräten.',
    useMyLocation: 'Meinen Standort verwenden',
    myLocation: 'Mein Standort',
    locating: 'Standort wird ermittelt …',
    locationDenied: 'Der Standort ist nicht verfügbar. Such stattdessen nach deiner Stadt.',
    cityPlaceholder: 'Stadt suchen',
    removeLocation: 'Standort entfernen',
    km: (n: number) => `${n} km`,
    showMore: 'Mehr anzeigen',
    showLess: 'Weniger anzeigen',
    onTour: 'Auf Tour',
  },
  en: {
    concert: 'Concert',
    concerts: 'Concerts',
    tickets: 'Tickets',
    addToCalendar: 'Add to calendar',
    lineup: 'Lineup',
    inLibrary: 'In your library',
    headliner: 'Headliner',
    venue: 'Venue',
    directions: 'Directions',
    details: 'Details',
    price: (from: string, to?: string) => (to ? `${from} – ${to}` : `from ${from}`),
    presale: (date: string) => `On sale from ${date}`,
    seatmap: 'Seating plan',
    moreBy: (name: string) => `More concerts by ${name}`,
    status: (code: string): string => ({ cancelled: 'Cancelled', postponed: 'Postponed', rescheduled: 'Rescheduled', offsale: 'Off sale' })[code] ?? '',
    notFound: "This concert couldn't be found.",
    unavailable: 'Concerts need a Ticketmaster key on the Lumio server (TICKETMASTER_API_KEY).',
    searchPlaceholder: 'Search artists, venues or festivals',
    nearYou: 'Near you',
    nearPlace: (place: string) => `Near ${place}`,
    fromLibrary: 'Artists from your library',
    followed: 'From artists you follow',
    results: (term: string) => `Concerts for “${term}”`,
    noResults: 'No upcoming concerts found.',
    setLocation: 'Set location',
    changeLocation: 'Change',
    locationHint: 'Set where you are to see concerts near you. The place applies to your account on every device.',
    useMyLocation: 'Use my location',
    myLocation: 'My location',
    locating: 'Finding your location …',
    locationDenied: "Your location isn't available. Search for your city instead.",
    cityPlaceholder: 'Search for a city',
    removeLocation: 'Remove location',
    km: (n: number) => `${n} km`,
    showMore: 'Show more',
    showLess: 'Show less',
    onTour: 'On tour',
  },
})

const dateOf = (concert: Concert) => new Date(`${concert.date}T${concert.time ?? '20:00:00'}`)

/** Finds the line-ups' artists in the library (so a line-up links to artists the user has), each looked up by name. */
function useLibraryArtistFinder(names: string[]) {
  const unique = [...new Set(names.filter(Boolean))].slice(0, 100)
  const artists = useLibraryArtistsNamed(unique)
  return (name: string): BaseItemDto | undefined => artists.data.find((artist) => sameName(artist.Name, name))
}

/**
 * One concert in a list: the date as a calendar leaf, where it is (or who plays, in lists spanning artists), the
 * weekday, time and venue, and how far away it is when the user set a location. Opens the concert's page.
 */
export function ConcertRow({ concert, showArtist, highlight }: { concert: Concert; showArtist?: boolean; highlight?: string }) {
  const t = useMessages(messages)
  const locale = getLocaleTag(useLocale())
  const location = useConcertLocation()
  const date = dateOf(concert)
  const distance = location ? distanceKm(location, concert.venue) : undefined
  const place = [concert.venue.city, concert.venue.countryCode].filter(Boolean).join(', ')
  const who = concert.artists.map((artist) => artist.name).join(', ') || concert.name
  const status = concert.status ? t.status(concert.status) : undefined
  return (
    <li>
      <Link to={`/listen/concert/${concert.id}`} className="group flex items-center gap-4 rounded-md p-2 outline-none transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid w-14 shrink-0 place-items-center rounded-md bg-foreground/10 py-1.5 text-center leading-tight">
          <span className="text-xs uppercase text-muted-foreground">{date.toLocaleDateString(locale, { month: 'short' })}</span>
          <span className="text-xl font-bold">{date.getDate()}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate font-semibold', status && 'text-muted-foreground line-through')}>{showArtist ? who : place}</span>
            {status && <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">{status}</span>}
            {highlight && <span className="shrink-0 rounded bg-listen/15 px-1.5 py-0.5 text-[11px] font-semibold text-listen">{highlight}</span>}
          </span>
          <span className="block truncate text-sm text-muted-foreground">
            {date.toLocaleDateString(locale, { weekday: 'short' })}
            {concert.time && ` ${concert.time.slice(0, 5)}`} · {concert.venue.name}
            {showArtist && place && `, ${place}`}
            {distance !== undefined && ` · ${t.km(Math.round(distance))}`}
          </span>
        </span>
        <IconChevronRight className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
    </li>
  )
}

/** A titled list of concerts, the first few shown and the rest behind "show more". */
export function ConcertList({
  title,
  concerts,
  loading,
  showArtist,
  limit = 6,
  highlight,
  action,
}: {
  title: string
  concerts: Concert[]
  loading?: boolean
  showArtist?: boolean
  limit?: number
  highlight?: (concert: Concert) => string | undefined
  action?: ReactNode
}) {
  const t = useMessages(messages)
  const [all, setAll] = useState(false)
  if (!loading && !concerts.length) return null
  return (
    <section className="px-4 sm:px-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-2xl font-extrabold tracking-tight">{title}</h2>
        {action}
      </div>
      <ul className="max-w-4xl">
        {loading && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="mb-1 h-16 rounded-md" />)}
        {concerts.slice(0, all ? undefined : limit).map((concert) => (
          <ConcertRow key={concert.id} concert={concert} showArtist={showArtist} highlight={highlight?.(concert)} />
        ))}
      </ul>
      {concerts.length > limit && (
        <button type="button" onClick={() => setAll(!all)} className="mt-3 px-2 text-sm font-bold text-muted-foreground hover:text-foreground">
          {all ? t.showLess : t.showMore}
        </button>
      )}
    </section>
  )
}

/** Writes an .ics file the system calendar opens. */
function downloadCalendarEntry(concert: Concert) {
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const start = concert.start ? new Date(concert.start) : dateOf(concert)
  const end = new Date(start.getTime() + 3 * 60 * 60_000)
  const escape = (value: string) => value.replace(/[\\,;]/g, (char) => `\\${char}`).replace(/\n/g, '\\n')
  const location = [concert.venue.name, concert.venue.address, [concert.venue.postalCode, concert.venue.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lumio//Listen//EN',
    'BEGIN:VEVENT',
    `UID:${concert.id}@lumio`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(concert.name)}`,
    location && `LOCATION:${escape(location)}`,
    concert.url && `URL:${concert.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
  link.download = `${concert.name.replace(/[^\p{L}\p{N} -]+/gu, '').trim() || 'concert'}.ics`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

/**
 * A concert's page, as Spotify shows one: the event picture, who plays when and where, tickets and a calendar entry;
 * the whole line-up (linked to the library where the user has the artist), the venue with a map and directions, the
 * details (prices, presale, notes, seating plan), and more dates of the headliner.
 */
export function ConcertPage() {
  const { id } = useParams()
  const t = useMessages(messages)
  const locale = getLocaleTag(useLocale())
  const concert = useConcert(id)
  const findArtist = useLibraryArtistFinder((concert.data?.artists ?? []).map((artist) => artist.name))
  const headliner = concert.data?.artists[0]
  const more = useConcerts(headliner?.name)

  if (!concertsAvailable()) return <p className="p-8 pt-24 text-muted-foreground">{t.unavailable}</p>
  if (concert.isLoading)
    return (
      <div className="space-y-6 px-4 pt-24 sm:px-8">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-64 max-w-4xl" />
      </div>
    )
  if (!concert.data) return <p className="p-8 pt-24 text-muted-foreground">{t.notFound}</p>

  const event = concert.data
  const date = dateOf(event)
  const status = event.status ? t.status(event.status) : undefined
  const { venue } = event
  const money = (value: number | undefined) =>
    value === undefined ? undefined : new Intl.NumberFormat(locale, { style: 'currency', currency: event.price?.currency ?? 'EUR' }).format(value)
  const from = money(event.price?.min)
  const to = event.price?.max !== event.price?.min ? money(event.price?.max) : undefined
  const presale = event.presale ? new Date(event.presale).toLocaleDateString(locale, { dateStyle: 'long' }) : undefined
  const notes = [event.info, event.pleaseNote].filter((note): note is string => !!note && !/refer to the german language version/i.test(note))

  return (
    <div className="pb-12">
      <div className="relative flex min-h-[22rem] items-end overflow-hidden pt-14">
        {event.image && (
          <>
            <FadeImage src={event.image} alt="" className="absolute inset-0 size-full object-cover" />
            <div className="absolute inset-0 bg-linear-to-t from-background via-background/60 to-black/20" />
          </>
        )}
        <div className="relative space-y-3 px-4 pb-6 sm:px-8">
          <p className="flex items-center gap-2 text-sm font-medium">
            {t.concert}
            {status && <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-xs font-semibold text-destructive">{status}</span>}
          </p>
          <h1 className="max-w-4xl text-4xl font-black leading-none tracking-tight text-balance drop-shadow-lg sm:text-6xl">{event.name}</h1>
          <p className="text-base font-medium text-foreground/90">
            {date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            {event.time && ` · ${event.time.slice(0, 5)}`}
          </p>
          <p className="flex items-center gap-1.5 text-sm text-foreground/80">
            <IconMapPin className="size-4" /> {[venue.name, venue.city].filter(Boolean).join(', ')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-4 py-5 sm:px-8">
        {event.url && (
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex h-12 items-center gap-2 rounded-full bg-listen px-6 font-bold text-listen-foreground transition-colors hover:bg-listen-hover"
          >
            <IconTicket className="size-5" /> {t.tickets}
          </a>
        )}
        <button
          type="button"
          onClick={() => downloadCalendarEntry(event)}
          className="flex h-12 items-center gap-2 rounded-full border border-foreground/40 px-5 text-sm font-bold transition-colors hover:border-foreground"
        >
          <IconCalendarPlus className="size-5" /> {t.addToCalendar}
        </button>
      </div>

      <div className="space-y-12">
        {event.artists.length > 0 && (
          <section className="px-4 sm:px-8">
            <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.lineup}</h2>
            <ul className="grid max-w-4xl gap-1 sm:grid-cols-2">
              {event.artists.map((artist, index) => {
                const own = findArtist(artist.name)
                const content = (
                  <>
                    <span className="size-16 shrink-0 overflow-hidden rounded-full bg-muted">
                      {artist.image ? (
                        <FadeImage src={artist.image} alt="" className="size-full object-cover" />
                      ) : (
                        <span className="grid size-full place-items-center text-muted-foreground">
                          <IconMicrophone2 className="size-6" stroke={1.5} />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{artist.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {[index === 0 && event.artists.length > 1 ? t.headliner : undefined, artist.genre !== 'Undefined' ? artist.genre : undefined, own ? t.inLibrary : undefined]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </>
                )
                return (
                  <li key={artist.id}>
                    {own ? (
                      <Link to={titlePath('MusicArtist', own.Id!)} className="flex items-center gap-4 rounded-md p-2 transition-colors hover:bg-foreground/[0.07]">
                        {content}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-4 p-2">{content}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <section className="px-4 sm:px-8">
          <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.venue}</h2>
          <div className="grid max-w-4xl overflow-hidden rounded-xl bg-muted sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-1 p-6">
              <p className="text-lg font-bold">{venue.name}</p>
              {venue.address && <p className="text-sm text-muted-foreground">{venue.address}</p>}
              <p className="text-sm text-muted-foreground">{[[venue.postalCode, venue.city].filter(Boolean).join(' '), venue.country].filter(Boolean).join(', ')}</p>
              {venue.lat !== undefined && venue.lon !== undefined && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lon}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-foreground/40 px-4 py-1.5 text-sm font-bold transition-colors hover:border-foreground"
                >
                  <IconRoute className="size-4" /> {t.directions}
                </a>
              )}
            </div>
            {venue.lat !== undefined && venue.lon !== undefined && (
              <VenueMap lat={venue.lat} lon={venue.lon} name={venue.name ?? t.venue} className="h-64 sm:h-auto sm:min-h-64" />
            )}
          </div>
        </section>

        {(from || presale || notes.length > 0 || event.seatmap) && (
          <section className="px-4 sm:px-8">
            <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.details}</h2>
            <div className="max-w-4xl space-y-3 text-sm">
              {from && <p className="font-semibold">{t.price(from, to)}</p>}
              {presale && <p>{t.presale(presale)}</p>}
              {notes.map((note) => (
                <p key={note} className="whitespace-pre-line leading-relaxed text-muted-foreground">
                  {note}
                </p>
              ))}
              {event.seatmap && (
                <a href={event.seatmap} target="_blank" rel="noreferrer noopener" className="inline-block font-semibold hover:underline">
                  {t.seatmap}
                </a>
              )}
            </div>
          </section>
        )}

        {headliner && (
          <ConcertList title={t.moreBy(headliner.name)} concerts={(more.data ?? []).filter((other) => other.id !== event.id)} loading={more.isLoading} />
        )}
      </div>
    </div>
  )
}

/**
 * Concerts in Listen (Spotify's "Live events"): a search across all upcoming music events, and, once the user set
 * where they are, what's on nearby (artists from their library first); plus the dates of the artists they follow.
 */
export function ConcertsPage() {
  const t = useMessages(messages)
  const location = useConcertLocation()
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [picking, setPicking] = useState(false)
  const search = useConcertSearch({ keyword: debounced })
  const near = useConcertSearch({ near: location })
  const followed = useFollowedArtists()
  const followedConcerts = useArtistsConcerts((followed.data ?? []).slice(0, 15).map((artist) => artist.Name ?? '').filter(Boolean))
  const findArtist = useLibraryArtistFinder((near.data ?? []).flatMap((concert) => concert.artists.map((artist) => artist.name)))

  // Searches once typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term), 350)
    return () => window.clearTimeout(timer)
  }, [term])

  if (!concertsAvailable()) return <p className="p-8 pt-24 text-muted-foreground">{t.unavailable}</p>

  const nearConcerts = near.data ?? []
  const fromLibrary = nearConcerts.filter((concert) => concert.artists.some((artist) => findArtist(artist.name)))
  const searching = debounced.trim().length > 1

  return (
    <div className="space-y-10 pb-12 pt-20">
      <div className="space-y-5 px-4 sm:px-8">
        <h1 className="text-4xl font-black tracking-tight">{t.concerts}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-md">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={term} onChange={(event) => setTerm(event.target.value)} placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder} className="h-10 rounded-full pl-9" />
          </div>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex h-10 items-center gap-2 rounded-full bg-foreground/10 px-4 text-sm font-semibold transition-colors hover:bg-foreground/20"
          >
            <IconMapPin className="size-4" />
            {location ? location.label : t.setLocation}
          </button>
        </div>
      </div>

      {searching ? (
        <>
          <ConcertList title={t.results(debounced.trim())} concerts={search.data ?? []} loading={search.isLoading} showArtist limit={20} />
          {!search.isLoading && !search.data?.length && <p className="px-4 text-sm text-muted-foreground sm:px-8">{t.noResults}</p>}
        </>
      ) : (
        <>
          {!location && (
            <div className="mx-4 max-w-4xl rounded-xl bg-muted p-6 sm:mx-8">
              <p className="mb-4 text-sm text-muted-foreground">{t.locationHint}</p>
              <button type="button" onClick={() => setPicking(true)} className="rounded-full bg-listen px-5 py-2 text-sm font-bold text-listen-foreground hover:bg-listen-hover">
                {t.setLocation}
              </button>
            </div>
          )}
          {location && fromLibrary.length > 0 && <ConcertList title={t.fromLibrary} concerts={fromLibrary} showArtist />}
          {location && (
            <ConcertList
              title={t.nearPlace(location.label.split(',')[0]!)}
              concerts={nearConcerts}
              loading={near.isLoading}
              showArtist
              limit={10}
              highlight={(concert) => (concert.artists.some((artist) => findArtist(artist.name)) ? t.inLibrary : undefined)}
            />
          )}
          {location && !near.isLoading && !nearConcerts.length && <p className="px-4 text-sm text-muted-foreground sm:px-8">{t.noResults}</p>}
          <ConcertList title={t.followed} concerts={followedConcerts.concerts} loading={followedConcerts.isLoading && !followedConcerts.concerts.length} showArtist limit={8} />
        </>
      )}

      <LocationDialog open={picking} onOpenChange={setPicking} />
    </div>
  )
}

/** Choosing where "near you" is: the browser's location, or a city looked up by name. */
export function LocationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(messages)
  const current = useConcertLocation()
  const setConcertLocation = useSetConcertLocation()
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'idle' | 'locating' | 'denied'>('idle')
  const places = usePlaceSearch(query)

  const choose = (place: ConcertLocation | null) => {
    setConcertLocation(place)
    setQuery('')
    onOpenChange(false)
  }
  const locate = () => {
    if (!('geolocation' in navigator)) return setState('denied')
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setState('idle')
        choose({ label: t.myLocation, lat: position.coords.latitude, lon: position.coords.longitude })
      },
      () => setState('denied'),
      { maximumAge: 60 * 60_000, timeout: 15_000 },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.setLocation}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t.locationHint}</p>
        <button
          type="button"
          onClick={locate}
          disabled={state === 'locating'}
          className="flex items-center gap-2 rounded-lg bg-foreground/10 px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-foreground/20 disabled:opacity-60"
        >
          <IconCurrentLocation className="size-4" /> {state === 'locating' ? t.locating : t.useMyLocation}
        </button>
        {state === 'denied' && <p className="text-sm text-destructive">{t.locationDenied}</p>}
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.cityPlaceholder} aria-label={t.cityPlaceholder} className="h-10 pl-9" />
        </div>
        {(places.data?.length ?? 0) > 0 && (
          <ul className="-mx-1 space-y-0.5">
            {places.data!.map((place) => (
              <li key={`${place.lat},${place.lon}`}>
                <button type="button" onClick={() => choose(place)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
                  <IconMapPin className="size-4 shrink-0 text-muted-foreground" /> <span className="truncate">{place.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {current && (
          <button type="button" onClick={() => choose(null)} className="justify-self-start text-sm text-muted-foreground hover:text-foreground hover:underline">
            {t.removeLocation}
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The artist page's "On tour": their dates, with how far each is when the user set a location; links to each date. */
export function ArtistConcerts({ name }: { name: string | undefined }) {
  const t = useMessages(messages)
  const concerts = useConcerts(name)
  const location = useConcertLocation()
  const list = concerts.data ?? []
  // Dates near the user come first, as on Spotify.
  const near = location ? list.filter((concert) => (distanceKm(location, concert.venue) ?? Infinity) <= NEAR_KM) : []
  const rest = list.filter((concert) => !near.includes(concert))
  return (
    <ConcertList
      title={t.onTour}
      concerts={[...near, ...rest]}
      highlight={(concert) => (near.includes(concert) ? t.nearYou : undefined)}
      action={
        <Link to="/listen/concerts" className="text-sm font-bold text-muted-foreground hover:text-foreground hover:underline">
          {t.concerts}
        </Link>
      }
    />
  )
}
