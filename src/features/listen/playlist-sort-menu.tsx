import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconArrowBackUp,
  IconArrowsSort,
  IconCalendar,
  IconClock,
  IconDisc,
  IconLoader2,
  IconSortAscendingLetters,
  IconSortDescendingLetters,
  IconSparkles,
  IconUser,
} from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { defineMessages, useMessages } from '@/lib/i18n'
import { usePlaylistAdds } from './playlist-share-dialog'
import { outcomeText, reorderMessages, useAnnounceReorder, usePlaylistReorder, usePreviousOrder } from './playlist-reorder'
import { addedDates, sortPlaylist, type PlaylistSortKey } from './playlist-sort'
import { hasSharedEntries } from './mixer/reorder'

const messages = defineMessages({
  de: {
    sort: 'Sortieren',
    sortBy: 'Playlist sortieren nach',
    titleAsc: 'Titel (A–Z)',
    titleDesc: 'Titel (Z–A)',
    artist: 'Künstler (A–Z)',
    album: 'Album',
    playlistNewest: 'Zur Playlist hinzugefügt (neueste zuerst)',
    playlistOldest: 'Zur Playlist hinzugefügt (älteste zuerst)',
    libraryNewest: 'Zur Bibliothek hinzugefügt (neueste zuerst)',
    libraryOldest: 'Zur Bibliothek hinzugefügt (älteste zuerst)',
    duration: 'Dauer (kürzeste zuerst)',
    suited: 'Passend (Tonart, Tempo, Stimmung)',
    undo: 'Sortierung rückgängig machen',
    confirmTitle: (label: string) => `Nach „${label}“ sortieren?`,
    confirmText:
      'Die Songs werden in der Playlist selbst umsortiert, für alle, die sie sehen; die bisherige Reihenfolge wird ersetzt. Solange Lumio offen ist, kannst du das rückgängig machen.',
    playlistDates: 'Sortiert danach, wann die Songs über Lumio zur Playlist hinzugefügt wurden.',
    libraryDates:
      'Jellyfin merkt sich nicht, wann ein Song in eine Playlist kam, und Lumio weiß es nicht für alle Songs dieser Playlist. Deshalb zählt, wann die Songs in die Bibliothek kamen.',
    mixerNote: 'Für Songs, die danach nebeneinander stehen, plant der Mixer die Übergänge automatisch.',
    cancel: 'Abbrechen',
    confirm: 'Sortieren',
    sorted: 'Playlist sortiert',
  },
  en: {
    sort: 'Sort',
    sortBy: 'Sort playlist by',
    titleAsc: 'Title (A–Z)',
    titleDesc: 'Title (Z–A)',
    artist: 'Artist (A–Z)',
    album: 'Album',
    playlistNewest: 'Added to the playlist (newest first)',
    playlistOldest: 'Added to the playlist (oldest first)',
    libraryNewest: 'Added to the library (newest first)',
    libraryOldest: 'Added to the library (oldest first)',
    duration: 'Duration (shortest first)',
    suited: 'Best flow (key, tempo, mood)',
    undo: 'Undo sorting',
    confirmTitle: (label: string) => `Sort by "${label}"?`,
    confirmText:
      'The songs are reordered in the playlist itself, for everyone who sees it; the current order is replaced. As long as Lumio stays open, you can undo it.',
    playlistDates: 'Sorted by when the songs were added to the playlist through Lumio.',
    libraryDates:
      "Jellyfin doesn't keep when a song was put into a playlist, and Lumio doesn't know it for every song here. So it goes by when the songs came into the library.",
    mixerNote: 'Songs that end up next to each other get automatic transitions from the mixer.',
    cancel: 'Cancel',
    confirm: 'Sort',
    sorted: 'Playlist sorted',
  },
})

/**
 * The "Sortieren" menu of a playlist the user owns: sorts the playlist itself (on Jellyfin), after asking, with
 * progress for long playlists and "Rückgängig" afterwards (on the message and here, for the session). "Passend" hands
 * over to the mixer's sorting dialog (`onSuited`).
 */
