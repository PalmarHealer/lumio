import { PlayMethod } from '@jellyfin/sdk/lib/generated-client/models'
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import { IconArrowLeft } from '@tabler/icons-react'
import Hls from 'hls.js'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { PortalContainerContext } from '@/components/portal-container'
import { emitPluginEvent, PluginSlot } from '@/features/admin/plugins'
import { Button } from '@/components/ui/button'
import { useAuthedSession } from '@/features/auth/session'
import { playMessages } from '@/features/items/messages'
import { episodeCode } from '@/features/items/play-target'
import { useItem, useNextItem } from '@/features/items/queries'
import { subtitleCssVars, useLocalSettings } from '@/features/settings/local-settings'
import { DeviceMenu } from '@/features/remote/device-menu'
import { RemoteHandoff, SyncPlayHandoff, rememberStopPosition } from '@/features/remote/handoff'
import { useRemote } from '@/features/remote/remote-provider'
import { SyncPlayMenu } from '@/features/remote/syncplay-menu'
import { useUserConfiguration } from '@/features/settings/use-user-configuration'
import { secondsToTicks, ticksToSeconds } from '@/lib/format'
import { backdropImageUrl, landscapeImageUrl, portraitImageUrl } from '@/lib/images'
import { rememberPlayback } from '@/lib/playback-outbox'
import { levelOf, loudness } from '@/lib/loudness'
import { logOfflineWatch } from '@/features/listen/player/play-log'
import { useMessages } from '@/lib/i18n'
import { music } from '@/features/listen/player/music-player'
import { markAppReady } from '@/lib/boot'
import { usePresence } from '@/lib/use-presence'
import { cn } from '@/lib/utils'
import { EpisodePanel } from './episode-panel'
import { LoadingIndicator } from './loading-indicator'
import { PauseSpotlight } from './pause-spotlight'
import { PlayerControls, TouchTransport } from './player-controls'
import { SwipeLevel, useSwipeGestures } from './swipe-gestures'
import { playerMessages, segmentSkipLabels } from './messages'
import { initialChoice, usePlayback, useStreamOptions, type PlaybackChoice } from './playback'
import { reportActivity } from '@/features/social/social'
import { usePreloadNext } from './preload-next'
import { useVideoPrefetch } from './use-video-prefetch'
import { forgetVideo, isVideoCached, isVideoPinned, storedAudio, storedQuality, useVideoStored } from './video-cache'
import { useOffline } from '@/lib/network'
import { useBackLayer } from '@/lib/back'
import { useTouch } from '@/lib/use-media-query'
import { holdAppFullscreen, inNativeApp } from '@/lib/native-app'
import { inCapacitor, onPipEvents, setAutoPip } from '@/lib/capacitor'
import { desktop } from '@/lib/desktop'
import { startAfterIntro, useMediaSegments } from './segments'
import { fitLabels } from './labels'
import { SettingsPanel } from './settings-panel'
import { ScrubPreview } from './scrub-preview'
import { StatsOverlay } from './stats-overlay'
import { usePreloadTrickplay, useTrickplay } from './trickplay'
import { useVideoState } from './use-video-state'
import { resolveFit, useElementSize, usePictureArea, useVideoDimensions, videoLayout } from './video-fit'
import { useLumioConfig } from '@/features/admin/branding'
import { BreakReminder } from './break-reminder'
import { noteWatched, setVideoPauseHandler, sleepsAfterVideo } from './watch-timers'

const PROGRESS_INTERVAL_MS = 10_000
/** Seconds of video that count as "enough buffered" for the loading percentage. */
const LOAD_TARGET_SECONDS = 10
/** Approximate height of one subtitle line, for placing cues when the frame is partly off screen. */
const SUBTITLE_LINE_PX = 36
/** The element counts as "at the start position" within 10 s of it (keyframes make it land a bit earlier). */
const START_TOLERANCE_TICKS = 100_000_000
/** If the start position is never reached (e.g. beyond the end), trust the element's clock after this long. */
const START_FALLBACK_MS = 15_000
/** Clicks this soon after the controls appeared belong to the tap that showed them. */
const SHOW_GRACE_MS = 400
/** Share of the loading ring each startup milestone is worth. */
const LOAD_STAGE = { preparing: 8, info: 20, playlist: 40, metadata: 55, segment: 70, data: 85 } as const

