import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getUserDataApi } from '@jellyfin/sdk/lib/utils/api/user-data-api'
import { useQueryClient } from '@tanstack/react-query'
import { ContextMenu } from '@base-ui/react/context-menu'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFolder,
  IconFolderOpen,
  IconPinnedFilled,
  IconPlus,
  IconVolume,
  IconX,
} from '@tabler/icons-react'
import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { FadeImage } from '@/components/media/fade-image'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useAuthedSession } from '@/features/auth/session'
import { defineMessages, useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { itemHref } from '@/lib/item-links'
import { useSocialMe } from '@/features/social/social'
import { externalOf } from '@/lib/external-items'
import { cn } from '@/lib/utils'
import { useOfficialPlaylist, useOfficialPlaylists } from './official'
import { useMusic } from './player/music-player'
import { LikedCover, OfficialCover, PlaylistCover, SavedEpisodesCover } from './playlist-cards'
import { ProfileAvatar } from './profile-page'
import { useProfile } from './profiles'
import { useFollowedPodcasts, useSavedEpisodes, type Podcast } from './podcasts'
import { PendingMenuItems, pendingMessages, usePendingImports, useRemovePending } from './library-import-state'
import {
  AlbumMenuItems,
  ArtistMenuItems,
  CreateMenuItems,
  FixedMenuItems,
  FolderMenuItems,
  OfficialMenuItems,
  PlaylistMenuItems,
  PodcastMenuItems,
  ProfileMenuItems,
} from './library-menu'
import { useFollowedArtists, useLikedSongs, useListenLibrary, usePlaylistActions, usePlaylists, usePlaylistTracks, useSavedAlbums, type LibraryFolder } from './playlists'
import { useTrackDrop } from './track-drag'
import { useArtistPhoto } from './artist-photo'
import { useDownloadedKeys } from './player/downloads'
import { MissingCover } from './missing-cover'

const messages = defineMessages({
  de: {
    library: 'Bibliothek',
    clearFilter: 'Filter entfernen',
    scrollFilters: 'Weitere Filter',
    downloaded: 'Heruntergeladen',
    create: 'Erstellen',
    folderName: (n: number) => (n === 1 ? 'Neuer Ordner' : `Neuer Ordner ${n}`),
    folderCount: (n: number) => (n === 1 ? '1 Eintrag' : `${n} Einträge`),
    renameFolder: 'Ordner umbenennen',
    dropToPin: 'Hier ablegen zum Anpinnen',
    save: 'Speichern',
    newPlaylistName: (n: number) => `Meine Playlist Nr. ${n}`,
    playlists: 'Playlists',
    artists: 'Künstler',
    albums: 'Alben',
    liked: 'Favoriten',
    playlist: 'Playlist',
    artist: 'Künstler',
    album: 'Album',
    profile: 'Profil',
    songs: (n: number) => (n === 1 ? '1 Song' : `${n} Songs`),
    podcasts: 'Podcasts',
    podcast: 'Podcast',
    yourEpisodes: 'Gespeicherte Folgen',
    episodes: (n: number) => (n === 1 ? '1 Folge' : `${n} Folgen`),
    addedTo: (name: string) => `Zu „${name}“ hinzugefügt`,
    addedToLiked: 'Zu Favoriten hinzugefügt',
    empty: 'Erstelle deine erste Playlist oder speichere, was dir gefällt.',
  },
  en: {
    library: 'Your Library',
    clearFilter: 'Clear filter',
    scrollFilters: 'More filters',
    downloaded: 'Downloaded',
    create: 'Create',
    folderName: (n: number) => (n === 1 ? 'New folder' : `New folder ${n}`),
    folderCount: (n: number) => (n === 1 ? '1 item' : `${n} items`),
    renameFolder: 'Rename folder',
    dropToPin: 'Drop here to pin',
    save: 'Save',
    newPlaylistName: (n: number) => `My Playlist #${n}`,
    playlists: 'Playlists',
    artists: 'Artists',
    albums: 'Albums',
    liked: 'Favorites',
    playlist: 'Playlist',
    artist: 'Artist',
    album: 'Album',
    profile: 'Profile',
    songs: (n: number) => (n === 1 ? '1 song' : `${n} songs`),
    podcasts: 'Podcasts',
    podcast: 'Podcast',
    yourEpisodes: 'Saved episodes',
    episodes: (n: number) => (n === 1 ? '1 episode' : `${n} episodes`),
    addedTo: (name: string) => `Added to "${name}"`,
    addedToLiked: 'Added to Favorites',
    empty: 'Create your first playlist or save what you like.',
  },
})

type Filter = 'all' | 'playlists' | 'podcasts' | 'artists' | 'albums' | 'downloaded'

/**
 * Listen's library, as in Spotify's sidebar: a "+" to create a playlist, filter chips, and everything the user keeps:
 * Liked Songs, their playlists, saved official and public playlists, followed artists and saved albums. Folded, only
 * the covers remain.
 */
export function LibrarySidebar({ compact, className, titleClassName }: { compact: boolean; className?: string; titleClassName?: string }) {
  const t = useMessages(messages)
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('all')
  const playlists = usePlaylists()
  const liked = useLikedSongs()
  const artists = useFollowedArtists()
  const albums = useSavedAlbums()
  const library = useListenLibrary()
  const official = useOfficialPlaylists()
  const downloaded = useDownloadedKeys()
  const actions = usePlaylistActions()
  const podcasts = useFollowedPodcasts()
  const savedEpisodes = useSavedEpisodes()
  const like = useLikeTracks()
  const pending = usePendingImports()
  const removePending = useRemovePending()
  const pendingT = useMessages(pendingMessages)
  const [openFolders, setOpenFolders] = useOpenFolders()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  // Saved official playlists; radios are built on their own (see useOfficialPlaylist), so they are kept by address.
  const savedOfficial = library.saved
    .filter((id) => id.startsWith('official:'))
    .map((id) => id.slice('official:'.length))
    .filter((slug) => slug.startsWith('radio-') || official.playlists.some((entry) => entry.slug === slug))

  // People the user follows (kept on the Lumio server).
  const followedProfiles = (useSocialMe().data?.following ?? []).map((person) => person.id)

  const createPlaylist = async () => {
    const id = await actions.create.mutateAsync({ name: t.newPlaylistName((playlists.data?.length ?? 0) + 1) })
    void navigate(`/listen/playlist/${id}`)
  }
  const createFolder = () => {
    const id = library.createFolder(t.folderName(library.folders.length + 1))
    setOpenFolders((open) => new Set(open).add(id))
    setRenaming({ id, name: t.folderName(library.folders.length + 1) })
  }
  const createActions = { onCreatePlaylist: () => void createPlaylist(), onCreateFolder: createFolder }

  // Everything the library holds, each with its key (for folders and pins) and its kind (for the filters).
  const entries: LibraryItem[] = [
    {
      key: 'liked',
      kinds: ['playlists'],
      render: (props: EntryExtra) => (
        <Entry
          key="liked"
          compact={compact}
          to="/listen/liked"
          source="liked"
          title={t.liked}
          subtitle={`${t.playlist} · ${t.songs(liked.data?.length ?? 0)}`}
          cover={<LikedCover />}
          onTracksDrop={(tracks) => like(tracks, t.addedToLiked)}
          menu={<FixedMenuItems entry="liked" path="/listen/liked" />}
          {...props}
        />
      ),
    },
    ...(savedEpisodes.length > 0
      ? [
          {
            key: 'episodes',
            kinds: ['podcasts', 'playlists'] as Filter[],
            render: (props: EntryExtra) => (
              <Entry
                key="episodes"
                compact={compact}
                to="/listen/episodes"
                title={t.yourEpisodes}
                subtitle={`${t.playlist} · ${t.episodes(savedEpisodes.length)}`}
                cover={<SavedEpisodesCover />}
                menu={<FixedMenuItems entry="episodes" path="/listen/episodes" />}
                {...props}
              />
            ),
          },
        ]
      : []),
    ...(playlists.data ?? []).map((playlist) => ({
      key: `playlist:${playlist.Id}`,
      kinds: ['playlists'] as Filter[],
      render: (props: EntryExtra) => <PlaylistEntry key={playlist.Id} playlist={playlist} compact={compact} label={t.playlist} {...props} {...createActions} />,
    })),
    ...savedOfficial.map((slug) => ({
      key: `official:${slug}`,
      kinds: ['playlists'] as Filter[],
      render: (props: EntryExtra) => <OfficialEntry key={slug} slug={slug} compact={compact} label={t.playlist} {...props} />,
    })),
    ...podcasts.podcasts.map((podcast) => ({
      key: `podcast:${podcast.id}`,
      kinds: ['podcasts'] as Filter[],
      render: (props: EntryExtra) => <PodcastEntry key={podcast.id} podcast={podcast} compact={compact} label={t.podcast} {...props} />,
    })),
    ...(artists.data ?? []).map((artist) => ({
      key: `artist:${artist.Id}`,
      kinds: ['artists'] as Filter[],
      render: (props: EntryExtra) => (
        <ItemEntry key={artist.Id} item={artist} compact={compact} subtitle={t.artist} round menu={<ArtistMenuItems artist={artist} />} {...props} />
      ),
    })),
    ...followedProfiles.map((userId) => ({
      key: `user:${userId}`,
      kinds: ['artists'] as Filter[],
      render: (props: EntryExtra) => <ProfileEntry key={userId} userId={userId} compact={compact} label={t.profile} {...props} />,
    })),
    ...(albums.data ?? []).map((album) => ({
      key: `album:${album.Id}`,
      kinds: ['albums'] as Filter[],
      render: (props: EntryExtra) => (
        <ItemEntry key={album.Id} item={album} compact={compact} subtitle={`${t.album} · ${album.AlbumArtist ?? ''}`} menu={<AlbumMenuItems album={album} />} {...props} />
      ),
    })),
    // From the Spotify import, not in Jellyfin yet: greyed out until they arrive (or are removed).
    ...[...pending.artists, ...pending.albums].map((row) => ({
      key: `pending:${row.kind}:${row.extId}`,
      kinds: [row.kind === 'artist' ? 'artists' : 'albums'] as Filter[],
      render: (props: EntryExtra) => (
        <Entry
          key={row.extId}
          compact={compact}
          to=""
          unavailable
          title={row.data.title}
          subtitle={`${row.kind === 'artist' ? t.artist : `${t.album} · ${row.data.artist ?? ''}`} · ${pendingT.notInLibrary}`}
          round={row.kind === 'artist'}
          cover={<MissingCover type={row.kind === 'artist' ? 'MusicArtist' : 'MusicAlbum'} />}
          menu={<PendingMenuItems onRemove={() => removePending.entry(row)} />}
          {...props}
        />
      ),
    })),
  ]
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  const inFolder = new Set(library.folders.flatMap((folder) => folder.items))
  const show = (kind: Filter) => filter === 'all' || filter === kind
  // "Downloaded": what has a download on this device (albums, playlists, podcasts with downloaded episodes).
  const visible = (entry: LibraryItem) => (filter === 'downloaded' ? downloaded.has(entry.key) : entry.kinds.some(show))

  // Folders as entries of the top level, holding theirs.
  const folderItems: LibraryItem[] = library.folders.map((folder) => {
    const items = folder.items.map((key) => byKey.get(key)).filter((entry): entry is LibraryItem => !!entry)
    return {
      key: `folder:${folder.id}`,
      kinds: ['playlists'],
      folder: { ...folder, entries: items },
      render: (props: EntryExtra) => (
        <FolderEntry
          key={folder.id}
          name={folder.name}
          count={items.length}
          compact={compact}
          open={openFolders.has(folder.id)}
          onToggle={() =>
            setOpenFolders((open) => {
              const next = new Set(open)
              if (next.has(folder.id)) next.delete(folder.id)
              else next.add(folder.id)
              return next
            })
          }
          menu={<FolderMenuItems folderId={folder.id} onRename={() => setRenaming({ id: folder.id, name: folder.name })} />}
          {...props}
        >
          {items.filter(visible).map((entry) => entry.render({ nested: true, target: { key: entry.key, folderId: folder.id, pinned: false, isFolder: false } }))}
        </FolderEntry>
      ),
    }
  })
  const topLevel = [...folderItems, ...entries.filter((entry) => !inFolder.has(entry.key))]
  // Pinned ones first, in the order they were pinned; then the rest as they come.
  const pinned = library.pinned.map((key) => topLevel.find((entry) => entry.key === key)).filter((entry): entry is LibraryItem => !!entry)
  const ordered = [...pinned, ...topLevel.filter((entry) => !library.pinned.includes(entry.key))].filter(
    (entry) => (entry.folder ? filter === 'all' || entry.folder.entries.some(visible) : visible(entry)),
  )

  // Dragging entries: into and out of folders, onto the pins (and among them, in any order) or off them.
  const dnd: LibraryDnd = {
    drop: (dragged, target, part) => {
      if (dragged === target.key) return
      const isFolder = dragged.startsWith('folder:')
      const folderOfTarget = target.isFolder ? target.key.slice('folder:'.length) : null
      // Into a folder (on it, or among its entries); folders themselves don't nest.
      if (!isFolder && part === 'into' && folderOfTarget) return library.place(dragged, { folderId: folderOfTarget, pinAt: null })
      if (!isFolder && target.folderId) {
        // At the line, among the folder's entries.
        const others = (library.folders.find((folder) => folder.id === target.folderId)?.items ?? []).filter((key) => key !== dragged)
        const at = others.indexOf(target.key) + (part === 'after' ? 1 : 0)
        return library.place(dragged, { folderId: target.folderId, pinAt: null, folderAt: at })
      }
      if (target.key === PIN_ZONE) return library.place(dragged, { folderId: null, pinAt: 0 })
      if (target.pinned) {
        // Counted among the pins without the dragged one, which may be among them.
        const rest = library.pinned.filter((key) => key !== dragged)
        const index = rest.indexOf(target.key) + (part === 'after' ? 1 : 0)
        return library.place(dragged, { folderId: null, pinAt: index })
      }
      // Onto the rest of the list: out of its folder, off the pins.
      library.place(dragged, { folderId: null, pinAt: null })
    },
  }

  const filters: Array<{ value: Filter; label: string }> = [
    { value: 'playlists', label: t.playlists },
    { value: 'podcasts', label: t.podcasts },
    { value: 'artists', label: t.artists },
    { value: 'albums', label: t.albums },
    ...(downloaded.size || filter === 'downloaded' ? [{ value: 'downloaded' as Filter, label: t.downloaded }] : []),
  ]

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col rounded-xl bg-surface [--background:var(--surface)]', compact ? 'w-full items-center py-2' : 'p-2', className)}>
      <div className={cn('flex items-center', compact ? 'flex-col gap-2' : 'justify-between px-2 pb-2 pt-1')}>
        {!compact && <p className={cn('text-sm font-bold', titleClassName)}>{t.library}</p>}
        {/* "+": a playlist or a folder, as in Spotify. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t.create}
            title={t.create}
            className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <IconPlus className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <CreateMenuItems {...createActions} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!compact && <FilterChips filters={filters} value={filter} onChange={setFilter} />}
      {/* Right-clicking the empty part of the list offers the same as "+". */}
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={<nav className={cn('min-h-0 flex-1 space-y-0.5 overflow-y-auto', compact ? 'w-full [scrollbar-width:none]' : '[scrollbar-width:thin]')} />}
        >
          <LibraryDndContext.Provider value={dnd}>
            {/* While dragging and nothing is pinned yet, the top of the list takes the first pin. */}
            {!pinned.length && <PinZone compact={compact} />}
            {ordered.map((entry) => {
              const isPinned = library.pinned.includes(entry.key)
              return entry.render({ pinned: isPinned, target: { key: entry.key, folderId: null, pinned: isPinned, isFolder: !!entry.folder } })
            })}
          </LibraryDndContext.Provider>
        </ContextMenu.Trigger>
        <DropdownMenuContent className="w-52">
          <CreateMenuItems {...createActions} />
        </DropdownMenuContent>
      </ContextMenu.Root>

      <Dialog open={!!renaming} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>{t.renameFolder}</DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (renaming?.name.trim()) library.renameFolder(renaming.id, renaming.name.trim())
              setRenaming(null)
            }}
            className="space-y-4"
          >
            <Input aria-label={t.renameFolder} value={renaming?.name ?? ''} onChange={(event) => setRenaming((current) => current && { ...current, name: event.target.value })} autoFocus maxLength={80} />
            <div className="flex justify-end">
              <Button type="submit">{t.save}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface EntryExtra {
  /** Shown with a pin. */
  pinned?: boolean
  /** Inside an open folder (indented). */
  nested?: boolean
  /** Where it sits, for dragging it and dropping others on it. */
  target?: DropTarget
}

