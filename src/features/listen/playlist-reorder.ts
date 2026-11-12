import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAuthedSession } from '@/features/auth/session'
import { defineMessages, useMessages } from '@/lib/i18n'
import { dropStaleBakes } from './mixer/mixmode/bake'
import { mixerKey, useStableLumioFetch } from './mixer/queries'
import { entriesInOrder, hasSharedEntries, planMoves } from './mixer/reorder'

/**
 * Putting a playlist into a new order on Jellyfin (sorting it, "sort & build transitions"), and taking that back.
 *
 * Jellyfin only moves one entry at a time, so the new order is reached with as few moves as possible (see
 * mixer/reorder.ts), one after the other:
 * - first the playlist is fetched fresh: it must still be what the order was worked out from (someone may have changed
 *   it meanwhile), and its entries must be told apart (a song twice can't be moved on its own);
 * - should a move fail, the rest isn't tried and the playlist shows what Jellyfin has now;
 * - afterwards the order is checked: Jellyfin counts positions among the songs this person can see, so with hidden ones
 *   in the playlist a move can land elsewhere than planned.
 * The order before is kept for this session (per playlist), so the change can be taken back.
 */

export type ReorderOutcome =
  | { kind: 'done'; moves: number }
  | { kind: 'unchanged' }
  | { kind: 'duplicates' }
  | { kind: 'changed' }
  | { kind: 'partial'; done: number; total: number }
  | { kind: 'notReached' }
  | { kind: 'failed' }

export const reorderMessages = defineMessages({
  de: {
    moving: (done: number, total: number) => `Reihenfolge wird gespeichert … ${done}/${total}`,
    unchanged: 'Die Playlist ist schon so sortiert.',
    duplicates:
      'Diese Playlist enthält Songs doppelt. Jellyfin kann doppelte Einträge nicht einzeln verschieben, deshalb lässt sie sich nicht automatisch sortieren. Entferne die doppelten Songs und versuch es noch einmal.',
    changed: 'Die Playlist hat sich gerade geändert. Lumio rechnet mit der neuen Reihenfolge noch einmal.',
    partial: (done: number, total: number) =>
      `Die Reihenfolge wurde nur teilweise gespeichert (${done} von ${total} Verschiebungen). Versuch es noch einmal.`,
    notReached: 'Jellyfin hat die Songs nicht ganz in die neue Reihenfolge gebracht (vermutlich wegen Songs, die du nicht sehen kannst).',
    failed: 'Die Reihenfolge konnte nicht gespeichert werden.',
    undo: 'Rückgängig',
    undone: 'Alte Reihenfolge wiederhergestellt',
    undoGone: 'Die Playlist hat sich seitdem geändert; die alte Reihenfolge lässt sich nicht mehr herstellen.',
  },
  en: {
    moving: (done: number, total: number) => `Saving the order … ${done}/${total}`,
    unchanged: 'The playlist is already in this order.',
    duplicates:
      "This playlist has songs in it twice. Jellyfin can't move repeated entries one by one, so it can't be sorted automatically. Remove the repeated songs and try again.",
    changed: 'The playlist just changed. Lumio works it out again with the new order.',
    partial: (done: number, total: number) => `The order was only partly saved (${done} of ${total} moves). Please try again.`,
    notReached: "Jellyfin didn't quite put the songs in the new order (probably because of songs you can't see).",
    failed: 'The order could not be saved.',
    undo: 'Undo',
    undone: 'Previous order restored',
    undoGone: 'The playlist has changed since; the previous order can no longer be restored.',
  },
})

type Messages = (typeof reorderMessages)['de']

/** What to tell about an outcome that isn't a success (null for 'done'). */
export function outcomeText(t: Messages, outcome: ReorderOutcome): string | null {
  switch (outcome.kind) {
    case 'done':
      return null
    case 'unchanged':
      return t.unchanged
    case 'duplicates':
      return t.duplicates
    case 'changed':
      return t.changed
    case 'partial':
      return t.partial(outcome.done, outcome.total)
    case 'notReached':
      return t.notReached
    case 'failed':
      return t.failed
  }
}

/** A playlist's songs in order with their entries, as compared before moving ("is it still what was sorted?"). */
export const playlistSignature = (tracks: readonly BaseItemDto[]) => tracks.map((track) => `${track.PlaylistItemId}:${track.Id}`).join(',')

// ---- the order before, per playlist, for this session ----

const previousOrders = new Map<string, string[]>()
const undoListeners = new Set<() => void>()
function setPrevious(playlistId: string, order: string[] | null) {
  if (order) previousOrders.set(playlistId, order)
  else previousOrders.delete(playlistId)
  for (const listener of undoListeners) listener()
}

