import { IconMicrophone, IconMicrophone2, IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { useItem, useNewestArtists } from '@/features/items/queries'
import { useCategories } from '@/features/library/categories'
import { markAppReady } from '@/lib/boot'
import { defineMessages, useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { itemHref } from '@/lib/item-links'
import { cn } from '@/lib/utils'
import { CardRow, MusicRow, usePlayCollection } from './music-card'
import { FollowedPodcastsRow } from './podcast-pages'
import { useOfficialPlaylist, useOfficialPlaylists, type OfficialPlaylist } from './official'
import { playCircle } from './play-circle'
import { music, START } from './player/music-player'
import { useNowPlaying } from './player/player-controls'
import { LikedCover, OfficialCard, OfficialCover, PlaylistCard, PlaylistCover } from './playlist-cards'
import { useFollowedArtists, useLikedSongs, usePlaylists, usePlaylistTracks } from './playlists'
import { usePodcast } from './podcasts'
import { useListeningStats } from './profiles'
import { useLumioFetch } from '@/features/social/social'
import { tasteSignalsQuery } from './taste-model'
import { RadioCard } from './radio-card'
import { useRecentSources } from './recent'
import { useNewestAlbums, useRecentAlbums } from './queries'
import { ContextMenu } from '@base-ui/react/context-menu'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { AlbumMenuItems, ArtistMenuItems, FixedMenuItems, OfficialMenuItems, PlaylistMenuItems, PodcastMenuItems } from './library-menu'
import { WrappedBanner } from './wrapped/wrapped-banner'

const messages = defineMessages({
  de: {
    morning: 'Guten Morgen',
    day: 'Guten Tag',
    evening: 'Guten Abend',
    night: 'Gute Nacht',
    liked: 'Favoriten',
    play: (name: string) => `${name} abspielen`,
    pause: (name: string) => `${name} pausieren`,
    recent: 'Zuletzt gehört',
    radios: 'Radio-Sender für dich',
    forYou: 'Für dich gemacht',
    mixes: 'Deine Mixe',
    moods: 'Für jede Stimmung',
    tags: 'Nach Tags',
    fromLibrary: 'Aus der Bibliothek',
    yourPlaylists: 'Deine Playlists',
    newAlbums: 'Neue Alben',
    topArtists: 'Deine meistgehörten Künstler',
    followedArtists: 'Künstler, denen du folgst',
    newArtists: 'Neu in der Bibliothek',
    audiobooks: 'Hörbücher',
  },
  en: {
    morning: 'Good morning',
    day: 'Good afternoon',
    evening: 'Good evening',
    night: 'Good night',
    liked: 'Favorites',
    play: (name: string) => `Play ${name}`,
    pause: (name: string) => `Pause ${name}`,
    recent: 'Recently played',
    radios: 'Radio stations for you',
    forYou: 'Made for you',
    mixes: 'Your mixes',
    moods: 'For every mood',
    tags: 'By tag',
    fromLibrary: 'From the library',
    yourPlaylists: 'Your playlists',
    newAlbums: 'New albums',
    topArtists: 'Your most played artists',
    followedArtists: 'Artists you follow',
    newArtists: 'New in the library',
    audiobooks: 'Audiobooks',
  },
})

/** The part of the day the greeting is for. */
function dayPart(hour: number): 'morning' | 'day' | 'evening' | 'night' {
  return hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'day' : hour >= 17 && hour < 22 ? 'evening' : 'night'
}

/** "Good morning" to "Good night" by the clock, switching over while the page stays open. */
function useGreeting(t: (typeof messages)['de']) {
  const [part, setPart] = useState(() => dayPart(new Date().getHours()))
  useEffect(() => {
    const timer = window.setInterval(() => setPart(dayPart(new Date().getHours())), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return t[part]
}

/** The made-for-you kinds of official playlists (the first row). */
const FOR_YOU = new Set<OfficialPlaylist['kind']>(['daylist', 'daily', 'month', 'discover', 'phase', 'radar', 'rediscover', 'top'])

/** How many tiles the greeting grid holds. */
const QUICK_TILES = 8
/** What the grid can show. */
const QUICK_KINDS = /^(album|artist|playlist|official|liked|podcast)(:|$)/
/** Played from for at least this many (faded) minutes lately to count as heavy rotation. */
const HEAVY_MINUTES = 10

/**
 * The greeting grid: half of it the last things played from, the rest what was played from a lot lately (heavy
 * rotation, by minutes listened over the last weeks), topped up with more recent ones. Ordered by both: the latest
 * and the most played lead.
 */
function quickPicks(recent: string[], heavy: Record<string, { w: number; t: number }> | undefined, fallback: string[]) {
  const picks: string[] = []
  const add = (source: string) => {
    if (picks.length < QUICK_TILES && QUICK_KINDS.test(source) && !picks.includes(source)) picks.push(source)
  }
  const rotation = Object.entries(heavy ?? {})
    .filter(([, entry]) => entry.w >= HEAVY_MINUTES)
    .sort((a, b) => b[1].w - a[1].w)
    .map(([source]) => source)
  for (const source of recent.slice(0, QUICK_TILES / 2)) add(source)
  for (const source of rotation) add(source)
  for (const source of [...recent, ...fallback]) add(source)
  const most = Math.max(1, ...picks.map((source) => heavy?.[source]?.w ?? 0))
  const score = (source: string) => {
    const index = recent.indexOf(source)
    return (index < 0 ? 0 : 0.5 ** (index / 2)) + (heavy?.[source]?.w ?? 0) / most
  }
  return picks.map((source) => ({ source, score: score(source) })).sort((a, b) => b.score - a.score).map((pick) => pick.source)
}

/** Listen's start page: a greeting with quick access to what was played last, then rows of music and audiobooks. */
export function ListenHome() {
  const t = useMessages(messages)
  const { categories } = useCategories('listen')
  const musicViews = categories.find((category) => category.id === 'music')?.views ?? []
  const bookViews = categories.find((category) => category.id === 'audiobooks')?.views ?? []
  const recent = useRecentAlbums()
  const newest = useNewestAlbums(musicViews)
  const audiobooks = useNewestAlbums(bookViews)
  const official = useOfficialPlaylists()
  const forYou = official.playlists.filter((playlist) => FOR_YOU.has(playlist.kind))
  const mixes = official.playlists.filter((playlist) => playlist.kind === 'genre' || playlist.kind === 'decade')
  const moods = official.playlists.filter((playlist) => playlist.kind === 'mood')
  const tags = official.playlists.filter((playlist) => playlist.kind === 'tag')
  // The newest songs, the charts and a few "Best of" (the charts first: they are rarer).
  const fromLibrary = [
    ...official.playlists.filter((playlist) => playlist.kind === 'new' || playlist.kind === 'chart'),
    ...official.playlists.filter((playlist) => playlist.kind === 'artist'),
  ]
  const playlists = usePlaylists()
  const greeting = useGreeting(t)
  const stats = useListeningStats()
  const followed = useFollowedArtists()
  const topArtists = stats.data?.topArtists ?? []
  const followedArtists = followed.data ?? []
  // The artists row is about the user: who they listen to most (last 30 days), else whom they follow; only someone
  // who has neither yet gets the artists newest to the library.
  const artistsRow = topArtists.length >= 3 ? 'top' : followedArtists.length ? 'followed' : 'new'
  const newestArtists = useNewestArtists(musicViews, !stats.isLoading && !followed.isLoading && artistsRow === 'new')
  const rowArtists = artistsRow === 'top' ? topArtists : artistsRow === 'followed' ? followedArtists : newestArtists.data
  const rowTitle = artistsRow === 'top' ? t.topArtists : artistsRow === 'followed' ? t.followedArtists : t.newArtists
  // Radios around the artists listened to most lately (or followed).
  const radioArtists = (topArtists.length ? topArtists : followedArtists).slice(0, 8)
  // The grid: what was played from most recently and what was played a lot lately, topped up with recent albums.
  const sources = useRecentSources()
  const { session } = useAuthedSession()
  const lumioFetch = useLumioFetch()
  const signals = useQuery(tasteSignalsQuery(session.userId, (path) => lumioFetch(path)))
  const quick = quickPicks(sources, signals.data?.sources, (recent.data ?? []).map((album) => `album:${album.Id}`))

  useEffect(() => {
    if (!recent.isLoading) markAppReady()
  }, [recent.isLoading])

  return (
    <div className="relative isolate space-y-10 pb-12 pt-20">
      <MoodGradient />
      <section className="space-y-4 px-4 sm:px-8">
        <h1 className="text-3xl font-extrabold tracking-tight">{greeting}</h1>
        {/* Like Spotify's top grid: the last few things played, one click away. */}
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {recent.isLoading
            ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-14 rounded-md" />)
            : quick.map((source) => <QuickTile key={source} source={source} />)}
        </div>
        <WrappedBanner />
      </section>
      {/* The platform's own playlists (made for the listener first), then the user's. */}
      {(official.isLoading || forYou.length > 0) && (
        <CardRow title={t.forYou} loading={official.isLoading}>
          {forYou.map((playlist) => (
            <OfficialCard key={playlist.slug} playlist={playlist} />
          ))}
        </CardRow>
      )}
      {!!moods.length && (
        <CardRow title={t.moods}>
          {moods.map((playlist) => (
            <OfficialCard key={playlist.slug} playlist={playlist} />
          ))}
        </CardRow>
      )}
      {!!mixes.length && (
        <CardRow title={t.mixes}>
          {mixes.slice(0, 12).map((playlist) => (
            <OfficialCard key={playlist.slug} playlist={playlist} />
          ))}
        </CardRow>
      )}
      <MusicRow title={t.recent} items={recent.data} loading={recent.isLoading} />
      {!!radioArtists.length && (
        <CardRow title={t.radios}>
          {radioArtists.map((artist) => (
            <RadioCard key={artist.Id} artist={artist} />
          ))}
        </CardRow>
      )}
      {!!playlists.data?.length && (
        <CardRow title={t.yourPlaylists}>
          {playlists.data.map((playlist) => (
            <PlaylistCard key={playlist.Id} playlist={playlist} />
          ))}
        </CardRow>
      )}
      <MusicRow title={t.newAlbums} items={newest.data} loading={newest.isLoading && musicViews.length > 0} />
      {!!tags.length && (
        <CardRow title={t.tags}>
          {tags.slice(0, 12).map((playlist) => (
            <OfficialCard key={playlist.slug} playlist={playlist} />
          ))}
        </CardRow>
      )}
      {!!fromLibrary.length && (
        <CardRow title={t.fromLibrary}>
          {fromLibrary.slice(0, 12).map((playlist) => (
            <OfficialCard key={playlist.slug} playlist={playlist} />
          ))}
        </CardRow>
      )}
      <MusicRow title={rowTitle} items={rowArtists} loading={stats.isLoading || followed.isLoading || (artistsRow === 'new' && newestArtists.isLoading && musicViews.length > 0)} />
      <FollowedPodcastsRow />
      <MusicRow title={t.audiobooks} items={audiobooks.data} loading={audiobooks.isLoading && bookViews.length > 0} />
    </div>
  )
}

/** One tile of the greeting grid, for whatever kind of collection it stands for (`source` as the player keys it). */
function QuickTile({ source }: { source: string }) {
  const [kind, id = ''] = source.split(/:(.*)/s)
  if (kind === 'album' || kind === 'artist') return <ItemTile id={id} source={source} />
  if (kind === 'playlist') return <PlaylistTile id={id} source={source} />
  if (kind === 'official') return <OfficialTile slug={id} source={source} />
  if (kind === 'liked') return <LikedTile source={source} />
  if (kind === 'podcast') return <PodcastTile id={id} source={source} />
  return null
}

function ItemTile({ id, source }: { id: string; source: string }) {
  const { api } = useAuthedSession()
  const item = useItem(id).data
  const play = usePlayCollection()
  if (!item) return null
  const cover = portraitImageUrl(api, item, { fillHeight: 120 })
  return (
    <TileShell
      href={itemHref(item)}
      title={item.Name ?? ''}
      source={source}
      round={item.Type === 'MusicArtist'}
      menu={item.Type === 'MusicArtist' ? <ArtistMenuItems artist={item} /> : item.Type === 'MusicAlbum' ? <AlbumMenuItems album={item} /> : undefined}
      onPlay={() => void play(item)}
      cover={
        cover ? (
          <FadeImage src={cover} alt="" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-muted-foreground">
            <IconMicrophone2 className="size-1/2" stroke={1.5} />
          </span>
        )
      }
    />
  )
}

function PlaylistTile({ id, source }: { id: string; source: string }) {
  const playlist = useItem(id).data
  const tracks = usePlaylistTracks(id)
  if (!playlist) return null
  return (
    <TileShell
      href={`/listen/playlist/${id}`}
      title={playlist.Name ?? ''}
      source={source}
      menu={<PlaylistMenuItems playlist={playlist} />}
      onPlay={() => music.play(tracks.data ?? [], START, { source })}
      cover={<PlaylistCover playlist={playlist} tracks={tracks.data ?? []} />}
    />
  )
}

function OfficialTile({ slug, source }: { slug: string; source: string }) {
  const { playlist } = useOfficialPlaylist(slug)
  if (!playlist) return null
  return (
    <TileShell
      href={`/listen/official/${slug}`}
      title={playlist.title}
      source={source}
      menu={<OfficialMenuItems playlist={playlist} />}
      onPlay={() => music.play(playlist.tracks, START, { source })}
      cover={<OfficialCover playlist={playlist} />}
    />
  )
}

function LikedTile({ source }: { source: string }) {
  const t = useMessages(messages)
  const liked = useLikedSongs()
  return (
    <TileShell
      href="/listen/liked"
      title={t.liked}
      source={source}
      onPlay={() => music.play(liked.data ?? [], START, { source })}
      cover={<LikedCover />}
      menu={<FixedMenuItems entry="liked" path="/listen/liked" />}
    />
  )
}

function PodcastTile({ id, source }: { id: string; source: string }) {
  const podcast = usePodcast(id).data
  if (!podcast) return null
  const latest = podcast.episodes[0]
  return (
    <TileShell
      href={`/listen/podcast/${id}`}
      title={podcast.podcast.name}
      source={source}
      menu={<PodcastMenuItems podcastId={id} />}
      onPlay={() => latest && music.play([latest.item], START, { source })}
      cover={
        podcast.podcast.image ? (
          <FadeImage src={podcast.podcast.image} alt="" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-muted-foreground">
            <IconMicrophone className="size-1/2" stroke={1.5} />
          </span>
        )
      }
    />
  )
}

/**
 * The tile itself, as in Spotify's greeting grid: cover, name, and a play button that shows on hover (and stays while
 * this collection plays); the name turns green while it plays.
 */
function TileShell({
  href,
  title,
  cover,
  source,
  round,
  onPlay,
  menu,
}: {
  href: string
  title: string
  cover: ReactNode
  source: string
  round?: boolean
  onPlay: () => void
  /** Its right-click menu. */
  menu?: ReactNode
}) {
  const t = useMessages(messages)
  const state = useNowPlaying()
  const here = state.source === source
  const playing = here && state.playing
  const tile = (
    <div className="group relative flex h-14 items-center gap-3 overflow-hidden rounded-md bg-foreground/[0.08] pr-2 transition-colors hover:bg-foreground/[0.16] data-popup-open:bg-foreground/[0.16] max-md:h-12 max-md:gap-2">
      <Link to={href} className="flex h-full min-w-0 flex-1 items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:gap-2">
        <span className={cn('aspect-square h-full shrink-0 overflow-hidden bg-muted', round && 'scale-[0.8] rounded-full')}>{cover}</span>
        {/* Two in a row on phones: the name may take two lines. */}
        <span className={cn('truncate text-sm font-semibold max-md:line-clamp-2 max-md:whitespace-normal max-md:text-xs max-md:leading-tight', here && 'text-listen')}>{title}</span>
      </Link>
      <button
        type="button"
        aria-label={playing ? t.pause(title) : t.play(title)}
        onClick={() => (here ? state.toggle() : onPlay())}
        className={cn(
          playCircle.listen,
          'size-8 shrink-0 shadow-lg shadow-black/40 transition-opacity',
          // Fingers can't hover: there it only shows while this plays (tapping the tile opens it).
          playing ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:hidden',
        )}
      >
        {playing ? <IconPlayerPauseFilled className="size-4" /> : <IconPlayerPlayFilled className="size-4 translate-x-px" />}
      </button>
    </div>
  )
  if (!menu) return tile
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={tile} />
      <DropdownMenuContent className="w-60">{menu}</DropdownMenuContent>
    </ContextMenu.Root>
  )
}

/** The colours the start page's glow takes turns with: one for every six hours, the same for everyone at a time. */
const MOOD_HUES = [295, 250, 200, 160, 25, 340, 80]
const MOOD_PERIOD_MS = 6 * 60 * 60_000

/**
 * A soft glow of colour at the top of the start page that fades into the panel, as in Spotify; it changes every six
 * hours, so the page feels a little different at each part of the day.
 */
function MoodGradient() {
  const [hue] = useState(() => MOOD_HUES[Math.floor(Date.now() / MOOD_PERIOD_MS) % MOOD_HUES.length]!)
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[26rem] [--mood:oklch(0.82_0.1_var(--hue))] dark:[--mood:oklch(0.36_0.11_var(--hue))]"
      style={{
        ['--hue' as string]: hue,
        background: 'linear-gradient(to bottom, color-mix(in oklch, var(--mood) 60%, var(--background)), var(--background))',
      }}
    />
  )
}