/** An entry as a place to drop another: its key, the folder it is in, whether it is pinned or is a folder. */
interface DropTarget {
  key: string
  folderId: string | null
  pinned: boolean
  isFolder: boolean
}

type DropPart = 'before' | 'after' | 'into'

interface LibraryDnd {
  drop: (dragged: string, target: DropTarget, part: DropPart) => void
}

const LibraryDndContext = createContext<LibraryDnd | null>(null)
const ENTRY_TYPE = 'application/x-lumio-library'
const PIN_ZONE = 'pin-zone'
/** The entry being dragged (the browser's drag data can't be read until the drop). */
let draggedEntry: string | null = null

/** A small card with the entry's cover and title that follows the pointer while dragging. */
function dragGhost(source: HTMLElement) {
  const ghost = document.createElement('div')
  const cover = source.querySelector('[data-cover]')
  const title = source.querySelector('[data-title]')?.textContent ?? source.getAttribute('aria-label') ?? ''
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-1000px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 14px 6px 6px',
    borderRadius: '8px',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    font: '600 14px/1.2 system-ui, sans-serif',
    maxWidth: '280px',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.4)',
  })
  if (cover) {
    const copy = cover.cloneNode(true) as HTMLElement
    Object.assign(copy.style, { width: '36px', height: '36px', flexShrink: '0' })
    // Cloned pictures start invisible (they fade in once loaded); these are loaded already.
    copy.querySelectorAll('img').forEach((image) => (image.style.opacity = '1'))
    ghost.append(copy)
  }
  const label = document.createElement('span')
  Object.assign(label.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
  label.textContent = title
  ghost.append(label)
  return ghost
}

