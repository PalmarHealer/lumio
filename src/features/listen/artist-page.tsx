import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { BaseItemKind, ItemFields, ItemSortBy, SortOrder } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import {
  IconDots,
  IconExternalLink,
  IconMicrophone2,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlaylistAdd,
  IconRadio,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { FadeImage } from '@/components/media/fade-image'
import { ImageLightbox } from '@/components/media/image-lightbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { useArtistAlbums, useLibraryArtists, useSetFavorite } from '@/features/items/queries'
import { useCategories } from '@/features/library/categories'
import { useDominantColor } from '@/lib/dominant-color'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { backdropImageUrl, portraitImageUrl } from '@/lib/images'
import { cn, tintWash } from '@/lib/utils'
import { TrackTableRow } from './album-view'
import { ArtistAboutDialog } from './artist-about'
import { useArtistRadio } from './radio'
import { ArtistConcerts } from './concert-pages'
import { sameName, useLastfmArtist, useLastfmTopTracks } from './external'
import { CardRow, MusicCard, MusicRow } from './music-card'
import { useReleaseLine } from './artist-discography'
import { LikedFromArtist } from './artist-liked'
import { Link } from '@/components/link'
import { music, START } from './player/music-player'
import { useNowPlaying } from './player/player-controls'
import { ShuffleToggle } from './shuffle-toggle'
import { playCircle } from './play-circle'
import { useArtistBio, useArtistPhoto } from './artist-photo'
import { MediaAdminMenu } from '@/features/admin/media-admin'

const messages = defineMessages({
  de: {
    artist: 'Künstler',
    listeners: (n: string) => `${n} Hörer`,
    plays: (n: string) => `${n} Wiedergaben`,
    play: 'Abspielen',
    pause: 'Pausieren',
    shuffle: 'Zufallswiedergabe an',
    shuffleOff: 'Zufallswiedergabe aus',
    follow: 'Folgen',
    following: 'Gefolgt',
    more: (name: string) => `Weitere Optionen für ${name}`,
    addToQueue: 'Alle Songs zur Warteschlange',
    radio: 'Zum Künstler*innen-Radio',
    lastfm: 'Auf Last.fm ansehen',
    popular: 'Beliebt',
    showMore: 'Mehr anzeigen',
    showLess: 'Weniger anzeigen',
    discography: 'Diskografie',
    showAll: 'Alle anzeigen',
    popularReleases: 'Beliebte Veröffentlichungen',
    albums: 'Alben',
    singles: 'Singles und EPs',
    about: 'Informationen',
    appearsOn: 'Erscheint auf',
    fansLike: 'Fans gefällt auch',
  },
  en: {
    artist: 'Artist',
    listeners: (n: string) => `${n} listeners`,
    plays: (n: string) => `${n} plays`,
    play: 'Play',
    pause: 'Pause',
    shuffle: 'Turn on shuffle',
    shuffleOff: 'Turn off shuffle',
    follow: 'Follow',
    following: 'Following',
    more: (name: string) => `More options for ${name}`,
    addToQueue: 'Add all songs to queue',
    radio: 'Go to artist radio',
    lastfm: 'View on Last.fm',
    popular: 'Popular',
    showMore: 'Show more',
    showLess: 'Show less',
    discography: 'Discography',
    showAll: 'Show all',
    popularReleases: 'Popular releases',
    albums: 'Albums',
    singles: 'Singles and EPs',
    about: 'About',
    appearsOn: 'Appears on',
    fansLike: 'Fans also like',
  },
})

/** All of an artist's tracks in the library, with play counts (for "popular" and for playing everything). */
export function useArtistTracks(artistId: string | undefined) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['artist-tracks', session.userId, artistId],
    enabled: !!artistId,
    queryFn: async () =>
      (
        await getLibraryApi(api).getItems({
          userId: session.userId,
          recursive: true,
          includeItemTypes: [BaseItemKind.Audio],
          artistIds: [artistId!],
          sortBy: [ItemSortBy.PlayCount, ItemSortBy.SortName],
          sortOrder: [SortOrder.Descending, SortOrder.Ascending],
          fields: [ItemFields.PrimaryImageAspectRatio],
          limit: 500,
        })
      ).data.Items ?? [],
  })
}

