import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { IconBookmark, IconBookmarkFilled, IconEye, IconEyeCheck, IconPlayerPlay } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Navigate, useLocation, useNavigationType, useParams, useSearchParams } from 'react-router'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { MediaRow } from '@/components/media/media-row'
import { PersonRow } from '@/components/media/person-row'
import { WatchedBadge } from '@/components/media/watched-badge'
import { ExternalLinks, RatingBadges } from '@/components/media/rating-badges'
import { emitPluginEvent, PluginSlot, useHidden } from '@/features/admin/plugins'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { formatRuntime, plainText } from '@/lib/format'
import { useMessages } from '@/lib/i18n'
import { backdropImageUrl, landscapeImageUrl, logoImageUrl, portraitImageUrl } from '@/lib/images'
import { itemHref, playHref, WATCHLIST_TYPES } from '@/lib/item-links'
import { useLocalizedItem } from '@/lib/localized'
import { AlbumView } from '@/features/listen/album-view'
import { ArtistPage } from '@/features/listen/artist-page'
import { cn } from '@/lib/utils'
import { EpisodeContextMenu, EpisodeWatchedButton } from './episode-actions'
import { useFilmSeries } from './film-series'
import { detailMessages } from './messages'
import { usePlayTarget } from './play-target'
import { TrackPicker, type TrackChoice } from './track-picker'
import { useEpisodes, useItem, useOtherVersions, useSeasons, useSeriesGuestStars, useSeriesPlayTarget, useSetFavorite, useSetPlayed, useSimilarItems } from './queries'
import { useUserViews } from '@/features/home/queries'
import { MediaAdminMenu } from '@/features/admin/media-admin'
import { EpisodeDownloadButton, MovieDownloadButton, SeasonDownloadButton, useVideoDownloadMessages, useVideoUnavailable } from '@/features/player/video-download-ui'