/**
 * Makes a library entry draggable and a place to drop others: `part` tells where a drop would land (before or after
 * it among the pins, or into it when it is a folder), for the line or outline that shows it.
 */
function useEntryDnd(target: DropTarget | undefined) {
  const dnd = useContext(LibraryDndContext)
  const [part, setPart] = useState<DropPart | null>(null)
  if (!dnd || !target) return { part: null, drag: {}, drop: {} }
  const takes = (event: DragEvent) => event.dataTransfer.types.includes(ENTRY_TYPE)
  const partAt = (event: DragEvent): DropPart => {
    const rect = event.currentTarget.getBoundingClientRect()
    const y = (event.clientY - rect.top) / rect.height
    if (target.isFolder && !draggedEntry?.startsWith('folder:')) return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into'
    return y < 0.5 ? 'before' : 'after'
  }
  return {
    part,
    drag: {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(ENTRY_TYPE, target.key)
        const ghost = dragGhost(event.currentTarget)
        document.body.append(ghost)
        event.dataTransfer.setDragImage(ghost, 22, ghost.offsetHeight / 2)
        window.setTimeout(() => ghost.remove())
        draggedEntry = target.key
      },
      onDragEnd: () => {
        draggedEntry = null
      },
    },
    drop: {
      onDragOver: (event: DragEvent) => {
        if (!takes(event) || draggedEntry === target.key) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const next = partAt(event)
        if (next !== part) setPart(next)
      },
      onDragLeave: (event: DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setPart(null)
      },
      onDrop: (event: DragEvent) => {
        setPart(null)
        if (!takes(event) || !draggedEntry) return
        event.preventDefault()
        dnd.drop(draggedEntry, target, partAt(event))
        draggedEntry = null
      },
    },
  }
}

