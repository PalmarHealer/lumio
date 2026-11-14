import type {
  GeneralCommand,
  GroupInfoDto,
  GroupUpdate,
  PlayQueueUpdate,
  PlayRequest,
  PlaystateRequest,
  SendCommand,
} from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import { getSyncPlayApi } from '@jellyfin/sdk/lib/utils/api/sync-play-api'
import { getSystemApi } from '@jellyfin/sdk/lib/utils/api/system-api'
import { WebSocketService } from '@jellyfin/sdk/lib/websocket'
import { checkReachability, setReachabilityProbe, useOffline } from '@/lib/network'
import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useSession } from '@/features/auth/session'
import { messagesFor } from '@/lib/i18n'
import { ticksToSeconds } from '@/lib/format'
import { jellyfin } from '@/lib/jellyfin'
import { remoteMessages } from './messages'
import { RemoteBar } from './remote-bar'
import { measureClockOffset } from './remote-session'
import { readLocalSettings } from '@/features/settings/local-settings'
import { handOverSnapshot, music, setRemoteSink } from '@/features/listen/player/music-player'
import { handoffMessages } from './messages'

/** What the video player exposes so other devices and SyncPlay can steer it. */
export interface PlayerController {
  play: () => void
  pause: () => void
  /** Resolves once the new position can be played (or after a short timeout). */
  seekToTicks: (ticks: number) => Promise<void>
  stop: () => void
  next: () => void
  previous: () => void
  /** 0..1 */
  setVolume: (volume: number) => void
  setMuted: (muted: boolean | 'toggle') => void
  /** Relative jump for Rewind / FastForward commands. */
  seekBy: (seconds: number) => void
  /** Current position on the item's own timeline. */
  getPositionTicks: () => number
  /** For SyncPlay's speed correction; 1 = normal. */
  setPlaybackRate: (rate: number) => void
  isPaused: () => boolean
}

/** The device Lumio is currently remote-controlling ("Abspielen auf"). */
export interface RemoteTarget {
  sessionId: string
  name: string
}

export interface SyncRequests {
  pause: () => void
  unpause: () => void
  seek: (ticks: number) => void
  setQueue: (itemId: string, startTicks: number) => Promise<void>
  /** Tells the group this client is ready at `ticks`; `isPlaying` is what the client intends to do next. */
  ready: (ticks: number, isPlaying: boolean) => void
  buffering: (ticks: number, isPlaying: boolean) => void
}

interface RemoteContextValue {
  target: RemoteTarget | null
  setTarget: (target: RemoteTarget | null) => void
  /** Starts playback of the items on another device. */
  playOn: (sessionId: string, itemIds: string[], startTicks?: number, options?: { audio?: number; subtitle?: number }) => Promise<void>
  registerPlayer: (controller: PlayerController) => () => void
  group: GroupInfoDto | null
  /** Whether the group currently wants to play (used when a client loads the shared item). */
  groupWantsPlaying: boolean
  syncRequests: SyncRequests
  joinGroup: (groupId: string) => Promise<void>
  createGroup: (name: string) => Promise<void>
  leaveGroup: () => Promise<void>
}

const RemoteContext = createContext<RemoteContextValue | null>(null)

export function useRemote() {
  const value = useContext(RemoteContext)
  if (!value) throw new Error('useRemote must be used inside RemoteProvider')
  return value
}

/** Reasons for a new play queue after which every member should open the new current item. */
const QUEUE_REASONS_THAT_NAVIGATE = new Set(['NewPlaylist', 'SetCurrentItem', 'NextItem', 'PreviousItem'])
/** A SyncPlay command only moves the playhead if it is off by more than this (0.5 s); smaller gaps would just cause stalls. */
const SYNC_TOLERANCE_TICKS = 5_000_000
const SOCKET_OPEN = 1
/** How often the playback position is compared with the group's. */
const DRIFT_CHECK_MS = 1000
const CLOCK_REFRESH_MS = 60_000

const TAB_CHANNEL = 'lumio-tabs'
const TAB_ID = crypto.randomUUID()
const TAB_PROBE_MS = 300

type TabMessage = { type: 'ping' | 'here'; from: string }