/** The song order a playlist had before Lumio last changed it in this session (to take it back), or null. */
export function usePreviousOrder(playlistId: string): string[] | null {
  return useSyncExternalStore(
    (listener) => {
      undoListeners.add(listener)
      return () => undoListeners.delete(listener)
    },
    () => previousOrders.get(playlistId) ?? null,
  )
}

/** Puts a playlist into an order (track ids, in the new order), with progress; see the comment above. */
export function usePlaylistReorder(playlistId: string) {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const lumioFetch = useStableLumioFetch()
  const tracksKey = ['playlist-tracks', session.userId, playlistId]

  /**
   * Moves the playlist into `order`. `basis` is the playlist as the order was worked out from it; `remember` keeps the
   * order before for undo (not when undoing).
   */
  const reorder = async (order: readonly string[], basis: readonly BaseItemDto[], remember = true): Promise<ReorderOutcome> => {
    const playlists = getPlaylistApi(api)
    setProgress({ done: 0, total: 0 })
    let moved = 0
    let before: string[] | null = null
    try {
      const fresh = (await playlists.getPlaylistItems({ playlistId, userId: session.userId })).data.Items ?? []
      if (hasSharedEntries(fresh.map((track) => track.PlaylistItemId))) {
        void queryClient.invalidateQueries({ queryKey: tracksKey })
        return { kind: 'duplicates' }
      }
      if (playlistSignature(fresh) !== playlistSignature(basis)) {
        void queryClient.invalidateQueries({ queryKey: tracksKey })
        return { kind: 'changed' }
      }
      before = fresh.map((track) => track.Id ?? '')
      const entries = fresh.map((track) => ({ id: track.Id ?? '', entry: track.PlaylistItemId ?? '' }))
      const moves = planMoves(
        entries.map((entry) => entry.entry),
        entriesInOrder(entries, order),
      )
      if (!moves.length) return { kind: 'unchanged' }
      setProgress({ done: 0, total: moves.length })
      for (const move of moves) {
        try {
          await playlists.moveItem({ playlistId, itemId: move.entry, newIndex: move.index })
        } catch {
          return { kind: 'partial', done: moved, total: moves.length }
        }
        moved++
        setProgress({ done: moved, total: moves.length })
      }
      const after = (await playlists.getPlaylistItems({ playlistId, userId: session.userId })).data.Items ?? []
      if (after.map((track) => track.Id).join(',') !== order.join(',')) return { kind: 'notReached' }
      return { kind: 'done', moves: moves.length }
    } catch {
      return { kind: 'failed' }
    } finally {
      setProgress(null)
      if (moved > 0) {
        await queryClient.invalidateQueries({ queryKey: tracksKey })
        // Baked clips of pairs that are no longer neighbours are let go (mixer playlists).
        const now = queryClient.getQueryData<BaseItemDto[]>(tracksKey)
        if (now) void dropStaleBakes(lumioFetch, playlistId, now.map((track) => track.Id ?? '')).then(() => queryClient.invalidateQueries({ queryKey: mixerKey(playlistId) }))
        // Whatever was reached, the order before can be had back.
        if (remember && before) setPrevious(playlistId, before)
      }
    }
  }

  /** Takes the last change back (to the order before it), if the playlist still holds the same songs. */
  const undo = async (current: readonly BaseItemDto[]): Promise<ReorderOutcome | 'gone'> => {
    const previous = previousOrders.get(playlistId)
    if (!previous) return 'gone'
    const now = current.map((track) => track.Id ?? '')
    if (now.length !== previous.length || [...now].sort().join(',') !== [...previous].sort().join(',')) {
      setPrevious(playlistId, null)
      return 'gone'
    }
    const outcome = await reorder(previous, current, false)
    if (outcome.kind === 'done' || outcome.kind === 'unchanged') setPrevious(playlistId, null)
    return outcome
  }

  return { reorder, undo, progress }
}

/**
 * Tells that a playlist was put into a new order, with "Rückgängig" on the message (for `unchanged`: says it already
 * was). The undo reads the playlist as it is when clicked.
 */
export function useAnnounceReorder(playlistId: string, tracks: readonly BaseItemDto[]) {
  const t = useMessages(reorderMessages)
  const { undo } = usePlaylistReorder(playlistId)
  const latest = useRef(tracks)
  useEffect(() => {
    latest.current = tracks
  }, [tracks])
  const takeBack = async () => {
    const outcome = await undo(latest.current)
    if (outcome === 'gone') toast.error(t.undoGone)
    else if (outcome.kind === 'done' || outcome.kind === 'unchanged') toast.success(t.undone)
    else toast.error(outcomeText(t, outcome) ?? t.failed)
  }
  return (outcome: ReorderOutcome, message: string) => {
    if (outcome.kind === 'unchanged') toast(t.unchanged)
    // Long enough to notice and take back.
    else toast.success(message, { duration: 10_000, action: { label: t.undo, onClick: () => void takeBack() } })
  }
}