function numberParam(value: string | null) {
  const parsed = value === null ? Number.NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Mounted per item (keyed by id) so choices, timers and the stream never leak from one title into the next. */
export function PlayerPage() {
  // The player has its own loading screen (black, with the ring). A film starting pauses the music.
  useEffect(() => {
    markAppReady()
    music.pause()
  }, [])
  const { id = '' } = useParams()
  const [search] = useSearchParams()
  const location = useLocation()
  const remote = useRemote()
  const ticks = Number(search.get('t') ?? 0)

  // Opened from the group's own queue (sp) or by another device asking this one to play (local): always play here.
  // Otherwise, while controlling another device or sitting in a SyncPlay group, the title goes there instead.
  const playsHere = search.get('sp') === '1' || search.get('local') === '1'
  if (!playsHere && remote.target) {
    return <RemoteHandoff id={id} ticks={ticks} audio={numberParam(search.get('a'))} subtitle={numberParam(search.get('s'))} target={remote.target} />
  }
  if (!playsHere && remote.group) return <SyncPlayHandoff id={id} ticks={ticks} />
  // Keyed per navigation, not per item: a new start position or track choice for the same item starts fresh. The shell
  // around it stays from one episode to the next, so a browser's fullscreen (and the phone's turn) lasts across them.
  return <PlayerShell id={id} navigationKey={location.key} />
}

function PlayerShell({ id, navigationKey }: { id: string; navigationKey: string }) {
  const shell = useRef<HTMLDivElement>(null)
  return (
    <div ref={shell} className="relative h-svh overflow-clip bg-black">
      <Player key={navigationKey} id={id} shell={shell} />
    </div>
  )
}

/** Set on the way to the next episode from the player: it starts on black, not on the title's picture again. */
interface ContinuingState {
  continuing?: boolean
}

function Player({ id, shell }: { id: string; shell: React.RefObject<HTMLDivElement | null> }) {
  const [search] = useSearchParams()
  const initialTicks = Number(search.get('t') ?? 0)
  const navigate = useNavigate()
  const location = useLocation()
  const { api, session } = useAuthedSession()
  const item = useItem(id)
  const lumioConfig = useLumioConfig().data
  // Which title's video has shown its first frame (the loading backdrop fades then).
  const [startedFor, setStartedFor] = useState<string | null>(null)
  const userConfig = useUserConfiguration()
  const next = useNextItem(item.data)
  const isAudio = item.data?.MediaType === 'Audio'
  const { settings, update: updateSettings } = useLocalSettings()
  const remote = useRemote()
  const syncActive = !!remote.group && search.get('sp') === '1'
  // Loaded from the group's queue: start paused and report ready instead of playing on our own.
  const startedInSync = useRef(search.get('sp') === '1' && !!remote.group)
  const syncRef = useRef(remote.syncRequests)
  const wantsPlayingRef = useRef(remote.groupWantsPlaying)
  useEffect(() => {
    syncRef.current = remote.syncRequests
    wantsPlayingRef.current = remote.groupWantsPlaying
  })

  // Device defaults from the settings page seed the first stream; the player menu can still change them per item.
  // Track choices made on the detail page come from the URL; without them the server picks from the language settings.
  const [choice, setChoice] = useState<PlaybackChoice>(() =>
    initialChoice(settings, initialTicks, numberParam(search.get('a')), numberParam(search.get('s'))),
  )
  const [localSubtitle, setLocalSubtitle] = useState<number | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [episodesOpen, setEpisodesOpen] = useState(false)
  // The system back button closes an open panel before it leaves the player.
  useBackLayer(settingsOpen || episodesOpen, () => {
    setSettingsOpen(false)
    setEpisodesOpen(false)
  })
  // Loading progress: the furthest real milestone reached so far, and whether the stream has played yet.
  const [loadStage, setLoadStage] = useState(0)
  const [started, setStarted] = useState(false)
  /** Why the stream couldn't be played (shown small on the error screen, so a screenshot tells what went wrong). */
  const [failed, setFailed] = useState<string | null>(null)

  // "Start after the intro": the stream is only requested once the segments are known, so it can be opened right at the
  // end of the intro instead of loading the intro first and jumping. (Not when the group decides the position.)
  const introSegments = useMediaSegments(id, settings.startAfterIntro && !isAudio && !!item.data)
  const [introResolved, setIntroResolved] = useState(!settings.startAfterIntro || search.get('sp') === '1')
  if (!introResolved && item.data && (isAudio || introSegments.isSuccess || introSegments.isError)) {
    setIntroResolved(true)
    const startSeconds = ticksToSeconds(choice.startTicks)
    const target = startAfterIntro(startSeconds, introSegments.data ?? [])
    if (target !== startSeconds) setChoice((current) => ({ ...current, startTicks: secondsToTicks(target) }))
  }
  const playback = usePlayback(id, isAudio, choice, !!item.data && introResolved)
  // A copy on the device (downloaded or stored ahead): its quality is marked in the menu, and offline it is all there is.
  const offline = useOffline()
  const hasStored = useVideoStored(id)
  const storedBitrateKnown = hasStored ? storedQuality(id) : undefined
  // Copies stored before their quality was noted were made in the cache's quality.
  const storedBitrate = !hasStored ? undefined : storedBitrateKnown === undefined ? (settings.videoBitrateMbit ? settings.videoBitrateMbit * 1_000_000 : null) : storedBitrateKnown
  // The item as it is now, for telling friends what plays (read inside the stream effect).
  const itemRef = useRef(item.data)
  useEffect(() => {
    itemRef.current = item.data
  }, [item.data])

  const container = useRef<HTMLDivElement>(null)
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = video.current
    if (!element) return
    const onPlaying = () => setStartedFor(id)
    element.addEventListener('playing', onPlaying)
    return () => element.removeEventListener('playing', onPlaying)
  }, [id])
  /** Current position in ticks on the item's own timeline; set by the stream effect. */
  const positionTicks = useRef<() => number>(() => choice.startTicks)
  /** The running hls.js instance (HLS streams only); scrubbing pauses its loading. */
  const hlsInstance = useRef<Hls | null>(null)
  /** Set by a stream restart (track/quality switch) that happened while paused, so the new stream doesn't autoplay. */
  const resumePaused = useRef(false)

  const data = playback.data
  const streamOptions = useStreamOptions(data)
  const t = useMessages(playerMessages)
  const skipLabels = useMessages(segmentSkipLabels)
  const playT = useMessages(playMessages)
  // A progressive transcode reports neither its length nor the offset it started at; use the item's own timeline.
  // While a (new) stream loads, the element sits at 0: show the position it is going to start from instead.
  const timelineOffset = !data || (data.transcoded && !data.hls) ? ticksToSeconds(choice.startTicks) : 0
  const runtimeSeconds = item.data?.RunTimeTicks ? ticksToSeconds(item.data.RunTimeTicks) : 0
  const rawState = useVideoState(video)
  const state = {
    ...rawState,
    currentTime: rawState.currentTime + timelineOffset,
    buffered: rawState.buffered + timelineOffset,
    ranges: rawState.ranges.map(([start, end]): [number, number] => [start + timelineOffset, end + timelineOffset]),
    duration: timelineOffset || !rawState.duration ? runtimeSeconds || rawState.duration : rawState.duration,
  }
  const frameAt = useTrickplay(item.data, data?.mediaSourceId)
  const bufferedAhead = Math.max(0, state.buffered - state.currentTime)
  const loadTarget = Math.min(LOAD_TARGET_SECONDS, state.duration ? Math.max(state.duration - state.currentTime, 1) : LOAD_TARGET_SECONDS)
  // Before the first frame, progress follows the real milestones (info, playlist, first segment, metadata) and the buffer;
  // afterwards (seeking, rebuffering) only the buffer counts.
  const bufferPercent = (bufferedAhead / loadTarget) * 100
  const milestonePercent = data ? Math.max(LOAD_STAGE.info, loadStage) : LOAD_STAGE.preparing
  const loadPercent = Math.min(99, started ? bufferPercent : Math.max(milestonePercent, bufferPercent))
  const activeSubtitle = localSubtitle ?? data?.subtitleIndex ?? -1
  // Reported to the server with every progress update (it remembers the choice per series).
  const activeSubtitleRef = useRef(activeSubtitle)
  useEffect(() => {
    activeSubtitleRef.current = activeSubtitle
  })
  const autoplayNext = isAudio || (userConfig.data?.Configuration?.EnableNextEpisodeAutoPlay ?? true)

  const playNext = useCallback(() => {
    if (next?.Id) void navigate(`/play/${next.Id}`, { replace: true, state: { continuing: true } satisfies ContinuingState })
  }, [next, navigate])
  // Playback speed: starts at the default from the settings; a SyncPlay group always plays at normal speed.
  const [rate, setRate] = useState(settings.playbackRate)
  const effectiveRate = syncActive ? 1 : rate
  useEffect(() => {
    const el = video.current
    if (!el) return
    // defaultPlaybackRate survives the element loading a new source (track or quality switch).
    el.defaultPlaybackRate = effectiveRate
    el.playbackRate = effectiveRate
  }, [effectiveRate, data])

  // A stop that couldn't be reported (offline): kept for later, as watched when it got near the end, and how long it
  // was watched for the statistics (Playback Reporting never saw it).
  const keepStop = useEffectEvent((ticks: number, elementTicks: number, watch: { startedAt: number; seconds: number; sessionId: string }) => {
    const runtime = item.data?.RunTimeTicks ?? elementTicks
    rememberPlayback(session.userId, { itemId: id, at: new Date().toISOString(), played: !!runtime && ticks >= runtime * 0.9, positionTicks: ticks })
    if (item.data && !isAudio) logOfflineWatch(item.data, watch.startedAt, watch.seconds, watch.sessionId)
  })

  // The sleep timer and the break reminder pause whichever player is open (in a group: ask the group to).
  const pauseForSleep = useRef(() => undefined as void)
  useEffect(() => {
    pauseForSleep.current = () => {
      const el = video.current
      if (!el || el.paused) return
      if (syncActive) remote.syncRequests.pause()
      else el.pause()
    }
  })
  useEffect(() => {
    if (isAudio) return
    setVideoPauseHandler(() => pauseForSleep.current())
    return () => setVideoPauseHandler(null)
  }, [isAudio])
  // Watched long enough without a break: pause and suggest one (the minutes it was due after).
  const [breakDue, setBreakDue] = useState<number | null>(null)
  const onWatchedStep = useEffectEvent((seconds: number) => {
    if (isAudio || !noteWatched(seconds, settings.breakReminderMinutes)) return
    pauseForSleep.current()
    setSettingsOpen(false)
    setEpisodesOpen(false)
    setBreakDue(settings.breakReminderMinutes)
  })

  const handleEnded = useEffectEvent(() => {
    // Watched to the end: a copy stored ahead has done its job (episodes are rarely watched twice); downloads stay.
    if (isVideoCached(id) && !isVideoPinned(id)) void forgetVideo(id)
    // The sleep timer was set to the end of this video: it stops here instead of going on.
    if (!isAudio && sleepsAfterVideo()) return
    // In a group the server advances the queue for everyone; each member doing it would race.
    if (autoplayNext && !syncActive) playNext()
  })

  // Wire the stream into the <video> element and report playback to Jellyfin.
  useEffect(() => {
    const element = video.current
    if (!element || !data || failed) return

    const sessionApi = getSessionApi(api)
    const startTicks = choice.startTicks
    const offsetTicks = data.transcoded && !data.hls ? startTicks : 0
    // Until the stream has actually reached its start position the element reports 0. Reporting or reusing that 0
    // (leaving during a slow transcode start, switching audio before the first frame) would wipe the resume point.
    let startReached = offsetTicks === startTicks
    const elementTicks = () => secondsToTicks(element.currentTime) + offsetTicks
    const checkStart = () => {
      if (!startReached && Math.abs(elementTicks() - startTicks) < START_TOLERANCE_TICKS) startReached = true
    }
    const startFallback = window.setTimeout(() => (startReached = true), START_FALLBACK_MS)
    positionTicks.current = () => (startReached ? elementTicks() : startTicks)
    const info = () => ({
      ItemId: id,
      MediaSourceId: data.mediaSourceId,
      PlaySessionId: data.playSessionId,
      AudioStreamIndex: data.audioIndex,
      SubtitleStreamIndex: activeSubtitleRef.current,
      PositionTicks: positionTicks.current(),
      IsPaused: element.paused,
      CanSeek: true,
      // Without it Jellyfin assumes a transcode (and Playback Reporting files it so): a copy from the device or the
      // file itself is direct play.
      PlayMethod: data.transcoded ? PlayMethod.Transcode : PlayMethod.DirectPlay,
    })
    // How long it is really watched (seeks don't count), for a stop that has to be handed in later.
    const watch = { startedAt: Date.now(), seconds: 0, sessionId: data.playSessionId }
    let lastTime: number | null = null
    const onTime = () => {
      if (!element.paused && lastTime !== null) {
        const step = element.currentTime - lastTime
        if (step > 0 && step < 3) {
          watch.seconds += step
          onWatchedStep(step)
        }
      }
      lastTime = element.currentTime
    }
    const onSeeking = () => (lastTime = null)
    element.addEventListener('timeupdate', onTime)
    element.addEventListener('seeking', onSeeking)
    const removeWatchListeners = () => {
      element.removeEventListener('timeupdate', onTime)
      element.removeEventListener('seeking', onSeeking)
    }
    const report = (kind: 'progress' | 'stopped') => {
      if (kind === 'progress' && !startReached) return
      // When the stop can't be reported (offline, e.g. a stored episode), it is kept and handed in later: watched to
      // the end counts as watched, otherwise where it was left.
      const keep = () => kind === 'stopped' && keepStop(positionTicks.current(), Number.isFinite(element.duration) ? secondsToTicks(element.duration) : 0, watch)
      if (!navigator.onLine) return keep()
      const call =
        kind === 'progress'
          ? sessionApi.reportPlaybackProgress({ playbackProgressInfo: info() })
          : sessionApi.reportPlaybackStopped({ playbackStopInfo: info() })
      call.catch(keep)
    }

    // What doesn't play as it is (a codec the device claims but can't decode, a broken remux, a damaged stored copy)
    // gets one more try converted by the server, from where it stopped. Only then the error screen, with the reason.
    let gaveUp = false
    const fail = (reason: string) => {
      if (gaveUp) return
      gaveUp = true
      console.warn('[player] stream failed', reason, data.stats)
      if (!choice.transcode && navigator.onLine) {
        setChoice((current) => ({ ...current, transcode: true, startTicks: positionTicks.current() }))
      } else setFailed(reason)
    }

    let hls: Hls | undefined
    const seekToStart = () => {
      if (startTicks) element.currentTime = ticksToSeconds(startTicks)
    }

    if (data.hls && Hls.isSupported()) {
      const instance = new Hls({ startPosition: startTicks ? ticksToSeconds(startTicks) : -1 })
      hls = instance
      hlsInstance.current = instance
      // hls.js' standard recovery: media errors get two recovery attempts (the second with the audio codec swapped),
      // network errors two reloads. Only then is the stream given up.
      let mediaRecoveries = 0
      let networkRetries = 0
      instance.on(Hls.Events.ERROR, (_event, details) => {
        if (!details.fatal) return
        if (details.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          if (mediaRecoveries++ === 1) instance.swapAudioCodec()
          instance.recoverMediaError()
        } else if (details.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries++ < 2) {
          instance.startLoad()
        } else {
          fail(`hls ${details.type}: ${details.details}${details.response?.code ? ` (${details.response.code})` : ''}`)
        }
      })
      instance.on(Hls.Events.MANIFEST_PARSED, () => setLoadStage((stage) => Math.max(stage, LOAD_STAGE.playlist)))
      instance.on(Hls.Events.FRAG_LOADED, () => setLoadStage((stage) => Math.max(stage, LOAD_STAGE.segment)))
      instance.loadSource(data.url)
      instance.attachMedia(element)
    } else {
      element.src = data.url
      // Direct files and natively played HLS (Safari) both span the whole item: seek to the start ourselves.
      if (!data.transcoded || data.hls) element.addEventListener('loadedmetadata', seekToStart, { once: true })
    }
    element.addEventListener('timeupdate', checkStart)
    element.addEventListener('seeked', checkStart)

    const onError = () => {
      const error = element.error
      fail(`media ${error?.code ?? '?'}${error?.message ? `: ${error.message}` : ''}`)
    }
    const onMetadata = () => setLoadStage((stage) => Math.max(stage, LOAD_STAGE.metadata))
    const onLoadedData = () => setLoadStage((stage) => Math.max(stage, LOAD_STAGE.data))
    const onFirstPlay = () => setStarted(true)
    element.addEventListener('loadedmetadata', onMetadata)
    element.addEventListener('loadeddata', onLoadedData)
    element.addEventListener('playing', onFirstPlay, { once: true })
    const onEnded = () => handleEnded()
    const onPauseOrPlay = () => report('progress')
    element.addEventListener('error', onError)
    element.addEventListener('ended', onEnded)
    element.addEventListener('pause', onPauseOrPlay)
    element.addEventListener('play', onPauseOrPlay)

    let removeSyncListeners = () => undefined as void
    if (startedInSync.current) {
      // Pause once there is data and tell the group we are ready; the server then starts everyone together.
      const onCanPlay = () => {
        element.pause()
        syncRef.current.ready(positionTicks.current(), wantsPlayingRef.current)
      }
      const onStall = () => syncRef.current.buffering(positionTicks.current(), !element.paused)
      const onResume = () => syncRef.current.ready(positionTicks.current(), true)
      element.addEventListener('canplay', onCanPlay, { once: true })
      element.addEventListener('waiting', onStall)
      element.addEventListener('playing', onResume)
      removeSyncListeners = () => {
        element.removeEventListener('canplay', onCanPlay)
        element.removeEventListener('waiting', onStall)
        element.removeEventListener('playing', onResume)
      }
    } else if (resumePaused.current) {
      resumePaused.current = false
    } else {
      element.play().catch(() => undefined)
    }
    sessionApi.reportPlaybackStart({ playbackStartInfo: { ...info(), PositionTicks: choice.startTicks } }).catch(() => undefined)
    const shareActivity = () => {
      const current = itemRef.current
      if (!current?.Id || isAudio) return
      reportActivity({
        itemId: current.Id,
        name: current.Name ?? '',
        subtitle: current.SeriesName ?? undefined,
        context: current.SeasonName ?? undefined,
        contextId: current.SeriesId ?? undefined,
        kind: 'video',
        playing: !element.paused,
      })
    }
    element.addEventListener('play', shareActivity)
    element.addEventListener('pause', shareActivity)
    emitPluginEvent('playback:start', { itemId: id, positionTicks: startTicks })
    const timer = window.setInterval(() => report('progress'), PROGRESS_INTERVAL_MS)

    return () => {
      removeSyncListeners()
      removeWatchListeners()
      window.clearInterval(timer)
      window.clearTimeout(startFallback)
      element.removeEventListener('loadedmetadata', seekToStart)
      element.removeEventListener('timeupdate', checkStart)
      element.removeEventListener('seeked', checkStart)
      element.removeEventListener('loadedmetadata', onMetadata)
      element.removeEventListener('loadeddata', onLoadedData)
      element.removeEventListener('playing', onFirstPlay)
      setLoadStage(0)
      setStarted(false)
      element.removeEventListener('error', onError)
      element.removeEventListener('ended', onEnded)
      element.removeEventListener('pause', onPauseOrPlay)
      element.removeEventListener('play', onPauseOrPlay)
      element.removeEventListener('play', shareActivity)
      element.removeEventListener('pause', shareActivity)
      if (!isAudio) reportActivity(null)
      report('stopped')
      emitPluginEvent('playback:stop', { itemId: id, positionTicks: positionTicks.current() })
      // Freeze the last position: the element is about to be emptied, and a menu choice made while the next stream
      // loads must still resume from here rather than from 0.
      const last = positionTicks.current()
      positionTicks.current = () => last
      rememberStopPosition(id, last)
      if (hls) {
        hlsInstance.current = null
        hls.destroy()
      } else {
        // Without this an old progressive/direct stream keeps playing (with sound) while the next one is prepared.
        element.pause()
        element.removeAttribute('src')
        element.load()
      }
    }
  }, [api, id, data, choice.startTicks, choice.transcode, failed, isAudio])

  // Audio track, quality and burned-in subtitles need a new stream; resume where we are.
  const restartWith = (patch: Partial<PlaybackChoice>) => {
    resumePaused.current = video.current?.paused ?? false
    setChoice((current) => ({ ...current, ...patch, startTicks: positionTicks.current() }))
  }
  const chooseSubtitle = (index: number) => {
    const needsNewStream = !!data && (data.burnedInSubtitle || (index >= 0 && data.encodedSubtitles.includes(index)))
    if (needsNewStream) {
      setLocalSubtitle(undefined)
      restartWith({ subtitle: index })
    } else {
      setLocalSubtitle(index)
    }
  }

  // Controls fade out while playing and the pointer is idle.
  const [awake, setAwake] = useState(true)
  const idleTimer = useRef<number | undefined>(undefined)
  const hideAfterMs = settings.controlsHideSeconds * 1000
  const scheduleHide = useCallback(() => {
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setAwake(false), hideAfterMs)
  }, [hideAfterMs])
  const [activity, setActivity] = useState(0)
  const wake = useCallback(() => {
    setAwake(true)
    setActivity((count) => count + 1)
    scheduleHide()
  }, [scheduleHide])
  useEffect(() => {
    scheduleHide()
    return () => window.clearTimeout(idleTimer.current)
  }, [scheduleHide])
  // Paused and untouched for a while: show the spotlight. The cleanup resets it, so any activity or resuming hides it again.
  const [spotlightArmed, setSpotlightArmed] = useState(false)
  useEffect(() => {
    if (!state.paused || settings.pauseSpotlightSeconds <= 0) return
    const timer = window.setTimeout(() => setSpotlightArmed(true), settings.pauseSpotlightSeconds * 1000)
    return () => {
      window.clearTimeout(timer)
      setSpotlightArmed(false)
    }
  }, [state.paused, activity, settings.pauseSpotlightSeconds])
  const panelOpen = settingsOpen || episodesOpen
  const spotlightVisible = spotlightArmed && state.paused && !state.waiting && !panelOpen && breakDue === null
  const controlsVisible = (awake || state.paused || panelOpen) && !spotlightVisible
  // When the controls last appeared (see the click guard on them).
  const shownAt = useRef(0)
  // A layout effect: it runs before the browser sends the click of the tap that showed them.
  useLayoutEffect(() => {
    if (controlsVisible) shownAt.current = performance.now()
  }, [controlsVisible])

  // The shell, not this player, is what goes fullscreen: the next episode's player is born into it.
  const [fullscreen, setFullscreen] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement && document.fullscreenElement === shell.current)
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shell.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [shell])

  const togglePlay = useCallback(() => {
    const el = video.current
    if (!el) return
    // In a group every client acts on the server's command, so the user's click becomes a request.
    if (syncActive) return el.paused ? remote.syncRequests.unpause() : remote.syncRequests.pause()
    if (el.paused) el.play().catch(() => undefined)
    else el.pause()
  }, [syncActive, remote.syncRequests])
  const progressiveTranscode = !!data && data.transcoded && !data.hls
  const seekLocal = useCallback(
    (seconds: number) => {
      const el = video.current
      if (!el) return
      if (progressiveTranscode) {
        // A progressive transcode can't be scrubbed; ask the server for a new one starting at the target.
        setChoice((current) => ({ ...current, startTicks: secondsToTicks(Math.max(seconds, 0)) }))
      } else if (Number.isFinite(el.duration)) {
        el.currentTime = Math.min(Math.max(seconds, 0), el.duration)
      } else {
        // No metadata yet (stream still starting): apply the seek as soon as it can be.
        el.addEventListener('loadedmetadata', () => (el.currentTime = Math.max(seconds, 0)), { once: true })
      }
    },
    [progressiveTranscode],
  )
  const seek = useCallback(
    (seconds: number) => (syncActive ? remote.syncRequests.seek(secondsToTicks(Math.max(seconds, 0))) : seekLocal(seconds)),
    [syncActive, remote.syncRequests, seekLocal],
  )
  const seekBy = useCallback((delta: number) => seek(ticksToSeconds(positionTicks.current()) + delta), [seek])
  /** `volume` is the slider's position: the element gets it as heard (see loudness). */
  const setVolume = useCallback((volume: number) => {
    const el = video.current
    if (!el) return
    el.volume = loudness(volume)
    el.muted = volume === 0
  }, [])
  const toggleMute = useCallback(() => {
    const el = video.current
    if (el) el.muted = !el.muted
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) return void document.exitFullscreen()
    const element = shell.current
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    // iPhone Safari can only put the video itself fullscreen (with its own controls).
    if (!element?.requestFullscreen) return el?.webkitEnterFullscreen?.()
    void element
      .requestFullscreen()
      // A phone turns a wide picture sideways (Chrome on Android allows this only while fullscreen).
      .then(() => {
        const orientation = window.screen.orientation as ScreenOrientation & { lock?: (to: string) => Promise<void> }
        if (el && el.videoWidth > el.videoHeight) void orientation.lock?.('landscape').catch(() => undefined)
      })
      .catch(() => undefined)
  }, [shell])
  // Leaving fullscreen lets the phone turn freely again.
  useEffect(() => {
    if (!fullscreen) (window.screen.orientation as ScreenOrientation & { unlock?: () => void } | undefined)?.unlock?.()
  }, [fullscreen])
  // Inside an app (Jellyfin's or Lumio's) the player is always fullscreen (no system bars, turned to landscape); there
  // is no fullscreen to toggle. Held across episodes, so the screen stays turned the way the phone is held.
  const inApp = inNativeApp()
  useEffect(() => (inApp ? holdAppFullscreen() : undefined), [inApp])

  // Picture-in-picture, where the browser offers it (Chromium, Safari; Firefox only has its own overlay button).
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true
  const [pip, setPip] = useState(false)
  useEffect(() => {
    const el = video.current
    if (!el || !pipSupported) return
    const onEnter = () => setPip(true)
    const onLeave = () => setPip(false)
    el.addEventListener('enterpictureinpicture', onEnter)
    el.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter)
      el.removeEventListener('leavepictureinpicture', onLeave)
      // Leaving the player must not leave a floating window of a video that no longer exists.
      if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => undefined)
    }
  }, [pipSupported])
  // Lumio's Android app: leaving it while the video plays shrinks the whole app into a floating window (Android's own
  // picture in picture; the setting can turn it off). In there the player shows only the picture.
  const [appPip, setAppPip] = useState(false)
  useEffect(() => {
    const el = video.current
    if (!inCapacitor() || isAudio) return
    setAutoPip(settings.autoPip && !state.paused, el?.videoWidth ?? 16, el?.videoHeight ?? 9, !state.paused)
  }, [settings.autoPip, state.paused, isAudio, data])
  useEffect(() => () => setAutoPip(false, 0, 0, false), [])
  const pipActions = useRef({ togglePlay, seekBy })
  useEffect(() => {
    pipActions.current = { togglePlay, seekBy }
  })
  useEffect(() => {
    if (!inCapacitor()) return
    return onPipEvents(setAppPip, (action) => {
      if (action === 'playpause') pipActions.current.togglePlay()
      else if (action === 'back') pipActions.current.seekBy(-settings.skipBackSeconds)
      else if (action === 'forward') pipActions.current.seekBy(settings.skipForwardSeconds)
      // The window was closed: the video stops rather than playing on unseen.
      else if (action === 'close') video.current?.pause()
    })
  }, [settings.skipBackSeconds, settings.skipForwardSeconds])
  // The desktop app: minimizing the window (or hiding it in the tray) pauses a film or episode, unless it floats in
  // picture in picture. Music and audio items play on.
  const pipNow = useRef(pip)
  useEffect(() => {
    pipNow.current = pip
  })
  useEffect(() => {
    if (isAudio) return
    return desktop()?.onWindowHidden?.(() => {
      if (!pipNow.current) pauseForSleep.current()
    })
  }, [isAudio])
  const togglePip = useCallback(() => {
    const el = video.current
    if (!el) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined)
    else void el.requestPictureInPicture().catch(() => undefined)
  }, [])

  // Picture format: burned-in black bars are detected from the frames, then the picture is fitted to the screen.
  const pictureArea = usePictureArea(video, !isAudio && !!data, data?.url)
  const screen = useElementSize(container)
  const dimensions = useVideoDimensions(video)
  const layout = isAudio ? null : videoLayout(settings.videoFit, pictureArea, dimensions.width, dimensions.height, screen.width, screen.height)
  const pictureWidth = pictureArea.width * dimensions.width
  const pictureHeight = pictureArea.height * dimensions.height
  const fitNames = useMessages(fitLabels)
  const appliedFit =
    pictureWidth && pictureHeight && screen.width && screen.height
      ? resolveFit(settings.videoFit, pictureWidth / pictureHeight, screen.width / screen.height)
      : undefined
  const autoFit =
    pictureWidth && pictureHeight && screen.width && screen.height
      ? fitNames[resolveFit('auto', pictureWidth / pictureHeight, screen.width / screen.height)]
      : undefined

  // Trickplay sheets load in the background once the video plays; while the seek bar is dragged, the frame of the
  // target time is shown large in place of the video.
  usePreloadTrickplay(frameAt, started && settings.preloadTrickplay)
  const [scrubSeconds, setScrubSeconds] = useState<number | null>(null)
  // While dragging over a part that is already buffered, the video itself jumps there (the real frame instead of the
  // thumbnail); only elsewhere does the trickplay frame stand in. Nothing new is loaded until the drag ends: the video
  // pauses, hls.js stops loading, and both resume from the final position on release.
  const [scrubLive, setScrubLive] = useState(false)
  /**
   * Where the video has actually arrived during the drag (its last finished seek). The real frame is only shown once
   * the video got close to the dragged time; until then, or if a seek gets stuck (it can with a paused HLS stream),
   * the trickplay frame stands in, so the picture never freezes on an old frame.
   */
  const [settledAt, setSettledAt] = useState<number | null>(null)
  const scrubbing = useRef<{ wasPlaying: boolean; pending: number | null; onSeeked: () => void } | null>(null)
  const canScrubLive = !syncActive && !progressiveTranscode
  const onScrub = useCallback(
    (seconds: number | null) => {
      setScrubSeconds(seconds)
      const el = video.current
      if (!el || !canScrubLive) return
      if (seconds === null) {
        const drag = scrubbing.current
        scrubbing.current = null
        setScrubLive(false)
        setSettledAt(null)
        if (!drag) return
        el.removeEventListener('seeked', drag.onSeeked)
        // The release has already seeked to the final position (onSeek runs first); load and play from there.
        hlsInstance.current?.startLoad(el.currentTime)
        if (drag.wasPlaying) el.play().catch(() => undefined)
        return
      }
      if (!scrubbing.current) {
        const drag = {
          wasPlaying: !el.paused,
          pending: null as number | null,
          // Seeks are applied one at a time: a new one only once the previous frame is shown, so it keeps up.
          onSeeked: () => {
            setSettledAt(el.currentTime)
            if (drag.pending === null) return
            el.currentTime = drag.pending
            drag.pending = null
          },
        }
        scrubbing.current = drag
        el.addEventListener('seeked', drag.onSeeked)
        hlsInstance.current?.stopLoad()
        el.pause()
      }
      const buffered = isBuffered(el, seconds)
      setScrubLive(buffered)
      if (!buffered) return
      if (el.seeking) scrubbing.current.pending = seconds
      else el.currentTime = seconds
    },
    [canScrubLive],
  )
  const showingLive = scrubLive && scrubSeconds !== null && settledAt !== null && Math.abs(settledAt - scrubSeconds) < 2
  const scrubFrame = scrubSeconds !== null && !showingLive && frameAt && !isAudio ? frameAt(scrubSeconds) : null

  const [statsOpen, setStatsOpen] = useState(false)

  // Fingers: a tap shows or hides the controls; a second tap on the left or right side skips back or ahead (and the
  // first tap's show/hide is undone), as in phone video apps.
  const touch = useTouch()
  // Lumio's Android app: swiping up and down sets the brightness (left) and the volume (right).
  const gesturesOn = inCapacitor() && touch && !isAudio && settings.playerGestures
  const gestures = useSwipeGestures(gesturesOn, settings.playerGestureDeadzone)
  const lastTap = useRef<{ at: number; side: 'back' | 'forward' | null; wasAwake: boolean } | null>(null)
  const [skipHint, setSkipHint] = useState<{ side: 'back' | 'forward'; seconds: number; key: number } | null>(null)
  const onTouchTap = (event: React.PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const side = x < 0.4 ? 'back' : x > 0.6 ? 'forward' : null
    const previous = lastTap.current
    const now = event.timeStamp
    if (previous && side && previous.side === side && now - previous.at < 320) {
      const seconds = side === 'back' ? settings.skipBackSeconds : settings.skipForwardSeconds
      seekBy(side === 'back' ? -seconds : seconds)
      setSkipHint((hint) => ({ side, seconds: hint?.side === side && now - previous.at < 1000 ? hint.seconds + seconds : seconds, key: now }))
      if (previous.wasAwake) wake()
      else setAwake(false)
      lastTap.current = { at: now, side, wasAwake: previous.wasAwake }
      return
    }
    lastTap.current = { at: now, side, wasAwake: awake }
    if (awake) setAwake(false)
    else wake()
  }
  useEffect(() => {
    if (!skipHint) return
    const timer = window.setTimeout(() => setSkipHint(null), 700)
    return () => window.clearTimeout(timer)
  }, [skipHint])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // An open dropdown (the season picker) closes itself first; Escape there must not close the whole panel.
      if (event.target instanceof Element && event.target.closest('[role=listbox]')) return
      if (event.key === 'Escape' && (settingsOpen || episodesOpen)) {
        setSettingsOpen(false)
        setEpisodesOpen(false)
        return
      }
      const target = event.target instanceof Element ? event.target : null
      // Text fields, the open menus and the seek bar handle their own keys; Space/Enter on a focused button must
      // press that button, not toggle playback.
      if (target?.closest('input, textarea, select, [contenteditable], [role=menu], [role=slider], aside')) return
      if ((event.key === ' ' || event.key === 'Enter') && target?.closest('button, a')) return
      if (!settings.keyboardShortcuts) return
      const el = video.current
      const handlers: Record<string, () => void> = {
        ' ': togglePlay,
        k: togglePlay,
        ArrowLeft: () => seekBy(-settings.skipBackSeconds),
        j: () => seekBy(-settings.skipBackSeconds),
        ArrowRight: () => seekBy(settings.skipForwardSeconds),
        l: () => seekBy(settings.skipForwardSeconds),
        ArrowUp: () => el && setVolume(Math.min(1, levelOf(el.volume) + 0.1)),
        ArrowDown: () => el && setVolume(Math.max(0, levelOf(el.volume) - 0.1)),
        m: toggleMute,
        f: inApp ? () => undefined : toggleFullscreen,
        n: playNext,
      }
      const handler = handlers[event.key]
      if (!handler) return
      event.preventDefault()
      handler()
      wake()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, episodesOpen, settings.skipBackSeconds, settings.skipForwardSeconds, settings.keyboardShortcuts, togglePlay, seekBy, setVolume, toggleMute, toggleFullscreen, inApp, playNext, wake])

  // Subtitle position: every cue that becomes active is moved to the line chosen on the settings page. When the
  // picture format pushes part of the frame off screen, lines are counted from the visible edge instead of the frame's,
  // or the subtitles would end up off screen with the cut-off bars.
  const visibleTop = layout ? Math.round(layout.visibleTop * 10) / 10 : 0
  const visibleBottom = layout ? Math.round(layout.visibleBottom * 10) / 10 : 100
  const videoHeightPx = typeof layout?.style.height === 'number' ? Math.round(layout.style.height) : 0
  useEffect(() => {
    const element = video.current
    if (!element || settings.subtitleStyle !== 'custom') return
    const cropped = videoHeightPx > 0 && (visibleTop > 0.5 || visibleBottom < 99.5)
    const linePercent = videoHeightPx ? (SUBTITLE_LINE_PX / videoHeightPx) * 100 : 0
    const listeners = [...element.textTracks].map((track) => {
      const place = () => {
        for (const cue of Array.from(track.activeCues ?? [])) {
          const textCue = cue as VTTCue
          if (!cropped) {
            textCue.snapToLines = true
            textCue.line = settings.subtitleLine
          } else if (settings.subtitleLine < 0) {
            textCue.snapToLines = false
            textCue.lineAlign = 'end'
            textCue.line = Math.max(0, visibleBottom - (Math.abs(settings.subtitleLine) - 1) * linePercent)
          } else {
            textCue.snapToLines = false
            textCue.lineAlign = 'start'
            textCue.line = Math.min(100, visibleTop + settings.subtitleLine * linePercent)
          }
        }
      }
      place()
      track.addEventListener('cuechange', place)
      return { track, place }
    })
    return () => listeners.forEach(({ track, place }) => track.removeEventListener('cuechange', place))
  }, [data, activeSubtitle, settings.subtitleLine, settings.subtitleStyle, visibleTop, visibleBottom, videoHeightPx])

  // Intro/outro/...: skip automatically or offer a button, depending on the device settings.
  const segments = useMediaSegments(id, !isAudio && !!item.data)
  // Before the start position is reached the clock sits at 0, which would wrongly match intros starting at 0.
  const activeSegment = !started ? undefined : segments.data?.find(
    (segment) => settings.segmentActions[segment.kind] !== 'None' && state.currentTime >= segment.start && state.currentTime < segment.end - 1,
  )
  // In a group, an automatic skip by every member would send a seek each; offer the button instead.
  const configuredAction = activeSegment ? settings.segmentActions[activeSegment.kind] : 'None'
  const segmentAction = syncActive && configuredAction === 'Skip' ? 'AskToSkip' : configuredAction
  const autoSkipped = useRef(new Set<string>())

  // Ending soon (last 90 s, or the outro has begun): get the next episode ready so it starts quickly.
  const outro = segments.data?.find((segment) => segment.kind === 'Outro')
  const endingSoon =
    started && state.duration > 0 && (state.duration - state.currentTime < 90 || (!!outro && state.currentTime >= outro.start - 20))
  usePreloadNext(next, settings.preloadNextEpisode && !syncActive && endingSoon)
  // The next episodes are downloaded for later once this one is under way (a minute in).
  // In the language being watched.
  const watchedLanguage = data?.streams.find((stream) => stream.Type === 'Audio' && stream.Index === data.audioIndex)?.Language
  useVideoPrefetch(item.data, started && state.currentTime > 60, watchedLanguage)
  useEffect(() => {
    if (!activeSegment || segmentAction !== 'Skip' || autoSkipped.current.has(activeSegment.id)) return
    autoSkipped.current.add(activeSegment.id)
    seek(activeSegment.end)
  }, [activeSegment, segmentAction, seek])

  // Opened directly (no in-app history): fall back to the detail page instead of leaving the app.
  const goBack = useCallback(
    () => void (location.key === 'default' ? navigate(`/item/${id}`, { replace: true }) : navigate(-1)),
    [location.key, navigate, id],
  )

  // Lets other devices and the SyncPlay group steer this player (their commands bypass the click interception above).
  const { registerPlayer } = remote
  useEffect(() => {
    const el = video.current
    if (!el) return
    return registerPlayer({
      play: () => void el.play().catch(() => undefined),
      pause: () => el.pause(),
      seekToTicks: (ticks) =>
        new Promise<void>((resolve) => {
          const done = () => {
            window.clearTimeout(timeout)
            el.removeEventListener('seeked', done)
            el.removeEventListener('canplay', done)
            resolve()
          }
          const timeout = window.setTimeout(done, 8000)
          // A progressive transcode "seeks" by loading a new stream: it is ready on canplay, not on seeked.
          el.addEventListener(progressiveTranscode ? 'canplay' : 'seeked', done)
          seekLocal(ticksToSeconds(ticks))
        }),
      stop: goBack,
      next: playNext,
      previous: () => seekLocal(0),
      setVolume,
      setMuted: (muted) => (muted === 'toggle' ? toggleMute() : void (el.muted = muted)),
      seekBy: (delta) => seekLocal(ticksToSeconds(positionTicks.current()) + delta),
      getPositionTicks: () => positionTicks.current(),
      setPlaybackRate: (rate) => void (el.playbackRate = rate),
      isPaused: () => el.paused,
    })
  }, [registerPlayer, seekLocal, progressiveTranscode, goBack, playNext, setVolume, toggleMute])

  const openItem = useCallback(
    (target: string) => void navigate(`/play/${target}`, { replace: true, state: { continuing: true } satisfies ContinuingState }),
    [navigate],
  )
  const closeEpisodes = useCallback(() => setEpisodesOpen(false), [])
  // Stays mounted while it slides back out.
  const episodesPresence = usePresence(episodesOpen)
  const settingsPresence = usePresence(settingsOpen, 150)

  // Episodes: the series as the title, below it which episode this is ("S9 · E2 — Ehevollzug!").
  const isEpisode = item.data?.Type === 'Episode'
  const title = isEpisode ? item.data?.SeriesName : item.data?.Name
  const episodeLine = isEpisode && item.data ? [episodeCode(item.data, playT.special), item.data.Name].filter(Boolean).join(' — ') : undefined

  if (playback.isError || failed) {
    return (
      <div className="dark grid min-h-svh place-items-center bg-black p-8 text-center text-white">
        <div className="space-y-4">
          <p>{t.cannotPlay}</p>
          {(failed || playback.error) && <p className="font-mono text-xs text-white/40">{failed ?? playback.error?.message}</p>}
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={() => window.location.reload()}>
              {t.retry}
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link to={`/item/${id}`} />}>
              {t.backToOverview}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const cover = isAudio && item.data ? portraitImageUrl(api, item.data, { fillHeight: 640 }) : undefined
  // Until the video's first frame, the title's backdrop (as Jellyfin's own apps do); admins can turn it off.
  // Not on the way from one episode to the next: the picture would flash up between them.
  const continuing = !!(location.state as ContinuingState | null)?.continuing
  const loadingArt =
    lumioConfig?.playerLoadingArt !== false && !isAudio && !continuing && item.data ? (backdropImageUrl(api, item.data) ?? landscapeImageUrl(api, item.data, { fillWidth: 1600 })) : undefined
  const firstFrame = startedFor === id
  // The tap that brings the controls back must not also press the button that appears under the finger: the browser
  // sends that tap's click after the controls are already there.
  const guardShowingTap = (event: React.MouseEvent) => {
    if (event.timeStamp - shownAt.current < SHOW_GRACE_MS) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const delivery = !data ? '…' : data.hls ? t.deliveryHls : data.transcoded ? t.deliveryTranscoded : t.deliveryDirect

  return (
    <PortalContainerContext value={portalRoot}>
    <div
      ref={(node) => {
        container.current = node
        setPortalRoot(node)
      }}
      data-player
      // overflow-clip, not -hidden: a hidden overflow is still a scroll container, and the oversized blurred cover behind
      // audio (or a focus moving into view) could scroll the whole player off by a few pixels, leaving bare strips.
      className={cn('dark relative h-svh overflow-clip bg-black text-foreground', settings.subtitleStyle === 'custom' && 'subs-custom', !controlsVisible && 'cursor-none')}
      // A finger brings the controls back by a tap (onTouchTap), not by moving: swipes (brightness, volume) leave them hidden.
      onPointerMove={(event) => event.pointerType !== 'touch' && wake()}
      // Tabbing into the (possibly faded-out) controls brings them back.
      onFocus={wake}
    >
      <video
        ref={video}
        playsInline
        crossOrigin="anonymous"
        style={{ ...subtitleCssVars(settings), ...layout?.style }}
        className={cn(
          isAudio ? 'pointer-events-none absolute size-px opacity-0' : 'size-full object-contain',
          // Glide into a new format (e.g. when the bars have been detected) instead of jumping.
          layout && 'transition-[left,top,width,height] duration-500 ease-out motion-reduce:transition-none',
        )}
      >
        {streamOptions.subtitles
          .filter((option) => option.url)
          .map((option) => (
            <track
              key={option.index}
              kind="subtitles"
              src={option.url}
              srcLang={option.language}
              label={option.title}
              // Inactive tracks stay "disabled" so their files are only downloaded when picked.
              ref={(node) => {
                if (node) node.track.mode = option.index === activeSubtitle ? 'showing' : 'disabled'
              }}
            />
          ))}
      </video>

      {loadingArt && (
        <div
          aria-hidden
          className={cn('pointer-events-none absolute inset-0 bg-black transition-opacity duration-700 ease-out', firstFrame ? 'opacity-0' : 'opacity-100')}
        >
          <FadeImage src={loadingArt} alt="" className="size-full object-cover" />
        </div>
      )}

      {isAudio && (
        <div className="absolute inset-0 grid place-items-center bg-neutral-950">
          {cover && <FadeImage src={cover} alt="" className="absolute inset-0 size-full scale-110 object-cover opacity-25 blur-3xl" />}
          <div className="relative flex max-w-md flex-col items-center gap-6 px-6 text-center text-white">
            <div className="aspect-square w-64 overflow-hidden rounded-xl bg-muted shadow-2xl ring-1 ring-white/10 sm:w-80">
              {cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}
            </div>
            <div className="space-y-1">
              <p className="text-xl font-semibold">{item.data?.Name}</p>
              <p className="text-sm text-white/70">{[item.data?.AlbumArtist, item.data?.Album].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Click surface: mouse toggles playback, touch toggles the controls (in Lumio's app, swipes set brightness/volume). */}
      <div
        className={cn('absolute inset-0', gesturesOn ? 'touch-none' : 'touch-manipulation')}
        {...gestures.handlers}
        onPointerUp={(event) => {
          // A swipe (brightness, volume) is no tap.
          if (gestures.consumed()) return
          if (panelOpen) {
            setSettingsOpen(false)
            setEpisodesOpen(false)
          } else if (event.pointerType === 'touch') onTouchTap(event)
          else togglePlay()
        }}
        // A finger's double tap skips (onTouchTap); only a mouse's double click toggles fullscreen.
        onDoubleClick={inApp || touch ? undefined : toggleFullscreen}
      />

      <SwipeLevel level={gestures.level} />

      {skipHint && (
        <div
          key={skipHint.key}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 z-10 flex w-2/5 items-center justify-center bg-white/10 text-lg font-semibold text-white animate-out fade-out-0 fill-mode-forwards delay-300 duration-400',
            skipHint.side === 'back' ? 'left-0 rounded-r-[50%]' : 'right-0 rounded-l-[50%]',
          )}
        >
          {skipHint.side === 'back' ? `−${skipHint.seconds} s` : `+${skipHint.seconds} s`}
        </div>
      )}

      {!isAudio && <PauseSpotlight item={item.data} visible={spotlightVisible && !appPip} />}

      {activeSegment && segmentAction === 'AskToSkip' && (
        <Button
          variant="secondary"
          className="absolute bottom-[4.75rem] right-4 z-20 animate-in fade-in-0 slide-in-from-right-4 duration-300 sm:right-8"
          // Skipping leaves the controls as they are: hidden ones stay hidden (the focus would wake them), shown ones stay.
          onFocus={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={() => seek(activeSegment.end)}
        >
          {skipLabels[activeSegment.kind]}
        </Button>
      )}

      {breakDue !== null && (
        <BreakReminder
          minutes={breakDue}
          onResume={() => {
            setBreakDue(null)
            if (video.current?.paused) togglePlay()
          }}
          onLeave={goBack}
        />
      )}

      {scrubFrame && <ScrubPreview frame={scrubFrame} pictureArea={pictureArea} fit={settings.videoFit} screen={screen} />}

      {(!data || state.waiting) && !scrubFrame && !scrubLive && <LoadingIndicator percent={loadPercent} />}

      <PluginSlot name="player:overlay" context={{ itemId: id }} className="pointer-events-none absolute inset-0 z-10 *:pointer-events-auto" />

      {statsOpen && data && (
        <StatsOverlay
          playback={data}
          video={video}
          delivery={delivery}
          pictureArea={pictureArea}
          fit={appliedFit}
          screen={screen}
          onClose={() => setStatsOpen(false)}
        />
      )}

      {/* Outside the fading layer below: an ancestor that is see-through mid-fade hides the video from the buttons'
          backdrop blur, which then only set in once the fade was over. They fade by themselves instead. */}
      {touch && !panelOpen && (
        <div onClickCapture={guardShowingTap}>
          <TouchTransport
            visible={controlsVisible && !appPip}
            paused={state.paused}
            onTogglePlay={togglePlay}
            onSeekBy={seekBy}
            skipBackSeconds={settings.skipBackSeconds}
            skipForwardSeconds={settings.skipForwardSeconds}
          />
        </div>
      )}

      <div
        className={cn('transition-opacity duration-300', (!controlsVisible || appPip) && 'pointer-events-none opacity-0')}
        onClickCapture={guardShowingTap}
      >
        <div data-titlebar data-titlebar-inset className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-linear-to-b from-black/70 to-transparent pt-[max(1rem,var(--safe-top))] pr-[max(1rem,var(--safe-right))] pb-4 pl-[max(1rem,var(--safe-left))] text-white">
          <Button variant="ghost" size="icon" aria-label={t.back} onClick={goBack}>
            <IconArrowLeft />
          </Button>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate font-medium">{title}</p>
            {episodeLine && <p className="truncate text-sm text-white/70">{episodeLine}</p>}
          </div>
          {/* Watch together and "play on" stay reachable while watching (they hand the title over at the current spot). */}
          <SyncPlayMenu />
          <DeviceMenu />
        </div>

        {episodesPresence.mounted && item.data && (
          <EpisodePanel item={item.data} closing={episodesPresence.closing} onSelect={openItem} onClose={closeEpisodes} />
        )}

        {settingsPresence.mounted && data && (
          <SettingsPanel
            closing={settingsPresence.closing}
            audioOnly={isAudio}
            audio={streamOptions.audio}
            audioIndex={data.audioIndex}
            onAudio={(index) => index !== data.audioIndex && restartWith({ audio: index })}
            subtitles={streamOptions.subtitles}
            subtitleIndex={activeSubtitle}
            onSubtitle={(index) => index !== activeSubtitle && chooseSubtitle(index)}
            maxBitrate={choice.maxBitrate}
            // The stored copy's quality plays from the device again; any other streams (online).
            onQuality={(bitrate, fromDevice) => {
              if (fromDevice ? !!data.stats.offline : bitrate === choice.maxBitrate && !data.stats.offline) return
              restartWith({ maxBitrate: fromDevice ? choice.maxBitrate : bitrate, stream: !fromDevice })
            }}
            storedBitrate={storedBitrate}
            playingStored={!!data.stats.offline}
            qualityLocked={offline && !!data.stats.offline}
            storedAudioIndex={hasStored ? storedAudio(id)?.index : undefined}
            onShowStats={() => {
              setSettingsOpen(false)
              setStatsOpen(true)
            }}
            speed={effectiveRate}
            speedLocked={syncActive}
            onSpeed={setRate}
            fit={isAudio ? undefined : settings.videoFit}
            autoFitLabel={autoFit}
            onFit={isAudio ? undefined : (videoFit) => updateSettings({ videoFit })}
          />
        )}

        <PlayerControls
          touch={touch}
          state={state}
          fullscreen={fullscreen}
          onTogglePlay={togglePlay}
          onSeek={seek}
          frameAt={frameAt}
          onSeekBy={seekBy}
          skipBackSeconds={settings.skipBackSeconds}
          skipForwardSeconds={settings.skipForwardSeconds}
          onVolume={setVolume}
          onToggleMute={toggleMute}
          onToggleFullscreen={inApp ? undefined : toggleFullscreen}
          settingsOpen={settingsOpen}
          episodesOpen={episodesOpen}
          onToggleEpisodes={
            item.data?.Type === 'Episode' || item.data?.Type === 'Audio'
              ? () => {
                  setSettingsOpen(false)
                  setEpisodesOpen((open) => !open)
                }
              : undefined
          }
          onToggleSettings={() => {
            setEpisodesOpen(false)
            setSettingsOpen((open) => !open)
          }}
          onNext={next ? playNext : undefined}
          onTogglePip={pipSupported && !isAudio ? togglePip : undefined}
          pip={pip}
          pictureArea={pictureArea}
          onScrub={onScrub}
        />
      </div>
    </div>
    </PortalContainerContext>
  )
}

/** Whether the video has the given time loaded (with a little room after it, so the frame can actually be shown). */
function isBuffered(el: HTMLVideoElement, seconds: number) {
  for (let i = 0; i < el.buffered.length; i++) {
    if (seconds >= el.buffered.start(i) && seconds <= el.buffered.end(i) - 0.5) return true
  }
  return false
}