/** Where a drop would land: a dividing line above or below the entry, or the folder lit up (into it), as in Spotify. */
function dropMark(part: DropPart | null, target: DropTarget | undefined) {
  if (!part || !target) return undefined
  if (part === 'into') return 'bg-foreground/10 shadow-[inset_0_0_0_2px_var(--color-listen)]'
  const line = 'relative after:pointer-events-none after:absolute after:inset-x-1 after:h-0.5 after:rounded-full after:bg-listen'
  return cn(line, part === 'before' ? 'after:-top-px' : 'after:-bottom-px')
}

/** The top of the list while nothing is pinned: dropping there pins. Only there while an entry is dragged. */
function PinZone({ compact }: { compact: boolean }) {
  const t = useMessages(messages)
  const [dragging, setDragging] = useState(false)
  const { part, drop } = useEntryDnd({ key: PIN_ZONE, folderId: null, pinned: true, isFolder: false })
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => setDragging(!!event.dataTransfer?.types.includes(ENTRY_TYPE))
    const end = () => setDragging(false)
    window.addEventListener('dragstart', start)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragstart', start)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [])
  if (!dragging) return null
  return (
    <div
      {...drop}
      className={cn(
        'grid h-10 place-items-center rounded-md border border-dashed border-foreground/20 text-xs text-muted-foreground transition-colors',
        part && 'border-listen bg-foreground/[0.07] text-foreground',
      )}
    >
      {compact ? <IconPinnedFilled className="size-4" /> : t.dropToPin}
    </div>
  )
}

