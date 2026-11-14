import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconCircleCheckFilled,
  IconCirclePlus,
  IconFolder,
  IconFolderPlus,
  IconLink,
  IconPencil,
  IconPinned,
  IconPinnedOff,
  IconPlaylistAdd,
  IconPlus,
  IconRadio,
  IconTrash,
  IconUserMinus,
  IconUserPlus,
} from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import { useAuthedSession } from '@/features/auth/session'
import { albumTracksOptions, useSetFavorite } from '@/features/items/queries'
import { useSocialFollow } from '@/features/social/social'
import { defineMessages, useMessages } from '@/lib/i18n'
import type { OfficialPlaylist } from './official'
import { music } from './player/music-player'
import { useFollowedArtists, useListenLibrary, usePlaylistActions, usePlaylists, usePlaylistTracks, useSavedAlbums } from './playlists'
import { TasteMenuItem } from './taste'
import { useEditablePlaylists } from './profiles'
import { useHeldByDownload } from './download-ui'

const messages = defineMessages({
  de: {
    unfollow: 'Nicht mehr folgen',
    follow: 'Folgen',
    addToLibrary: 'Zur Bibliothek hinzufügen',
    radio: 'Zum Künstler*innen-Radio',
    pin: 'Anheften',
    unpin: 'Lösen',
    moveToFolder: 'In Ordner verschieben',
    newFolder: 'Neuer Ordner',
    removeFromFolder: 'Aus Ordner entfernen',
    folderName: (n: number) => (n === 1 ? 'Neuer Ordner' : `Neuer Ordner ${n}`),
    copyLink: 'Link kopieren',
    linkCopied: 'Link kopiert',
    removeFromLibrary: 'Aus Bibliothek entfernen',
    addToQueue: 'Zur Warteschlange hinzufügen',
    addToPlaylist: 'Zu Playlist hinzufügen',
    addToOtherPlaylist: 'Zu einer anderen Playlist hinzufügen',
    newPlaylist: 'Neue Playlist',
    newPlaylistName: (n: number) => `Meine Playlist Nr. ${n}`,
    createPlaylist: 'Playlist erstellen',
    createFolder: 'Ordner erstellen',
    addedTo: (name: string) => `Zu „${name}“ hinzugefügt`,
    rename: 'Umbenennen',
    deleteFolder: 'Ordner löschen',
  },
  en: {
    unfollow: 'Unfollow',
    follow: 'Follow',
    addToLibrary: 'Add to library',
    radio: 'Go to artist radio',
    pin: 'Pin',
    unpin: 'Unpin',
    moveToFolder: 'Move to folder',
    newFolder: 'New folder',
    removeFromFolder: 'Remove from folder',
    folderName: (n: number) => (n === 1 ? 'New folder' : `New folder ${n}`),
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    removeFromLibrary: 'Remove from library',
    addToQueue: 'Add to queue',
    addToPlaylist: 'Add to playlist',
    addToOtherPlaylist: 'Add to other playlist',
    newPlaylist: 'New playlist',
    newPlaylistName: (n: number) => `My Playlist #${n}`,
    createPlaylist: 'Create playlist',
    createFolder: 'Create folder',
    addedTo: (name: string) => `Added to "${name}"`,
    rename: 'Rename',
    deleteFolder: 'Delete folder',
  },
})

export const libraryMenuMessages = messages

async function copyLink(path: string, done: string) {
  try {
    await navigator.clipboard.writeText(new URL(path, window.location.origin).toString())
    toast.success(done)
  } catch {
    // No clipboard here.
  }
}

/** Pin, folder and link: what every entry of the library offers (pin and folder only once it is in the library). */
function CommonItems({ entry, path, inLibrary = true }: { entry: string; path: string; inLibrary?: boolean }) {
  const t = useMessages(messages)
  const library = useListenLibrary()
  const pinned = library.isPinned(entry)
  const current = library.folderOf(entry)
  if (!inLibrary)
    return (
      <DropdownMenuItem onClick={() => void copyLink(path, t.linkCopied)}>
        <IconLink /> {t.copyLink}
      </DropdownMenuItem>
    )
  return (
    <>
      <DropdownMenuItem onClick={() => library.togglePin(entry)}>
        {pinned ? <IconPinnedOff /> : <IconPinned />} {pinned ? t.unpin : t.pin}
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <IconFolder /> {t.moveToFolder}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
          <DropdownMenuItem onClick={() => library.createFolder(t.folderName(library.folders.length + 1), entry)}>
            <IconFolderPlus /> {t.newFolder}
          </DropdownMenuItem>
          {library.folders.length > 0 && <DropdownMenuSeparator />}
          {library.folders.map((folder) => (
            <DropdownMenuItem key={folder.id} disabled={folder.id === current} onClick={() => library.moveToFolder(entry, folder.id)}>
              <span className="truncate">{folder.name}</span>
            </DropdownMenuItem>
          ))}
          {current && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => library.moveToFolder(entry, null)}>{t.removeFromFolder}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => void copyLink(path, t.linkCopied)}>
        <IconLink /> {t.copyLink}
      </DropdownMenuItem>
    </>
  )
}