/** Whether another Lumio tab of this browser is open (they share the device id, and with it the server session). */
function anotherTabIsOpen(): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(TAB_CHANNEL)
    const finish = (open: boolean) => {
      channel.close()
      resolve(open)
    }
    const timeout = window.setTimeout(() => finish(false), TAB_PROBE_MS)
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type !== 'here' || event.data.from === TAB_ID) return
      window.clearTimeout(timeout)
      finish(true)
    }
    channel.postMessage({ type: 'ping', from: TAB_ID } satisfies TabMessage)
  })
}

function answerTabProbes() {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(TAB_CHANNEL)
  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    if (event.data?.type === 'ping' && event.data.from !== TAB_ID) channel.postMessage({ type: 'here', from: TAB_ID } satisfies TabMessage)
  }
  return () => channel.close()
}



/**
 * Connects Lumio to Jellyfin's remote-control channel. That makes the app show up as a playable device for other clients
 * ("Abspielen auf"), lets Lumio control other devices, and takes part in SyncPlay groups.
 */
export function RemoteProvider({ children }: { children: ReactNode }) {
  const { session, api } = useSession()
  const navigate = useNavigate()
  const inListen = useLocation().pathname.startsWith('/listen')
  const player = useRef<PlayerController | null>(null)
  const [target, setTarget] = useState<RemoteTarget | null>(null)
  const [group, setGroup] = useState<GroupInfoDto | null>(null)
  const [queue, setQueue] = useState<{ playlistItemId?: string; isPlaying: boolean } | null>(null)
  /** Milliseconds to add to Date.now() to get the server's time. */
  const clockOffset = useRef(0)
  /** A SyncPlay command waiting for its scheduled time; replaced by newer commands and dropped when the group or player goes. */
  const pendingCommand = useRef<number | undefined>(undefined)
  const cancelPendingCommand = () => window.clearTimeout(pendingCommand.current)

  // Everything here belongs to one signed-in session. Reset it in the same render the session changes (not in an
  // effect), so nothing session-bound, like the remote bar, renders for even one frame without a session.
  const sessionKey = session?.accessToken ?? null
  const [stateSession, setStateSession] = useState(sessionKey)
  if (stateSession !== sessionKey) {
    setStateSession(sessionKey)
    setTarget(null)
    setGroup(null)
    setQueue(null)
  }

  // The extra offset from the SyncPlay settings compensates for output lag (e.g. Bluetooth audio).
  const serverNow = useCallback(
    () => Date.now() + clockOffset.current + (session ? readLocalSettings(session.userId).syncPlay.extraOffset : 0),
    [session],
  )
  /** Where the group's playback is supposed to be: a position and the server time it applied at (null while paused). */
  const groupReference = useRef<{ positionTicks: number; serverTime: number } | null>(null)

  const syncRequests = useMemo<SyncRequests>(() => {
    const noop = () => undefined
    if (!api) return { pause: noop, unpause: noop, seek: noop, setQueue: async () => undefined, ready: noop, buffering: noop }
    const sync = getSyncPlayApi(api)
    const stamp = () => new Date(serverNow()).toISOString()
    const swallow = (promise: Promise<unknown>) => void promise.catch(() => undefined)
    return {
      pause: () => swallow(sync.syncPlayPause()),
      unpause: () => swallow(sync.syncPlayUnpause()),
      seek: (ticks) => swallow(sync.syncPlaySeek({ seekRequestDto: { PositionTicks: ticks } })),
      setQueue: async (itemId, startTicks) => {
        await sync.syncPlaySetNewQueue({ playRequestDto: { PlayingQueue: [itemId], PlayingItemPosition: 0, StartPositionTicks: startTicks } })
      },
      ready: (ticks, isPlaying) =>
        swallow(sync.syncPlayReady({ readyRequestDto: { When: stamp(), PositionTicks: ticks, IsPlaying: isPlaying, PlaylistItemId: queue?.playlistItemId } })),
      buffering: (ticks, isPlaying) =>
        swallow(sync.syncPlayBuffering({ bufferRequestDto: { When: stamp(), PositionTicks: ticks, IsPlaying: isPlaying, PlaylistItemId: queue?.playlistItemId } })),
    }
  }, [api, queue, serverNow])

  /** Measures the server clock offset; failures keep the last known value. */
  const syncClock = useEffectEvent(() => {
    if (!api) return
    measureClockOffset(async () => (await getSystemApi(api).getUtcTime()).data)
      .then((offset) => (clockOffset.current = offset))
      .catch(() => undefined)
  })

  // Drift correction while playing in a group (jellyfin-web's SpeedToSync / SkipToSync): compare where this player is
  // with where the group should be by now; nudge the speed for small differences, jump for large ones.
  const correctDrift = useEffectEvent(() => {
    const reference = groupReference.current
    const controller = player.current
    if (!reference || !controller || !session || controller.isPaused() || speedCorrecting.current) return
    const settings = readLocalSettings(session.userId).syncPlay
    if (!settings.correction) return
    const expected = reference.positionTicks + (serverNow() - reference.serverTime) * 10_000
    const diffMs = (expected - controller.getPositionTicks()) / 10_000
    const distance = Math.abs(diffMs)
    if (settings.speedToSync && distance >= settings.speedMinDelay && distance <= settings.speedMaxDelay) {
      // Cover the difference within speedDuration: ahead → slower, behind → faster.
      const rate = Math.min(1.5, Math.max(0.5, 1 + diffMs / settings.speedDuration))
      controller.setPlaybackRate(rate)
      speedCorrecting.current = window.setTimeout(() => {
        speedCorrecting.current = undefined
        player.current?.setPlaybackRate(1)
      }, settings.speedDuration)
    } else if (settings.skipToSync && distance >= Math.max(settings.skipMinDelay, settings.speedToSync ? settings.speedMaxDelay : 0)) {
      void controller.seekToTicks(expected)
    }
  })
  const speedCorrecting = useRef<number | undefined>(undefined)
  const inGroup = !!group?.GroupId
  useEffect(() => {
    if (!inGroup) {
      groupReference.current = null
      return
    }
    const timer = window.setInterval(() => correctDrift(), DRIFT_CHECK_MS)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(speedCorrecting.current)
      speedCorrecting.current = undefined
      player.current?.setPlaybackRate(1)
    }
  }, [inGroup])

  // Clocks drift; refresh the offset while in a group.
  const groupId = group?.GroupId
  useEffect(() => {
    if (!groupId) return
    const timer = window.setInterval(() => syncClock(), CLOCK_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [groupId])

  // Answer other tabs asking whether Lumio is already open (see anotherTabIsOpen).
  useEffect(() => answerTabProbes(), [])

  const handlePlaystate = useEffectEvent((request: PlaystateRequest) => {
    const controller = player.current
    // No video playing: the commands steer Listen's music player (when music is loaded here).
    if (!controller) {
      if (!music.isLoaded()) return
      switch (request.Command) {
        case 'Pause': return music.pause()
        case 'Unpause': return music.resume()
        case 'PlayPause': return music.toggle()
        case 'Stop': return music.stop()
        case 'Seek': return music.seek(ticksToSeconds(request.SeekPositionTicks ?? 0))
        case 'NextTrack': return music.next()
        case 'PreviousTrack': return music.previous()
        case 'Rewind': return music.seekBy(-10)
        case 'FastForward': return music.seekBy(30)
      }
      return
    }
    switch (request.Command) {
      case 'Pause': return controller.pause()
      case 'Unpause': return controller.play()
      // The usual play/pause button of remote controls (Lumio's remote bar sends it too).
      case 'PlayPause': return controller.isPaused() ? controller.play() : controller.pause()
      case 'Stop': return controller.stop()
      case 'Seek': return void controller.seekToTicks(request.SeekPositionTicks ?? 0)
      case 'NextTrack': return controller.next()
      case 'PreviousTrack': return controller.previous()
      case 'Rewind': return controller.seekBy(-10)
      case 'FastForward': return controller.seekBy(30)
    }
  })

  const handleGeneralCommand = useEffectEvent((command: GeneralCommand) => {
    const args = command.Arguments ?? {}
    switch (command.Name) {
      case 'DisplayMessage':
        toast(args.Header ?? messagesFor(remoteMessages).message, { description: args.Text })
        break
      case 'SetVolume': {
        const volume = Math.min(Math.max(Number(args.Volume ?? 100) / 100, 0), 1)
        if (player.current) player.current.setVolume(volume)
        else music.setVolume(volume)
        break
      }
      // Shuffle and repeat for Listen's music (sent by a device steering this one).
      case 'SetRepeatMode':
        music.setRepeat(args.RepeatMode === 'RepeatAll' ? 'all' : args.RepeatMode === 'RepeatOne' ? 'one' : 'off')
        break
      case 'SetShuffleQueue':
        music.setShuffle(args.ShuffleMode === 'Shuffle')
        break
      case 'Mute':
      case 'Unmute':
      case 'ToggleMute':
        if (player.current) player.current.setMuted(command.Name === 'Mute' ? true : command.Name === 'Unmute' ? false : 'toggle')
        else if (command.Name === 'ToggleMute' || (command.Name === 'Mute') !== music.isMuted()) music.toggleMute()
        break
    }
  })

  const handlePlay = useEffectEvent(async (request: PlayRequest) => {
    const itemId = request.ItemIds?.[0]
    if (!itemId) return
    // Music (and audiobooks) play in Listen's player, with the whole list sent and its queue commands.
    if (api && session) {
      const ids = request.ItemIds ?? []
      const found = (await getLibraryApi(api).getItems({ userId: session.userId, ids }).catch(() => null))?.data.Items ?? []
      const byId = new Map(found.map((item) => [item.Id, item]))
      const items = ids.map((id) => byId.get(id)).filter((item) => !!item)
      if (items.length && items.every((item) => item.MediaType === 'Audio')) {
        if (request.PlayCommand === 'PlayNext') return music.playNext(items)
        if (request.PlayCommand === 'PlayLast') return music.addToQueue(items)
        const start = request.StartIndex ?? 0
        return music.playHere(items, start, request.StartPositionTicks ? ticksToSeconds(request.StartPositionTicks) : undefined)
      }
    }
    if (request.PlayCommand && request.PlayCommand !== 'PlayNow') {
      const t = messagesFor(remoteMessages)
      toast(t.queueUnsupported, { description: t.queueUnsupportedHint })
      return
    }
    // local=1: this device was asked to play, so don't forward it to a controlled device or the SyncPlay group.
    const params = new URLSearchParams({ local: '1' })
    if (request.StartPositionTicks) params.set('t', String(request.StartPositionTicks))
    if (request.AudioStreamIndex != null) params.set('a', String(request.AudioStreamIndex))
    if (request.SubtitleStreamIndex != null) params.set('s', String(request.SubtitleStreamIndex))
    const query = params.toString()
    void navigate(`/play/${itemId}${query ? `?${query}` : ''}`)
  })

  /** Runs a SyncPlay command at the moment the server asked for, compensating for being late. */
  const handleSyncCommand = useEffectEvent((command: SendCommand) => {
    if (!command.Command) return
    // A command for another queue entry (e.g. the item before a switch) must not act on what is playing now.
    if (command.PlaylistItemId && queue?.playlistItemId && command.PlaylistItemId !== queue.playlistItemId) return
    cancelPendingCommand()
    const delay = Date.parse(command.When ?? '') - serverNow()
    const positionTicks = command.PositionTicks ?? 0
    const run = () => {
      pendingCommand.current = undefined
      // Read the player at execution time: the user may have left it since the command arrived.
      const controller = player.current
      if (!controller) return
      const late = Math.max(0, -delay)
      const expected = positionTicks + late * 10_000
      // Seeking always makes the video stall for a moment, which is reported to the server, which answers with another
      // command: only move the playhead when it is really out of line.
      const tolerance = session ? readLocalSettings(session.userId).syncPlay.skipMinDelay * 10_000 : SYNC_TOLERANCE_TICKS
      const isClose = (target: number) => Math.abs(controller.getPositionTicks() - target) < tolerance
      switch (command.Command) {
        case 'Unpause':
          groupReference.current = { positionTicks, serverTime: Date.parse(command.When ?? '') || serverNow() }
          void (isClose(expected) ? Promise.resolve() : controller.seekToTicks(expected)).then(() => controller.play())
          break
        case 'Pause':
          groupReference.current = null
          controller.pause()
          if (!isClose(positionTicks)) void controller.seekToTicks(positionTicks)
          break
        case 'Seek':
          groupReference.current = null
          // Hold still while seeking (as jellyfin-web does), then report a single Ready; the group resumes everyone.
          controller.pause()
          void controller.seekToTicks(positionTicks).then(() => syncRequests.ready(positionTicks, false))
          break
        case 'Stop':
          groupReference.current = null
          controller.stop()
          break
      }
    }
    if (delay > 0) pendingCommand.current = window.setTimeout(run, delay)
    else run()
  })

  const handleGroupUpdate = useEffectEvent((update: GroupUpdate) => {
    const t = messagesFor(remoteMessages)
    switch (update.Type) {
      case 'GroupJoined': {
        setGroup(update.Data as GroupInfoDto)
        syncClock()
        toast.success(t.joined((update.Data as GroupInfoDto).GroupName ?? ''))
        break
      }
      case 'GroupLeft':
        cancelPendingCommand()
        setGroup(null)
        setQueue(null)
        toast(t.left)
        break
      case 'UserJoined':
      case 'UserLeft': {
        const name = String(update.Data)
        setGroup((current) => {
          if (!current) return current
          const others = (current.Participants ?? []).filter((participant) => participant !== name)
          return { ...current, Participants: update.Type === 'UserJoined' ? [...others, name] : others }
        })
        toast(update.Type === 'UserJoined' ? t.userJoined(name) : t.userLeft(name))
        break
      }
      case 'StateUpdate':
        setGroup((current) => (current ? { ...current, State: (update.Data as { State?: GroupInfoDto['State'] }).State } : current))
        break
      case 'PlayQueue': {
        const data = update.Data as PlayQueueUpdate
        const current = data.Playlist?.[data.PlayingItemIndex ?? 0]
        setQueue({ playlistItemId: current?.PlaylistItemId ?? undefined, isPlaying: !!data.IsPlaying })
        if (current?.ItemId && QUEUE_REASONS_THAT_NAVIGATE.has(data.Reason ?? '')) {
          const ticks = data.StartPositionTicks ? `&t=${data.StartPositionTicks}` : ''
          void navigate(`/play/${current.ItemId}?sp=1${ticks}`, { replace: location.pathname.startsWith('/play/') })
        }
        break
      }
      // The normal answer to the clean-up "leave" at startup; nothing to tell the user.
      case 'NotInGroup':
        cancelPendingCommand()
        setGroup(null)
        setQueue(null)
        break
      case 'GroupDoesNotExist':
        cancelPendingCommand()
        setGroup(null)
        setQueue(null)
        toast.error(t.groupGone)
        break
      case 'LibraryAccessDenied':
        toast.error(t.accessDenied)
        break
    }
  })

  /** A group membership can outlive a page reload on the server while our state is gone; start clean. */
  const staleGroupChecked = useRef(false)
  const announceCapabilities = useEffectEvent(() => {
    if (!api) return
    if (!staleGroupChecked.current) {
      staleGroupChecked.current = true
      // Tabs of one browser share the device id and so the server session; leaving would kick a running tab out.
      void anotherTabIsOpen().then((busy) => {
        if (!busy) getSyncPlayApi(api).syncPlayLeaveGroup().catch(() => undefined)
      })
    }
    getSessionApi(api)
      .postFullCapabilities({
        clientCapabilitiesDto: {
          PlayableMediaTypes: ['Audio', 'Video'],
          SupportedCommands: ['DisplayMessage', 'SetVolume', 'Mute', 'Unmute', 'ToggleMute', 'SetRepeatMode', 'SetShuffleQueue'],
          SupportsMediaControl: true,
        },
      })
      .catch(() => undefined)
  })

  // Whether the server is reachable is checked with its ping while signed in (see network).
  const serverUrl = session?.serverUrl
  useEffect(() => {
    setReachabilityProbe(serverUrl ? `${serverUrl}/System/Ping` : null)
    return () => setReachabilityProbe(null)
  }, [serverUrl])

  // One socket per signed-in session, while the server can be reached: offline it would only keep failing (each try
  // an error in the console); it connects again as soon as the server answers.
  const offline = useOffline()
  useEffect(() => {
    if (!session || offline) return
    staleGroupChecked.current = false
    const url = `${session.serverUrl.replace(/^http/, 'ws')}/socket?ApiKey=${encodeURIComponent(session.accessToken)}&deviceId=${encodeURIComponent(jellyfin.deviceInfo.id)}`
    const socket = new WebSocketService(url)
    const stopStatus = socket.onStatusChange((status) => {
      if (status === SOCKET_OPEN) announceCapabilities()
      // Dropped: maybe the connection is gone; the ping finds out (and offline closes this socket).
      else if (status === 'disconnected') checkReachability()
    })
    const stopMessages = socket.subscribe(['Play', 'Playstate', 'GeneralCommand', 'SyncPlayCommand', 'SyncPlayGroupUpdate'], (message) => {
      switch (message.MessageType) {
        case 'Play': return handlePlay(message.Data as PlayRequest)
        case 'Playstate': return handlePlaystate(message.Data as PlaystateRequest)
        case 'GeneralCommand': return handleGeneralCommand(message.Data as GeneralCommand)
        case 'SyncPlayCommand': return handleSyncCommand(message.Data as SendCommand)
        case 'SyncPlayGroupUpdate': return handleGroupUpdate(message.Data as GroupUpdate)
      }
    })
    return () => {
      stopMessages()
      stopStatus()
      socket.disconnect()
    }
  }, [session, offline])

  const registerPlayer = useCallback((controller: PlayerController) => {
    player.current = controller
    return () => {
      if (player.current !== controller) return
      player.current = null
      window.clearTimeout(pendingCommand.current)
    }
  }, [])

  // Music started in Listen goes to the controlled device too (whole lists, with the chosen song first to play).
  useEffect(() => {
    if (!api || !target) return setRemoteSink(null)
    const sessions = getSessionApi(api)
    const failed = () => {
      toast.error(messagesFor(handoffMessages).unreachable(target.name))
      setTarget(null)
    }
    // Choosing a device while music plays here hands it over, as Spotify Connect does: the current song from where it
    // is, and what follows it; here it pauses.
    const now = handOverSnapshot()
    if (now?.playing) {
      music.pause()
      sessions
        .play({ sessionId: target.sessionId, playCommand: 'PlayNow', itemIds: now.items.map((item) => item.Id!), startIndex: 0, startPositionTicks: now.positionTicks })
        .catch(failed)
    }
    setRemoteSink({
      play: (items, startIndex) => {
        // Not here as well. No toast: the player bar already says where it plays, a toast on every song is noise.
        music.pause()
        sessions.play({ sessionId: target.sessionId, playCommand: 'PlayNow', itemIds: items.map((item) => item.Id!), startIndex }).catch(failed)
      },
      enqueue: (items, how) => {
        sessions
          .play({ sessionId: target.sessionId, playCommand: how === 'next' ? 'PlayNext' : 'PlayLast', itemIds: items.map((item) => item.Id!) })
          .then(() => toast.success(messagesFor(handoffMessages).queuedOn(target.name)))
          .catch(failed)
      },
    })
    return () => setRemoteSink(null)
  }, [api, target])

  const value = useMemo<RemoteContextValue>(
    () => ({
      target,
      setTarget,
      playOn: async (sessionId, itemIds, startTicks, options) => {
        if (!api) return
        await getSessionApi(api).play({
          sessionId,
          playCommand: 'PlayNow',
          itemIds,
          startPositionTicks: startTicks,
          audioStreamIndex: options?.audio,
          subtitleStreamIndex: options?.subtitle,
        })
      },
      registerPlayer,
      group,
      groupWantsPlaying: queue?.isPlaying ?? false,
      syncRequests,
      joinGroup: async (groupId) => {
        if (api) await getSyncPlayApi(api).syncPlayJoinGroup({ joinGroupRequestDto: { GroupId: groupId } })
      },
      createGroup: async (name) => {
        if (api) await getSyncPlayApi(api).syncPlayCreateGroup({ newGroupRequestDto: { GroupName: name } })
      },
      leaveGroup: async () => {
        if (api) await getSyncPlayApi(api).syncPlayLeaveGroup()
      },
    }),
    [api, target, group, queue, syncRequests, registerPlayer],
  )

  return (
    <RemoteContext value={value}>
      {children}
      {/* Always rendered so it can animate out; it shows nothing without a target. */}
      {/* Listen's own player bar turns into the remote control instead (see RemotePlayerBar). */}
      {session && <RemoteBar target={inListen ? null : target} onDisconnect={() => setTarget(null)} />}
    </RemoteContext>
  )
}