interface LibraryItem {
  key: string
  kinds: Filter[]
  render: (props: EntryExtra) => ReactNode
  folder?: LibraryFolder & { entries: LibraryItem[] }
}

const OPEN_FOLDERS_KEY = 'lumio.listen.openFolders'

/** Which folders are open; remembered on this device. */
function useOpenFolders() {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const update = (change: (open: Set<string>) => Set<string>) =>
    setOpen((current) => {
      const next = change(current)
      try {
        localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...next]))
      } catch {
        // Not remembered.
      }
      return next
    })
  return [open, update] as const
}

type Handlers = Partial<Record<'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop', (event: DragEvent) => void>>

/** Both drops on one element (songs onto a playlist, entries onto a place in the list); each only acts on its own drag. */
function mergeHandlers(a: Handlers, b: Handlers): Handlers {
  const merged: Handlers = {}
  for (const name of ['onDragEnter', 'onDragOver', 'onDragLeave', 'onDrop'] as const) {
    const first = a[name]
    const second = b[name]
    if (first || second)
      merged[name] = (event) => {
        first?.(event)
        second?.(event)
      }
  }
  return merged
}

/** A folder: a click opens it right there (its entries below it, indented) or closes it again. */
function FolderEntry({
  name,
  count,
  compact,
  open,
  onToggle,
  menu,
  pinned,
  target,
  children,
}: {
  name: string
  count: number
  compact: boolean
  open: boolean
  onToggle: () => void
  menu: ReactNode
  children: ReactNode
} & EntryExtra) {
  const t = useMessages(messages)
  const entryDnd = useEntryDnd(target)
  return (
    <div>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <button
              {...entryDnd.drag}
              {...entryDnd.drop}
              type="button"
              aria-expanded={open}
              title={compact ? name : undefined}
              aria-label={compact ? name : undefined}
              onClick={onToggle}
              className={cn(
                'flex w-full items-center gap-3 rounded-md p-1.5 text-left outline-none transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/10',
                compact && 'mx-auto w-fit justify-center p-1',
                dropMark(entryDnd.part, target),
              )}
            />
          }
        >
          <span data-cover className={cn('grid shrink-0 place-items-center rounded bg-muted text-muted-foreground', compact ? 'size-10' : 'size-12')}>
            {open ? <IconFolderOpen className="size-6" /> : <IconFolder className="size-6" />}
          </span>
          {!compact && (
            <>
              <span className="min-w-0 flex-1">
                <span data-title className="block truncate text-sm font-medium">{name}</span>
                <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  {pinned && <IconPinnedFilled className="size-3 shrink-0 text-listen" />}
                  {t.folderCount(count)}
                </span>
              </span>
              <IconChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </>
          )}
        </ContextMenu.Trigger>
        <DropdownMenuContent className="w-52">{menu}</DropdownMenuContent>
      </ContextMenu.Root>
      {open && <div className={cn(!compact && 'pl-3')}>{children}</div>}
    </div>
  )
}