export function PlaylistSortMenu({ playlistId, tracks, mixing, onSuited }: { playlistId: string; tracks: BaseItemDto[]; mixing: boolean; onSuited: () => void }) {
  const t = useMessages(messages)
  const rt = useMessages(reorderMessages)
  const adds = usePlaylistAdds(playlistId, true).data
  const dates = addedDates(tracks, adds)
  const { reorder, undo, progress } = usePlaylistReorder(playlistId)
  const announce = useAnnounceReorder(playlistId, tracks)
  const previous = usePreviousOrder(playlistId)
  const [asking, setAsking] = useState<PlaylistSortKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A song twice can't be moved on its own: said before anything is tried.
  const shared = hasSharedEntries(tracks.map((track) => track.PlaylistItemId))

  const labels: Record<PlaylistSortKey, string> = {
    titleAsc: t.titleAsc,
    titleDesc: t.titleDesc,
    artist: t.artist,
    album: t.album,
    addedNewest: dates.source === 'playlist' ? t.playlistNewest : t.libraryNewest,
    addedOldest: dates.source === 'playlist' ? t.playlistOldest : t.libraryOldest,
    duration: t.duration,
  }
  const icons: Record<PlaylistSortKey, ReactNode> = {
    titleAsc: <IconSortAscendingLetters />,
    titleDesc: <IconSortDescendingLetters />,
    artist: <IconUser />,
    album: <IconDisc />,
    addedNewest: <IconCalendar />,
    addedOldest: <IconCalendar />,
    duration: <IconClock />,
  }

  const ask = (key: PlaylistSortKey) => {
    setError(null)
    setAsking(key)
  }

  const sort = async () => {
    if (!asking || busy) return
    setBusy(true)
    try {
      const outcome = await reorder(sortPlaylist(tracks, asking, dates.at), tracks)
      if (outcome.kind === 'done' || outcome.kind === 'unchanged') {
        announce(outcome, t.sorted)
        setAsking(null)
      } else setError(outcomeText(rt, outcome))
    } finally {
      setBusy(false)
    }
  }

  const takeBack = async () => {
    const outcome = await undo(tracks)
    if (outcome === 'gone') toast.error(rt.undoGone)
    else if (outcome.kind === 'done' || outcome.kind === 'unchanged') toast.success(rt.undone)
    else toast.error(outcomeText(rt, outcome) ?? rt.failed)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={t.sort} title={t.sort} className="grid size-10 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <IconArrowsSort className="size-6" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t.sortBy}</DropdownMenuLabel>
            {(Object.keys(labels) as PlaylistSortKey[]).map((key) => (
              <DropdownMenuItem key={key} disabled={tracks.length < 2} onClick={() => ask(key)}>
                {icons[key]} {labels[key]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem disabled={tracks.length < 2} onClick={onSuited}>
              <IconSparkles /> {t.suited}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {previous && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void takeBack()}>
                <IconArrowBackUp /> {t.undo}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={asking !== null} onOpenChange={(open) => !open && !busy && setAsking(null)}>
        <DialogContent className="gap-4 p-6 sm:max-w-md">
          <div className="space-y-2 pr-8">
            <DialogTitle className="text-xl font-bold">{asking ? t.confirmTitle(labels[asking]) : ''}</DialogTitle>
            <DialogDescription>{t.confirmText}</DialogDescription>
          </div>
          {(asking === 'addedNewest' || asking === 'addedOldest') && (
            <p className="text-sm text-muted-foreground">{dates.source === 'playlist' ? t.playlistDates : t.libraryDates}</p>
          )}
          {mixing && <p className="text-sm text-muted-foreground">{t.mixerNote}</p>}
          {(error ?? (shared ? rt.duplicates : null)) && <p className="text-sm text-destructive">{error ?? rt.duplicates}</p>}
          <DialogFooter className="items-center gap-2">
            {progress && progress.total > 0 && <span className="mr-auto text-sm text-muted-foreground tabular-nums">{rt.moving(progress.done, progress.total)}</span>}
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
              {t.cancel}
            </Button>
            <Button disabled={busy || shared} onClick={() => void sort()}>
              {busy && <IconLoader2 className="animate-spin" />}
              {t.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
