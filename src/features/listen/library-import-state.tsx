import type { Api } from '@jellyfin/sdk'
import { IconTrash } from '@tabler/icons-react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAuthedSession } from '@/features/auth/session'
import { lumioFetch, useLumioFetch } from '@/features/social/social'
import { defineMessages, messagesFor, useMessages } from '@/lib/i18n'
import { libraryImports, newLibraryItems, rematchLibraryImports, refreshAfterImport, removeLibraryImport, waitingRows, type LibraryImportRow } from './library-import'

/**
 * The Spotify library import in the app: what waits for Jellyfin (greyed out in the library, Liked Songs and
 * playlists), removing it, and looking for it again: every quarter hour among the items new in Jellyfin, once a day in
 * the whole library (an item fixed up later keeps its old date).
 */
export const pendingMessages = defineMessages({
  de: {
    notInLibrary: 'Noch nicht in der Bibliothek',
    remove: 'Entfernen',
    removed: 'Entfernt',
    arrived: (count: number) => (count === 1 ? 'Ein Titel aus deinem Spotify-Import ist jetzt da' : `${count} Titel aus deinem Spotify-Import sind jetzt da`),
  },
  en: {
    notInLibrary: 'Not in the library yet',
    remove: 'Remove',
    removed: 'Removed',
    arrived: (count: number) => (count === 1 ? 'One item from your Spotify import has arrived' : `${count} items from your Spotify import have arrived`),
  },
})

const CHECK_EVERY_MS = 15 * 60_000
const FULL_EVERY_MS = 24 * 60 * 60_000

const importsKey = (userId: string) => ['library-imports', userId]

/** The imported library as the Lumio server keeps it (empty without the server). */
export function useLibraryImports() {
  const { session } = useAuthedSession()
  const request = useLumioFetch()
  return useQuery({ queryKey: importsKey(session.userId), staleTime: 5 * 60_000, retry: false, queryFn: () => libraryImports(request) })
}

/** What still waits for Jellyfin: liked songs, albums, artists, and each playlist's record by its Jellyfin id. */
export function usePendingImports() {
  const rows = useLibraryImports().data ?? []
  const waiting = waitingRows(rows)
  return {
    tracks: waiting.filter((row) => row.kind === 'track'),
    albums: waiting.filter((row) => row.kind === 'album'),
    artists: waiting.filter((row) => row.kind === 'artist'),
    playlist: (playlistId: string | undefined) => (playlistId ? rows.find((row) => row.kind === 'playlist' && row.data.playlistId === playlistId) : undefined),
    count: waiting.reduce((sum, row) => sum + (row.kind === 'playlist' ? (row.data.entries ?? []).filter((entry) => !entry.id).length : 1), 0),
  }
}

/** Forgets a waiting entry; a playlist's waiting song is taken out of the playlist's record. */
export function useRemovePending() {
  const { session } = useAuthedSession()
  const request = useLumioFetch()
  const queryClient = useQueryClient()
  const t = useMessages(pendingMessages)
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: importsKey(session.userId) })
    toast.success(t.removed)
  }
  return {
    entry: (row: LibraryImportRow) => void removeLibraryImport(request, { kind: row.kind, extId: row.extId }).then(done, () => undefined),
    playlistSong: (row: LibraryImportRow, index: number) => {
      const entries = (row.data.entries ?? []).filter((_, at) => at !== index)
      const complete = entries.every((entry) => entry.id)
      void request(`/me/library-imports/spotify`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ ...row, data: { ...row.data, entries }, matchedId: complete ? (row.data.playlistId ?? null) : null }] }),
      }).then(done, () => undefined)
    },
  }
}

/** The menu of a greyed-out entry: removing it. */
export function PendingMenuItems({ onRemove }: { onRemove: () => void }) {
  const t = useMessages(pendingMessages)
  return (
    <DropdownMenuItem variant="destructive" onClick={onRemove}>
      <IconTrash /> {t.remove}
    </DropdownMenuItem>
  )
}

const stored = (key: string) => {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}
const store = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Without storage the next start just looks again.
  }
}

async function check(api: Api, userId: string, queryClient: QueryClient) {
  const rows = await queryClient.fetchQuery({ queryKey: importsKey(userId), staleTime: 60_000, queryFn: () => libraryImports(lumioFetch) })
  const waiting = waitingRows(rows)
  if (!waiting.length) return
  const checkedKey = `lumio.library-import.checked:${userId}`
  const fullKey = `lumio.library-import.full:${userId}`
  const now = Date.now()
  // Since the last look here; on a new device since the import.
  const since = stored(checkedKey) || Math.max(...rows.map((row) => row.at ?? 0))
  let found = 0
  if (now - stored(fullKey) > FULL_EVERY_MS) {
    found = await rematchLibraryImports(api, userId, lumioFetch)
    store(fullKey, now)
  } else {
    const fresh = await newLibraryItems(api, userId, since)
    if (fresh.length) found = await rematchLibraryImports(api, userId, lumioFetch, fresh)
  }
  store(checkedKey, now)
  refreshAfterImport(queryClient, userId)
  if (found) toast.success(messagesFor(pendingMessages).arrived(found))
}

/** Looks for what the import still waits for, from the start and every quarter hour (see the top). */
export function useLibraryImportSync(api: Api | undefined, userId: string | undefined) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!api || !userId) return
    let busy = false
    const run = () => {
      if (busy) return
      busy = true
      void check(api, userId, queryClient)
        .catch(() => undefined)
        .finally(() => (busy = false))
    }
    // A moment after the start, so the first screens load first.
    const first = window.setTimeout(run, 20_000)
    const timer = window.setInterval(run, CHECK_EVERY_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [api, userId, queryClient])
}