export function DetailPage() {
  const { id = '' } = useParams()
  const [search] = useSearchParams()
  const { api } = useAuthedSession()
  const { data: jellyfinItem, isLoading, isError } = useItem(id)
  // In the interface's language; a title not filled in yet is looked up now.
  const item = useLocalizedItem(jellyfinItem, true)
  const [tracks, setTracks] = useState<TrackChoice>({})
  const t = useMessages(detailMessages)
  const location = useLocation()
  const hideRatings = useHidden('item:ratings')
  const hideLinks = useHidden('item:links')
  const series = useFilmSeries(item)
  // Plugins can follow which title is open.
  const openedId = item?.Id
  useEffect(() => {
    if (openedId && item) emitPluginEvent('item', { item })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedId])

  if (isLoading) {
    // Albums and artists live in Listen and load into its layout: a square cover (round for artists), not a poster.
    if (location.pathname.startsWith('/listen/')) return <MusicSkeleton round={location.pathname.startsWith('/listen/artist/')} />
    return <DetailSkeleton id={id} />
  }
  if (isError || !item) return <p className="p-8 pt-24 text-muted-foreground">{t.loadFailed}</p>
  // Every item has one address: /movie/…, /show/… or /item/…, and episodes, seasons and tracks live on their
  // series/album page, scrolled to the right place. Whatever was opened is corrected to that.
  const canonicalHref = itemHref(item)
  const [canonicalPath, canonicalQuery] = canonicalHref.split('?')
  if (canonicalPath !== location.pathname) {
    // Keep the query (season/episode) when only the prefix was wrong, e.g. /item/<series>?episode=… → /show/<series>?….
    return <Navigate to={canonicalQuery ? canonicalHref : `${canonicalPath}${location.search}`} replace />
  }

  if (item.Type === 'MusicArtist') return <ArtistPage item={item} />
  // Albums are music, laid out like a music app (Listen), not like a film page.
  if (item.Type === 'MusicAlbum') return <AlbumView item={item} />

  const backdrop = backdropImageUrl(api, item)
  const poster = portraitImageUrl(api, item, { fillHeight: 600 })
  const isSeries = item.Type === 'Series'
  const meta = [item.ProductionYear, item.OfficialRating, isSeries ? undefined : formatRuntime(item.RunTimeTicks)].filter(Boolean)
  const directors = item.People?.filter((person) => person.Type === 'Director').map((person) => person.Name) ?? []
  const cast = item.People?.filter((person) => person.Type === 'Actor') ?? []
  const overview = plainText(item.Overview)

  return (
    <div className="pb-12">
      <div className="relative h-72 sm:h-96">
        {/* Anchored to the top edge so faces aren't cut off when the backdrop is cropped to the banner. */}
        {backdrop && <FadeImage src={backdrop} alt="" className="size-full object-cover object-top" />}
        <div className="absolute inset-0 bg-linear-to-t from-background via-background/60 to-transparent" />
      </div>

      <div className="relative -mt-40 flex flex-col items-start gap-6 px-4 sm:-mt-48 sm:flex-row sm:px-8">
        <div
          className="aspect-[2/3] w-40 shrink-0 self-start overflow-hidden rounded-lg bg-muted ring-1 ring-border sm:w-56"
          style={{ viewTransitionName: `poster-${item.Id}` }}
        >
          {poster && <FadeImage src={poster} alt="" className="size-full object-cover" />}
        </div>
        <div className="min-w-0 space-y-4 sm:pt-24">
          <Title item={item} />
          {meta.length > 0 && <p className="text-sm text-muted-foreground">{meta.join(' · ')}</p>}
          {series && <p className="text-sm text-muted-foreground">{t.seriesPart(series.index + 1, series.films.length, series.name)}</p>}
          <OtherVersions item={item} />
          {!hideRatings && <RatingBadges item={item} />}
          {!!item.Genres?.length && (
            <div className="flex flex-wrap gap-2">
              {item.Genres.map((genre) => (
                <Badge key={genre} variant="secondary">
                  {genre}
                </Badge>
              ))}
            </div>
          )}
          {item.Type === 'Movie' && <TrackPicker item={item} value={tracks} onChange={setTracks} />}
          <div className="flex flex-wrap gap-3">
            <PlayButton item={item} tracks={tracks} />
            {item.Type === 'Movie' && <MovieDownloadButton movie={item} />}
            {WATCHLIST_TYPES.has(item.Type ?? '') && <WatchlistButton item={item} />}
            {PLAYED_TYPES.has(item.Type ?? '') && <PlayedButton item={item} />}
            <PluginSlot name="item:actions" context={{ item }} className="contents" />
            {/* Administrators: images, identify, refresh metadata. */}
            <MediaAdminMenu item={item} className="size-10 rounded-full border border-border/60 bg-background/40" />
          </div>
          {overview && <p className="max-w-3xl whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{overview}</p>}
          {directors.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground">{t.director}</span> · {directors.join(', ')}
            </p>
          )}
          {!hideLinks && <ExternalLinks item={item} />}
        </div>
      </div>

      <div className="mt-10 space-y-10">
        {series && <MediaRow title={t.seriesRow(series.name)} items={series.films} currentId={item.Id} />}
        <PersonRow title={t.cast} people={cast.slice(0, 30).map((person) => ({ person }))} />
        {isSeries && <GuestStarsRow seriesId={item.Id!} />}
        {isSeries && <SeasonsSection key={`${item.Id}:${search.get('episode') ?? ''}`} series={item} seriesId={item.Id!} highlightId={search.get('episode') ?? undefined} />}
        <SimilarRow item={item} exclude={series?.films} />
        <PluginSlot name="item:bottom" context={{ item }} className="px-4 sm:px-8" />
      </div>
    </div>
  )
}

/** The title as the item's logo artwork where there is one (most films and series), else as text. */
function Title({ item }: { item: BaseItemDto }) {
  const { api } = useAuthedSession()
  const logo = logoImageUrl(api, item, { fillWidth: 800 })
  const [failed, setFailed] = useState<string | null>(null)
  if (!logo || failed === logo) return <h1 className="text-3xl font-semibold tracking-tight">{item.Name}</h1>
  return (
    <h1>
      <img
        src={logo}
        alt={item.Name ?? ''}
        onError={() => setFailed(logo)}
        className="max-h-24 w-auto max-w-[min(28rem,100%)] object-contain object-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)] sm:max-h-32"
      />
    </h1>
  )
}

