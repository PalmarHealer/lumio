import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconCircleCheckFilled,
  IconCirclePlus,
  IconClock,
  IconDots,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlaylistAdd,
  IconTextPlus,
  IconUser,
} from '@tabler/icons-react'
import { Fragment, useState, type ReactNode } from 'react'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { ImageLightbox } from '@/components/media/image-lightbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { useAlbumTracks, useArtistAlbums, useSetFavorite } from '@/features/items/queries'
import { useDominantColor } from '@/lib/dominant-color'
import { formatClock, formatRuntime, ticksToSeconds } from '@/lib/format'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { artistsOf, titlePath } from '@/lib/item-links'
import { cn, tintWash } from '@/lib/utils'
import { MusicRow } from './music-card'
import { currentTrack, music, START, useMusic } from './player/music-player'
import { SwipeToQueue } from './swipe-to-queue'
import { ShuffleToggle } from './shuffle-toggle'
import { endTrackDrag, startTrackDrag } from './track-drag'
import { LikeToggle, TrackContextMenu, TrackMenu } from './track-menu'
import { playCircle } from './play-circle'
import { TrackArtists } from './track-artists'
import { AddToPlaylist } from './library-menu'
import { TasteMenuItem } from './taste'
import { DownloadButton, DownloadMenuItem } from './download-ui'
import { useHeldByDownload } from './download-ui'
import { useUnavailable } from './availability'
import { MediaAdminMenu } from '@/features/admin/media-admin'
import { displayName } from '@/lib/unscanned'

const messages = defineMessages({
  de: {
    album: 'Album',
    single: 'Single',
    ep: 'EP',
    audiobook: 'Hörbuch',
    songs: (n: number) => (n === 1 ? '1 Song' : `${n} Songs`),
    play: 'Abspielen',
    pause: 'Pausieren',
    shuffle: 'Zufallswiedergabe an',
    shuffleOff: 'Zufallswiedergabe aus',
    save: 'In der Bibliothek speichern',
    saved: 'In deiner Bibliothek',
    more: (name: string) => `Weitere Optionen für ${name}`,
    addToQueue: 'Zur Warteschlange hinzufügen',
    addToPlaylist: 'Zu Playlist hinzufügen',
    playNext: 'Als Nächstes abspielen',
    goToArtist: 'Zum Künstler',
    title: 'Titel',
    duration: 'Dauer',
    disc: (n: number) => `CD ${n}`,
    moreBy: (name: string) => `Mehr von ${name}`,
    released: (date: string) => `Veröffentlicht am ${date}`,
  },
  en: {
    album: 'Album',
    single: 'Single',
    ep: 'EP',
    audiobook: 'Audiobook',
    songs: (n: number) => (n === 1 ? '1 song' : `${n} songs`),
    play: 'Play',
    pause: 'Pause',
    shuffle: 'Turn on shuffle',
    shuffleOff: 'Turn off shuffle',
    save: 'Save to your library',
    saved: 'In your library',
    more: (name: string) => `More options for ${name}`,
    addToQueue: 'Add to queue',
    addToPlaylist: 'Add to playlist',
    playNext: 'Play next',
    goToArtist: 'Go to artist',
    title: 'Title',
    duration: 'Duration',
    disc: (n: number) => `Disc ${n}`,
    moreBy: (name: string) => `More by ${name}`,
    released: (date: string) => `Released ${date}`,
  },
})

/** Number, title, length, and the "…" menu; phones only the title, a like mark and the menu (as in Spotify). */
export const TRACK_GRID = 'grid-cols-[2rem_minmax(0,1fr)_6rem_2rem] max-md:grid-cols-[minmax(0,1fr)_auto_2rem]'

/** The same with a column before the length (e.g. the play count). */
export const TRACK_GRID_EXTRA = 'grid-cols-[2rem_minmax(0,1fr)_6rem_2rem] sm:grid-cols-[2rem_minmax(0,1fr)_9rem_6rem_2rem] max-md:grid-cols-[minmax(0,1fr)_auto_2rem]'

