import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { BaseItemKind, ItemSortBy, SortOrder } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { ScrollRow } from '@/components/media/scroll-row'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { albumTracksOptions } from '@/features/items/queries'
import { defineMessages, useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { artistsOf, itemHref } from '@/lib/item-links'
import { cn } from '@/lib/utils'
import { currentTrack, music, START, useMusic } from './player/music-player'
import { playCircle } from './play-circle'
import { useArtistPhoto } from './artist-photo'
import { ContextMenu } from '@base-ui/react/context-menu'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { AlbumMenuItems, ArtistMenuItems } from './library-menu'
import { TrackArtists } from './track-artists'
import { MissingCover } from './missing-cover'

const messages = defineMessages({
  de: { artist: 'Künstler', play: (name: string) => `${name} abspielen`, pause: (name: string) => `${name} pausieren` },
  en: { artist: 'Artist', play: (name: string) => `Play ${name}`, pause: (name: string) => `Pause ${name}` },
})

/** Plays what a card stands for: an album's tracks, or an artist's tracks (most played first). */
export function usePlayCollection() {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  return async (item: BaseItemDto) => {
    if (item.Type === 'MusicArtist') {
      const tracks =
        (
          await getLibraryApi(api).getItems({
            userId: session.userId,
            recursive: true,
            includeItemTypes: [BaseItemKind.Audio],
            artistIds: [item.Id!],
            sortBy: [ItemSortBy.PlayCount, ItemSortBy.SortName],
            sortOrder: [SortOrder.Descending, SortOrder.Ascending],
            limit: 100,
          })
        ).data.Items ?? []
      return music.play(tracks, START, { source: `artist:${item.Id}` })
    }
    if (item.Type === 'Audio') return music.play([item])
    music.play(await queryClient.fetchQuery(albumTracksOptions(api, session.userId, item.Id!)), START, { source: `album:${item.Id}` })
  }
}

/** Whether the music playing comes from this album or artist. */
function useIsPlayingFrom(item: BaseItemDto) {
  const state = useMusic()
  const track = currentTrack(state)
  if (!track) return { here: false, playing: false }
  const here = item.Type === 'MusicArtist' ? artistsOf(track).some((artist) => artist.id === item.Id) : track.AlbumId === item.Id
  return { here, playing: here && state.playing }
}

interface CardShellProps {
  href: string
  cover: ReactNode
  title: string
  subtitle?: ReactNode
  round?: boolean
  /** Whether what the card stands for is the music currently loaded, and playing. */
  here: boolean
  playing: boolean
  onPlay: () => void
  className?: string
  /** Its right-click menu. */
  menu?: ReactNode
}

/**
 * A card in Listen, styled after music apps: the cover (round for artists) on a tile that lights up on hover, with a
 * play button rising into its corner. No big preview card as in Watch; music is played, not read about.
 */
export function CardShell({ href, cover, title, subtitle, round, here, playing, onPlay, className, menu }: CardShellProps) {
  const t = useMessages(messages)
  const card = (
    <div className={cn('group/music relative w-44 shrink-0 rounded-lg p-3 transition-colors duration-300 hover:bg-foreground/[0.07] data-popup-open:bg-foreground/[0.07]', className)}>
      <Link to={href} className="block outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring">
        <div className={cn('relative aspect-square overflow-hidden bg-muted shadow-lg shadow-black/40', round ? 'rounded-full' : 'rounded-md')}>{cover}</div>
        <p className="mt-3 truncate text-sm font-semibold">{title}</p>
        {subtitle && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{subtitle}</p>}
      </Link>
      {/* Laid over the cover (outside the link, a button can't sit inside one); rises in on hover, stays while this
          collection plays. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 aspect-square">
        <button
          type="button"
          aria-label={playing ? t.pause(title) : t.play(title)}
          onClick={() => (here ? music.toggle() : onPlay())}
          className={cn(
            // After the circle's classes, so its `absolute` wins over their `relative`.
            playCircle.listen,
            'pointer-events-auto absolute bottom-2 right-2 z-10 size-12 transition-[opacity,translate] duration-300 ease-out',
            // Fingers can't hover: there it only shows while this plays (tapping the card opens it).
            playing ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0 group-hover/music:translate-y-0 group-hover/music:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 pointer-coarse:hidden',
          )}
        >
          {playing ? <IconPlayerPauseFilled className="size-5" /> : <IconPlayerPlayFilled className="size-5 translate-x-px" />}
        </button>
      </div>
    </div>
  )
  if (!menu) return card
  // Right-click: what can be done with it (as in the library).
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={card} />
      <DropdownMenuContent className="w-60">{menu}</DropdownMenuContent>
    </ContextMenu.Root>
  )
}

/** An album, artist or track as a card. */
export function MusicCard({ item, className, subtitle }: { item: BaseItemDto; className?: string; /** In place of the artists (e.g. "2024 • Single"). */ subtitle?: string }) {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const play = usePlayCollection()
  const { here, playing } = useIsPlayingFrom(item)
  const isArtist = item.Type === 'MusicArtist'
  const artistPhoto = useArtistPhoto(item.Type === 'MusicArtist' ? item : undefined)
  const image = item.Type === 'MusicArtist' ? artistPhoto : portraitImageUrl(api, item, { fillHeight: 360 })
  return (
    <CardShell
      href={itemHref(item)}
      menu={isArtist ? <ArtistMenuItems artist={item} /> : item.Type === 'MusicAlbum' ? <AlbumMenuItems album={item} /> : undefined}
      title={item.Name ?? ''}
      subtitle={subtitle ?? (isArtist ? t.artist : item.Type === 'Audio' ? <TrackArtists track={item} linked={false} /> : artistsOf(item).map((artist) => artist.name).join(', ') || item.ProductionYear)}
      round={isArtist}
      here={here}
      playing={playing}
      onPlay={() => void play(item)}
      className={className}
      cover={
        image ? (
          <FadeImage src={image} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <MissingCover type={item.Type} iconClassName="size-1/3" stroke={1.25} />
        )
      }
    />
  )
}

/** A titled, horizontally scrolling row of cards (albums, artists, playlists). */
export function CardRow({
  title,
  subtitle,
  loading,
  action,
  children,
}: {
  title: string
  /** A small line under the title (e.g. "Only visible to you"). */
  subtitle?: string
  loading?: boolean
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="space-y-1">
      {/* Without a title (a section that has its own heading), just the row. */}
      {(title || action) && (
        <div className="flex items-baseline justify-between gap-4 px-4 sm:px-8">
          <div className="min-w-0">
            <h2 className="text-2xl font-extrabold tracking-tight">{title}</h2>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <ScrollRow className="px-1 sm:px-5" restoreKey={loading ? undefined : title} dashes={!!title || !!action}>
        {loading
          ? Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="w-44 shrink-0 p-3">
                <Skeleton className="aspect-square rounded-md" />
                <Skeleton className="mt-3 h-4 w-3/4" />
              </div>
            ))
          : children}
      </ScrollRow>
    </section>
  )
}

/** A row of album or artist cards; hidden when there is nothing to show. */
export function MusicRow({ title, items, loading, action }: { title: string; items?: BaseItemDto[]; loading?: boolean; action?: ReactNode }) {
  if (!loading && !items?.length) return null
  return (
    <CardRow title={title} loading={loading} action={action}>
      {items?.map((item) => <MusicCard key={item.Id} item={item} />)}
    </CardRow>
  )
}

/** Music cards in a responsive grid (a library or category page). */
export function MusicGrid({ items, loading }: { items: BaseItemDto[]; loading?: boolean }) {
  return (
    <div className="-mx-3 grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
      {loading && Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="m-3 aspect-square rounded-md" />)}
      {items.map((item) => (
        <MusicCard key={item.Id} item={item} className="w-auto" />
      ))}
    </div>
  )
}
