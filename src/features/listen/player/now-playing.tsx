import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { SingerLabel, singerChange } from './lyrics-singer'
import { IconArrowsDiagonal } from '@tabler/icons-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAuthedSession } from '@/features/auth/session'
import { useItem, useSetFavorite } from '@/features/items/queries'
import { useDominantColor } from '@/lib/dominant-color'
import { externalOf } from '@/lib/external-items'
import { formatClock, ticksToSeconds } from '@/lib/format'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { backdropImageUrl, portraitImageUrl } from '@/lib/images'
import { artistsOf, itemHref, titlePath } from '@/lib/item-links'
import { cn } from '@/lib/utils'
import { ArtistAboutDialog } from '../artist-about'
import { useConcerts } from '../concerts'
import { useLastfmArtist } from '../external'
import { useLyrics } from './lyrics'
import { music, useMusic } from './music-player'
import { toggleListenPanel } from './panel'
import { ArtistLine } from './player-bar'
import { useTrackQuality } from './quality'
import { usePlayerControls, usePlayerTime } from './player-controls'
import { useArtistBio, useArtistPhoto } from '../artist-photo'
import { artistHref, useArtistLookup, useTrackArtists, useTrackCredits } from '../credits'
import { TrackContextMenu } from '../track-menu'
import { TrackArtists } from '../track-artists'

const messages = defineMessages({
  de: {
    lyricsPreview: 'Vorschau der Lyrics',
    lyricsFullscreen: 'Songtext im Vollbild',
    aboutArtist: 'Über den Künstler',
    listeners: (n: string) => `${n} Hörer`,
    onTour: 'Auf Tour',
    showAll: 'Alle anzeigen',
    songInfo: 'Songinfos',
    follow: 'Folgen',
    following: 'Gefolgt',
    mainArtist: 'Hauptkünstler*in',
    artist: 'Künstler*in',
    albumArtist: 'Albumkünstler*in',
    composer: 'Komponist*in',
    lyricist: 'Texter*in',
    producer: 'Produzent*in',
    writer: 'Songwriter*in',
    mixer: 'Mix',
    engineer: 'Tontechnik',
    publisher: 'Verlag',
    label: 'Label',
    isrc: 'ISRC',
    nextInQueue: 'Nächster Titel in der Warteschlange',
    openQueue: 'Warteschlange öffnen',
    queueEmpty: 'Deine Warteschlange ist leer.',
    findSomething: 'Nach etwas Neuem suchen',
    title: 'Titel',
    album: 'Album',
    released: 'Erschienen',
    track: 'Titelnummer',
    trackOf: (n: number, disc?: number) => (disc ? `${n} (CD ${disc})` : String(n)),
    duration: 'Länge',
    genres: 'Genres',
    plays: 'Von dir gehört',
    playCount: (n: number) => (n === 1 ? '1 Mal' : `${n} Mal`),
    quality: 'Qualität',
    credits: 'Mitwirkende',
  },
  en: {
    lyricsPreview: 'Lyrics preview',
    lyricsFullscreen: 'Lyrics in fullscreen',
    aboutArtist: 'About the artist',
    listeners: (n: string) => `${n} listeners`,
    onTour: 'On tour',
    showAll: 'Show all',
    songInfo: 'Credits',
    follow: 'Follow',
    following: 'Following',
    mainArtist: 'Main artist',
    artist: 'Artist',
    albumArtist: 'Album artist',
    composer: 'Composer',
    lyricist: 'Lyricist',
    producer: 'Producer',
    writer: 'Songwriter',
    mixer: 'Mixing',
    engineer: 'Engineering',
    publisher: 'Publisher',
    label: 'Label',
    isrc: 'ISRC',
    nextInQueue: 'Next in queue',
    openQueue: 'Open queue',
    queueEmpty: 'Your queue is empty.',
    findSomething: 'Search for something new',
    title: 'Title',
    album: 'Album',
    released: 'Released',
    track: 'Track',
    trackOf: (n: number, disc?: number) => (disc ? `${n} (disc ${disc})` : String(n)),
    duration: 'Length',
    genres: 'Genres',
    plays: 'Played by you',
    playCount: (n: number) => (n === 1 ? 'once' : `${n} times`),
    quality: 'Quality',
    credits: 'Credits',
  },
})