/** "Add to playlist ▸": the user's playlists and a new one, for a list of tracks. */
/** "Add to playlist" as a submenu: a new playlist with these songs, or one of the user's own. */
export function AddToPlaylist({ tracks, label, exclude }: { tracks: () => Promise<BaseItemDto[]>; label: string; exclude?: string }) {
  const t = useMessages(messages)
  const navigate = useNavigate()
  const playlists = usePlaylists()
  const actions = usePlaylistActions()
  // Own playlists and shared ones the user edits.
  const mine = useEditablePlaylists().filter((playlist) => playlist.Id !== exclude)
  const add = async (playlist: BaseItemDto) => {
    const ids = (await tracks()).map((track) => track.Id!).filter(Boolean)
    if (ids.length) actions.add.mutate({ playlistId: playlist.Id!, ids, name: t.addedTo(playlist.Name ?? '') })
  }
  const create = async () => {
    const ids = (await tracks()).map((track) => track.Id!).filter(Boolean)
    const id = await actions.create.mutateAsync({ name: t.newPlaylistName((playlists.data?.length ?? 0) + 1), ids })
    void navigate(`/listen/playlist/${id}`)
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <IconPlus /> {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuItem onClick={() => void create()}>
          <IconPlus /> {t.newPlaylist}
        </DropdownMenuItem>
        {mine.length > 0 && <DropdownMenuSeparator />}
        {mine.map((playlist) => (
          <DropdownMenuItem key={playlist.Id} onClick={() => void add(playlist)}>
            <span className="truncate">{playlist.Name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function ArtistMenuItems({ artist }: { artist: BaseItemDto }) {
  const t = useMessages(messages)
  const favorite = useSetFavorite(artist.Id!)
  const navigate = useNavigate()
  const followed = useFollowedArtists().data?.some((other) => other.Id === artist.Id) ?? !!artist.UserData?.IsFavorite
  return (
    <>
      <DropdownMenuItem onClick={() => favorite.mutate(!followed)}>
        {followed ? <IconUserMinus /> : <IconUserPlus />} {followed ? t.unfollow : t.follow}
      </DropdownMenuItem>
      {/* Opens the radio like a playlist (play it from there). */}
      <DropdownMenuItem onClick={() => void navigate(`/listen/official/radio-${artist.Id}`)}>
        <IconRadio /> {t.radio}
      </DropdownMenuItem>
      <TasteMenuItem kind="artists" id={artist.Id} />
      <DropdownMenuSeparator />
      <CommonItems entry={`artist:${artist.Id}`} path={`/listen/artist/${artist.Id}`} inLibrary={followed} />
    </>
  )
}

export function AlbumMenuItems({ album }: { album: BaseItemDto }) {
  const t = useMessages(messages)
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const favorite = useSetFavorite(album.Id!)
  const tracks = () => queryClient.fetchQuery(albumTracksOptions(api, session.userId, album.Id!))
  const saved = useSavedAlbums().data?.some((other) => other.Id === album.Id) ?? !!album.UserData?.IsFavorite
  const hold = useHeldByDownload(`album:${album.Id}`)
  return (
    <>
      <DropdownMenuItem disabled={saved && hold.held} title={saved && hold.held ? hold.hint : undefined} onClick={() => favorite.mutate(!saved)}>
        {saved ? <IconCircleCheckFilled className="text-listen" /> : <IconCirclePlus />} {saved ? t.removeFromLibrary : t.addToLibrary}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() =>
          void tracks().then((list) => music.addToQueue(list))
        }
      >
        <IconPlaylistAdd /> {t.addToQueue}
      </DropdownMenuItem>
      <AddToPlaylist tracks={tracks} label={t.addToPlaylist} />
      <TasteMenuItem kind="albums" id={album.Id} />
      <DropdownMenuSeparator />
      <CommonItems entry={`album:${album.Id}`} path={`/listen/album/${album.Id}`} inLibrary={saved} />
    </>
  )
}

export function PlaylistMenuItems({ playlist, onCreatePlaylist, onCreateFolder }: { playlist: BaseItemDto; onCreatePlaylist?: () => void; onCreateFolder?: () => void }) {
  const t = useMessages(messages)
  const list = usePlaylistTracks(playlist.Id ?? undefined)
  const tracks = async () => list.data ?? []
  return (
    <>
      <DropdownMenuItem
        onClick={() => music.addToQueue(list.data ?? [])}
      >
        <IconPlaylistAdd /> {t.addToQueue}
      </DropdownMenuItem>
      {/* Creating belongs to the library sidebar's own menu. */}
      {onCreatePlaylist && onCreateFolder && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCreatePlaylist}>
            <IconPlus /> {t.createPlaylist}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCreateFolder}>
            <IconFolderPlus /> {t.createFolder}
          </DropdownMenuItem>
        </>
      )}
      <AddToPlaylist tracks={tracks} label={t.addToOtherPlaylist} exclude={playlist.Id ?? undefined} />
      <TasteMenuItem kind="playlists" id={playlist.Id} />
      <DropdownMenuSeparator />
      <CommonItems entry={`playlist:${playlist.Id}`} path={`/listen/playlist/${playlist.Id}`} />
    </>
  )
}

export function OfficialMenuItems({ playlist }: { playlist: OfficialPlaylist }) {
  const t = useMessages(messages)
  const library = useListenLibrary()
  const saved = library.isSaved(`official:${playlist.slug}`)
  const hold = useHeldByDownload(`official:${playlist.slug}`)
  return (
    <>
      <DropdownMenuItem disabled={saved && hold.held} title={saved && hold.held ? hold.hint : undefined} onClick={() => library.toggle(`official:${playlist.slug}`)}>
        {saved ? <IconCircleCheckFilled className="text-listen" /> : <IconCirclePlus />} {saved ? t.removeFromLibrary : t.addToLibrary}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => music.addToQueue(playlist.tracks)}
      >
        <IconPlaylistAdd /> {t.addToQueue}
      </DropdownMenuItem>
      <AddToPlaylist tracks={async () => playlist.tracks} label={t.addToPlaylist} />
      <DropdownMenuSeparator />
      <CommonItems entry={`official:${playlist.slug}`} path={`/listen/official/${playlist.slug}`} inLibrary={saved} />
    </>
  )
}

export function PodcastMenuItems({ podcastId }: { podcastId: string }) {
  const t = useMessages(messages)
  const library = useListenLibrary()
  const followed = library.isSaved(`podcast:${podcastId}`)
  return (
    <>
      <DropdownMenuItem onClick={() => library.toggle(`podcast:${podcastId}`)}>
        {followed ? <IconUserMinus /> : <IconUserPlus />} {followed ? t.unfollow : t.follow}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <CommonItems entry={`podcast:${podcastId}`} path={`/listen/podcast/${podcastId}`} inLibrary={followed} />
    </>
  )
}

export function ProfileMenuItems({ userId }: { userId: string }) {
  const t = useMessages(messages)
  const follow = useSocialFollow()
  return (
    <>
      <DropdownMenuItem onClick={() => follow.mutate({ userId, follow: false })}>
        <IconUserMinus /> {t.unfollow}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <CommonItems entry={`user:${userId}`} path={`/listen/user/${userId}`} />
    </>
  )
}

export function FolderMenuItems({ folderId, onRename }: { folderId: string; onRename: () => void }) {
  const t = useMessages(messages)
  const library = useListenLibrary()
  const pinned = library.isPinned(`folder:${folderId}`)
  return (
    <>
      <DropdownMenuItem onClick={onRename}>
        <IconPencil /> {t.rename}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => library.togglePin(`folder:${folderId}`)}>
        {pinned ? <IconPinnedOff /> : <IconPinned />} {pinned ? t.unpin : t.pin}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => library.deleteFolder(folderId)}>
        <IconTrash /> {t.deleteFolder}
      </DropdownMenuItem>
    </>
  )
}

/** The library's own "+" and empty-space menu. */
/** Liked Songs and Your Episodes: pin and folder, like everything else in the library. */
export function FixedMenuItems({ entry, path }: { entry: 'liked' | 'episodes'; path: string }) {
  return <CommonItems entry={entry} path={path} />
}

export function CreateMenuItems({ onCreatePlaylist, onCreateFolder }: { onCreatePlaylist: () => void; onCreateFolder: () => void }) {
  const t = useMessages(messages)
  return (
    <>
      <DropdownMenuItem onClick={onCreatePlaylist}>
        <IconPlus /> {t.createPlaylist}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onCreateFolder}>
        <IconFolderPlus /> {t.createFolder}
      </DropdownMenuItem>
    </>
  )
}

