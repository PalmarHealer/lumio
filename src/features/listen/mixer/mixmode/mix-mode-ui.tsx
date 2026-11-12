import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { IconAlertTriangle, IconLoader2, IconWaveSine } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ticksToSeconds } from '@/lib/format'
import { defineMessages, useMessages } from '@/lib/i18n'
import type { LumioFetch } from '@/features/social/social'
import { useStableLumioFetch } from '../queries'
import type { PlaylistMixer } from '../types'
import { leaveMixMode, preheat, setMixMode, songStemState, stemStatus, useMixMode } from './mix-mode'
import { playlistWindows } from './windows'

const messages = defineMessages({
  de: {
    start: 'Mix-Modus starten',
    leave: 'Mix-Modus beenden',
    baking: 'Mix-Modus wird beendet …',
    noWorker: 'Auf diesem Lumio-Server trennt niemand Stems; der Mix-Modus ist hier nicht verfügbar.',
    forbidden: 'Nur wer die Playlist bearbeiten darf, kann den Mix-Modus starten.',
    failed: 'Der Mix-Modus konnte nicht gestartet werden.',
    on: 'Mix-Modus',
    onHint: 'Echte Stems (Stimme, Drums, Instrumental) für die Übergänge. Beim Beenden werden deine eigenen Übergänge gebacken.',
    ready: (ready: number, total: number) => `${ready} von ${total} Songs mit Stems`,
    failedSongs: (n: number) => (n === 1 ? '1 Song ging nicht' : `${n} Songs gingen nicht`),
    bakingNow: (done: number, total: number) => `Übergänge werden gebacken: ${done} von ${total}`,
    bakingHint: 'Das läuft im Hintergrund weiter, auch wenn du die Seite verlässt.',
    retry: 'Erneut versuchen',
  },
  en: {
    start: 'Start Mix mode',
    leave: 'Leave Mix mode',
    baking: 'Leaving Mix mode …',
    noWorker: 'Nobody separates stems on this Lumio server; Mix mode is not available here.',
    forbidden: 'Only those who may edit the playlist can start Mix mode.',
    failed: 'Mix mode could not be started.',
    on: 'Mix mode',
    onHint: 'Real stems (voice, drums, instrumental) for the transitions. Leaving bakes your own transitions.',
    ready: (ready: number, total: number) => `${ready} of ${total} songs with stems`,
    failedSongs: (n: number) => (n === 1 ? '1 song failed' : `${n} songs failed`),
    bakingNow: (done: number, total: number) => `Baking transitions: ${done} of ${total}`,
    bakingHint: 'This carries on in the background, also when you leave the page.',
    retry: 'Try again',
  },
})

/** While the stems are coming, they are asked for this often. */
const POLL_MS = 10_000

const ids = (tracks: readonly BaseItemDto[]) => tracks.map((track) => track.Id ?? '').filter(Boolean)

/** Asks the server for the stems of the windows around the playlist's transitions (again: failed ones are retried). */
function heat(lumioFetch: LumioFetch, playlistId: string, tracks: readonly BaseItemDto[], mixer: PlaylistMixer | undefined) {
  const durations = Object.fromEntries(tracks.map((track) => [track.Id ?? '', ticksToSeconds(track.RunTimeTicks ?? 0)]))
  const windows = playlistWindows(ids(tracks), mixer?.transitions ?? {}, durations)
  return preheat(
    lumioFetch,
    playlistId,
    Object.entries(windows).map(([id, list]) => ({ id, windows: list })),
  )
}

/**
 * Starting and leaving a playlist's Mix-Modus, in its "…" menu (for its editors). Starting asks the server for the
 * stems of the windows around the transitions; leaving hands the playlist's own transitions of neighbouring songs to
 * the baking (see mix-mode-host.tsx), which lets the stems go when it is done.
 */
