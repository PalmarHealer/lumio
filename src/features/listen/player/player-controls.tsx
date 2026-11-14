import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { useRemote, type RemoteTarget } from '@/features/remote/remote-provider'
import { useRemoteSession } from '@/features/remote/remote-session'
import { readLocalSettings } from '@/features/settings/local-settings'
import { secondsToTicks, ticksToSeconds } from '@/lib/format'
import { continuation } from '../radio'
import { currentTrack, music, useMusic, useMusicTime, useRemoteStart, type MusicTime, type RepeatMode } from './music-player'

/**
 * What Listen's player shows and steers — the player bar, the side panel (lyrics, queue, now playing), the big view:
 * this device's music player, or another device Lumio controls ("play on"). Everything looks and works the same
 * either way; only where the state comes from and where commands go differs. The position lives in a context of its
 * own, so only what shows it follows it several times a second.
 */
export interface PlayerControls {
  track: BaseItemDto | undefined
  playing: boolean
  buffering: boolean
  shuffle: boolean
  repeat: RepeatMode
  /** 0..1 */
  volume: number
  muted: boolean
  toggle: () => void
  next: () => void
  previous: () => void
  seek: (seconds: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  /** Set while controlling another device: its name, the way back, and its queue (as far as it tells). */
  remote?: {
    name: string
    disconnect: () => void
    queue: BaseItemDto[]
    /** Position of the current track in `queue` (-1 when unknown). */
    index: number
    jump: (index: number) => void
  }
}

const PlayerControlsContext = createContext<PlayerControls | null>(null)
const PlayerTimeContext = createContext<MusicTime>({ position: 0, duration: 0 })

export function usePlayerControls(): PlayerControls {
  const controls = useContext(PlayerControlsContext)
  if (!controls) throw new Error('usePlayerControls must be used inside ListenControlsProvider')
  return controls
}

/**
 * What plays — on this device, or on the one Lumio controls — for pages marking "this is playing": the track, whether
 * it runs, and the collection it was started from (null when unknown, e.g. started on the device itself).
 */
export function useNowPlaying(): { track: BaseItemDto | undefined; playing: boolean; source: string | null; toggle: () => void } {
  const controls = useContext(PlayerControlsContext)
  const state = useMusic()
  const started = useRemoteStart()
  if (controls?.remote) {
    const track = controls.track
    return { track, playing: controls.playing, source: track?.Id && started.ids.has(track.Id) ? started.source : null, toggle: controls.toggle }
  }
  return { track: currentTrack(state), playing: state.playing, source: state.index >= 0 ? state.source : null, toggle: music.toggle }
}

/** Where the playing track is, in seconds (this device's, or the controlled one's). */
export function usePlayerTime(): MusicTime {
  return useContext(PlayerTimeContext)
}

function useLocalControls(): PlayerControls {
  const state = useMusic()
  return {
    track: currentTrack(state),
    playing: state.playing,
    buffering: state.buffering,
    shuffle: state.shuffle,
    repeat: state.repeat,
    volume: state.volume,
    muted: state.muted,
    toggle: music.toggle,
    next: music.next,
    previous: music.previous,
    seek: music.seek,
    toggleShuffle: music.toggleShuffle,
    cycleRepeat: music.cycleRepeat,
    setVolume: music.setVolume,
    toggleMute: music.toggleMute,
  }
}

const REPEAT_TO_JELLYFIN: Record<RepeatMode, string> = { off: 'RepeatNone', all: 'RepeatAll', one: 'RepeatOne' }
const REPEAT_FROM_JELLYFIN: Record<string, RepeatMode> = { RepeatNone: 'off', RepeatAll: 'all', RepeatOne: 'one' }

/** The last known position of the controlled device, from which the shown one moves on. */
interface RemoteClock {
  /** Seconds at `at`. */
  position: number
  at: number
  paused: boolean
  duration: number
}

/**
 * Another device: what plays there and its queue (asked every couple of seconds), commands sent there and applied here
 * at once, so everything answers before the device reports back. null without a device.
 */
function useRemoteControls(target: RemoteTarget | null, disconnect: () => void): { controls: PlayerControls; clock: RemoteClock } | null {
  const { api, session } = useAuthedSession()
  const { query: sessions, remote, anchor } = useRemoteSession(target?.sessionId)
  const queueIds = (remote?.NowPlayingQueue ?? []).map((entry) => entry.Id!).filter(Boolean)
  const queueItems = useQuery({
    queryKey: ['remote-queue', queueIds.join(',')],
    enabled: queueIds.length > 0,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    queryFn: async () => (await getLibraryApi(api).getItems({ userId: session.userId, ids: queueIds })).data.Items ?? [],
  })
  const [pending, setPending] = useState<{ at: number; paused?: boolean; position?: number; volume?: number; muted?: boolean; shuffle?: boolean; repeat?: RepeatMode }>({ at: 0 })
  // The volume set here, kept a moment longer than other changes: devices apply it in their own time.
  const [volumeSet, setVolumeSet] = useState<{ value: number; at: number } | null>(null)
  // Dragging the volume sends the newest level at most every 150 ms, not every step (devices work through each one).
  const volumeTimer = useRef<number | undefined>(undefined)
  const volumeLatest = useRef<number | null>(null)
  const queryClient = useQueryClient()

  // A device that isn't Lumio plays the list it was sent and stops at its end; it doesn't know Lumio's autoplay. While
  // this app steers it, shortly before the end it gets the next similar songs added to its queue.
  const isLumio = remote?.Client === 'Lumio'
  const nearEndOf = !isLumio && queueIds.length > 0 ? queueIds.slice(-2).join(',') : ''
  const extendedFor = useRef('')
  useEffect(() => {
    if (!target || !nearEndOf || extendedFor.current === nearEndOf || !readLocalSettings(session.userId).musicAutoplay) return
    const ids = (remote?.NowPlayingQueue ?? []).map((entry) => entry.Id!)
    const position = (remote?.NowPlayingQueue ?? []).findIndex((entry) => entry.PlaylistItemId && entry.PlaylistItemId === remote?.PlaylistItemId)
    const at = position >= 0 ? position : ids.indexOf(remote?.NowPlayingItem?.Id ?? '')
    if (at < 0 || at < ids.length - 2) return
    extendedFor.current = nearEndOf
    const played = queueItems.data ?? []
    void continuation(api, session.userId, queryClient, played)
      .then((more) => {
        const known = new Set(ids)
        const next = more.filter((item) => item.Id && !known.has(item.Id)).slice(0, 10)
        if (next.length) return getSessionApi(api).play({ sessionId: target.sessionId, playCommand: 'PlayLast', itemIds: next.map((item) => item.Id!) })
      })
      .catch(() => {
        extendedFor.current = ''
      })
  })
  if (!target) return null

  const state = remote?.PlayState
  const track = remote?.NowPlayingItem
  const reportedAt = sessions.dataUpdatedAt
  // Changes sent but not reported back yet are shown right away (dropped once a newer report is in).
  const fresh = pending.at > reportedAt ? pending : { at: 0 }
  const paused = fresh.paused ?? state?.IsPaused ?? true
  const duration = ticksToSeconds(track?.RunTimeTicks ?? 0)
  const clock: RemoteClock =
    fresh.position !== undefined
      ? { position: fresh.position, at: fresh.at, paused, duration }
      : // Where the device's playback stood and when (see useRemoteAnchor), so lyrics and the bar keep time with it.
        { position: anchor?.position ?? 0, at: anchor?.at ?? reportedAt, paused, duration }
  const positionNow = () => Math.min(duration || Infinity, clock.position + (clock.paused ? 0 : Math.max(0, Date.now() - clock.at) / 1000))

  const byId = new Map((queueItems.data ?? []).map((item) => [item.Id, item]))
  const queue = queueIds.map((id) => byId.get(id)).filter((item): item is BaseItemDto => !!item)
  const playlistIndex = (remote?.NowPlayingQueue ?? []).findIndex((entry) => entry.PlaylistItemId && entry.PlaylistItemId === remote?.PlaylistItemId)
  const index = playlistIndex >= 0 ? playlistIndex : queue.findIndex((item) => item.Id === track?.Id)

  const commands = getSessionApi(api)
  const sessionId = target.sessionId
  const changed = (patch: Omit<typeof pending, 'at'>) => setPending((current) => ({ ...(current.at > reportedAt ? current : {}), ...patch, at: Date.now() }))
  const refresh = () => void sessions.refetch()
  const playstate = (command: 'PlayPause' | 'NextTrack' | 'PreviousTrack' | 'Seek', seekPositionTicks?: number) =>
    void commands.sendPlaystateCommand({ sessionId, command, seekPositionTicks }).then(refresh).catch(() => undefined)
  const general = (Name: string, Arguments: Record<string, string> = {}) =>
    void commands.sendFullGeneralCommand({ sessionId, generalCommand: { Name: Name as never, Arguments } }).then(refresh).catch(() => undefined)

  const shuffle = fresh.shuffle ?? state?.PlaybackOrder === 'Shuffle'
  const repeat = fresh.repeat ?? REPEAT_FROM_JELLYFIN[state?.RepeatMode ?? ''] ?? 'off'
  // The level set here wins over reports until one comes in a few seconds after it (the device has applied it by then).
  const volume = volumeSet && reportedAt < volumeSet.at + 3000 ? volumeSet.value : (state?.VolumeLevel ?? 100) / 100
  const muted = fresh.muted ?? !!state?.IsMuted
  const controls: PlayerControls = {
    track,
    playing: !!track && !paused,
    buffering: sessions.isLoading,
    shuffle,
    repeat,
    volume,
    muted,
    toggle: () => {
      changed({ paused: !paused, position: positionNow() })
      playstate('PlayPause')
    },
    next: () => playstate('NextTrack'),
    previous: () => playstate('PreviousTrack'),
    seek: (seconds) => {
      const clamped = Math.max(0, duration ? Math.min(seconds, duration) : seconds)
      changed({ position: clamped })
      playstate('Seek', secondsToTicks(clamped))
    },
    toggleShuffle: () => {
      changed({ shuffle: !shuffle })
      general('SetShuffleQueue', { ShuffleMode: shuffle ? 'Sorted' : 'Shuffle' })
    },
    cycleRepeat: () => {
      const next: RepeatMode = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'
      changed({ repeat: next })
      general('SetRepeatMode', { RepeatMode: REPEAT_TO_JELLYFIN[next] })
    },
    setVolume: (level) => {
      setVolumeSet({ value: level, at: Date.now() })
      changed({ muted: false })
      volumeLatest.current = level
      if (volumeTimer.current !== undefined) return
      const flush = () => {
        const latest = volumeLatest.current
        volumeLatest.current = null
        if (latest === null) {
          volumeTimer.current = undefined
          return
        }
        void commands.sendFullGeneralCommand({ sessionId, generalCommand: { Name: 'SetVolume', Arguments: { Volume: String(Math.round(latest * 100)) } } }).catch(() => undefined)
        volumeTimer.current = window.setTimeout(flush, 150)
      }
      flush()
    },
    toggleMute: () => {
      changed({ muted: !muted })
      general('ToggleMute')
    },
    remote: {
      name: target.name,
      disconnect,
      queue,
      index,
      // The device's queue from that song on (Jellyfin's remote commands can't jump within a queue).
      jump: (at) =>
        void commands
          .play({ sessionId, playCommand: 'PlayNow', itemIds: queueIds, startIndex: at })
          .then(refresh)
          .catch(() => undefined),
    },
  }
  return { controls, clock }
}

/** Provides Listen's player — this device's, or the one Lumio controls — to the bar, the side panel and the big view. */
export function ListenControlsProvider({ children }: { children: ReactNode }) {
  const remoteContext = useRemote()
  const local = useLocalControls()
  const remote = useRemoteControls(remoteContext.target, () => remoteContext.setTarget(null))
  return (
    <PlayerControlsContext value={remote?.controls ?? local}>
      <PlayerTime clock={remote?.clock}>{children}</PlayerTime>
    </PlayerControlsContext>
  )
}

/** The position, several times a second: this device's player, or the controlled one's moving on from its last report. */
function PlayerTime({ clock, children }: { clock: RemoteClock | undefined; children: ReactNode }) {
  const local = useMusicTime()
  const [now, setNow] = useState(() => Date.now())
  const ticking = !!clock && !clock.paused
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [ticking])
  const time = clock
    ? {
        position: Math.min(clock.duration || Infinity, clock.position + (clock.paused ? 0 : Math.max(0, now - clock.at) / 1000)),
        duration: clock.duration,
      }
    : local
  return <PlayerTimeContext value={time}>{children}</PlayerTimeContext>
}