/**
 * An artist in Listen, built like Spotify's artist page: a banner with the name and listener count, the actions,
 * popular tracks, the discography (all, albums, singles/EPs), upcoming concerts, an about card, what they appear on and
 * similar artists. Library data comes from Jellyfin; listeners, popularity, biography and similar artists from Last.fm,
 * concerts from Ticketmaster (each only with its key).
 */
export function ArtistPage({ item }: { item: BaseItemDto }) {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const lastfm = useLastfmArtist(item.Name ?? undefined)
  const topTracks = useLastfmTopTracks(item.Name ?? undefined)
  const tracks = useArtistTracks(item.Id ?? undefined)
  const albums = useArtistAlbums(item.Id ?? undefined)
  const state = useNowPlaying()
  const radio = useArtistRadio()

  const banner = backdropImageUrl(api, item, { fillWidth: 1600 })
  const ownPhoto = portraitImageUrl(api, item, { fillHeight: 480 })
  // Jellyfin's photo, or one from Deezer when it has none.
  const photo = useArtistPhoto(item, 480)
  const tint = useDominantColor(ownPhoto ? portraitImageUrl(api, item, { fillHeight: 64 }) : photo).data

  // Popular: Last.fm's ranking where we have those songs, otherwise the plays on this server.
  const library = tracks.data ?? []
  const ranked = topTracks.data
    ?.map((top) => {
      const match = library.find((track) => sameName(track.Name, top.name))
      return match ? { track: match, plays: top.playcount } : null
    })
    .filter((entry): entry is { track: BaseItemDto; plays: number } => !!entry)
  const seen = new Set<string>()
  const popular = (ranked?.length ? ranked : library.map((track) => ({ track, plays: undefined as number | undefined }))).filter((entry) => {
    // One entry per song, even if the library has it on several releases.
    const key = (entry.track.Name ?? '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const [expanded, setExpanded] = useState(false)
  const shownPopular = popular.slice(0, expanded ? 10 : 5)

  const playingHere = state.track && library.some((track) => track.Id === state.track?.Id)
  const source = `artist:${item.Id}`
  const playAll = () => (playingHere ? state.toggle() : music.play(popular.map((entry) => entry.track), START, { source }))

  const [following, setFollowing] = useState<boolean | null>(null)
  const isFollowing = following ?? !!item.UserData?.IsFavorite
  const follow = useSetFavorite(item.Id!)

  const listeners = lastfm.data?.listeners
  const bio = useArtistBio(item)

  return (
    <div className="pb-12">
      {/* Banner: the artist's backdrop where there is one, else their color with the round photo, as Spotify does. */}
      <div
        className="relative flex h-[22rem] items-end overflow-hidden pt-14 sm:h-[26rem]"
        style={banner ? undefined : { background: tintWash(tint ?? 'rgb(64 64 64)') }}
      >
        {banner && (
          <>
            <FadeImage src={banner} alt="" className="absolute inset-0 size-full object-cover object-[50%_25%]" />
            <div className="absolute inset-0 bg-linear-to-t from-background via-background/30 to-black/10" />
          </>
        )}
        <div className="relative flex items-end gap-6 px-4 pb-6 sm:px-8">
          {!banner && (
            <ImageLightbox
              src={ownPhoto ? portraitImageUrl(api, item, { fillHeight: 1600 }) : photo}
              label={item.Name ?? ''}
              round
              className="size-40 shrink-0 overflow-hidden rounded-full bg-muted shadow-2xl shadow-black/50 sm:size-52"
            >
              {photo ? (
                <FadeImage src={photo} alt="" className="size-full object-cover object-[50%_20%]" />
              ) : (
                <div className="grid size-full place-items-center text-muted-foreground">
                  <IconMicrophone2 className="size-1/3" stroke={1.25} />
                </div>
              )}
            </ImageLightbox>
          )}
          <div className="min-w-0 space-y-3">
            <p className="text-sm font-medium">{t.artist}</p>
            <h1 className="text-5xl font-black leading-none tracking-tight text-balance drop-shadow-lg sm:text-7xl xl:text-8xl">{item.Name}</h1>
            {!!listeners && <p className="text-sm font-medium text-foreground/90">{t.listeners(number.format(listeners))}</p>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-5 px-4 py-5 sm:px-8">
        <button
          type="button"
          aria-label={playingHere && state.playing ? t.pause : t.play}
          onClick={() => playAll()}
          disabled={!popular.length}
          className={cn('size-14', playCircle.listen)}
        >
          {playingHere && state.playing ? <IconPlayerPauseFilled className="size-6" /> : <IconPlayerPlayFilled className="size-6 translate-x-px" />}
        </button>
        <ShuffleToggle source={source} />
        <button
          type="button"
          aria-pressed={isFollowing}
          onClick={() => {
            setFollowing(!isFollowing)
            follow.mutate(!isFollowing)
          }}
          className="h-8 rounded-full border border-foreground/40 px-4 text-sm font-bold transition-colors hover:border-foreground"
        >
          {isFollowing ? t.following : t.follow}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={t.more(item.Name ?? '')} className="grid size-10 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <IconDots className="size-7" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem onClick={() => music.addToQueue(library)}>
              <IconPlaylistAdd /> {t.addToQueue}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void radio(item)}>
              <IconRadio /> {t.radio}
            </DropdownMenuItem>
            {lastfm.data?.url && (
              <DropdownMenuItem render={<a href={lastfm.data.url} target="_blank" rel="noreferrer noopener" />}>
                <IconExternalLink /> {t.lastfm}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <MediaAdminMenu item={item} />
      </div>

      <div className="space-y-12">
        {/* Popular, and beside it (as on Spotify) what the user liked by this artist. */}
        <div className="flex flex-col gap-8 px-4 sm:px-8 xl:flex-row">
          {(tracks.isLoading || popular.length > 0) && (
            <section className="min-w-0 max-w-4xl flex-1">
              <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.popular}</h2>
              <div>
                {tracks.isLoading && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mb-1 h-14 rounded-md" />)}
                {shownPopular.map(({ track, plays }, index) => (
                  <TrackTableRow
                    key={track.Id}
                    track={track}
                    number={index + 1}
                    cover
                    extra={plays ? number.format(plays) : undefined}
                    onPlay={() => music.play(popular.map((entry) => entry.track), index, { source })}
                  />
                ))}
                {popular.length > 5 && (
                  <button type="button" onClick={() => setExpanded(!expanded)} className="mt-3 px-4 text-sm font-bold text-muted-foreground hover:text-foreground">
                    {expanded ? t.showLess : t.showMore}
                  </button>
                )}
              </div>
            </section>
          )}
          <LikedFromArtist artist={item} />
        </div>

        <Discography artistId={item.Id!} albums={albums.data?.albums} tracks={library} loading={albums.isLoading} />

        <ArtistConcerts name={item.Name ?? undefined} />

        {/* About */}
        {(bio || listeners) && (
          <section className="px-4 sm:px-8">
            <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.about}</h2>
            <About artist={item} image={banner ?? photo} listeners={listeners ? t.listeners(number.format(listeners)) : undefined} bio={bio} />
          </section>
        )}

        <MusicRow title={t.appearsOn} items={albums.data?.appearsOn} />
        <SimilarArtists names={lastfm.data?.similar ?? []} self={item.Id} />
      </div>
    </div>
  )
}

type DiscographyFilter = 'popular' | 'albums' | 'singles'

/**
 * Releases in a row with Spotify's three filters (albums have seven or more tracks, singles and EPs up to six); with
 * more than a row's worth, "Show all" leads to every release, with search and sorting.
 */
function Discography({ artistId, albums, tracks, loading }: { artistId: string; albums?: BaseItemDto[]; tracks: BaseItemDto[]; loading: boolean }) {
  const t = useMessages(messages)
  const line = useReleaseLine()
  const [filter, setFilter] = useState<DiscographyFilter>('popular')
  if (!loading && !albums?.length) return null
  const count = (album: BaseItemDto) => album.ChildCount ?? tracks.filter((track) => track.AlbumId === album.Id).length
  const plays = (album: BaseItemDto) => tracks.filter((track) => track.AlbumId === album.Id).reduce((sum, track) => sum + (track.UserData?.PlayCount ?? 0), 0)
  const list = albums ?? []
  const shown =
    filter === 'albums'
      ? list.filter((album) => count(album) > 6)
      : filter === 'singles'
        ? list.filter((album) => count(album) <= 6)
        : // Most played here first, then newest.
          [...list].sort((a, b) => plays(b) - plays(a))
  const filters: Array<{ value: DiscographyFilter; label: string }> = [
    { value: 'popular', label: t.popularReleases },
    { value: 'albums', label: t.albums },
    { value: 'singles', label: t.singles },
  ]
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4 px-4 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">{t.discography}</h2>
        {list.length > 6 && (
          <Link to={`/listen/artist/${artistId}/discography`} className="shrink-0 text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline">
            {t.showAll}
          </Link>
        )}
      </div>
      <div className="flex gap-2 px-4 sm:px-8">
        {filters.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={filter === entry.value}
            onClick={() => setFilter(entry.value)}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm transition-colors',
              filter === entry.value ? 'bg-foreground text-background' : 'bg-foreground/10 text-foreground hover:bg-foreground/20',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <CardRow title="" loading={loading}>
        {shown.slice(0, 12).map((album) => (
          <MusicCard key={album.Id} item={album} subtitle={line(album, tracks)} />
        ))}
      </CardRow>
    </section>
  )
}

/** The about card; as on Spotify, clicking it opens the full "About" popup. */
function About({ artist, image, listeners, bio }: { artist: BaseItemDto; image?: string; listeners?: string; bio?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group block w-full max-w-4xl overflow-hidden rounded-xl bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* As on Spotify: the photo fills the card, listeners and biography sit on it at the bottom left. */}
        <div className={cn('relative w-full overflow-hidden', image ? 'aspect-[3/2] max-h-[32rem]' : 'min-h-40')}>
          {image && (
            <FadeImage src={image} alt="" className="absolute inset-0 size-full object-cover object-[50%_25%] transition-transform duration-500 group-hover:scale-[1.02]" />
          )}
          <div className="absolute inset-0 bg-linear-to-t from-black/85 via-black/25 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 max-w-xl space-y-2 p-6 text-white sm:p-9">
            {listeners && <p className="font-bold">{listeners}</p>}
            {bio && <p className="line-clamp-3 whitespace-pre-line text-sm leading-relaxed text-white/85">{bio}</p>}
          </div>
        </div>
      </button>
      <ArtistAboutDialog artist={artist} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Last.fm's similar artists, as far as the library has them. */
function SimilarArtists({ names, self }: { names: string[]; self?: string }) {
  const t = useMessages(messages)
  const { categories } = useCategories('listen')
  const musicViews = categories.find((category) => category.id === 'music')?.views ?? []
  const artists = useLibraryArtists(musicViews, names.length > 0)
  const similar = names
    .map((name) => artists.data?.find((artist) => sameName(artist.Name, name)))
    .filter((artist): artist is BaseItemDto => !!artist && artist.Id !== self)
  return <MusicRow title={t.fansLike} items={similar} />
}
