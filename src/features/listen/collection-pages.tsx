import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconCircleCheckFilled,
  IconCirclePlus,
  IconClock,
  IconDots,
  IconLock,
  IconPencil,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlaylistAdd,
  IconTrash,
  IconUsersPlus,
  IconVinyl,
  IconWorld,
} from '@tabler/icons-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { ModeTile } from '@/components/app-switcher'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useBranding } from '@/features/admin/branding'
import { useAuthedSession } from '@/features/auth/session'
import { useItem } from '@/features/items/queries'
import { formatRuntime } from '@/lib/format'
import { defineMessages, useMessages } from '@/lib/i18n'
import { cn, tintWash } from '@/lib/utils'
import { TRACK_GRID, TRACK_GRID_EXTRA, TrackTableRow } from './album-view'
import { useOfficialPlaylist } from './official'
import { playCircle } from './play-circle'
import { music, START, useMusic } from './player/music-player'
import { ShuffleToggle } from './shuffle-toggle'
import { PlaylistDetailsDialog } from './playlist-details-dialog'
import { LikedCover, OfficialCover, PlaylistCover } from './playlist-cards'
import { useLikedSongs, useListenLibrary, usePlaylistAccess, usePlaylistActions, usePlaylistTracks } from './playlists'
import { ProfileAvatar } from './profile-page'
import { usePlaylistInfos, usePlaylistOwner, useProfile } from './profiles'
import { PlaylistShareDialog, usePlaylistAdds } from './playlist-share-dialog'
import { AddToPlaylist } from './library-menu'
import { TasteMenuItem } from './taste'
import { DownloadButton, DownloadMenuItem } from './download-ui'
import { useHeldByDownload } from './download-ui'
import { MixerBadge, MixerMenuItems, SortBuildDialog } from './mixer/mixer-ui'
import { useMixInfo, usePlaylistMixer, useStableLumioFetch } from './mixer/queries'
import { PlaylistSortMenu } from './playlist-sort-menu'
import { dropStaleBakes } from './mixer/mixmode/bake'
import { MixModeBanner, MixModeMenuItem } from './mixer/mixmode/mix-mode-ui'

const messages = defineMessages({
  de: {
    playlist: 'Playlist',
    publicPlaylist: 'Öffentliche Playlist',
    privatePlaylist: 'Private Playlist',
    liked: 'Favoriten',
    songs: (n: number) => (n === 1 ? '1 Song' : `${n} Songs`),
    play: 'Abspielen',
    pause: 'Pausieren',
    shuffle: 'Zufallswiedergabe an',
    shuffleOff: 'Zufallswiedergabe aus',
    save: 'In der Bibliothek speichern',
    saved: 'In deiner Bibliothek',
    more: 'Weitere Optionen',
    addToQueue: 'Zur Warteschlange hinzufügen',
    addToOtherPlaylist: 'Zu einer anderen Playlist hinzufügen',
    rename: 'Umbenennen',
    editDetails: 'Details bearbeiten',
    makePublic: 'Öffentlich machen',
    sharedPlaylist: 'Gemeinsame Playlist',
    share: 'Mitwirkende einladen',
    addedBy: 'Hinzugefügt von',
    makePrivate: 'Privat machen',
    delete: 'Löschen',
    deleteConfirm: (name: string) => `„${name}“ wird endgültig gelöscht.`,
    cancel: 'Abbrechen',
    saveName: 'Speichern',
    name: 'Name',
    title: 'Titel',
    album: 'Album',
    empty: 'Noch keine Songs. Füge welche über das „…“-Menü eines Songs hinzu.',
    likedEmpty: 'Songs, die du mit dem Herz markierst, landen hier.',
    madeFor: (name: string) => `Von ${name}`,
    madeForPrefix: 'Für',
    tempoKey: 'Tempo · Tonart',
    editTransition: 'Übergang zum nächsten Song bearbeiten',
  },
  en: {
    playlist: 'Playlist',
    publicPlaylist: 'Public playlist',
    privatePlaylist: 'Private playlist',
    liked: 'Favorites',
    songs: (n: number) => (n === 1 ? '1 song' : `${n} songs`),
    play: 'Play',
    pause: 'Pause',
    shuffle: 'Turn on shuffle',
    shuffleOff: 'Turn off shuffle',
    save: 'Save to your library',
    saved: 'In your library',
    more: 'More options',
    addToQueue: 'Add to queue',
    addToOtherPlaylist: 'Add to other playlist',
    rename: 'Rename',
    editDetails: 'Edit details',
    makePublic: 'Make public',
    sharedPlaylist: 'Shared playlist',
    share: 'Invite collaborators',
    addedBy: 'Added by',
    makePrivate: 'Make private',
    delete: 'Delete',
    deleteConfirm: (name: string) => `"${name}" will be deleted for good.`,
    cancel: 'Cancel',
    saveName: 'Save',
    name: 'Name',
    title: 'Title',
    album: 'Album',
    empty: 'No songs yet. Add some from a song’s "…" menu.',
    likedEmpty: 'Songs you like with the heart end up here.',
    madeFor: (name: string) => `By ${name}`,
    madeForPrefix: 'For',
    tempoKey: 'Tempo · key',
    editTransition: 'Edit the transition into the next song',
  },
})