/**
 * The filter chips, as in Spotify: one row that scrolls sideways when the sidebar is narrow (with an arrow at the
 * edge that has more), and once a filter is picked, a clear button and only that chip.
 */
function FilterChips({ filters, value, onChange }: { filters: Array<{ value: Filter; label: string }>; value: Filter; onChange: (value: Filter) => void }) {
  const t = useMessages(messages)
  const row = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const shown = value === 'all' ? filters : filters.filter((entry) => entry.value === value)

  const measure = () => {
    const element = row.current
    if (!element) return
    const left = element.scrollLeft > 1
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setEdges((current) => (current.left === left && current.right === right ? current : { left, right }))
  }
  useEffect(() => {
    const element = row.current
    if (!element) return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [value])

  const scroll = (direction: 1 | -1) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.7, behavior: 'smooth' })
  return (
    <div className="relative px-1 pb-2">
      <div ref={row} onScroll={measure} className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {value !== 'all' && (
          <button
            type="button"
            aria-label={t.clearFilter}
            title={t.clearFilter}
            onClick={() => onChange('all')}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/10 transition-colors hover:bg-foreground/20"
          >
            <IconX className="size-4" />
          </button>
        )}
        {shown.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={value === entry.value}
            onClick={() => onChange(value === entry.value ? 'all' : entry.value)}
            className={cn(
              'h-7 shrink-0 whitespace-nowrap rounded-full px-3 text-xs font-medium transition-colors',
              value === entry.value ? 'bg-foreground text-background' : 'bg-foreground/10 hover:bg-foreground/20',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {edges.left && <ScrollEdge side="left" label={t.scrollFilters} onClick={() => scroll(-1)} />}
      {edges.right && <ScrollEdge side="right" label={t.scrollFilters} onClick={() => scroll(1)} />}
    </div>
  )
}

/** The arrow at an edge of the chip row with more chips behind it, on a fade so the cut-off chip doesn't show through. */
function ScrollEdge({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  const Icon = side === 'left' ? IconChevronLeft : IconChevronRight
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-0 flex h-7 w-12 items-center from-card from-50% to-transparent',
        side === 'left' ? 'left-1 justify-start bg-linear-to-r' : 'right-1 justify-end bg-linear-to-l',
      )}
    >
      <button
        type="button"
        aria-label={label}
        tabIndex={-1}
        onClick={onClick}
        className="pointer-events-auto grid size-7 place-items-center rounded-full bg-muted text-foreground shadow-md transition-colors hover:bg-foreground/20"
      >
        <Icon className="size-4" />
      </button>
    </div>
  )
}