/** Spotify's convention: one track is a single, up to six an EP, more an album. */
function kindOf(trackCount: number, t: (typeof messages)['de'], isBook: boolean) {
  if (isBook) return t.audiobook
  if (trackCount === 1) return t.single
  if (trackCount > 1 && trackCount <= 6) return t.ep
  return t.album
}

/**
 * An album in Listen, laid out like a music app rather than a film page: a header tinted with the cover's color
 * (type, big title, artist, year, songs, length), a row of round actions, the track table, and more by the artist.
 */
export function AlbumView({ item }: { item: BaseItemDto }) {
  const hold = useHeldByDownload(`album:${item.Id}`)
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const tracks = useAlbumTracks(item.Id)
  const list = tracks.data ?? []
  const cover = portraitImageUrl(api, item, { fillHeight: 600 })
  const tint = useDominantColor(portraitImageUrl(api, item, { fillHeight: 64 })).data
  const artists = artistsOf(item)
  const mainArtist = artists[0]
  const otherAlbums = useArtistAlbums(mainArtist?.id)
  const state = useMusic()
  const playingHere = currentTrack(state)?.AlbumId === item.Id
  const totalTicks = list.reduce((sum, track) => sum + (track.RunTimeTicks ?? 0), 0)
  const isBook = list.some((track) => ticksToSeconds(track.RunTimeTicks ?? 0) > 20 * 60) || /h[öo]rbuch|audiobook/i.test(item.Genres?.join(' ') ?? '')
  const discs = [...new Set(list.map((track) => track.ParentIndexNumber ?? 1))]
  // In the app's language, not the browser's.
  const locale = getLocaleTag(useLocale())
  const released = item.PremiereDate ? new Date(item.PremiereDate).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : undefined

  const [saved, setSaved] = useState<boolean | null>(null)
  const isSaved = saved ?? !!item.UserData?.IsFavorite
  const favorite = useSetFavorite(item.Id!)

  const source = `album:${item.Id}`
  const playAll = () => (playingHere ? music.toggle() : music.play(list, START, { source }))

  return (
    <div className="pb-12">
      {/* Header: tinted with the cover's color, fading into the page. */}
      <div className="relative pt-14" style={{ background: tintWash(tint ?? 'rgb(64 64 64)') }}>
        <div className="flex flex-col gap-6 px-4 pb-6 pt-10 sm:flex-row sm:items-end sm:px-8">
          <ImageLightbox
            src={portraitImageUrl(api, item, { fillHeight: 1600 })}
            label={item.Name ?? ''}
            className="size-48 shrink-0 overflow-hidden rounded-md bg-muted shadow-2xl shadow-black/50 sm:size-56"
          >
            {cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}
          </ImageLightbox>
          <div className="min-w-0 space-y-3">
            <p className="text-sm font-medium">{kindOf(list.length, t, isBook)}</p>
            <h1 className="line-clamp-2 text-4xl font-black leading-none tracking-tight text-balance sm:text-6xl xl:text-7xl">{displayName(item)}</h1>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-foreground/80">
              {mainArtist && <ArtistAvatar id={mainArtist.id} />}
              {artists.map((artist, index) => (
                <Fragment key={artist.id ?? artist.name}>
                  {index > 0 && <span>•</span>}
                  {artist.id ? (
                    <Link to={titlePath('MusicArtist', artist.id)} className="font-bold text-foreground hover:underline">
                      {artist.name}
                    </Link>
                  ) : (
                    <span className="font-bold text-foreground">{artist.name}</span>
                  )}
                </Fragment>
              ))}
              {item.ProductionYear && <span>• {item.ProductionYear}</span>}
              {list.length > 0 && (
                <span>
                  • {t.songs(list.length)}, {formatRuntime(totalTicks)}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Actions, Spotify-style: the big play button, shuffle, save, more. */}
      <div className="flex items-center gap-5 px-4 py-5 sm:px-8">
        <button
          type="button"
          aria-label={playingHere && state.playing ? t.pause : t.play}
          onClick={() => playAll()}
          disabled={!list.length}
          className={cn('size-14', playCircle.listen)}
        >
          {playingHere && state.playing ? <IconPlayerPauseFilled className="size-6" /> : <IconPlayerPlayFilled className="size-6 translate-x-px" />}
        </button>
        <ShuffleToggle source={source} />
        <RoundAction
          label={isSaved && hold.held ? hold.hint : isSaved ? t.saved : t.save}
          active={isSaved}
          onClick={() => {
            // A downloaded album stays in the library.
            if (isSaved && hold.held) return
            setSaved(!isSaved)
            favorite.mutate(!isSaved)
          }}
        >
          {isSaved ? <IconCircleCheckFilled className="size-8" /> : <IconCirclePlus className="size-8" />}
        </RoundAction>
        <DownloadButton downloadKey={`album:${item.Id}`} name={item.Name ?? ''} items={tracks.data} collection={item} />
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={t.more(item.Name ?? '')} className="grid size-10 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <IconDots className="size-7" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem onClick={() => music.addToQueue(list)}>
              <IconPlaylistAdd /> {t.addToQueue}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => music.playNext(list)}>
              <IconTextPlus /> {t.playNext}
            </DropdownMenuItem>
            <AddToPlaylist tracks={async () => list} label={t.addToPlaylist} />
            <DownloadMenuItem downloadKey={`album:${item.Id}`} name={item.Name ?? ''} items={tracks.data} collection={item} />
            <TasteMenuItem kind="albums" id={item.Id} />
            {mainArtist?.id && (
              <DropdownMenuItem render={<Link to={titlePath('MusicArtist', mainArtist.id)} />}>
                <IconUser /> {t.goToArtist}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <MediaAdminMenu item={item} />
      </div>

      {/* Track table */}
      <div className="px-4 sm:px-8">
        <div className={cn('grid items-center gap-4 border-b px-4 pb-2 text-sm text-muted-foreground max-md:hidden', TRACK_GRID)}>
          <span className="text-right">#</span>
          <span>{t.title}</span>
          <span className="flex justify-end" aria-label={t.duration}>
            <IconClock className="size-4" />
          </span>
          <span />
        </div>
        {tracks.isLoading && (
          <div className="mt-2 space-y-1">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-md" />
            ))}
          </div>
        )}
        {discs.map((disc) => (
          <div key={disc} className="mt-2">
            {discs.length > 1 && <p className="px-4 pb-1 pt-3 text-sm font-semibold text-muted-foreground">{t.disc(disc)}</p>}
            {list.map((track, index) =>
              (track.ParentIndexNumber ?? 1) === disc ? (
                <TrackTableRow key={track.Id} track={track} number={track.IndexNumber ?? index + 1} onPlay={() => music.play(list, index, { source })} />
              ) : null,
            )}
          </div>
        ))}
        {released && <p className="px-4 pt-6 text-sm text-muted-foreground">{t.released(released)}</p>}
      </div>

      {mainArtist && (
        <div className="mt-12">
          <MusicRow title={t.moreBy(mainArtist.name)} items={(otherAlbums.data?.albums ?? []).filter((album) => album.Id !== item.Id)} />
        </div>
      )}
    </div>
  )
}