interface CollectionProps {
  kind: string
  /** A mark beside the kind (a mixer playlist's). */
  badge?: ReactNode
  title: string
  cover: ReactNode
  /** Owner and stats line under the title. */
  byline: ReactNode
  description?: string
  tracks: BaseItemDto[]
  loading: boolean
  /** Identifies the collection in the player (so its page knows it is the one playing). */
  source: string
  /** Header gradient color. */
  tint?: string
  /** Extra buttons next to play/shuffle (save, owner menu). */
  actions?: ReactNode
  empty?: string
  /** Removes an entry (own playlists). */
  onRemove?: (track: BaseItemDto) => void
  /** Moves an entry to another position (own playlists; rows can then be dragged). */
  onMove?: (track: BaseItemDto, index: number) => void
  /** Opens "Edit details" (own playlists): clicking the title or the cover. */
  onEdit?: (from: 'title' | 'cover') => void
  /** A column beside the songs (plays, listeners), by track id, with its heading. */
  extras?: Record<string, ReactNode>
  extraLabel?: string
  /** A strip above the songs (a playlist in Mix-Modus: how far its stems are). */
  notice?: ReactNode
  /** Items on top of a row's menu (in the list's order as shown). */
  rowMenu?: (track: BaseItemDto, index: number, tracks: BaseItemDto[]) => ReactNode
}