/** Jellyfin's similar titles, at the end like in jellyfin-web; films of the same series are already shown above. */
function SimilarRow({ item, exclude }: { item: BaseItemDto; exclude?: BaseItemDto[] }) {
  const t = useMessages(detailMessages)
  const similar = useSimilarItems(SIMILAR_TYPES.has(item.Type ?? '') ? item.Id! : undefined)
  const skip = new Set(exclude?.map((film) => film.Id))
  return <MediaRow title={t.similar} items={similar.data?.filter((entry) => !skip.has(entry.Id))} loading={similar.isLoading} />
}

const SIMILAR_TYPES = new Set(['Movie', 'Series', 'MusicAlbum', 'BoxSet', 'Book'])

function PlayButton({ item, tracks }: { item: BaseItemDto; tracks: TrackChoice }) {
  const { target, label } = usePlayTarget(item)
  const downloadT = useVideoDownloadMessages()
  // Offline, only what is stored on the device plays.
  const unavailable = useVideoUnavailable(target?.Type === 'Movie' || target?.Type === 'Episode' ? target.Id : null)
  if (!target) return null
  if (unavailable) {
    return (
      <Button size="lg" disabled title={downloadT.unavailable}>
        <IconPlayerPlay /> <span className="max-w-64 truncate">{label}</span>
      </Button>
    )
  }

  return (
    <Button size="lg" nativeButton={false} render={<Link to={playHref(target, { a: tracks.audio, s: tracks.subtitle })} />}>
      <IconPlayerPlay /> <span className="max-w-64 truncate">{label}</span>
    </Button>
  )
}

const PLAYED_TYPES = new Set(['Movie', 'Series', 'MusicAlbum'])

function PlayedButton({ item }: { item: BaseItemDto }) {
  const t = useMessages(detailMessages)
  const setPlayed = useSetPlayed(item.Id!)
  const watched = !!item.UserData?.Played
  return (
    <Button size="lg" variant="outline" aria-pressed={watched} disabled={setPlayed.isPending} onClick={() => setPlayed.mutate(!watched)}>
      {watched ? <IconEyeCheck /> : <IconEye />} {watched ? t.watched : t.markWatched}
    </Button>
  )
}

function WatchlistButton({ item }: { item: BaseItemDto }) {
  const t = useMessages(detailMessages)
  const favorite = useSetFavorite(item.Id!)
  const saved = !!item.UserData?.IsFavorite
  return (
    <Button
      size="lg"
      variant="outline"
      aria-pressed={saved}
      disabled={favorite.isPending}
      onClick={() => favorite.mutate(!saved)}
    >
      {saved ? <IconBookmarkFilled /> : <IconBookmark />} {saved ? t.onWatchlist : t.watchlist}
    </Button>
  )
}

function GuestStarsRow({ seriesId }: { seriesId: string }) {
  const t = useMessages(detailMessages)
  const guests = useSeriesGuestStars(seriesId)
  // Worded here rather than in the query, so a cached result follows a language change.
  const people = (guests.data ?? []).map(({ person, roles, episodes }) => ({
    person,
    subtitle: [roles.join(', '), t.episodes(episodes)].filter(Boolean).join(' · '),
  }))
  return <PersonRow title={t.guestStars} people={people} loading={guests.isLoading} />
}

const isSpecials = (season: BaseItemDto) => season.IndexNumber === 0

/**
 * The season the user is "at": the first regular season that isn't fully watched, else the last one.
 * Specials never count; they are only picked if a series has nothing else.
 */
function currentSeasonId(seasons: BaseItemDto[]): string | undefined {
  const regular = seasons.filter((season) => !isSpecials(season))
  if (regular.length === 0) return seasons[0]?.Id
  const fullyWatched = (season: BaseItemDto) => !!season.UserData?.Played || season.UserData?.UnplayedItemCount === 0
  return (regular.find((season) => !fullyWatched(season)) ?? regular[regular.length - 1]).Id
}

interface SeasonsSectionProps {
  series: BaseItemDto
  seriesId: string
  highlightId?: string
}

