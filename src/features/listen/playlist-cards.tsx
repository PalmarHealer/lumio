import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { IconBookmarkFilled, IconHeartFilled, IconMusic } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { FadeImage } from '@/components/media/fade-image'
import { useAuthedSession } from '@/features/auth/session'
import { useBranding } from '@/features/admin/branding'
import { defineMessages, useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { cn } from '@/lib/utils'
import { OfficialMenuItems, PlaylistMenuItems } from './library-menu'
import { CardShell } from './music-card'
import type { OfficialPlaylist } from './official'
import { coverFontsReady, drawCover, type CoverStyle } from './official-covers'
import { music, START, useMusic } from './player/music-player'
import { hasCustomCover, mosaicSources, usePlaylistTracks } from './playlists'
import { RadioCover } from './radio-card'

const messages = defineMessages({
  de: {
    liked: 'Favoriten',
    songs: (n: number) => (n === 1 ? '1 Song' : `${n} Songs`),
    playlistBy: (owner: string) => `Playlist · ${owner}`,
    playlist: 'Playlist',
    thisIs: 'Best of',
    forYou: 'Aus deiner Bibliothek',
    charts: 'Charts',
  },
  en: {
    liked: 'Favorites',
    songs: (n: number) => (n === 1 ? '1 song' : `${n} songs`),
    playlistBy: (owner: string) => `Playlist · ${owner}`,
    playlist: 'Playlist',
    thisIs: 'Best of',
    forYou: 'From your library',
    charts: 'Charts',
  },
})

export const playlistCardMessages = messages

/** The cover of a playlist without its own image: the first four album covers in a square, like Spotify makes them. */
export function MosaicCover({ tracks, className }: { tracks: BaseItemDto[]; className?: string }) {
  const { api } = useAuthedSession()
  const sources = mosaicSources(tracks)
  if (sources.length === 0) {
    return (
      <div className={cn('grid size-full place-items-center bg-muted text-muted-foreground', className)}>
        <IconMusic className="size-1/3" stroke={1.25} />
      </div>
    )
  }
  // Fewer than four different albums: one cover is cleaner than a half-empty grid.
  if (sources.length < 4) {
    const url = portraitImageUrl(api, sources[0]!, { fillHeight: 360 })
    return url ? <FadeImage src={url} alt="" className={cn('size-full object-cover', className)} /> : null
  }
  return (
    <div className={cn('grid size-full grid-cols-2 grid-rows-2', className)}>
      {sources.map((track) => {
        const url = portraitImageUrl(api, track, { fillHeight: 180 })
        return url ? <FadeImage key={track.Id} src={url} alt="" className="size-full object-cover" /> : <div key={track.Id} className="bg-muted" />
      })}
    </div>
  )
}

/**
 * A Jellyfin playlist's cover: the picture chosen for it, else the mosaic of its first four albums (kept up to date
 * as songs are added, unlike the collage Jellyfin makes once).
 */
export function PlaylistCover({ playlist, tracks, className }: { playlist: BaseItemDto; tracks: BaseItemDto[]; className?: string }) {
  const { api } = useAuthedSession()
  const own = hasCustomCover(playlist) ? portraitImageUrl(api, playlist, { fillHeight: 360 }) : undefined
  if (own) return <FadeImage src={own} alt="" className={cn('size-full object-cover', className)} />
  return <MosaicCover tracks={tracks} className={className} />
}

/**
 * The cover of an official playlist, drawn after the Cover-Werkstatt designs (see `official-covers.ts`): genre mixes,
 * "This is …" and the made-for-you playlists each have their own style, the same within each kind. The corner dot
 * carries the platform account's picture, or its initial without one.
 */
export function OfficialCover({ playlist, className }: { playlist: OfficialPlaylist; className?: string }) {
  // Radios have their own cover (the artist with similar ones around).
  if (playlist.kind === 'radio' && playlist.artist) return <RadioCover artist={playlist.artist} className={className} />
  return <DrawnCover playlist={playlist} className={className} />
}

function DrawnCover({ playlist, className }: { playlist: OfficialPlaylist; className?: string }) {
  const { api } = useAuthedSession()
  const { appName, avatar } = useBranding('listen')
  const t = useMessages(messages)
  const canvas = useRef<HTMLCanvasElement>(null)
  // The artist is known only by id here (no image tags): asked for straight away; a missing photo leaves the gradient.
  // Charts show their number one's cover.
  const leader = playlist.kind === 'chart' ? playlist.tracks[0] : undefined
  const photoUrl = playlist.artist?.Id
    ? `${api.basePath}/Items/${playlist.artist.Id}/Images/Primary?fillHeight=720&quality=90`
    : leader
      ? portraitImageUrl(api, leader, { fillHeight: 720 })
      : undefined
  const style: CoverStyle = playlist.kind === 'genre' ? 'mix' : playlist.kind === 'artist' ? 'foto' : playlist.kind === 'chart' ? 'block' : 'stimmung'
  const title = playlist.kind === 'artist' ? (playlist.artist?.Name ?? playlist.title) : playlist.kind === 'chart' ? t.charts : playlist.title
  const subtitle =
    playlist.kind === 'artist' ? t.thisIs : playlist.kind === 'genre' ? undefined : playlist.kind === 'chart' ? playlist.title.replace(/^Charts\s*/, '') : t.forYou

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let cancelled = false
    let photo: HTMLImageElement | null = null
    let markImage: HTMLImageElement | null = null
    const draw = () => {
      if (cancelled || !element.clientWidth) return
      // Sharp on high-density screens, never bigger than the design grid.
      const size = Math.min(1080, Math.round(element.clientWidth * window.devicePixelRatio))
      if (element.width !== size) element.width = element.height = size
      drawCover(element, { style, seed: playlist.slug, title, subtitle, mark: appName, markImage, photo })
    }
    void coverFontsReady().then(draw)
    if (photoUrl) {
      const image = new Image()
      image.onload = () => {
        photo = image
        void coverFontsReady().then(draw)
      }
      image.src = photoUrl
    }
    if (avatar) {
      const image = new Image()
      image.onload = () => {
        markImage = image
        void coverFontsReady().then(draw)
      }
      image.src = avatar
    }
    const observer = new ResizeObserver(() => void coverFontsReady().then(draw))
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [style, playlist.slug, title, subtitle, appName, avatar, photoUrl])

  return <canvas ref={canvas} role="img" aria-label={playlist.title} className={cn('block size-full', className)} />
}