// ---- the song info popup, opened from here and from any track's menu ----

let songInfoFor: BaseItemDto | null = null
const songInfoListeners = new Set<() => void>()

/** Opens the song info popup for a track (the track menu's "Song info"). */
export function openSongInfo(track: BaseItemDto | null) {
  songInfoFor = track
  for (const listener of songInfoListeners) listener()
}

/** Shows the song info popup when asked for; mounted once in Listen's frame. */
export function SongInfoHost() {
  const track = useSyncExternalStore(
    (listener) => {
      songInfoListeners.add(listener)
      return () => songInfoListeners.delete(listener)
    },
    () => songInfoFor,
  )
  return <SongInfoDialog track={track} onClose={() => openSongInfo(null)} />
}

interface Credit {
  id?: string
  name: string
  role: string
}

/**
 * Who made a track: its artists first (the first as main artist, with featured artists from MusicBrainz), then
 * writers, composers, lyricists, producers and mixing (Jellyfin's people, else MusicBrainz's), the album artist; and
 * the labels and publishers behind it.
 */
function useCredits(track: BaseItemDto | undefined) {
  const t = useMessages(messages)
  const item = useItem(track?.Id ?? '', !!track?.Id && !externalOf(track)).data ?? track
  const recording = useTrackCredits(item, true)
  const artists = useTrackArtists(item, true)
  const find = useArtistLookup([
    ...(item?.People ?? []).map((person) => person.Name ?? ''),
    ...(['writers', 'composers', 'lyricists', 'producers', 'mixers', 'engineers'] as const).flatMap((role) => recording?.[role] ?? []),
  ])
  if (!item) return { item, credits: [] as Credit[], recording }
  const credits: Credit[] = artists.map((artist, index) => ({ id: artist.id, name: artist.name, role: index === 0 ? t.mainArtist : t.artist }))
  const push = (name: string | null | undefined, role: string) => {
    // Linked to the library's artist of that name (a producer who is also an artist here).
    if (name && !credits.some((credit) => credit.name === name && credit.role === role)) credits.push({ ...find(name), role })
  }
  const roles: Record<string, string> = { Composer: t.composer, Lyricist: t.lyricist, Producer: t.producer, Writer: t.writer }
  for (const person of item.People ?? []) if (roles[person.Type ?? '']) push(person.Name, roles[person.Type ?? '']!)
  for (const name of recording?.writers ?? []) push(name, t.writer)
  for (const name of recording?.composers ?? []) push(name, t.composer)
  for (const name of recording?.lyricists ?? []) push(name, t.lyricist)
  for (const name of recording?.producers ?? []) push(name, t.producer)
  for (const name of recording?.mixers ?? []) push(name, t.mixer)
  for (const name of recording?.engineers ?? []) push(name, t.engineer)
  for (const album of item.AlbumArtists ?? [])
    if (album.Name && !credits.some((credit) => credit.name === album.Name)) credits.push({ id: album.Id ?? undefined, name: album.Name, role: t.albumArtist })
  return { item, credits, recording }
}