function SeasonsSection({ series, seriesId, highlightId }: SeasonsSectionProps) {
  const seasons = useSeasons(seriesId)
  // The season shown lives in the address (?season=): coming back from the player (or any other page) opens the page
  // exactly as it was left, instead of working out "where the user is" again.
  const [search, setSearch] = useSearchParams()
  const picked = search.get('season') ?? undefined
  const showSeason = (id: string) =>
    setSearch(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('season', id)
        return next
      },
      // Only the address changes: the page stays where it is (see PageTransition).
      { replace: true, preventScrollReset: true, state: { keepScroll: true } },
    )
  const navigationType = useNavigationType()
  const orderedSeasons = useMemo(() => {
    const all = seasons.data ?? []
    return [...all.filter((season) => !isSpecials(season)), ...all.filter(isSpecials)]
  }, [seasons.data])
  // Opens at the season of the episode "play" would start (in progress, else next up). A watched episode opened again
  // doesn't count (see unfinished), so a quick look into an old season doesn't move the series back there.
  const playTarget = useSeriesPlayTarget(picked ? undefined : seriesId)
  // A watched target is only the "from the start" fallback of a series seen in full: that one opens at its last season.
  const target = playTarget.data?.UserData?.Played ? undefined : playTarget.data
  const targetSeason = orderedSeasons.find((season) => season.Id === target?.SeasonId && !isSpecials(season))?.Id
  const seasonId = picked ?? (playTarget.isPending && !playTarget.isError ? undefined : (targetSeason ?? currentSeasonId(orderedSeasons)))
  const episodes = useEpisodes(seriesId, seasonId)
  const episodesLoading = episodes.isLoading || (!seasonId && orderedSeasons.length > 0)
  // The season worked out on arrival is kept in the address too, so it stays when the user comes back.
  useEffect(() => {
    if (!picked && seasonId) showSeason(seasonId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, seasonId])

  // Jump to the episode the user came from (e.g. "Weiterschauen"), once per episode. Not on the way back (from the
  // player): the page then keeps the scroll position it was left at.
  const highlighted = useRef<HTMLLIElement>(null)
  const scrolledTo = useRef<string | undefined>(navigationType === 'POP' ? highlightId : undefined)
  useEffect(() => {
    if (!highlightId || scrolledTo.current === highlightId || !highlighted.current) return
    scrolledTo.current = highlightId
    const target = highlighted.current
    // Wait a frame for the list (and the page transition) to lay out, or the scroll lands short.
    const frame = requestAnimationFrame(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [highlightId, episodes.data])

  return (
    <section className="space-y-4 px-4 sm:px-8">
        <div className="flex flex-wrap items-center gap-2">
          {orderedSeasons.map((season) => (
            <Button key={season.Id} size="sm" variant={season.Id === seasonId ? 'default' : 'outline'} onClick={() => showSeason(season.Id!)}>
              <SeasonName season={season} />
            </Button>
          ))}
          <SeasonDownloadButton
            series={series}
            seasons={orderedSeasons}
            season={orderedSeasons.find((season) => season.Id === seasonId)}
            episodes={episodes.data}
          />
        </div>

        {/* One column as wide as the page: long titles truncate instead of widening it (and the whole page). */}
        <ul className="grid grid-cols-1 gap-3">
          {episodesLoading && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
          {episodes.data?.map((episode) => {
            const isHighlighted = episode.Id === highlightId
            return (
              <EpisodeItem
                key={episode.Id}
                ref={isHighlighted ? highlighted : undefined}
                episode={episode}
                highlighted={isHighlighted}
                context={[series, ...orderedSeasons, ...(episodes.data ?? [])]}
              />
            )
          })}
        </ul>
    </section>
  )
}

function SeasonName({ season }: { season: BaseItemDto }) {
  return useLocalizedItem(season).Name
}

/** An episode in the season's list; offline, one without a stored copy is greyed out and can't be opened. */
function EpisodeItem({ episode: jellyfinEpisode, highlighted, context, ref }: { episode: BaseItemDto; highlighted: boolean; context: BaseItemDto[]; ref?: Ref<HTMLLIElement> }) {
  const episode = useLocalizedItem(jellyfinEpisode)
  const { api } = useAuthedSession()
  const t = useVideoDownloadMessages()
  const unavailable = useVideoUnavailable(episode.Id)
  const thumb = landscapeImageUrl(api, episode, { fillWidth: 320 })
  const progress = episode.UserData?.PlayedPercentage
  const overview = plainText(episode.Overview)
  return (
    // The card is the row; its watched and download buttons sit inside it, on the right. Right-click: more.
    <EpisodeContextMenu episode={episode}>
      <li
        ref={ref}
        title={unavailable ? t.unavailable : undefined}
        className={cn(
          'group/episode relative rounded-lg transition hover:bg-muted',
          highlighted && 'bg-muted ring-1 ring-foreground/30',
          unavailable && 'opacity-40 hover:bg-transparent',
        )}
      >
        <Link
          to={playHref(episode)}
          aria-disabled={unavailable || undefined}
          onClick={(event) => unavailable && event.preventDefault()}
          className={cn(
            'flex min-w-0 gap-4 rounded-lg p-2 pr-28 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            unavailable && 'cursor-default',
          )}
        >
          <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-muted sm:w-52">
            {thumb && <FadeImage src={thumb} alt="" loading="lazy" className="size-full object-cover" />}
            <WatchedBadge item={episode} className="absolute right-1.5 top-1.5" />
            {!!progress && (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <p className={cn('truncate font-medium', episode.UserData?.Played && 'text-muted-foreground')}>
              {episode.IndexNumber}. {episode.Name}
            </p>
            <p className="text-xs text-muted-foreground">{formatRuntime(episode.RunTimeTicks)}</p>
            <p className="line-clamp-2 whitespace-pre-line text-sm text-muted-foreground">{overview}</p>
          </div>
        </Link>
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
          <EpisodeWatchedButton episode={episode} />
          <EpisodeDownloadButton episode={episode} context={context} />
        </div>
      </li>
    </EpisodeContextMenu>
  )
}

/**
 * Placeholder while the item loads. It mirrors the real layout and shows the poster the user just clicked (passed in the
 * router state), so the poster can morph from the card to its final position right away.
 */
function MusicSkeleton({ round }: { round: boolean }) {
  return (
    <div className="pb-12">
      <div className="flex flex-col gap-6 px-4 pb-6 pt-24 sm:flex-row sm:items-end sm:px-8">
        <Skeleton className={cn('size-48 shrink-0 sm:size-56', round ? 'rounded-full' : 'rounded-md')} />
        <div className="min-w-0 flex-1 space-y-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-14 w-2/3 max-w-xl" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </div>
      <div className="flex items-center gap-5 px-4 py-5 sm:px-8">
        <Skeleton className="size-14 rounded-full" />
        <Skeleton className="size-8 rounded-full" />
      </div>
      <div className="space-y-1 px-4 sm:px-8">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-md" />
        ))}
      </div>
    </div>
  )
}

function DetailSkeleton({ id }: { id: string }) {
  const poster = (useLocation().state as { poster?: string } | null)?.poster
  return (
    <div>
      <Skeleton className="h-72 rounded-none sm:h-96" />
      <div className="relative -mt-40 flex flex-col items-start gap-6 px-4 sm:-mt-48 sm:flex-row sm:px-8">
        <div
          className="aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-border sm:w-56"
          style={{ viewTransitionName: `poster-${id}` }}
        >
          {poster && <img src={poster} alt="" className="size-full object-cover" />}
        </div>
        <div className="min-w-0 space-y-3 sm:pt-24">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
    </div>
  )
}

/**
 * The same title in other libraries (e.g. "Animes" and "Animes ENG"): the category pages list it once, so the switch
 * between the copies lives here, labelled with the library each one is in.
 */
function OtherVersions({ item }: { item: BaseItemDto }) {
  const t = useMessages(detailMessages)
  const views = useUserViews()
  const versions = useOtherVersions(item, views.data ?? [])
  const list = versions.data ?? []
  if (list.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t.version}</span>
      <div className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-0.5">
        {list.map(({ item: version, library }) => {
          const current = version.Id === item.Id
          return (
            <Link
              key={version.Id}
              to={itemHref(version)}
              replace
              aria-current={current ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                current ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {library.Name}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