function ArtistAvatar({ id }: { id?: string }) {
  const { api } = useAuthedSession()
  if (!id) return null
  // The artist's photo is requested straight by id; missing photos just leave the slot empty.
  const url = `${api.basePath}/Items/${id}/Images/Primary?fillHeight=48&quality=85`
  return <img src={url} alt="" className="size-6 rounded-full bg-muted object-cover" onError={(event) => (event.currentTarget.style.display = 'none')} />
}

function RoundAction({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid size-10 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'text-listen' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * One row of the track table: number (a play icon on hover, an animated bar while it plays), title and artists, length.
 * It can be dragged onto a playlist or the queue, and right-clicked for the track's menu.
 */
export function TrackTableRow({
  track,
  number,
  onPlay,
  cover,
  extra,
  onRemove,
}: {
  track: BaseItemDto
  number: number
  onPlay: () => void
  /** Show the track's cover next to its title (lists spanning several albums). */
  cover?: boolean
  /** A column before the length, e.g. the play count. */
  extra?: ReactNode
  /** For a playlist's own entries: removes this one from the playlist. */
  onRemove?: () => void
}) {
  const { api } = useAuthedSession()
  const state = useMusic()
  const isCurrent = currentTrack(state)?.Id === track.Id
  // Offline, songs that need the network are greyed out (the player skips them).
  const unavailable = useUnavailable(track)
  const image = cover ? portraitImageUrl(api, track, { fillHeight: 80 }) : undefined
  return (
    <SwipeToQueue onQueue={() => music.addToQueue([track])} className="rounded-md">
      <TrackContextMenu track={track} onRemove={onRemove}>
        <div
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(event) => startTrackDrag(event, [track])}
          onDragEnd={endTrackDrag}
          onClick={onPlay}
          onKeyDown={(event) => {
            // Keys pressed in the row's own controls (the "…" menu) are theirs.
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onPlay()
            }
          }}
          className={cn(
            // Stays lit while its right-click menu is open.
            'group/track grid cursor-default items-center gap-4 rounded-md px-4 py-2 outline-none hover:bg-foreground/10 focus-visible:bg-foreground/10 data-popup-open:bg-foreground/10',
            unavailable && 'opacity-40',
            extra !== undefined ? TRACK_GRID_EXTRA : TRACK_GRID,
            'max-md:gap-3 max-md:px-2',
          )}
        >
          <span className="relative flex h-5 items-center justify-end text-sm tabular-nums text-muted-foreground max-md:hidden">
            {isCurrent && state.playing ? (
              <span aria-hidden className="flex h-3.5 items-end gap-px">
                {[0, 1, 2].map((bar) => (
                  <span key={bar} className="w-[3px] animate-[eq_0.9s_ease-in-out_infinite] rounded-sm bg-listen" style={{ animationDelay: `${bar * 0.2}s` }} />
                ))}
              </span>
            ) : (
              <>
                <span className={cn('group-hover/track:invisible', isCurrent && 'text-listen')}>{number}</span>
                <IconPlayerPlayFilled className="invisible absolute size-4 text-foreground group-hover/track:visible" />
              </>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-3">
            {cover && <span className="size-10 shrink-0 overflow-hidden rounded bg-muted">{image && <FadeImage src={image} alt="" className="size-full object-cover" />}</span>}
            <span className="min-w-0">
              <span className={cn('block truncate', isCurrent ? 'text-listen' : 'text-foreground')}>{displayName(track)}</span>
              {/* Keeps its line when there are no artists yet, so every row is as tall. */}
              <span className="block min-h-5 truncate text-sm text-muted-foreground">
                {/* All of them, with the featured artists (as Spotify lists them on an album too). */}
                <TrackArtists track={track} stopPropagation />
              </span>
            </span>
          </span>
          {extra !== undefined && <span className="hidden min-w-0 justify-end text-right text-sm tabular-nums text-muted-foreground sm:flex max-md:hidden">{extra}</span>}
          <span className="flex items-center justify-end gap-3 text-sm tabular-nums text-muted-foreground">
            <LikeToggle track={track} />
            {/* Unknown until the scan has probed the file. */}
            <span className="max-md:hidden">{track.RunTimeTicks ? formatClock(ticksToSeconds(track.RunTimeTicks)) : '–'}</span>
          </span>
          <TrackMenu track={track} onRemove={onRemove} />
        </div>
      </TrackContextMenu>
    </SwipeToQueue>
  )
}