/** The saved episodes tile: Lumio's own deep blue to cyan with a white bookmark. */
export function SavedEpisodesCover({ className }: { className?: string }) {
  return (
    <div className={cn('grid size-full place-items-center bg-linear-to-br from-blue-900 via-sky-700 to-cyan-400', className)}>
      <IconBookmarkFilled className="size-[38%] text-white drop-shadow" />
    </div>
  )
}

/** The Favorites tile: Lumio's own warm pink to amber with a white heart. */
export function LikedCover({ className }: { className?: string }) {
  return (
    <div className={cn('grid size-full place-items-center bg-linear-to-br from-fuchsia-700 via-pink-500 to-amber-300', className)}>
      <IconHeartFilled className="size-[38%] text-white drop-shadow" />
    </div>
  )
}

function usePlayingSource(source: string) {
  const state = useMusic()
  const here = state.source === source && state.index >= 0
  return { here, playing: here && state.playing }
}

export function PlaylistCard({ playlist }: { playlist: BaseItemDto }) {
  const t = useMessages(messages)
  const tracks = usePlaylistTracks(playlist.Id ?? undefined)
  const source = `playlist:${playlist.Id}`
  const { here, playing } = usePlayingSource(source)
  return (
    <CardShell
      href={`/listen/playlist/${playlist.Id}`}
      menu={<PlaylistMenuItems playlist={playlist} />}
      title={playlist.Name ?? ''}
      subtitle={t.songs(tracks.data?.length ?? playlist.ChildCount ?? 0)}
      here={here}
      playing={playing}
      onPlay={() => music.play(tracks.data ?? [], START, { source })}
      cover={<PlaylistCover playlist={playlist} tracks={tracks.data ?? []} />}
    />
  )
}

export function OfficialCard({ playlist }: { playlist: OfficialPlaylist }) {
  const source = `official:${playlist.slug}`
  const { here, playing } = usePlayingSource(source)
  return (
    <CardShell
      href={`/listen/official/${playlist.slug}`}
      menu={<OfficialMenuItems playlist={playlist} />}
      title={playlist.title}
      subtitle={playlist.description}
      here={here}
      playing={playing}
      onPlay={() => music.play(playlist.tracks, START, { source })}
      cover={<OfficialCover playlist={playlist} />}
    />
  )
}