/** The layout shared by playlists, official playlists and liked songs: header, actions, track table with albums. */
export function Collection({ kind, badge, title, cover, byline, description, tracks: loaded, loading, source, tint, actions, empty, onRemove, onMove, onEdit, extras, extraLabel, rowMenu, notice }: CollectionProps) {
  const t = useMessages(messages)
  // Dragging reorders right away; the server's order replaces it once it has saved the move.
  const [reordered, setReordered] = useState<{ from: BaseItemDto[]; order: BaseItemDto[] } | null>(null)
  const tracks = reordered && reordered.from === loaded ? reordered.order : loaded
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const drop = (to: number) => {
    if (dragging === null || dragging === to || !onMove) return
    const order = [...tracks]
    const [moved] = order.splice(dragging, 1)
    order.splice(to, 0, moved!)
    setReordered({ from: loaded, order })
    onMove(moved!, to)
  }
  const state = useMusic()
  const here = state.source === source && state.index >= 0
  const totalTicks = tracks.reduce((sum, track) => sum + (track.RunTimeTicks ?? 0), 0)
  const playAll = () => (here ? music.toggle() : music.play(tracks, START, { source }))
  return (
    <div className="pb-12">
      <div className="relative pt-14" style={{ background: tintWash(tint ?? 'rgb(72 72 80)') }}>
        <div className="flex flex-col gap-6 px-4 pb-6 pt-10 sm:flex-row sm:items-end sm:px-8">
          {onEdit ? (
            <button
              type="button"
              aria-label={t.editDetails}
              onClick={() => onEdit('cover')}
              className="group relative size-48 shrink-0 overflow-hidden rounded-md bg-muted shadow-2xl shadow-black/50 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-56"
            >
              {cover}
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-sm font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                <IconPencil className="size-10" stroke={1.5} />
                {t.editDetails}
              </span>
            </button>
          ) : (
            <div className="size-48 shrink-0 overflow-hidden rounded-md bg-muted shadow-2xl shadow-black/50 sm:size-56">{cover}</div>
          )}
          <div className="min-w-0 space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              {kind}
              {badge}
            </p>
            {onEdit ? (
              <button type="button" onClick={() => onEdit('title')} className="block text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <h1 className="line-clamp-2 text-4xl font-black leading-none tracking-tight text-balance sm:text-6xl xl:text-7xl">{title}</h1>
              </button>
            ) : (
              <h1 className="line-clamp-2 text-4xl font-black leading-none tracking-tight text-balance sm:text-6xl xl:text-7xl">{title}</h1>
            )}
            {description && <p className="line-clamp-2 text-sm text-foreground/70">{description}</p>}
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-foreground/80">
              {byline}
              {tracks.length > 0 && (
                <span>
                  • {t.songs(tracks.length)}, {formatRuntime(totalTicks)}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-5 px-4 py-5 sm:px-8">
        <button type="button" aria-label={here && state.playing ? t.pause : t.play} onClick={() => playAll()} disabled={!tracks.length} className={cn('size-14', playCircle.listen)}>
          {here && state.playing ? <IconPlayerPauseFilled className="size-6" /> : <IconPlayerPlayFilled className="size-6 translate-x-px" />}
        </button>
        <ShuffleToggle source={source} />
        {actions}
      </div>

      {notice && <div className="px-4 pb-4 sm:px-8">{notice}</div>}

      <div className="px-4 sm:px-8">
        <div
          className={cn(
            'grid items-center gap-4 border-b px-4 pb-2 text-sm text-muted-foreground max-md:hidden',
            extras ? TRACK_GRID_EXTRA : TRACK_GRID,
          )}
        >
          <span className="text-right">#</span>
          <span>{t.title}</span>
          {extras && <span className="hidden text-right sm:block">{extraLabel}</span>}
          <span className="flex justify-end">
            <IconClock className="size-4" />
          </span>
          <span />
        </div>
        <div className="mt-2">
          {loading && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="mb-1 h-14 rounded-md" />)}
          {!loading && tracks.length === 0 && empty && <p className="px-4 py-8 text-sm text-muted-foreground">{empty}</p>}
          {tracks.map((track, index) => (
            <div
              key={`${track.PlaylistItemId ?? track.Id}-${index}`}
              // The row itself is dragged (onto playlists or the queue too); here it also reorders.
              onDragStart={() => onMove && setDragging(index)}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setOver(index)
              }}
              onDrop={(event) => {
                event.preventDefault()
                drop(index)
                setDragging(null)
                setOver(null)
              }}
              onDragEnd={() => {
                setDragging(null)
                setOver(null)
              }}
              className={cn(
                'rounded-md transition-opacity',
                dragging === index && 'opacity-40',
                // A line (drawn inside, so nothing shifts) shows where the dragged song will land.
                over === index &&
                  dragging !== null &&
                  dragging !== index &&
                  (dragging < index ? 'shadow-[inset_0_-2px_0_var(--color-listen)]' : 'shadow-[inset_0_2px_0_var(--color-listen)]'),
              )}
            >
              <TrackTableRow
                track={track}
                number={index + 1}
                cover
                extra={extras ? (extras[track.Id ?? ''] ?? '') : undefined}
                onPlay={() => music.play(tracks, index, { source })}
                onRemove={onRemove ? () => onRemove(track) : undefined}
                menuExtra={rowMenu?.(track, index, tracks)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SaveButton({ id }: { id: string }) {
  const t = useMessages(messages)
  const library = useListenLibrary()
  const saved = library.isSaved(id)
  // A downloaded playlist stays in the library.
  const hold = useHeldByDownload(id.startsWith('official:') ? id : `playlist:${id}`)
  const locked = saved && hold.held
  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={locked ? hold.hint : saved ? t.saved : t.save}
      title={locked ? hold.hint : saved ? t.saved : t.save}
      onClick={() => !locked && library.toggle(id)}
      className={cn('grid size-10 place-items-center rounded-full transition-colors', saved ? 'text-listen' : 'text-muted-foreground hover:text-foreground')}
    >
      {saved ? <IconCircleCheckFilled className="size-8" /> : <IconCirclePlus className="size-8" />}
    </button>
  )
}

/** The playlist's creator, linking to their profile. */
function OwnerByline({ userId }: { userId: string }) {
  const profile = useProfile(userId)
  const name = profile.data?.Name
  return (
    <Link to={`/listen/user/${userId}`} className="flex items-center gap-1.5 font-bold text-foreground hover:underline">
      <ProfileAvatar userId={userId} name={name} className="size-6 text-[10px]" />
      {name}
    </Link>
  )
}

/** The platform as an owner: the instance's mark and name, like "Spotify" under its own playlists; opens its profile. */
function PlatformByline() {
  const { appName, avatar } = useBranding('listen')
  return (
    <Link to="/listen/platform" className="flex items-center gap-1.5 font-bold text-foreground hover:underline">
      {avatar ? <img src={avatar} alt="" className="size-5 rounded-full object-cover" /> : <ModeTile mode="listen" className="size-5 rounded-full" />} {appName}
    </Link>
  )
}

export function PlaylistPage() {
  const { id = '' } = useParams()
  const t = useMessages(messages)
  const { session } = useAuthedSession()
  const navigate = useNavigate()
  const playlist = useItem(id)
  const tracks = usePlaylistTracks(id)
  const access = usePlaylistAccess(id)
  const editor = usePlaylistOwner(id)
  const actions = usePlaylistActions()
  const infos = usePlaylistInfos()
  const [editing, setEditing] = useState<'title' | 'cover' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [building, setBuilding] = useState(false)
  // "Passend" outside mixer mode: the same dialog, the order only.
  const [suiting, setSuiting] = useState(false)
  const mixer = usePlaylistMixer(id)
  const mixing = mixer.data?.on === true
  const lumioFetch = useStableLumioFetch()
  const shareInfo = infos.data?.find((info) => info.playlist.Id === id)
  const adds = usePlaylistAdds(id, (shareInfo?.editors.length ?? 0) > 1).data
  // A mixer playlist shows each song's tempo and key (what its transitions are planned with) where a shared one shows
  // who added it.
  const trackIds = useMemo(() => (tracks.data ?? []).map((track) => track.Id ?? ''), [tracks.data])
  const mixInfo = useMixInfo(trackIds, mixing && (shareInfo?.editors.length ?? 0) <= 1)

  if (playlist.isError) return <Navigate to="/listen" replace />
  const item = playlist.data
  const mine = item?.CanDelete !== false
  const owner = editor ?? (mine ? session.userId : undefined)
  const isPublic = !!access.data?.OpenAccess
  const list = tracks.data ?? []
  // A shared playlist: more than one editor; each of them may change its songs, and it shows who added what.
  const editors = shareInfo?.editors ?? (owner ? [owner] : [])
  const shared = editors.length > 1
  const canEdit = mine || editors.includes(session.userId)
  let addedBy: Record<string, ReactNode> | undefined
  if (shared) {
    addedBy = {}
    for (const track of list) {
      const person = adds?.[track.Id ?? '']?.person
      addedBy[track.Id ?? ''] = person ? (
        <Link to={`/listen/user/${person.id}`} onClick={(event) => event.stopPropagation()} className="flex min-w-0 items-center gap-2 hover:text-foreground hover:underline">
          <ProfileAvatar userId={person.id} name={person.name} tag={person.imageTag} className="size-5 text-[9px]" />
          <span className="truncate">{person.name}</span>
        </Link>
      ) : (
        ''
      )
    }
  }

  return (
    <>
      <Collection
        kind={shared ? t.sharedPlaylist : isPublic ? t.publicPlaylist : mine ? t.privatePlaylist : t.playlist}
        title={item?.Name ?? ''}
        description={item?.Overview ?? undefined}
        cover={item ? <PlaylistCover playlist={item} tracks={list} /> : null}
        byline={owner ? <OwnerByline userId={owner} /> : null}
        badge={mixing ? <MixerBadge /> : undefined}
        tracks={list}
        loading={tracks.isLoading}
        source={`playlist:${id}`}
        empty={canEdit ? t.empty : undefined}
        extras={addedBy ?? (mixing ? mixInfo : undefined)}
        extraLabel={addedBy ? t.addedBy : t.tempoKey}
        notice={mixing ? <MixModeBanner playlistId={id} tracks={list} mixer={mixer.data} canLeave={canEdit} /> : undefined}
        rowMenu={
          mixing && canEdit
            ? (track, index, shown) => {
                const next = shown[index + 1]
                return next?.Id && track.Id ? (
                  <DropdownMenuItem onClick={() => void navigate(`/listen/playlist/${id}/mix/${track.Id}/${next.Id}`)}>
                    <IconVinyl /> {t.editTransition}
                  </DropdownMenuItem>
                ) : null
              }
            : undefined
        }
        onRemove={canEdit ? (track) => track.PlaylistItemId && actions.remove.mutate({ playlistId: id, entryIds: [track.PlaylistItemId] }) : undefined}
        onMove={
          canEdit
            ? (track, index) => {
                if (!track.PlaylistItemId) return
                // The order after the move: baked clips of pairs that are no longer neighbours are let go (as when sorting).
                const order = list.map((entry) => entry.Id ?? '')
                const from = list.findIndex((entry) => entry.PlaylistItemId === track.PlaylistItemId)
                if (from >= 0) order.splice(index, 0, ...order.splice(from, 1))
                actions.move.mutate({ playlistId: id, entryId: track.PlaylistItemId, index }, { onSuccess: () => mixing && void dropStaleBakes(lumioFetch, id, order) })
              }
            : undefined
        }
        onEdit={mine && item ? setEditing : undefined}
        actions={
          <>
            {!mine && <SaveButton id={id} />}
            {/* Sorting changes the playlist itself: only its owner may. */}
            {mine && <PlaylistSortMenu playlistId={id} tracks={list} mixing={mixing} onSuited={() => (mixing ? setBuilding(true) : setSuiting(true))} />}
            <DownloadButton downloadKey={`playlist:${id}`} name={item?.Name ?? ''} items={tracks.data} collection={item} />
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={t.more} className="grid size-10 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground">
                <IconDots className="size-7" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onClick={() => music.addToQueue(list)}>
                  <IconPlaylistAdd /> {t.addToQueue}
                </DropdownMenuItem>
                <AddToPlaylist tracks={async () => list} label={t.addToOtherPlaylist} exclude={id} />
                <DownloadMenuItem downloadKey={`playlist:${id}`} name={item?.Name ?? ''} items={tracks.data} collection={item} />
                <TasteMenuItem kind="playlists" id={id} />
                {canEdit && <MixerMenuItems playlistId={id} onBuild={() => setBuilding(true)} />}
                {canEdit && mixing && <MixModeMenuItem playlistId={id} tracks={list} mixer={mixer.data} />}
                {mine && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setEditing('title')}>
                      <IconPencil /> {t.editDetails}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSharing(true)}>
                      <IconUsersPlus /> {t.share}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => actions.update.mutate({ playlistId: id, isPublic: !isPublic })}>
                      {isPublic ? <IconLock /> : <IconWorld />} {isPublic ? t.makePrivate : t.makePublic}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                      <IconTrash /> {t.delete}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {item && (
        <PlaylistDetailsDialog
          playlist={item}
          tracks={list}
          isPublic={isPublic}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          focus={editing === 'cover' ? 'none' : 'name'}
        />
      )}

      {canEdit && <SortBuildDialog playlistId={id} tracks={list} open={building} onOpenChange={setBuilding} />}
      {mine && <SortBuildDialog playlistId={id} tracks={list} open={suiting} onOpenChange={setSuiting} mode="order" />}

      {mine && <PlaylistShareDialog playlistId={id} editors={editors} open={sharing} onOpenChange={setSharing} />}

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.delete}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t.deleteConfirm(item?.Name ?? '')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                actions.destroy.mutate(id, {
                  onSuccess: () => {
                    setDeleting(false)
                    void navigate('/listen', { replace: true })
                  },
                })
              }
            >
              {t.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function OfficialPlaylistPage() {
  const { slug = '' } = useParams()
  const t = useMessages(messages)
  const { session } = useAuthedSession()
  const { playlist, isLoading } = useOfficialPlaylist(slug)
  if (!isLoading && !playlist) return <Navigate to="/listen" replace />
  return (
    <Collection
      // A radio is public: its address shows everyone their own radio of the artist.
      kind={playlist?.kind === 'radio' ? t.publicPlaylist : t.playlist}
      title={playlist?.title ?? ''}
      description={playlist?.description}
      cover={playlist ? <OfficialCover playlist={playlist} /> : <Skeleton className="size-full" />}
      byline={
        <>
          <PlatformByline />
          {/* Made for whoever opens it: the same link shows everyone their own. */}
          {playlist?.personal && (
            <span>
              • {t.madeForPrefix}{' '}
              <Link to={`/listen/user/${session.userId}`} className="font-bold text-foreground hover:underline">
                {session.userName}
              </Link>
            </span>
          )}
        </>
      }
      extras={playlist?.extras}
      extraLabel={playlist?.extraLabel}
      tracks={playlist?.tracks ?? []}
      loading={isLoading}
      source={`official:${slug}`}
      tint="rgb(40 90 70)"
      actions={
        <>
          <SaveButton id={`official:${slug}`} />
          <DownloadButton downloadKey={`official:${slug}`} name={playlist?.title ?? ''} items={playlist?.tracks} />
        </>
      }
    />
  )
}

export function LikedSongsPage() {
  const t = useMessages(messages)
  const { session } = useAuthedSession()
  const liked = useLikedSongs()
  return (
    <Collection
      kind={t.playlist}
      title={t.liked}
      cover={<LikedCover />}
      byline={<span className="font-bold text-foreground">{session.userName}</span>}
      tracks={liked.data ?? []}
      actions={<DownloadButton downloadKey="liked" name={t.liked} items={liked.data} />}
      loading={liked.isLoading}
      source="liked"
      tint="rgb(80 56 160)"
      empty={t.likedEmpty}
    />
  )
}