function SongInfoDialog({ track, onClose }: { track: BaseItemDto | null; onClose: () => void }) {
  const t = useMessages(messages)
  const { api } = useAuthedSession()
  const locale = getLocaleTag(useLocale())
  const { item, credits, recording } = useCredits(track ?? undefined)
  const quality = useTrackQuality(track ?? undefined)
  const shown = item ?? track
  const cover = shown ? portraitImageUrl(api, shown, { fillHeight: 240 }) : undefined
  const rows: Array<[string, string | undefined]> = shown
    ? [
        [t.album, shown.Album ?? undefined],
        [t.released, shown.PremiereDate ? new Date(shown.PremiereDate).toLocaleDateString(locale, { dateStyle: 'long' }) : shown.ProductionYear ? String(shown.ProductionYear) : undefined],
        [t.track, shown.IndexNumber ? t.trackOf(shown.IndexNumber, shown.ParentIndexNumber && shown.ParentIndexNumber > 1 ? shown.ParentIndexNumber : undefined) : undefined],
        [t.duration, shown.RunTimeTicks ? formatClock(ticksToSeconds(shown.RunTimeTicks)) : undefined],
        [t.genres, shown.Genres?.join(', ') || undefined],
        [t.quality, quality?.label],
        [t.plays, shown.UserData?.PlayCount ? t.playCount(shown.UserData.PlayCount) : undefined],
        [t.label, recording?.labels.join(', ') || undefined],
        [t.publisher, recording?.publishers.join(', ') || undefined],
        [t.isrc, recording?.isrc],
      ]
    : []
  return (
    <Dialog open={!!track} onOpenChange={(open) => !open && onClose()}>
      {/* Long credits scroll inside the popup, under the song's head, which stays. */}
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-5 overflow-hidden p-6 sm:max-w-lg">
        {shown && (
          <>
            <div className="flex items-center gap-4">
              <div className="size-20 shrink-0 overflow-hidden rounded-md bg-muted">{cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}</div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">{t.songInfo}</p>
                <DialogTitle className="truncate text-xl font-bold">{shown.Name}</DialogTitle>
                <ArtistLine item={shown} className="text-sm" />
              </div>
            </div>
            <div className="-mx-6 -mb-6 min-h-0 space-y-5 overflow-y-auto px-6 pb-6">
              {credits.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t.credits}</h3>
                  <ul className="space-y-2">
                    {credits.map((credit) => (
                      <li key={`${credit.role}-${credit.name}`} className="text-sm">
                        <Link to={artistHref(credit)} onClick={onClose} className="font-medium hover:underline">
                          {credit.name}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{credit.role}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-t pt-4 text-sm">
                {rows
                  .filter(([, value]) => !!value)
                  .map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate">{value}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---- "now playing" in the side panel ----

/**
 * What plays, as Spotify's side panel shows it: the cover, title and artists, a running preview of the lyrics, the
 * artist with their upcoming concerts, the song's credits, and what comes next in the queue.
 */
export function NowPlaying({ track }: { track: BaseItemDto }) {
  const { api } = useAuthedSession()
  const cover = portraitImageUrl(api, track, { fillHeight: 640 })
  return (
    <div className="space-y-4">
      {/* Right-click: the song's menu. */}
      <TrackContextMenu track={track}>
        <Link to={itemHref(track)} data-vt="listen-cover" className="block aspect-square overflow-hidden rounded-lg bg-muted shadow-lg">
          {cover && <FadeImage key={cover} src={cover} alt="" className="size-full object-cover" />}
        </Link>
      </TrackContextMenu>
      <div className="min-w-0">
        <Link to={itemHref(track)} className="block truncate text-xl font-bold hover:underline">
          {track.Name}
        </Link>
        <ArtistLine item={track} className="text-sm" />
      </div>
      <NowPlayingDetails track={track} />
    </div>
  )
}

/**
 * Below the cover: lyrics, the artist and their concerts, the credits, what comes next (also the phone's player, whose
 * lyrics open in fullscreen: `onExpandLyrics`).
 */
export function NowPlayingDetails({ track, onExpandLyrics }: { track: BaseItemDto; onExpandLyrics?: () => void }) {
  const artistId = artistsOf(track)[0]?.id
  const artist = useItem(artistId ?? '', !!artistId)
  const external = !!externalOf(track)
  return (
    <>
      {!external && <LyricsPreview track={track} onExpand={onExpandLyrics} />}
      {artistId && artist.data && <AboutArtist artist={artist.data} />}
      {artist.data?.Name && <ArtistTour name={artist.data.Name} artistId={artist.data.Id!} />}
      {!external && <SongInfoCard track={track} />}
      <NextInQueue />
    </>
  )
}

function Card({ title, action, className, style, children }: { title: string; action?: React.ReactNode; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <section className={cn('space-y-3 rounded-lg bg-muted/50 p-4', className)} style={style}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

const cardAction = 'shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline'

/**
 * A small window onto the lyrics on the cover's colour, moving like the full lyrics: the lines slide up as the song
 * goes on, the sung one lit, the coming ones dimmed. A click opens the full lyrics (in the side panel, or `onExpand`,
 * which then also shows an expand icon, as in Spotify).
 */
function LyricsPreview({ track, onExpand }: { track: BaseItemDto; onExpand?: () => void }) {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const lyrics = useLyrics(track)
  const { position } = usePlayerTime()
  const tint = useDominantColor(portraitImageUrl(api, track, { fillHeight: 64 })).data
  const list = useRef<HTMLSpanElement>(null)
  const lines = (lyrics.data?.lines ?? []).filter((line) => line.text)
  const synced = !!lyrics.data?.synced
  let current = 0
  if (synced) for (let i = 0; i < lines.length; i++) if ((lines[i]!.time ?? Infinity) <= position + 0.2) current = i

  // The current line moves to the top of the window (a transform, so it slides).
  useEffect(() => {
    const line = list.current?.querySelector<HTMLElement>(`[data-line="${current}"]`)
    if (list.current && line) list.current.style.transform = `translateY(${-line.offsetTop}px)`
  }, [current, lines.length])

  if (!lines.length) return null
  return (
    <button
      type="button"
      onClick={() => (onExpand ? onExpand() : toggleListenPanel('lyrics'))}
      aria-label={onExpand ? t.lyricsFullscreen : undefined}
      className="block w-full space-y-3 rounded-lg p-4 text-left text-white transition-[filter,background-color] duration-500 hover:brightness-110"
      style={{ background: tint ?? 'var(--muted)' }}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold">{t.lyricsPreview}</span>
        {onExpand && (
          <span aria-hidden className="-my-1.5 grid size-8 shrink-0 place-items-center rounded-full bg-black/25">
            <IconArrowsDiagonal className="size-4" />
          </span>
        )}
      </span>
      <span className="relative block h-[6.75rem] overflow-hidden">
        <span ref={list} className="block space-y-1 transition-transform duration-500 ease-out">
          {lines.map((line, index) => (
            <span
              key={index}
              data-line={index}
              className={cn(
                'block text-xl font-bold leading-snug transition-colors duration-300',
                !synced || index === current ? 'text-white' : index < current ? 'text-white/55' : 'text-white/35',
              )}
            >
              {singerChange(lines, index) && <SingerLabel name={line.singer!} />}
              {line.text}
            </span>
          ))}
        </span>
      </span>
    </button>
  )
}

/** The artist card; as on Spotify, clicking it opens the "About" popup. The name goes straight to the artist's page. */
function AboutArtist({ artist }: { artist: BaseItemDto }) {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const [open, setOpen] = useState(false)
  const lastfm = useLastfmArtist(artist.Name ?? undefined)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const photo = useArtistPhoto(artist, 400)
  const image = backdropImageUrl(api, artist, { fillWidth: 640 }) ?? photo
  const bio = useArtistBio(artist)
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t.aboutArtist}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          setOpen(true)
        }}
        className="block w-full cursor-pointer overflow-hidden rounded-lg bg-muted/50 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative aspect-video bg-muted">
          {image && <FadeImage src={image} alt="" className="size-full object-cover object-top" />}
          <p className="absolute left-3 top-3 text-sm font-semibold text-white drop-shadow">{t.aboutArtist}</p>
        </div>
        <div className="space-y-1 p-4">
          <Link to={titlePath('MusicArtist', artist.Id!)} onClick={(event) => event.stopPropagation()} className="font-semibold hover:underline">
            {artist.Name}
          </Link>
          {!!lastfm.data?.listeners && <p className="text-sm text-muted-foreground">{t.listeners(number.format(lastfm.data.listeners))}</p>}
          {bio && <p className="line-clamp-3 text-sm text-muted-foreground">{bio}</p>}
        </div>
      </div>
      <ArtistAboutDialog artist={artist} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** The artist's next concerts (up to three), each opening its page; "Show all" leads to the artist's page. */
function ArtistTour({ name, artistId }: { name: string; artistId: string }) {
  const t = useMessages(messages)
  const locale = getLocaleTag(useLocale())
  const concerts = useConcerts(name)
  const list = (concerts.data ?? []).slice(0, 3)
  if (!list.length) return null
  return (
    <Card
      title={t.onTour}
      action={
        <Link to={titlePath('MusicArtist', artistId)} className={cardAction}>
          {t.showAll}
        </Link>
      }
    >
      <ul className="-mx-2 space-y-1">
        {list.map((concert) => {
          const date = new Date(`${concert.date}T${concert.time ?? '20:00:00'}`)
          return (
            <li key={concert.id}>
              <Link to={`/listen/concert/${concert.id}`} className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-foreground/[0.07]">
                <span className="grid w-11 shrink-0 place-items-center rounded-md bg-background py-1 text-center leading-tight">
                  <span className="text-[10px] uppercase text-muted-foreground">{date.toLocaleDateString(locale, { month: 'short' })}</span>
                  <span className="text-lg font-bold">{date.getDate()}</span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{concert.venue.city ?? concert.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {date.toLocaleDateString(locale, { weekday: 'short' })}
                    {concert.time && `, ${concert.time.slice(0, 5)}`} · {concert.venue.name}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** The first credits, the main artist with a follow button; "Show all" opens the song info popup. */
function SongInfoCard({ track }: { track: BaseItemDto }) {
  const t = useMessages(messages)
  const { credits } = useCredits(track)
  if (!credits.length) return null
  return (
    <Card
      title={t.songInfo}
      action={
        <button type="button" onClick={() => openSongInfo(track)} className={cardAction}>
          {t.showAll}
        </button>
      }
    >
      <ul className="space-y-3">
        {credits.slice(0, 3).map((credit, index) => (
          <li key={`${credit.role}-${credit.name}`} className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <Link to={artistHref(credit)} className="block truncate text-sm font-semibold hover:underline">
                {credit.name}
              </Link>
              <span className="block truncate text-xs text-muted-foreground">{credit.role}</span>
            </span>
            {index === 0 && credit.id && <FollowArtist id={credit.id} />}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function FollowArtist({ id }: { id: string }) {
  const t = useMessages(messages)
  const artist = useItem(id)
  const favorite = useSetFavorite(id)
  const [following, setFollowing] = useState<boolean | null>(null)
  const isFollowing = following ?? !!artist.data?.UserData?.IsFavorite
  return (
    <button
      type="button"
      aria-pressed={isFollowing}
      onClick={() => {
        setFollowing(!isFollowing)
        favorite.mutate(!isFollowing)
      }}
      className="h-8 shrink-0 rounded-full border border-foreground/40 px-4 text-xs font-bold transition-colors hover:border-foreground"
    >
      {isFollowing ? t.following : t.follow}
    </button>
  )
}

/** What plays after this one, with the way to the whole queue; when nothing follows, the way to find something. */
function NextInQueue() {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const navigate = useNavigate()
  const state = useMusic()
  const { remote, track } = usePlayerControls()
  // Steering another device: its next song.
  const next = remote ? remote.queue[remote.index + 1] : state.queue[state.index + 1]
  if (!track) return null
  if (!next)
    return (
      <section className="space-y-3 rounded-lg bg-muted/50 p-4 text-center">
        <p className="text-sm font-bold">{t.queueEmpty}</p>
        <button type="button" onClick={() => void navigate('/listen/search')} className="rounded-full bg-foreground/10 px-4 py-1.5 text-xs font-bold transition-colors hover:bg-foreground/20">
          {t.findSomething}
        </button>
      </section>
    )
  const cover = portraitImageUrl(api, next, { fillHeight: 96 })
  return (
    <Card
      title={t.nextInQueue}
      action={
        <button type="button" onClick={() => toggleListenPanel('queue')} className={cardAction}>
          {t.openQueue}
        </button>
      }
    >
      {/* The whole row plays it; the artists on it are links of their own (above the row's button). */}
      <div className="relative -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md p-2 transition-colors hover:bg-foreground/[0.07]">
        <button
          type="button"
          aria-label={next.Name ?? undefined}
          onClick={() => (remote ? remote.jump(remote.index + 1) : music.jump(state.index + 1))}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="pointer-events-none size-11 shrink-0 overflow-hidden rounded bg-muted">{cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}</span>
        <span className="pointer-events-none min-w-0">
          <span className="block truncate text-sm font-medium">{next.Name}</span>
          <span className="block truncate text-xs text-muted-foreground [&_a]:pointer-events-auto [&_a]:relative">
            <TrackArtists track={next} />
          </span>
        </span>
      </div>
    </Card>
  )
}