function ProfileEntry({ userId, compact, label, ...extra }: { userId: string; compact: boolean; label: string } & EntryExtra) {
  const profile = useProfile(userId)
  const name = profile.data?.Name ?? ''
  return (
    <Entry
      {...extra}
      menu={<ProfileMenuItems userId={userId} />}
      compact={compact}
      to={`/listen/user/${userId}`}
      title={name}
      subtitle={label}
      round
      cover={<ProfileAvatar userId={userId} name={name} className="size-full text-sm" />}
    />
  )
}

/** Marks dropped songs as liked. */
function useLikeTracks() {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  return async (tracks: BaseItemDto[], done: string) => {
    const userData = getUserDataApi(api)
    await Promise.all(tracks.filter((track) => track.Id && !externalOf(track)).map((track) => userData.markFavoriteItem({ itemId: track.Id!, userId: session.userId })))
    void queryClient.invalidateQueries({ queryKey: ['liked-songs'] })
    for (const track of tracks) void queryClient.invalidateQueries({ queryKey: ['item', session.userId, track.Id] })
    toast.success(done)
  }
}

function OfficialEntry({ slug, compact, label, ...extra }: { slug: string; compact: boolean; label: string } & EntryExtra) {
  const { playlist } = useOfficialPlaylist(slug)
  return (
    <Entry
      {...extra}
      compact={compact}
      to={`/listen/official/${slug}`}
      source={`official:${slug}`}
      title={playlist?.title ?? ''}
      subtitle={label}
      cover={playlist ? <OfficialCover playlist={playlist} /> : null}
      menu={playlist ? <OfficialMenuItems playlist={playlist} /> : undefined}
    />
  )
}

function PodcastEntry({ podcast, compact, label, ...extra }: { podcast: Podcast; compact: boolean; label: string } & EntryExtra) {
  return (
    <Entry
      {...extra}
      menu={<PodcastMenuItems podcastId={podcast.id} />}
      compact={compact}
      to={`/listen/podcast/${podcast.id}`}
      source={`podcast:${podcast.id}`}
      title={podcast.name}
      subtitle={`${label} · ${podcast.author}`}
      cover={podcast.image ? <FadeImage src={podcast.image} alt="" className="size-full object-cover" /> : null}
    />
  )
}

function PlaylistEntry({
  playlist,
  compact,
  label,
  onCreatePlaylist,
  onCreateFolder,
  ...extra
}: { playlist: BaseItemDto; compact: boolean; label: string; onCreatePlaylist: () => void; onCreateFolder: () => void } & EntryExtra) {
  const t = useMessages(messages)
  const tracks = usePlaylistTracks(playlist.Id ?? undefined)
  const actions = usePlaylistActions()
  // Songs can be dropped on playlists the user may change.
  const mine = playlist.CanDelete !== false
  return (
    <Entry
      {...extra}
      menu={<PlaylistMenuItems playlist={playlist} onCreatePlaylist={onCreatePlaylist} onCreateFolder={onCreateFolder} />}
      compact={compact}
      to={`/listen/playlist/${playlist.Id}`}
      source={`playlist:${playlist.Id}`}
      title={playlist.Name ?? ''}
      subtitle={label}
      cover={<PlaylistCover playlist={playlist} tracks={tracks.data ?? []} />}
      onTracksDrop={
        mine
          ? (dropped) =>
              actions.add.mutate({ playlistId: playlist.Id!, ids: dropped.filter((track) => !externalOf(track)).map((track) => track.Id!), name: t.addedTo(playlist.Name ?? '') })
          : undefined
      }
    />
  )
}

