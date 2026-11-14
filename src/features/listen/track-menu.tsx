import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { ContextMenu } from '@base-ui/react/context-menu'
import {
  IconCircleCheckFilled,
  IconCirclePlus,
  IconDisc,
  IconDots,
  IconInfoCircle,
  IconLink,
  IconMicrophone,
  IconPlaylistAdd,
  IconPlus,
  IconTextPlus,
  IconTrash,
  IconUser,
} from '@tabler/icons-react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSetFavorite } from '@/features/items/queries'
import { externalOf } from '@/lib/external-items'
import { openSongInfo } from './player/now-playing'
import { toggleSavedEpisode, useEpisodeSaved } from './podcasts'
import { defineMessages, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { artistsOf, itemHref, titlePath } from '@/lib/item-links'
import { music } from './player/music-player'
import { LikedCover } from './playlist-cards'
import { useLikedSongs } from './playlists'
import { usePlaylistActions, usePlaylists } from './playlists'
import { TasteMenuItem } from './taste'
import { useEditablePlaylists } from './profiles'

const messages = defineMessages({
  de: {
    more: (name: string) => `Weitere Optionen für ${name}`,
    addToPlaylist: 'Zur Playlist hinzufügen',
    newPlaylist: 'Neue Playlist',
    newPlaylistName: (n: number) => `Meine Playlist Nr. ${n}`,
    addedTo: (name: string) => `Zu „${name}“ hinzugefügt`,
    addToQueue: 'Zur Warteschlange hinzufügen',
    playNext: 'Als Nächstes abspielen',
    like: 'Zu Favoriten hinzufügen',
    unlike: 'Aus Favoriten entfernen',
    goToAlbum: 'Zum Album',
    goToArtist: 'Zum Künstler',
    removeFromPlaylist: 'Aus dieser Playlist entfernen',
    goToPodcast: 'Zum Podcast',
    saveEpisode: 'Zu deinen Folgen hinzufügen',
    unsaveEpisode: 'Aus deinen Folgen entfernen',
    copyLink: 'Link kopieren',
    songInfo: 'Songinfos',
    linkCopied: 'Link kopiert',
  },
  en: {
    more: (name: string) => `More options for ${name}`,
    addToPlaylist: 'Add to playlist',
    newPlaylist: 'New playlist',
    newPlaylistName: (n: number) => `My Playlist #${n}`,
    addedTo: (name: string) => `Added to "${name}"`,
    addToQueue: 'Add to queue',
    playNext: 'Play next',
    like: 'Add to Favorites',
    unlike: 'Remove from Favorites',
    goToAlbum: 'Go to album',
    goToArtist: 'Go to artist',
    removeFromPlaylist: 'Remove from this playlist',
    goToPodcast: 'Go to podcast',
    saveEpisode: 'Save episode',
    unsaveEpisode: 'Remove from saved episodes',
    copyLink: 'Copy link',
    songInfo: 'Credits',
    linkCopied: 'Link copied',
  },
})

/**
 * Adds a song to Liked Songs right from its row, as in Spotify: a "+" while hovering the row, a filled check once it
 * is liked (which stays visible).
 */
export function LikeToggle({ track, className }: { track: BaseItemDto; className?: string }) {
  const t = useMessages(messages)
  const favorite = useSetFavorite(track.Id ?? '')
  const likedSongs = useLikedSongs()
  const [liked, setLiked] = useState<boolean | null>(null)
  const isLiked = liked ?? (likedSongs.data?.some((song) => song.Id === track.Id) || !!track.UserData?.IsFavorite)
  if (!track.Id || externalOf(track)) return null
  return (
    <button
      type="button"
      aria-label={isLiked ? t.unlike : t.like}
      title={isLiked ? t.unlike : t.like}
      aria-pressed={isLiked}
      onClick={(event) => {
        event.stopPropagation()
        setLiked(!isLiked)
        favorite.mutate(!isLiked)
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        'grid size-6 place-items-center rounded-full outline-none transition-[opacity,scale] hover:scale-110 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
        isLiked ? 'text-listen' : 'text-muted-foreground opacity-0 hover:text-foreground group-hover/track:opacity-100 group-data-popup-open/track:opacity-100',
        className,
      )}
    >
      {isLiked ? <IconCircleCheckFilled className="size-[18px]" /> : <IconCirclePlus className="size-[18px]" />}
    </button>
  )
}

/**
 * What can be done with a track, shared by its "…" button and its right-click menu (as in Spotify): playlists, liked
 * songs, the queue, and the way to its album and artist. Podcast episodes only offer the queue and their show.
 */
export function TrackMenuItems({ track, onRemove, removeLabel, extra }: { track: BaseItemDto; onRemove?: () => void; removeLabel?: string; extra?: ReactNode }) {
  const t = useMessages(messages)
  const navigate = useNavigate()
  const playlists = usePlaylists()
  const actions = usePlaylistActions()
  const external = externalOf(track)
  const episodeSaved = useEpisodeSaved(external?.guid ?? '')
  const favorite = useSetFavorite(track.Id!)
  const [liked, setLiked] = useState<boolean | null>(null)
  const isLiked = liked ?? !!track.UserData?.IsFavorite
  // Only playlists the user may change take new songs (their own, and shared ones they edit).
  const mine = useEditablePlaylists()
  const artist = artistsOf(track)[0]

  const addTo = (playlist: BaseItemDto) => actions.add.mutate({ playlistId: playlist.Id!, ids: [track.Id!], name: t.addedTo(playlist.Name ?? '') })
  const createWith = async () => {
    const id = await actions.create.mutateAsync({ name: t.newPlaylistName((playlists.data?.length ?? 0) + 1), ids: [track.Id!] })
    void navigate(`/listen/playlist/${id}`)
  }

  const queueItems = (
    <>
      <DropdownMenuItem onClick={() => music.addToQueue([track])}>
        <IconPlaylistAdd /> {t.addToQueue}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => music.playNext([track])}>
        <IconTextPlus /> {t.playNext}
      </DropdownMenuItem>
    </>
  )

  if (external)
    return (
      <>
        <DropdownMenuItem onClick={() => toggleSavedEpisode(track)}>
          {episodeSaved ? <IconCircleCheckFilled className="text-listen" /> : <IconCirclePlus />} {episodeSaved ? t.unsaveEpisode : t.saveEpisode}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {queueItems}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigate(`/listen/podcast/${external.podcastId}`)}>
          <IconMicrophone /> {t.goToPodcast}
        </DropdownMenuItem>
      </>
    )

  return (
    <>
      {/* What the list itself adds for this row (a mixer playlist: its transition into the next song). */}
      {extra && (
        <>
          {extra}
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <IconPlus /> {t.addToPlaylist}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
          <DropdownMenuItem onClick={() => void createWith()}>
            <IconPlus /> {t.newPlaylist}
          </DropdownMenuItem>
          {mine.length > 0 && <DropdownMenuSeparator />}
          {mine.map((playlist) => (
            <DropdownMenuItem key={playlist.Id} onClick={() => addTo(playlist)}>
              <span className="truncate">{playlist.Name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {onRemove && (
        <DropdownMenuItem onClick={onRemove}>
          <IconTrash /> {removeLabel ?? t.removeFromPlaylist}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => {
          setLiked(!isLiked)
          favorite.mutate(!isLiked)
        }}
      >
        {/* The Favorites' own cover as the icon. */}
        <LikedCover className="size-4 shrink-0 rounded-[3px] [&_svg]:size-2.5!" /> {isLiked ? t.unlike : t.like}
      </DropdownMenuItem>
      <TasteMenuItem kind="tracks" id={track.Id} />
      <DropdownMenuSeparator />
      {queueItems}
      <DropdownMenuSeparator />
      {artist?.id && (
        <DropdownMenuItem onClick={() => void navigate(titlePath('MusicArtist', artist.id!))}>
          <IconUser /> {t.goToArtist}
        </DropdownMenuItem>
      )}
      {track.AlbumId && (
        <DropdownMenuItem onClick={() => void navigate(itemHref(track))}>
          <IconDisc /> {t.goToAlbum}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => openSongInfo(track)}>
        <IconInfoCircle /> {t.songInfo}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void copyLink(track, t.linkCopied)}>
        <IconLink /> {t.copyLink}
      </DropdownMenuItem>
    </>
  )
}

/** Copies the address of the track's album page, where the track can be played. */
async function copyLink(track: BaseItemDto, done: string) {
  try {
    await navigator.clipboard.writeText(new URL(itemHref(track), window.location.origin).toString())
    toast.success(done)
  } catch {
    // The clipboard isn't available (insecure context or denied); nothing to report beyond not copying.
  }
}

/** The "…" of a track. */
export function TrackMenu({
  track,
  onRemove,
  removeLabel,
  visible,
  extra,
}: {
  track: BaseItemDto
  onRemove?: () => void
  removeLabel?: string
  visible?: boolean
  /** Items of the list the row is in, on top of the menu. */
  extra?: ReactNode
}) {
  const t = useMessages(messages)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t.more(track.Name ?? '')}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-opacity hover:text-foreground',
          // Fingers can't hover: always there.
          visible ? 'hover:bg-muted' : 'opacity-0 focus-visible:opacity-100 group-hover/track:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100',
        )}
      >
        <IconDots className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" onClick={(event) => event.stopPropagation()}>
        <TrackMenuItems track={track} onRemove={onRemove} removeLabel={removeLabel} extra={extra} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Right-clicking `children` (a track row, rendered as the trigger itself) opens the track's menu at the pointer.
 * Long-pressing does the same on touch screens.
 */
export function TrackContextMenu({
  track,
  onRemove,
  removeLabel,
  extra,
  children,
}: {
  track: BaseItemDto
  onRemove?: () => void
  /** What removing means here ("Remove from queue"); a playlist's own entries by default. */
  removeLabel?: string
  /** Items of the list the row is in, on top of the menu. */
  extra?: ReactNode
  children: ReactElement
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <DropdownMenuContent className="w-64" onClick={(event) => event.stopPropagation()}>
        <TrackMenuItems track={track} onRemove={onRemove} removeLabel={removeLabel} extra={extra} />
      </DropdownMenuContent>
    </ContextMenu.Root>
  )
}