export function MixModeMenuItem({ playlistId, tracks, mixer }: { playlistId: string; tracks: BaseItemDto[]; mixer: PlaylistMixer | undefined }) {
  const t = useMessages(messages)
  const state = useMixMode(playlistId)
  const lumioFetch = useStableLumioFetch()
  const [starting, setStarting] = useState(false)

  const start = async () => {
    setStarting(true)
    try {
      const answer = await heat(lumioFetch, playlistId, tracks, mixer)
      if (answer === 'unavailable') return void toast.error(t.noWorker)
      if (answer === 'forbidden') return void toast.error(t.forbidden)
      if (answer === 'failed') return void toast.error(t.failed)
      setMixMode(playlistId, { phase: 'on', since: Date.now() })
    } finally {
      setStarting(false)
    }
  }

  const leave = () => leaveMixMode(lumioFetch, playlistId, ids(tracks), mixer?.transitions)

  if (state?.phase === 'baking')
    return (
      <DropdownMenuItem disabled>
        <IconLoader2 className="animate-spin" /> {t.baking}
      </DropdownMenuItem>
    )
  return state ? (
    <DropdownMenuItem onClick={leave}>
      <IconWaveSine /> {t.leave}
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem disabled={starting} onClick={() => void start()}>
      {starting ? <IconLoader2 className="animate-spin" /> : <IconWaveSine />} {t.start}
    </DropdownMenuItem>
  )
}

/** On the playlist page while in Mix-Modus: how far the stems are, or the baking when leaving it. */
export function MixModeBanner({ playlistId, tracks, mixer, canLeave }: { playlistId: string; tracks: BaseItemDto[]; mixer: PlaylistMixer | undefined; canLeave: boolean }) {
  const t = useMessages(messages)
  const state = useMixMode(playlistId)
  const lumioFetch = useStableLumioFetch()
  const songIds = ids(tracks)
  const status = useQuery({
    queryKey: ['stem-status', playlistId, songIds.join(',')],
    enabled: state?.phase === 'on' && songIds.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data
      return data && songIds.every((id) => songStemState(data[id]) !== 'waiting') ? false : POLL_MS
    },
    queryFn: () => stemStatus(lumioFetch, songIds),
  })
  if (!state) return null

  if (state.phase === 'baking') {
    const total = state.done + state.failed.length + state.pending.length
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-listen/30 bg-listen/10 px-4 py-3 text-sm">
        <IconLoader2 className="size-4 animate-spin text-listen" />
        <span className="font-medium">{t.bakingNow(state.done + state.failed.length, total)}</span>
        <span className="text-muted-foreground">{t.bakingHint}</span>
      </div>
    )
  }

  const states = songIds.map((id) => songStemState(status.data?.[id]))
  const ready = states.filter((s) => s === 'ready').length
  const failed = states.filter((s) => s === 'failed').length
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-listen/30 bg-listen/10 px-4 py-3 text-sm">
      <IconWaveSine className="size-4 text-listen" />
      <span className="font-semibold">{t.on}</span>
      <span className="tabular-nums">{t.ready(ready, songIds.length)}</span>
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={songIds.length} aria-valuenow={ready}>
        <div className="h-full rounded-full bg-listen transition-[width] duration-500" style={{ width: `${songIds.length ? (ready / songIds.length) * 100 : 0}%` }} />
      </div>
      {failed > 0 && (
        <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
          <IconAlertTriangle className="size-4" /> {t.failedSongs(failed)}
          {canLeave && (
            <Button size="sm" variant="ghost" onClick={() => void heat(lumioFetch, playlistId, tracks, mixer).then(() => status.refetch())}>
              {t.retry}
            </Button>
          )}
        </span>
      )}
      <span className="basis-full text-muted-foreground sm:basis-auto">{t.onHint}</span>
      {canLeave && (
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => leaveMixMode(lumioFetch, playlistId, songIds, mixer?.transitions)}>
          {t.leave}
        </Button>
      )}
    </div>
  )
}