function ItemEntry({ item, compact, subtitle, round, ...extra }: { item: BaseItemDto; compact: boolean; subtitle: string; round?: boolean; menu?: ReactNode } & EntryExtra) {
  const { api } = useAuthedSession()
  const artistPhoto = useArtistPhoto(item.Type === 'MusicArtist' ? item : undefined, 96)
  const image = item.Type === 'MusicArtist' ? artistPhoto : portraitImageUrl(api, item, { fillHeight: 96 })
  return (
    <Entry
      {...extra}
      compact={compact}
      to={itemHref(item)}
      title={item.Name ?? ''}
      subtitle={subtitle}
      round={round}
      cover={
        image ? (
          <FadeImage src={image} alt="" className="size-full object-cover" />
        ) : (
          <MissingCover type={item.Type} />
        )
      }
    />
  )
}

interface EntryProps {
  to: string
  title: string
  subtitle: string
  cover: ReactNode
  compact: boolean
  round?: boolean
  /** The player's source key; the entry playing shows a speaker and green title. */
  source?: string
  /** Takes songs dragged onto it (playlists, Liked Songs). */
  onTracksDrop?: (tracks: BaseItemDto[]) => void
  /** Its right-click menu. */
  menu?: ReactNode
  /** Not in Jellyfin yet (from an import): greyed out, leads nowhere; only its menu works. */
  unavailable?: boolean
}

function Entry({ to, title, subtitle, cover, compact, round, source, onTracksDrop, menu, unavailable, pinned, nested, target }: EntryProps & EntryExtra) {
  const state = useMusic()
  const playing = !!source && state.source === source && state.index >= 0
  const drop = useTrackDrop((tracks) => onTracksDrop?.(tracks), !!onTracksDrop)
  const entryDnd = useEntryDnd(target)
  const inner = (
    <>
      <span data-cover className={cn('shrink-0 overflow-hidden bg-muted', compact ? 'size-10' : 'size-12', round ? 'rounded-full' : 'rounded')}>{cover}</span>
      {!compact && (
        <span className="min-w-0 flex-1">
          <span data-title className={cn('block truncate text-sm font-medium', playing && 'text-listen')}>{title}</span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            {pinned && <IconPinnedFilled className="size-3 shrink-0 text-listen" />}
            <span className="truncate">{subtitle}</span>
          </span>
        </span>
      )}
      {!compact && playing && <IconVolume className="size-4 shrink-0 text-listen" />}
    </>
  )
  const link = unavailable ? (
    <div
      {...entryDnd.drag}
      {...entryDnd.drop}
      title={compact ? title : undefined}
      aria-label={title}
      aria-disabled
      className={cn(
        'flex cursor-default items-center gap-3 rounded-md p-1.5 opacity-45 outline-none transition-colors hover:bg-foreground/[0.04]',
        'data-popup-open:bg-foreground/10',
        nested && !compact && 'pl-2',
        compact ? 'mx-auto w-fit justify-center p-1' : '',
        dropMark(entryDnd.part, target),
      )}
    >
      {inner}
    </div>
  ) : (
    <NavLink
      {...entryDnd.drag}
      {...mergeHandlers(drop.handlers, entryDnd.drop)}
      to={to}
      title={compact ? title : undefined}
      aria-label={compact ? title : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md p-1.5 outline-none transition-colors hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-ring',
          isActive && 'bg-foreground/10',
          'data-popup-open:bg-foreground/10',
          nested && !compact && 'pl-2',
          // Folded: just the cover with a tight tile around it, centred in the strip.
          compact ? 'mx-auto w-fit justify-center p-1' : '',
          // The place under the dragged songs gets a green outline drawn inside it (an outer ring would be cut off by
          // the scrolling list and overlap the neighbours).
          drop.over && 'bg-foreground/10 shadow-[inset_0_0_0_2px_var(--color-listen)]',
          dropMark(entryDnd.part, target),
        )
      }
    >
      {inner}
    </NavLink>
  )
  if (!menu) return link
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={link} />
      <DropdownMenuContent className="w-60">{menu}</DropdownMenuContent>
    </ContextMenu.Root>
  )
}
