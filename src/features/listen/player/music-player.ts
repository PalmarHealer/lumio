import type { Api } from '@jellyfin/sdk'
import { PlayMethod, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { useSyncExternalStore } from 'react'
import { externalOf } from '@/lib/external-items'
import { secondsToTicks, ticksToSeconds } from '@/lib/format'
import { readLocalSettings, streamingMusicQuality } from '@/features/settings/local-settings'
import { jellyfin } from '@/lib/jellyfin'
import { levelOf, loudness } from '@/lib/loudness'
import { podcastProgress, recordPodcastProgress } from '../podcasts'
import { reportActivity } from '@/features/social/social'
import { flushPlayback, rememberPlayback } from '@/lib/playback-outbox'
import { recordRecent } from '../recent'
import { adoptIntoCache, audioCacheAvailable, cachedAudioUrl, isCached, prefetchAudio, recordCachedPlay } from './audio-cache'
import { isOffline } from '@/lib/network'
import { inJellyfinApp, setAppPlaybackManager, updateAppMediaSession } from '@/lib/native-app'
import { inCapacitor } from '@/lib/capacitor'
import { desktop } from '@/lib/desktop'
import { MediaSession as NativeMediaSession } from '@capgo/capacitor-media-session'
import { flushPlays, logBuffering, logPlay, type EndReason, type PlayContext, type StartReason } from './play-log'
import { downloadedAudioUrl, downloadId, isDownloaded, setDownloadQuality, setDownloadSource, setReleaseHandler } from './downloads'
import { DIRECT_FORMATS } from './quality'
import { setSleepHandler, sleepsAfterTrack, stopsAfterTrack } from './sleep-timer'
import type { Transition } from '../mixer/types'
import { asPlayed, createDeck, createMaster, freezeDeck, handoverPoint, rampAt, releaseEcho, resetDeck, scheduleTransition, type Deck, type Master } from '../mixer/engine'
import { bSettled, deckPlan, positionAt, rateOf, timeOfAdvance, trackSpan, withBrake, type DeckPlan } from '../mixer/deck-schedule'
import { bufferDeckKind, tempoChangeKind, type BufferDeckKind } from '../mixer/buffer-deck'
import { mono } from '../mixer/xcorr'
import { currentPlayLead, followPlan, learnPlayLead, waitForCue, wakeAfter } from './deck-sync'
import { calibratedStart, closeSide, crossfade, locateElement, medianStart, openSide, type BufferSide, type Located } from './mix-buffers'
import { blobSlice, streamSlice, type Slice } from './slices'

/**
 * Listen's player: one <audio> element for the whole app, so music keeps playing while the user moves between pages
 * (and even over to Watch). A small store outside React holds the queue and the playback state; components read it
 * with `useMusic`. The fast-changing position has its own store (`useMusicTime`) so the whole UI doesn't re-render
 * several times a second.
 */
export type RepeatMode = 'off' | 'all' | 'one'

/**
 * Where an entry of the play order comes from, as in Spotify: the collection that was started (`context`), the user's
 * own queue (`user`: added songs, played before the collection goes on), or autoplay after the collection ended.
 */
export type QueueKind = 'context' | 'user' | 'autoplay'

/** What the player knows about each entry of `queue` (same positions): where it comes from, and a stable id for lists. */
export interface QueueEntry {
  kind: QueueKind
  uid: string
}

export interface MusicState {
  queue: BaseItemDto[]
  /** One per track in `queue`. */
  entries: QueueEntry[]
  /** Position of the current track in `queue`; -1 when nothing is loaded. */
  index: number
  playing: boolean
  /** Waiting for data (start, seeking, slow network). */
  buffering: boolean
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  muted: boolean
  /** The order before shuffling, restored when shuffle is switched off. */
  unshuffled: BaseItemDto[] | null
  /** What the queue was started from (e.g. `playlist:<id>`), so its page can show it is the one playing. */
  source: string | null
}

export interface MusicTime {
  position: number
  duration: number
}

/** The slider's position (0–1); the older key held the element's volume itself (see `loudness`). */
const VOLUME_KEY = 'lumio.music.level'
const OLD_VOLUME_KEY = 'lumio.music.volume'
const SHUFFLE_KEY = 'lumio.music.shuffle'
/** How often the position is reported while playing (also what a device steering this one moves on from). */
const PROGRESS_EVERY_MS = 5000
/** "Previous" within this many seconds goes to the previous track; later it restarts the current one. */
const RESTART_AFTER_S = 3
/** Long tracks (audiobook chapters, mixes) resume where they were left. */
const RESUME_MIN_S = 10 * 60

function readVolume() {
  try {
    const level = localStorage.getItem(VOLUME_KEY)
    const old = localStorage.getItem(OLD_VOLUME_KEY)
    // A volume set before the slider followed the ear: the same loudness as then.
    const stored = level !== null ? Number(level) : old !== null ? levelOf(Number(old)) : NaN
    return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.8
  } catch {
    return 0.8
  }
}

let state: MusicState = {
  queue: [],
  entries: [],
  index: -1,
  playing: false,
  buffering: false,
  shuffle: false,
  repeat: 'off',
  volume: readVolume(),
  muted: false,
  unshuffled: null,
  source: null,
}
let time: MusicTime = { position: 0, duration: 0 }

/**
 * Shuffle is remembered per collection (album, artist, playlist; keyed like `source`), as in Spotify: switching it on
 * for one doesn't touch what plays now, and playing a collection takes its own setting along. Kept per device.
 */
let shufflePrefs: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SHUFFLE_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
})()
const shuffleListeners = new Set<() => void>()

function saveShufflePref(source: string, on: boolean) {
  const { [source]: _previous, ...rest } = shufflePrefs
  // Only "on" is stored; off is the default.
  shufflePrefs = on ? { ...rest, [source]: true } : rest
  try {
    localStorage.setItem(SHUFFLE_KEY, JSON.stringify(shufflePrefs))
  } catch {
    // Only remembered for this visit.
  }
  for (const listener of shuffleListeners) listener()
}

/** Whether shuffle is on for a collection: while it plays, the player's own state; otherwise what was set for it. */
export function useShuffleFor(source: string) {
  const playing = useMusic()
  const prefs = useSyncExternalStore(
    (listener) => {
      shuffleListeners.add(listener)
      return () => shuffleListeners.delete(listener)
    },
    () => shufflePrefs,
  )
  if (playing.source === source && playing.index >= 0) return playing.shuffle
  return !!prefs[source]
}

const stateListeners = new Set<() => void>()
const timeListeners = new Set<() => void>()

function setState(patch: Partial<MusicState>) {
  state = { ...state, ...patch }
  for (const listener of stateListeners) listener()
  if ('queue' in patch || 'index' in patch || 'source' in patch || 'shuffle' in patch || 'repeat' in patch) saveSessionSoon()
  // What comes next may have changed: the mixer looks again at the transition into it.
  if ('queue' in patch || 'entries' in patch || 'index' in patch || 'source' in patch || 'shuffle' in patch || 'repeat' in patch) planSoon()
}

function setTime(next: MusicTime) {
  if (next.position === time.position && next.duration === time.duration) return
  time = next
  for (const listener of timeListeners) listener()
}

export function useMusic(): MusicState {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    () => state,
  )
}

export function useMusicTime(): MusicTime {
  return useSyncExternalStore(
    (listener) => {
      timeListeners.add(listener)
      return () => timeListeners.delete(listener)
    },
    () => time,
  )
}

export const currentTrack = (from: MusicState = state) => from.queue[from.index]

// ---- connection to the server (set by MusicPlayerHost once signed in) ----

let connection: { api: Api; userId: string; accessToken: string } | null = null
let playSessionId = ''
let progressTimer: number | undefined

export function connectMusicPlayer(next: typeof connection) {
  if (!next && connection) stop('logout')
  connection = next
  if (next && state.index < 0) restoreSession(next.userId)
  // Plays that couldn't be sent before (offline) go out now.
  if (next) flushPlays()
  // Songs that leave the downloads go into the cache, if they are at least as good as what streams (else they'd play
  // worse than streaming would); otherwise they are dropped.
  setReleaseHandler(
    next
      ? async (id, blob, quality) => {
          const settings = readLocalSettings(next.userId)
          const stream = streamingMusicQuality(settings)
          const goodEnough = quality === null || (stream !== null && quality >= stream)
          if (!goodEnough) return
          await adoptIntoCache(`${id}|${stream ?? 'original'}`, blob, { maxBytes: settings.musicCacheMb * 1024 * 1024, keepOftenPlayed: settings.musicKeepOften })
        }
      : null,
  )
  // Downloads come from the library in their own quality (and are fetched again when it changed while away).
  if (next) void setDownloadQuality(readLocalSettings(next.userId).musicDownloadQuality).then(() => setDownloadSource((id, quality) => libraryAudioUrl(id, quality, crypto.randomUUID())))
  else setDownloadSource(null)
}

// ---- picking up where the user left off (after a reload) ----

/**
 * The queue, the track and its position are kept on this device, per user, so a reload (or coming back later) shows
 * the same track paused at the same spot: pressing play goes on from there. Until then nothing is loaded from the
 * server; `pendingStart` holds where playback will start.
 */
const sessionKey = (userId: string) => `lumio.music.session.${userId}`
/** At most this many tracks of the queue are kept (around the current one). */
const KEEP_QUEUE = 500
/** While playing, the position is written at most this often. */
const SAVE_POSITION_MS = 5000

interface SavedSession {
  queue: BaseItemDto[]
  /** Where each track comes from (older sessions: all from the collection). */
  kinds?: QueueKind[]
  index: number
  position: number
  source: string | null
  shuffle: boolean
  repeat: RepeatMode
}

let pendingStart: number | null = null
let sessionTimer: number | undefined
let positionSavedAt = 0

/** Only what the player and its views need of a track, so the saved queue stays small. */
function compactTrack(item: BaseItemDto): BaseItemDto {
  const keep = [
    'Id', 'Name', 'Type', 'AlbumId', 'Album', 'AlbumArtist', 'AlbumArtists', 'Artists', 'ArtistItems', 'RunTimeTicks', 'ImageTags',
    'AlbumPrimaryImageTag', 'ParentId', 'ParentPrimaryImageItemId', 'ParentPrimaryImageTag', 'IndexNumber', 'ParentIndexNumber',
    'PlaylistItemId', 'PremiereDate', 'UserData', 'NormalizationGain', '__lumioExternal',
  ]
  const source = item as Record<string, unknown>
  return Object.fromEntries(keep.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]])) as BaseItemDto
}

function writeSession() {
  window.clearTimeout(sessionTimer)
  if (!connection) return
  try {
    if (state.index < 0) return localStorage.removeItem(sessionKey(connection.userId))
    const from = Math.max(0, Math.min(state.index - 100, state.queue.length - KEEP_QUEUE))
    const saved: SavedSession = {
      queue: state.queue.slice(from, from + KEEP_QUEUE).map(compactTrack),
      kinds: state.entries.slice(from, from + KEEP_QUEUE).map((entry) => entry.kind),
      index: state.index - from,
      position: pendingStart ?? audio?.currentTime ?? 0,
      source: state.source,
      shuffle: state.shuffle,
      repeat: state.repeat,
    }
    localStorage.setItem(sessionKey(connection.userId), JSON.stringify(saved))
    positionSavedAt = Date.now()
  } catch {
    // Not remembered (storage full or blocked).
  }
}

function saveSessionSoon() {
  window.clearTimeout(sessionTimer)
  sessionTimer = window.setTimeout(writeSession, 500)
}

function restoreSession(userId: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey(userId)) ?? 'null') as SavedSession | null
    const track = saved?.queue[saved.index]
    if (!saved || !track) return
    pendingStart = saved.position
    const entries = saved.queue.map((_, position) => entry(saved.kinds?.[position] ?? 'context'))
    setState({ queue: saved.queue, entries, index: saved.index, source: saved.source, shuffle: saved.shuffle, repeat: saved.repeat, unshuffled: null, playing: false })
    setTime({ position: saved.position, duration: ticksToSeconds(track.RunTimeTicks ?? 0) })
    updateMediaSession()
  } catch {
    // Nothing usable stored.
  }
}

// Leaving the page saves the exact spot; a tab with nothing loaded leaves the stored session alone (only stopping
// playback clears it), so it can't wipe what another tab saved.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => state.index >= 0 && writeSession())

function streamUrl(item: BaseItemDto, sessionId = playSessionId) {
  // Podcast episodes play straight from their host.
  const external = externalOf(item)
  if (external) return external.url
  return libraryAudioUrl(item.Id!, streamingMusicQuality(readLocalSettings(connection!.userId)), sessionId)
}

/** A library song's audio in a quality (kbps; null = the original file where the browser can play it). */
function libraryAudioUrl(id: string, limit: number | null, sessionId: string) {
  const { api, userId, accessToken } = connection!
  const params = new URLSearchParams({
    UserId: userId,
    DeviceId: jellyfin.deviceInfo.id,
    // Direct play whatever the browser can decode (FLAC included); anything else is converted to MP3 on the fly, as is
    // anything above the quality limit set in the settings.
    Container: DIRECT_FORMATS,
    TranscodingContainer: 'mp3',
    TranscodingProtocol: 'http',
    AudioCodec: 'mp3',
    MaxStreamingBitrate: String(limit ? limit * 1000 : 320_000_000),
    ...(limit ? { AudioBitRate: String(Math.min(limit, 320) * 1000) } : {}),
    PlaySessionId: sessionId,
    ApiKey: accessToken,
  })
  return `${api.basePath}/Audio/${id}/universal?${params}`
}

// ---- the audio elements ----

/**
 * Volume normalization (Settings → Music): Jellyfin measures each track's and album's loudness (its "audio
 * normalization" task) and tells the gain in dB that brings it to a common level. Lumio can only turn the element
 * down, not up, so loud tracks are lowered and quiet ones stay as they are. Tracks without a measurement play unchanged.
 * Kept per element: during a mixer transition both tracks sound, each with its own gain.
 */
const trackGains = new WeakMap<HTMLAudioElement, number>()
const albumGains = new Map<string, number | null>()

/** Pause and play fade (0 silent – 1 full), instead of cutting the sound off. */
let fadeLevel = 1
let fadeTimer = 0
const FADE_OUT_MS = 300
const FADE_IN_MS = 400

/** The mixer's Web Audio decks, per element (see "the mixer" below); an element without one plays straight out. */
const decks = new WeakMap<HTMLAudioElement, Deck>()
/** Which track each element has loaded (an element's position only means something for its own track). */
const holds = new WeakMap<HTMLAudioElement, BaseItemDto>()

/**
 * `audio` plays the current track. A mixer transition plays the next track on a second element (`standby`) while both
 * sound; then the two swap roles. Without transitions only `audio` ever plays.
 */
let audio: HTMLAudioElement | null = typeof Audio !== 'undefined' ? createElement() : null
let standby: HTMLAudioElement | null = null
applyVolume()

function createElement() {
  const element = new Audio()
  element.preload = 'auto'
  wire(element)
  return element
}

/** An element's volume: the slider, the pause fade and its track's normalization. */
function volumeOf(element: HTMLAudioElement) {
  return Math.min(1, Math.max(0, loudness(state.volume * fadeLevel) * (trackGains.get(element) ?? 1)))
}

/** Sets each element's volume. */
function applyVolume() {
  for (const element of [audio, standby]) {
    if (!element) continue
    const volume = volumeOf(element)
    const deck = decks.get(element)
    if (!deck) {
      element.volume = volume
      if (element.muted !== state.muted) element.muted = state.muted
      continue
    }
    // On the graph the deck's level does it; the element stays at full volume so nothing is applied twice.
    element.volume = 1
    element.muted = false
    deck.level.gain.setTargetAtTime(state.muted ? 0 : volume, deck.ctx.currentTime, 0.005)
  }
}

/**
 * Fades to `to` and then calls `done`. Steps follow the clock, so a throttled timer (a hidden window) only makes the
 * fade coarser, never longer than it should be.
 */
function fade(to: number, ms: number, done?: () => void) {
  window.clearInterval(fadeTimer)
  const from = fadeLevel
  const start = performance.now()
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / ms)
    // Eased: gentle at both ends.
    fadeLevel = from + (to - from) * (t * t * (3 - 2 * t))
    applyVolume()
    if (t < 1) return
    window.clearInterval(fadeTimer)
    done?.()
  }
  fadeTimer = window.setInterval(step, 16)
  step()
}

/** Whether a pause is fading out (still audible, but as good as paused). */
let fadingOut = false

/** Ends a fade at once at full volume (a new track, a stop). */
function unfade() {
  window.clearInterval(fadeTimer)
  fadingOut = false
  fadeLevel = 1
  applyVolume()
}

/** Fades out, then pauses; the controls show the pause right away. (A transition under way pauses with it.) */
function fadeOut() {
  const element = audio
  if (!element || element.paused || fadingOut) return
  fadingOut = true
  setState({ playing: false })
  fade(0, FADE_OUT_MS, () => {
    // The current element then: a transition may have handed over to the next track during the fade.
    audio?.pause()
    unfade()
  })
}

/** Plays, fading in (also when a fade out is still under way: it turns back). */
function fadeIn() {
  const element = audio
  if (!element) return
  fadingOut = false
  wakeContext()
  if (element.paused) {
    window.clearInterval(fadeTimer)
    fadeLevel = 0
    applyVolume()
    void element.play().catch(() => unfade())
  } else setState({ playing: true })
  fade(1, FADE_IN_MS)
}

async function gainOf(item: BaseItemDto): Promise<number | null> {
  const mode = connection ? readLocalSettings(connection.userId).musicNormalization : 'off'
  if (mode === 'off' || externalOf(item)) return null
  const track = item.NormalizationGain ?? null
  if (mode !== 'album' || !item.AlbumId || !connection) return track
  if (!albumGains.has(item.AlbumId)) {
    const { api, userId } = connection
    const album = await getLibraryApi(api)
      .getItem({ itemId: item.AlbumId, userId })
      .then((response) => response.data.NormalizationGain ?? null)
      .catch(() => null)
    albumGains.set(item.AlbumId, album)
  }
  // Albums without a measurement fall back to the track's own.
  return albumGains.get(item.AlbumId) ?? track
}

/** Sets the gain for the track playing (on every track change, and when the setting changes). */
async function normalize(item = currentTrack()) {
  const gain = item ? await gainOf(item) : null
  if (item !== currentTrack() || !audio) return
  trackGains.set(audio, gainFactorOf(gain))
  applyVolume()
}

const gainFactorOf = (gain: number | null) => (gain === null ? 1 : Math.min(1, 10 ** (gain / 20)))

/**
 * The element's events. Only those of the element playing the current track count; the other one's are the mixer's
 * business (it loads and starts the next track) and are left to it.
 */
function wire(element: HTMLAudioElement) {
  const current = () => element === audio
  element.addEventListener('play', () => {
    if (!current()) return
    setState({ playing: true })
    updateAppSession()
    shareActivity(true)
    // Listening time counts again from here (it stopped at the pause).
    const item = currentTrack()
    if (item) logPlay('progress', item, true, playSessionId)
    mixerPlayed()
  })
  element.addEventListener('pause', () => {
    if (!current()) return
    // A's own end during a transition: 'ended' follows and hands over to B, which must not be paused here.
    if (element.ended && running?.a === element && !running.handedOver) return
    setState({ playing: false })
    updateAppSession()
    shareActivity(false)
    report('progress')
    writeSession()
    mixerPaused()
  })
  element.addEventListener('waiting', () => {
    if (!current()) return
    setState({ buffering: true })
    logBuffering(true)
  })
  element.addEventListener('playing', () => {
    if (!current()) return
    setState({ buffering: false })
    logBuffering(false)
  })
  element.addEventListener('canplay', () => current() && setState({ buffering: false }))
  element.addEventListener('timeupdate', () => {
    if (!current()) return
    setTime({ position: element.currentTime, duration: durationOf() })
    if (Date.now() - positionSavedAt > SAVE_POSITION_MS) writeSession()
    mixerTick()
  })
  element.addEventListener('durationchange', () => {
    if (!current()) return
    setTime({ position: element.currentTime, duration: durationOf() })
    updateAppSession()
  })
  element.addEventListener('seeked', () => current() && updateAppSession())
  element.addEventListener('ended', () => {
    // The track ran out while the next one was already coming in: that one is the track now.
    if (running && running.a === element && !running.handedOver) return finishRunning(running)
    if (current() && !followsBackToBack(element)) onEnded()
  })
  element.addEventListener('error', () => {
    if (!current()) return mixerElementFailed(element)
    setState({ buffering: false })
    // A library track loaded with CORS: maybe the server refuses CORS (checked before giving up on it).
    const item = currentTrack()
    if (corsLoads.has(element) && element.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && item && !externalOf(item)) return void corsFailed(element, item)
    failed(element)
  })
}

/** The current track can't be played: the next transition's B takes over, or it is skipped (not the whole queue). */
function failed(element: HTMLAudioElement) {
  if (running && running.a === element && !running.handedOver) return finishRunning(running)
  if (state.index < state.queue.length - 1) void go(state.index + 1, undefined, 'trackerror')
}

/** Transcoded streams don't always know their length; the library does. */
function durationOf() {
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration
  return ticksToSeconds(currentTrack()?.RunTimeTicks ?? 0)
}

// ---- reporting (play counts, "recently played", resume points) ----

/**
 * `finished`: a track a transition took over from before its end (a cut outro); reported as played to the end, so it
 * counts as played (Jellyfin's play count, Wrapped), as the user heard it as a whole.
 */
function report(kind: 'start' | 'progress' | 'stopped', item = currentTrack(), reasonEnd?: EndReason, finished = false) {
  if (!connection || !item?.Id || !audio) return
  if (kind === 'start') startReported = playSessionId
  // Lumio's own play log: how long, and (songs) how the play went.
  logPlay(kind, item, !audio.paused, playSessionId, { context: kind === 'start' ? startContext : undefined, reasonEnd })
  // Jellyfin doesn't know podcast episodes; Lumio keeps their progress itself.
  const external = externalOf(item)
  if (external) {
    if (kind !== 'start') recordPodcastProgress(external.guid, item, audio.currentTime, durationOf(), kind === 'stopped' || audio.paused)
    return
  }
  const info = {
    ItemId: item.Id,
    PositionTicks: finished && item.RunTimeTicks ? item.RunTimeTicks : secondsToTicks(audio.currentTime),
    IsPaused: audio.paused,
    IsMuted: state.muted,
    VolumeLevel: Math.round(state.volume * 100),
    PlayMethod: PlayMethod.DirectStream,
    PlaySessionId: playSessionId,
    CanSeek: true,
    // So a device steering this one shows shuffle and repeat as they are.
    RepeatMode: ({ off: 'RepeatNone', all: 'RepeatAll', one: 'RepeatOne' } as const)[state.repeat],
    PlaybackOrder: state.shuffle ? ('Shuffle' as const) : ('Default' as const),
    // The queue (podcasts left out), so a device steering this one can show it and play from any song in it.
    NowPlayingQueue: state.queue
      .map((queued, position) => ({ Id: queued.Id ?? '', PlaylistItemId: state.entries[position]?.uid }))
      .filter((queued, position) => queued.Id && !externalOf(state.queue[position]!))
      .slice(0, 300),
    PlaylistItemId: state.entries[state.index]?.uid,
  }
  // When a play can't be reported (offline, e.g. a cached song), it is kept and handed in later, so it still counts.
  const { userId } = connection
  // Judged now: by the time a failed report is kept, the element may already play the next track.
  const duration = durationOf()
  const played = finished || (!!duration && audio.currentTime >= duration * 0.9)
  const keep = () => {
    if (kind !== 'stopped') return
    rememberPlayback(userId, { itemId: item.Id!, at: new Date().toISOString(), played, positionTicks: info.PositionTicks })
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) return keep()
  const sessions = getSessionApi(connection.api)
  const call =
    kind === 'start'
      ? sessions.reportPlaybackStart({ playbackStartInfo: info })
      : kind === 'progress'
        ? sessions.reportPlaybackProgress({ playbackProgressInfo: info })
        : sessions.reportPlaybackStopped({ playbackStopInfo: info })
  // Reachable again: what was kept goes out too.
  call.then(() => kind === 'start' && void flushPlayback()).catch(keep)
}

// ---- transport ----

/** Plays the queue's track at `index`, from `startAt` or else from where it was left (long tracks, podcasts). */
/** How the track playing now came to play (for the play log). */
let startContext: PlayContext | undefined
/** The play session whose start was reported last (a track whose first try failed hasn't been). */
let startReported = ''

/** Why the track playing until now ended, given why the next one starts. */
function endFor(reason: StartReason): EndReason {
  return reason === 'appload' ? 'endplay' : reason
}

/** Where the track at `index` plays from: the collection, the user's queue or autoplay. */
function sourceOf(index: number) {
  const kind = state.entries[index]?.kind
  return kind === 'user' ? 'queue' : kind === 'autoplay' ? 'autoplay' : (state.source ?? undefined)
}

async function go(index: number, startAt?: number, reason: StartReason = 'clickrow') {
  if (!audio || !connection) return
  // A transition under way ends here (the track it kept is the one being left now), and so does any plan.
  wakeContext()
  abortRunning()
  dropPlan()
  cancelEase()
  // Offline, songs that need the network are skipped: on to the next one that is here (downloaded or cached).
  if (isOffline() && state.queue[index] && !playableOffline(state.queue[index])) {
    const next = state.queue.findIndex((entry, position) => position > index && playableOffline(entry))
    if (next < 0) return setState({ playing: false, buffering: false })
    index = next
    startAt = undefined
  }
  const item = state.queue[index]
  if (!item) return
  startAt ??= resumePoint(item)
  pendingStart = null
  const previous = currentTrack()
  if (previous && !audio.paused) report('stopped', previous, endFor(reason))
  // Paused: Jellyfin was told already; the play log still learns why it ended.
  else if (previous) logPlay('stopped', previous, false, playSessionId, { reasonEnd: endFor(reason) })
  playSessionId = crypto.randomUUID()
  setState({ index, buffering: true })
  setTime({ position: startAt, duration: ticksToSeconds(item.RunTimeTicks ?? 0) })
  // Downloaded songs always play from the download, whatever its quality; then from the cache (instant, and without
  // a connection), else streamed.
  const downloaded = await downloadedAudioUrl(downloadId(item, externalOf(item)?.guid))
  const key = downloaded ? null : cacheKey(item)
  const cached = key ? await cachedAudioUrl(key) : null
  // Another track may have been chosen meanwhile.
  if (currentTrack() !== item || !audio) {
    for (const url of [downloaded, cached]) if (url) release(url)
    return
  }
  const element = load(audio, downloaded ?? cached ?? streamUrl(item), wantsCors(item, audio))
  holds.set(element, item)
  prepareDeck(element)
  void normalize(item)
  startContext = { reasonStart: reason, source: sourceOf(index), shuffle: state.shuffle, offline: !!(downloaded ?? cached) }
  if (key && cached) recordCachedPlay(key)
  // The position can only be set once the stream's metadata is in.
  if (startAt) element.addEventListener('loadedmetadata', () => (element.currentTime = startAt), { once: true })
  unfade()
  try {
    await element.play()
    report('start')
  } catch {
    // Autoplay blocked or the stream failed; the UI shows a play button again.
    if (element === audio) setState({ playing: false, buffering: false })
  }
  restartProgress()
  updateMediaSession()
  // Once the collection is through, autoplay keeps the next songs lined up (and shown), so it simply goes on.
  await extendQueue()
  void cacheAhead()
}

/** Reports the position now and then while playing. */
function restartProgress() {
  window.clearInterval(progressTimer)
  progressTimer = window.setInterval(() => audio && !audio.paused && report('progress'), PROGRESS_EVERY_MS)
}

// ---- autoplay: when the queue runs out, more of the same ----

let autoplay: ((played: BaseItemDto[]) => Promise<BaseItemDto[]>) | null = null
let extending = false

/** Set by MusicPlayerHost: what to play after the queue (similar songs). */
export function setAutoplayProvider(next: typeof autoplay) {
  autoplay = next
}

/**
 * How many autoplay songs are kept decided ahead, once the collection has run out: below `AUTOPLAY_AHEAD` it tops up
 * to `AUTOPLAY_FILL`, so between 10 and 20 are always lined up.
 */
const AUTOPLAY_AHEAD = 10
const AUTOPLAY_FILL = 20

/** Autoplay songs lined up after the current track. */
const autoplayAhead = () => state.entries.slice(state.index + 1).filter((item) => item.kind === 'autoplay').length
/** Songs of the collection still to come. */
const contextAhead = () => state.entries.slice(state.index + 1).filter((item) => item.kind === 'context').length

/**
 * Once nothing of the collection is left to play, keeps 10–20 similar songs lined up after everything
 * else (the user's queue still plays first). They are not the user's queue: clearing it leaves them.
 */
async function extendQueue() {
  if (!autoplay || !connection || extending || state.repeat !== 'off' || !readLocalSettings(connection.userId).musicAutoplay) return
  if (state.index < 0 || contextAhead() > 0 || autoplayAhead() >= AUTOPLAY_AHEAD) return
  extending = true
  try {
    for (let attempt = 0; attempt < 3 && autoplayAhead() < AUTOPLAY_FILL; attempt++) {
      const known = new Set(state.queue.map((item) => item.Id))
      const more = (await autoplay(state.queue)).filter((item) => item.Id && !known.has(item.Id))
      if (!more.length) break
      const add = more.slice(0, AUTOPLAY_FILL - autoplayAhead())
      setState({ queue: [...state.queue, ...add], entries: [...state.entries, ...add.map(() => entry('autoplay'))] })
    }
  } catch {
    // No suggestions: playback simply ends after the last song.
  } finally {
    extending = false
  }
}

// ---- telling friends what plays (the Lumio server, when there is one) ----

function shareActivity(playing: boolean) {
  const item = currentTrack()
  if (!item?.Id) return
  const external = externalOf(item)
  reportActivity({
    itemId: item.Id,
    name: item.Name ?? '',
    subtitle: (item.Artists ?? []).join(', ') || item.AlbumArtist || undefined,
    context: item.Album ?? undefined,
    contextId: external ? external.podcastId : (item.AlbumId ?? undefined),
    kind: 'audio',
    playing,
  })
}

// ---- downloading ahead ----

/** Whether a track can play without a connection: downloaded, or in the cache (in the current quality). */
export function playableOffline(item: BaseItemDto) {
  const external = externalOf(item)
  if (isDownloaded(downloadId(item, external?.guid))) return true
  const key = cacheKey(item)
  return !!key && isCached(key)
}

/** The cache key of a library track: its id and the quality it plays in (a different limit is a different file). */
function cacheKey(item: BaseItemDto) {
  if (externalOf(item) || !item.Id || !connection) return null
  return `${item.Id}|${streamingMusicQuality(readLocalSettings(connection.userId)) ?? 'original'}`
}

/** Bumped on every track change, so a running round of downloads stops when the queue moved on. */
let aheadRound = 0

/**
 * While a song plays, the next ones (as many as set) are downloaded into the cache one after another, then the song
 * playing itself, so a song heard again comes from the cache. Off when "ahead" is set to none.
 */
async function cacheAhead() {
  if (!connection || !audioCacheAvailable) return
  const settings = readLocalSettings(connection.userId)
  if (!settings.musicPrefetch) return
  const round = ++aheadRound
  const limits = { maxBytes: settings.musicCacheMb * 1024 * 1024, keepOftenPlayed: settings.musicKeepOften }
  const upcoming = state.queue.slice(state.index + 1, state.index + 1 + settings.musicPrefetch)
  const playing = currentTrack()
  for (const item of [...upcoming, ...(playing ? [playing] : [])]) {
    if (round !== aheadRound || !connection) return
    const key = cacheKey(item)
    // Downloaded songs need no copy in the cache.
    if (!key || isDownloaded(item.Id)) continue
    await prefetchAudio(key, streamUrl(item, crypto.randomUUID()), limits, item === playing ? 1 : 0)
  }
}

function onEnded() {
  report('stopped', currentTrack(), 'trackdone')
  // The sleep timer was set to the end of this track.
  if (stopsAfterTrack()) return setState({ playing: false })
  if (state.repeat === 'one') return void go(state.index, 0, 'trackdone')
  if (state.index < state.queue.length - 1) return void go(state.index + 1, undefined, 'trackdone')
  if (state.repeat === 'all' && state.queue.length) return void go(0, undefined, 'trackdone')
  setState({ playing: false })
}

/** Where a track should start: long ones (audiobook chapters) resume where they were left, music from the beginning. */
function resumePoint(item: BaseItemDto) {
  const external = externalOf(item)
  if (external) {
    const saved = podcastProgress(external.guid)
    return saved && !saved.done ? saved.position : 0
  }
  const position = ticksToSeconds(item.UserData?.PlaybackPositionTicks ?? 0)
  return ticksToSeconds(item.RunTimeTicks ?? 0) >= RESUME_MIN_S && position > 0 && !item.UserData?.Played ? position : 0
}

function shuffled<T>(items: T[]) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

/** `music.play`'s start for "the collection as a whole" (its play button), rather than one picked track. */
/** Tracks put into the queue (at its end, or next): the app confirms it with a short message (see music-host). */
type QueuedListener = (how: 'queue' | 'next', items: BaseItemDto[]) => void
const queuedListeners = new Set<QueuedListener>()

export function onQueued(listener: QueuedListener) {
  queuedListeners.add(listener)
  return () => {
    queuedListeners.delete(listener)
  }
}

function announceQueued(how: 'queue' | 'next', items: BaseItemDto[]) {
  for (const listener of queuedListeners) listener(how, items)
}

export const START = -1

// ---- "play on" another device ----

/**
 * While Lumio controls another device ("Abspielen auf"), music goes there instead of playing here: what is started,
 * and what is queued. Set by the remote provider; podcasts (which Jellyfin doesn't know) still play here.
 */
export interface RemoteSink {
  play: (items: BaseItemDto[], startIndex: number) => void
  enqueue: (items: BaseItemDto[], how: 'next' | 'last') => void
}
let remoteSink: RemoteSink | null = null

export function setRemoteSink(next: RemoteSink | null) {
  remoteSink = next
  // Transitions are played here only: while another device is steered, none is prepared.
  if (next) {
    abortRunning()
    dropPlan()
  } else planSoon()
}

/**
 * What plays here right now, to hand over to another device: the current track and what follows it (podcasts left
 * out, as other devices can't play them), and where in the current track it is. null when nothing music is loaded.
 */
export function handOverSnapshot(): { items: BaseItemDto[]; positionTicks: number; playing: boolean } | null {
  const current = currentTrack()
  if (!current?.Id || externalOf(current)) return null
  const items = state.queue.slice(state.index, state.index + 200).filter((item) => item.Id && !externalOf(item))
  const position = pendingStart ?? audio?.currentTime ?? 0
  return { items, positionTicks: secondsToTicks(position), playing: state.playing }
}

const forRemote = (items: BaseItemDto[]) => !!remoteSink && items.length > 0 && items.every((item) => item.Id && !externalOf(item))

function entry(kind: QueueKind): QueueEntry {
  return { kind, uid: Math.random().toString(36).slice(2, 10) }
}

/** Where the user's queue ends: right after the current track and the songs already queued by hand. */
function userQueueEnd() {
  let at = state.index + 1
  while (state.entries[at]?.kind === 'user') at++
  return at
}

function insertAt(position: number, items: BaseItemDto[], kind: QueueKind) {
  const queue = [...state.queue]
  const entries = [...state.entries]
  queue.splice(position, 0, ...items)
  entries.splice(position, 0, ...items.map(() => entry(kind)))
  setState({ queue, entries })
}

export const music = {
  /**
   * Replaces the queue with `items` and plays from `startIndex` (a track picked by the user), or with `START` (the
   * collection's play button) from the beginning, or from a random track when shuffling.
   */
  play(items: BaseItemDto[], startIndex: number = START, options: { shuffle?: boolean; source?: string; startAt?: number; reason?: StartReason } = {}) {
    const playable = items.filter((item) => item.Id)
    if (!playable.length) return
    if (forRemote(playable)) {
      // On the other device, in the order it would play here (shuffled when the collection plays shuffled).
      const shuffleThere = options.shuffle ?? (options.source ? !!shufflePrefs[options.source] : false)
      const at = Math.min(Math.max(startIndex, 0), playable.length - 1)
      if (shuffleThere) {
        const first = playable[startIndex === START ? Math.floor(Math.random() * playable.length) : at]!
        remoteSink!.play([first, ...shuffled(playable.filter((item) => item !== first))], 0)
      } else remoteSink!.play(playable, at)
      if (options.source) recordRecent(options.source)
      return
    }
    // A collection plays with its own shuffle setting; loose tracks in order.
    const shuffle = options.shuffle ?? (options.source ? !!shufflePrefs[options.source] : false)
    let queue = playable
    let index = Math.min(Math.max(startIndex, 0), playable.length - 1)
    if (shuffle) {
      // The chosen track first, the rest in random order.
      const first = playable[startIndex === START ? Math.floor(Math.random() * playable.length) : index]!
      queue = [first, ...shuffled(playable.filter((item) => item !== first))]
      index = 0
    }
    setState({ queue, entries: queue.map(() => entry('context')), shuffle, unshuffled: shuffle ? playable : null, source: options.source ?? null })
    if (options.source) recordRecent(options.source)
    // A track picked in a list, or the collection's play button.
    void go(index, options.startAt, options.reason ?? (startIndex === START ? 'playbtn' : 'clickrow'))
  },
  /** Puts tracks at the front of the user's queue: they play right after the current one. */
  playNext(items: BaseItemDto[]) {
    if (!items.length) return
    if (forRemote(items)) return remoteSink!.enqueue(items, 'next')
    if (state.index < 0) return music.play(items)
    insertAt(state.index + 1, items, 'user')
    announceQueued('next', items)
  },
  /** Adds tracks to the end of the user's queue: after what was queued before, but before the collection goes on. */
  addToQueue(items: BaseItemDto[]) {
    if (!items.length) return
    if (forRemote(items)) return remoteSink!.enqueue(items, 'last')
    if (state.index < 0) return music.play(items)
    insertAt(userQueueEnd(), items, 'user')
    announceQueued('queue', items)
  },
  /**
   * Moves an upcoming entry to `to` (its position counted before the move), into the user's queue or the collection's
   * order as `kind` says; only this play order changes, not the collection itself.
   */
  reorder(from: number, to: number, kind: QueueKind) {
    if (from <= state.index || from === to) return
    const queue = [...state.queue]
    const entries = [...state.entries]
    const [item] = queue.splice(from, 1)
    const [moved] = entries.splice(from, 1)
    const at = Math.max(state.index + 1, to > from ? to - 1 : to)
    queue.splice(at, 0, item!)
    entries.splice(at, 0, { ...moved!, kind })
    setState({ queue, entries })
  },
  /** Empties the user's queue; the collection (and autoplay) go on as before. */
  clearQueue() {
    const keep = state.entries.map((item, position) => position <= state.index || item.kind !== 'user')
    setState({ queue: state.queue.filter((_, position) => keep[position]), entries: state.entries.filter((_, position) => keep[position]) })
  },
  toggle() {
    if (!audio || state.index < 0) return
    // Restored after a reload: the track is loaded only now, from where it was left.
    if (pendingStart !== null) return void go(state.index, pendingStart, 'appload')
    if (audio.paused || fadingOut) fadeIn()
    else fadeOut()
  },
  pause() {
    fadeOut()
  },
  /** Goes on if paused (a remote "unpause"). */
  resume() {
    if (state.index >= 0 && !state.playing) music.toggle()
  },
  /** Sets repeat (a remote's command). */
  setRepeat(mode: RepeatMode) {
    setState({ repeat: mode })
  },
  /** Turns shuffle on or off (a remote's command). */
  setShuffle(on: boolean) {
    if (state.shuffle !== on) music.toggleShuffle()
  },
  /** Jumps by some seconds (a remote's rewind / fast forward). */
  seekBy(seconds: number) {
    music.seek((pendingStart ?? audio?.currentTime ?? 0) + seconds)
  },
  isMuted() {
    return state.muted
  },
  /** Whether music is loaded here (another device may steer it then). */
  isLoaded() {
    return state.index >= 0
  },
  /** Starts tracks asked for by another device: here, never forwarded to a device this one controls. */
  playHere(items: BaseItemDto[], startIndex: number, startAt?: number) {
    const sink = remoteSink
    remoteSink = null
    try {
      music.play(items, startIndex, { startAt, reason: 'remote' })
    } finally {
      remoteSink = sink
    }
  },
  next() {
    if (state.index < state.queue.length - 1) void go(state.index + 1, undefined, 'fwdbtn')
    else if (state.repeat === 'all' && state.queue.length) void go(0, undefined, 'fwdbtn')
  },
  previous() {
    if (!audio) return
    const position = pendingStart ?? audio.currentTime
    if (position > RESTART_AFTER_S || state.index === 0) {
      if (pendingStart !== null) {
        pendingStart = 0
        setTime({ position: 0, duration: durationOf() })
        return writeSession()
      }
      mixerSeeking()
      audio.currentTime = 0
      return
    }
    void go(state.index - 1, undefined, 'backbtn')
  },
  jump(index: number) {
    void go(index, undefined, 'clickrow')
  },
  seek(seconds: number) {
    if (!audio) return
    if (pendingStart !== null) {
      // Not loaded yet: playback will start there.
      pendingStart = Math.max(0, Math.min(seconds, durationOf() || seconds))
      setTime({ position: pendingStart, duration: durationOf() })
      return writeSession()
    }
    mixerSeeking()
    audio.currentTime = Math.max(0, Math.min(seconds, durationOf() || seconds))
    setTime({ position: audio.currentTime, duration: durationOf() })
    report('progress')
  },
  setVolume(volume: number) {
    if (!audio) return
    const next = Math.min(1, Math.max(0, volume))
    setState({ volume: next, muted: next === 0 })
    applyVolume()
    try {
      localStorage.setItem(VOLUME_KEY, String(next))
    } catch {
      // Not remembered for the next visit.
    }
  },
  /** Applies a changed normalization setting to the track playing. */
  renormalize() {
    void normalize()
  },
  toggleMute() {
    if (!audio) return
    setState({ muted: !state.muted })
    applyVolume()
  },
  /** Sets shuffle for a collection; if it is the one playing, the queue follows right away. */
  setShuffleFor(source: string, on: boolean) {
    saveShufflePref(source, on)
    if (state.source === source && state.index >= 0 && state.shuffle !== on) music.toggleShuffle()
  },
  toggleShuffle() {
    if (state.source) saveShufflePref(state.source, !state.shuffle)
    const current = currentTrack()
    // Only the collection is shuffled: the user's queue still comes first, autoplay last.
    const ahead = (kind: QueueKind) => state.queue.slice(state.index + 1).filter((_, offset) => state.entries[state.index + 1 + offset]?.kind === kind)
    const user = ahead('user')
    const auto = ahead('autoplay')
    const tail = (context: BaseItemDto[]) => {
      const queue = [...state.queue.slice(0, state.index + 1), ...user, ...context, ...auto]
      const entries = [
        ...state.entries.slice(0, state.index + 1),
        ...state.entries.slice(state.index + 1).filter((item) => item.kind === 'user'),
        ...context.map(() => entry('context')),
        ...state.entries.slice(state.index + 1).filter((item) => item.kind === 'autoplay'),
      ]
      return { queue, entries }
    }
    if (!state.shuffle) {
      // The rest of the collection in random order; the current track keeps playing.
      setState({ shuffle: true, unshuffled: state.queue.filter((_, position) => state.entries[position]?.kind === 'context'), ...tail(shuffled(ahead('context'))) })
    } else {
      // Back to the collection's order, going on from the current track where it is in it.
      const original = state.unshuffled ?? ahead('context')
      const at = current ? original.indexOf(current) : -1
      const remaining = new Set(ahead('context'))
      const rest = at >= 0 ? original.slice(at + 1) : original.filter((item) => remaining.has(item))
      setState({ shuffle: false, unshuffled: null, ...tail(rest) })
    }
  },
  cycleRepeat() {
    setState({ repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off' })
  },
  /** Removes a track from the queue (not the one playing). */
  remove(index: number) {
    if (index === state.index) return
    const queue = state.queue.filter((_, position) => position !== index)
    const entries = state.entries.filter((_, position) => position !== index)
    setState({ queue, entries, index: index < state.index ? state.index - 1 : state.index })
    void extendQueue()
  },
  /** Ends playback and empties the queue (the mini player's close button). */
  stop() {
    stop('endplay')
  },
  /** Moves a queued track to another position. */
  move(from: number, to: number) {
    const queue = [...state.queue]
    const entries = [...state.entries]
    const [moved] = queue.splice(from, 1)
    const [movedEntry] = entries.splice(from, 1)
    queue.splice(to, 0, moved!)
    entries.splice(to, 0, movedEntry!)
    const playingItem = currentTrack()
    setState({ queue, entries, index: playingItem ? queue.indexOf(playingItem) : state.index })
  },
}

/** Stops and forgets everything (the mini player's close button, or signing out). */
function stop(reason: EndReason = 'endplay') {
  if (!audio) return
  const item = currentTrack()
  if (item && !audio.paused) report('stopped', item, reason)
  else if (item) logPlay('stopped', item, false, playSessionId, { reasonEnd: reason })
  pendingStart = null
  reportActivity(null)
  abortRunning()
  dropPlan()
  cancelEase()
  unfade()
  unload(audio)
  if (standby) unload(standby)
  window.clearInterval(progressTimer)
  setState({ queue: [], entries: [], index: -1, playing: false, buffering: false, unshuffled: null, source: null })
  setTime({ position: 0, duration: 0 })
  updateAppSession()
}

// ---- the mixer: transitions between tracks (DJ mode) ----

/**
 * In a mixer playlist a transition can take the place of a plain track change: the next track starts on the second
 * element before the current one has ended, both sound through the Web Audio decks (../mixer/engine.ts) with the
 * transition's automation, and then the second element simply goes on as the current track.
 *
 * - The graph is attached to an element only when transitions are possible (a provider is set and the audio clock
 *   runs): from the track's start, so nothing is rerouted mid-song. An element on the graph stays there for good (a
 *   MediaElementSource can't be undone) and is then only given CORS-loaded audio, the only kind the graph may hear:
 *   Jellyfin answers with `Access-Control-Allow-Origin: *`, blob: URLs (downloads, cache) are our own. Podcasts come
 *   from hosts that may not allow CORS: they never take part in a transition and always play on an element off the
 *   graph (a fresh one when needed). With no provider set, nothing of this happens: one element, as before.
 * - Steps for the next track ("plan"): ask the provider when the track starts or the queue changes; load the next track
 *   into the standby element 30 s before the cue and park it at `bIn` ("ready"); time its start on the cue; then
 *   "running": hand over (UI, reports, media session switch to the new track) once it is louder than the old one;
 *   stop the old one when the overlap ends.
 * - The AudioContext needs a user gesture to run (iOS, autoplay rules): it is created and resumed on the first
 *   pointer or key press while a provider is set. Without a running context there are simply no transitions. If it
 *   stops later (the system took the audio device), the track moves to a fresh element off the graph.
 */
/**
 * Decides the transition from `from` into `to` (the natural successor in the queue), or null for a plain track change.
 * A 'none' transition is back to back: A plays to its real end, then B starts at `bIn` at once (preloaded on the
 * second deck, so with hardly a gap), without automation.
 */
export type TransitionProvider = (
  from: BaseItemDto,
  to: BaseItemDto,
  context: { source: string | null },
) => Transition | null | Promise<Transition | null>

/** The next track is loaded this long before its cue. */
const PRELOAD_S = 30
/** From this long before the cue its start is timed precisely. */
const ARM_S = 2
/** Reaching the cue later than this (a sleeping tab, a slow load) is too late: the track ends plainly instead. */
const TOO_LATE_S = 1
/** A paused audio clock with nothing to do is stopped after this long (it keeps the audio device busy). */
const IDLE_SUSPEND_MS = 30_000
/** When the audio clock hasn't come back after this long, the track moves off the graph. */
const RESCUE_AFTER_S = 1.5
/** A deck that keeps playing glides back to neutral over this long; one that leaves fades out over this long. */
const SETTLE_S = 0.05
const RETIRE_S = 0.03
/** How long an echo may ring on after its deck has gone (after a transition), or after one was called off. */
const ECHO_TAIL_S = 6
const ABORT_TAIL_S = 0.5
/** Buffered: A is located in its slice this long before the cue (recording, matching, the stretcher's lead). */
const BUFFER_ARM_S = 5
/** A's sound moves to its buffer this long before t = 0 (at least `MIN_HANDOVER_LEAD_S` ahead of now). */
const HANDOVER_LEAD_S = 1
const MIN_HANDOVER_LEAD_S = 0.3
/** B hands back to its element this long after it plays at its own tempo again, within at most `HANDBACK_SPAN_S`. */
const HANDBACK_AFTER_S = 0.5
const HANDBACK_SPAN_S = 8
const HANDBACK_ATTEMPTS = 4
/** B's slice is lined up this many times (their median). */
const B_CALIBRATIONS = 3
/** The element must play within this of the buffer before the sound goes back to it. */
const HANDBACK_TOLERANCE_S = 0.002
/** Slices reach this much further than the decks play. */
const SLICE_MARGIN_S = 1

interface Plan {
  fromUid: string
  toUid: string
  from: BaseItemDto
  to: BaseItemDto
  /** Asking the provider, no transition for this pair, decided, loading B, B parked at `bIn`, start being timed. */
  status: 'asking' | 'none' | 'planned' | 'loading' | 'ready' | 'armed'
  transition: Transition | null
  /** Preset 'none': B follows A's real end (its `aOut` is kept on the element's own duration). */
  backToBack: boolean
  /** Buffers ready for the transition (A's slice, still to be lined up when armed; B's side), or null: without. */
  buffered: { sliceA: Slice; sideB: BufferSide; kindA: BufferDeckKind } | null
  /** The buffers being loaded (to call off), and whether B's element is being lined up (it plays muted meanwhile). */
  loading: AbortController | null
  calibrating: boolean
  /** B's element (once loading), its play session, and whether it came from the device (and the cache key then). */
  element: HTMLAudioElement | null
  sessionId: string
  offline: boolean
  cacheKey: string | null
  cancelCue: () => void
}

interface Running {
  plan: Plan
  transition: Transition
  a: HTMLAudioElement
  b: HTMLAudioElement
  /** Context time of the transition's t = 0 (A at `aOut`). */
  start: number
  /** Transition time where it was paused; null while playing. */
  pausedAt: number | null
  /** When B takes over as the track playing (transition time). */
  handover: number
  handedOver: boolean
  /** Stops what runs over time (timers, B's alignment, the brake); called on pause, abort and end. */
  stops: Array<() => void>
  /** B's start error was learned from already (only the first start teaches, not a resume). */
  learned: boolean
  /** B's element was started (at `bAt`). */
  bStarted: boolean
  /** What the elements follow: the decks' plans (without buffers: straight, no loops); A's with its brake. */
  planA: DeckPlan
  planB: DeckPlan
  /** When A's brake starts (its pitch falls from then on), or null. */
  brake: number | null
  /** The buffers the decks sound from (null: the elements play it), and when A's sound moved there. */
  sides: { a: BufferSide; b: BufferSide } | null
  handoverLead: number
  /** When B plays straight at its own tempo again (transition time). */
  settled: number
  /** A is gone; B is still on its buffer until it hands back. */
  trailing: boolean
}

let transitionProvider: TransitionProvider | null = null
let context: AudioContext | null = null
/**
 * Where the decks meet: the master limiter (no clipping when two loud tracks overlap). Until its worklet has loaded
 * nothing goes onto the graph; if it can't load, there are no transitions (rather than ones that may clip).
 */
let master: Master | null = null
let masterFailed = false
/** Elements whose current audio was loaded with CORS: only those may go through the graph (others would be silent). */
const corsLoads = new WeakSet<HTMLAudioElement>()
/** The server didn't allow CORS for the audio: no transitions for this visit. */
let corsBlocked = false
/** Elements fading out of a transition, and until when (context time) an echo rings on one: not loaded until quiet. */
const retiring = new Set<HTMLAudioElement>()
const ringing = new WeakMap<HTMLAudioElement, number>()
let plan: Plan | null = null
let running: Running | null = null
let planQueued = false
let idleTimer = 0
let cancelEase = () => {}

/**
 * Set by the mixer layer: decides the transitions. Set it only while a transition may come up (a mixer playlist is
 * around): with a provider, library tracks load with CORS and play through the (transparent) decks.
 */
export function setTransitionProvider(next: TransitionProvider | null) {
  transitionProvider = next
  dropPlan()
  if (!next) abortRunning()
  else wakeContext()
  planSoon()
}

/** Creates or resumes the audio clock (in a user gesture: browsers only let it run after one). */
function wakeContext() {
  if (!transitionProvider || corsBlocked || typeof AudioContext === 'undefined') return
  try {
    if (!context) {
      const created = new AudioContext({ latencyHint: 'playback' })
      context = created
      created.addEventListener('statechange', contextChanged)
      createMaster(created, created.destination).then(
        (ready) => {
          master = ready
          planSoon()
        },
        () => (masterFailed = true),
      )
    }
  } catch {
    return
  }
  if (context.state !== 'running') void context.resume().catch(() => undefined)
}

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, wakeContext, { capture: true, passive: true })
}

/** The audio clock stopped (the system took the device, a call): an element playing through it would fall silent. */
function contextChanged() {
  if (!context || context.state === 'running') return
  const element = audio
  if (!element || element.paused || !decks.has(element)) return
  void context.resume().catch(() => undefined)
  rescueIfSilent()
}

/** Moves the track off the graph when the audio clock doesn't come back in time. */
function rescueIfSilent() {
  wakeAfter(null, RESCUE_AFTER_S, () => {
    const element = audio
    if (context?.state !== 'running' && element && !element.paused && decks.has(element)) rescue(element)
  })
}

/** The track playing goes on, at the same spot, on a fresh element off the graph. */
function rescue(element: HTMLAudioElement) {
  abortRunning()
  dropPlan()
  const position = element.currentTime
  const source = element.currentSrc || element.src
  const cors = corsLoads.has(element)
  const fresh = replaceElement(element, source)
  if (cors) fresh.crossOrigin = 'anonymous'
  fresh.src = source
  if (cors) corsLoads.add(fresh)
  trackGains.set(fresh, trackGains.get(element) ?? 1)
  const item = holds.get(element)
  if (item) holds.set(fresh, item)
  applyVolume()
  fresh.addEventListener('loadedmetadata', () => (fresh.currentTime = position), { once: true })
  void fresh.play().catch(() => setState({ playing: false, buffering: false }))
}

/** Whether a track loads with CORS on `element`: library tracks while transitions are possible, or on the graph. */
function wantsCors(item: BaseItemDto, element: HTMLAudioElement) {
  if (externalOf(item) || corsBlocked) return false
  return transitionProvider !== null || decks.has(element)
}

/**
 * Points an element at a track's audio. An element on the graph can't play audio loaded without CORS (the graph
 * would hear silence), so that goes to a fresh element instead, which is returned.
 */
function load(element: HTMLAudioElement, url: string, cors: boolean) {
  const previous = element.getAttribute('src')
  const target = !cors && decks.has(element) ? replaceElement(element, url) : element
  if (cors) target.crossOrigin = 'anonymous'
  else target.removeAttribute('crossorigin')
  target.src = url
  if (cors) corsLoads.add(target)
  else corsLoads.delete(target)
  if (previous && target === element) release(previous)
  return target
}

/**
 * Lets go of an object URL (a downloaded or cached song) once no element uses it any more: the cache and downloads
 * hand out a new one per play, and the player releases each.
 */
function release(url: string, keep?: string) {
  if (!url.startsWith('blob:') || url === keep || audio?.getAttribute('src') === url || standby?.getAttribute('src') === url) return
  URL.revokeObjectURL(url)
}

/** A track starts on `element`: its deck (if any) back to neutral, or onto the graph now if transitions are possible. */
function prepareDeck(element: HTMLAudioElement) {
  element.preservesPitch = true
  elementGains.get(element)?.gain.cancelScheduledValues(0)
  if (elementGains.get(element)) elementGains.get(element)!.gain.value = 1
  const deck = decks.get(element)
  if (deck) safely(() => resetDeck(deck))
  else if (transitionProvider) attach(element)
}

const elementGains = new WeakMap<HTMLAudioElement, GainNode>()

/** An element's own gain into its deck (a stand-in for one off the graph, which no transition uses). */
const elementGain = (element: HTMLAudioElement) => elementGains.get(element) ?? new GainNode(context!)
/** Where a buffer deck joins an element's deck (its input, beside the element's own gain). */
const elementInput = (element: HTMLAudioElement) => decks.get(element)!.input

/** Puts an element on the graph (only CORS-loaded audio, and only while the audio clock runs). */
function attach(element: HTMLAudioElement): Deck | null {
  const existing = decks.get(element)
  if (existing) return existing
  if (!context || !master || context.state !== 'running' || !corsLoads.has(element)) return null
  try {
    const deck = createDeck(context, master.input)
    // At its volume before any sound goes through (the element may be playing already, at full volume on the graph).
    deck.level.gain.value = state.muted ? 0 : volumeOf(element)
    const source = context.createMediaElementSource(element)
    // The element's own way into the deck: 0 while a transition's buffer plays its sound instead.
    const gain = new GainNode(context)
    source.connect(gain).connect(deck.input)
    deck.source = source
    elementGains.set(element, gain)
    decks.set(element, deck)
    applyVolume()
    return deck
  } catch {
    return null
  }
}

/**
 * Swaps an element for a fresh one in its role (current or standby); the old one is emptied and dropped (its audio's
 * object URL too, unless it is `keep`, handed on to the fresh one).
 */
function replaceElement(old: HTMLAudioElement, keep?: string) {
  const fresh = createElement()
  fresh.preservesPitch = true
  if (audio === old) audio = fresh
  if (standby === old) standby = fresh
  unload(old, keep)
  decks.get(old)?.dispose()
  decks.delete(old)
  retiring.delete(old)
  applyVolume()
  return fresh
}

function unload(element: HTMLAudioElement, keep?: string) {
  const url = element.getAttribute('src')
  element.pause()
  element.removeAttribute('src')
  element.load()
  corsLoads.delete(element)
  if (url) release(url, keep)
}

/**
 * A library track loaded with CORS failed. Whether the server refuses CORS is checked by fetching the same address
 * with and without it (a server error or a lost connection fails both): if so, the track plays again without CORS and
 * transitions are off for this visit; otherwise it is an ordinary failure.
 */
async function corsFailed(element: HTMLAudioElement, item: BaseItemDto) {
  const url = element.src
  const refused = !url.startsWith('blob:') && (await corsRefused(url))
  if (element !== audio || currentTrack() !== item) return
  if (!refused) return failed(element)
  corsBlocked = true
  abortRunning()
  dropPlan()
  const position = element.currentTime
  const fresh = load(element, url, false)
  holds.set(fresh, item)
  trackGains.set(fresh, trackGains.get(element) ?? 1)
  applyVolume()
  if (position) fresh.addEventListener('loadedmetadata', () => (fresh.currentTime = position), { once: true })
  void fresh
    .play()
    .then(() => startReported !== playSessionId && report('start'))
    .catch(() => setState({ playing: false, buffering: false }))
}

/** Whether `url` loads without CORS but not with it (only the first bytes are fetched). */
async function corsRefused(url: string) {
  const reaches = async (mode: RequestMode) => {
    const abort = new AbortController()
    try {
      await fetch(url, { mode, cache: 'no-store', signal: abort.signal, headers: mode === 'cors' ? { Range: 'bytes=0-1' } : undefined })
      return true
    } catch {
      return false
    } finally {
      abort.abort()
    }
  }
  return !(await reaches('cors')) && (await reaches('no-cors'))
}

/** Runs engine scheduling; a browser refusing it (it shouldn't) calls the transition off instead of leaving it stuck. */
function safely(schedule: () => void) {
  try {
    schedule()
    return true
  } catch {
    return false
  }
}

// -- planning --

/** The queue position that plays after the current track on its own, or -1 (none, or repeat one). */
function successorIndex() {
  if (state.repeat === 'one' || state.index < 0) return -1
  if (state.index < state.queue.length - 1) return state.index + 1
  return state.repeat === 'all' && state.queue.length > 1 ? 0 : -1
}

const mixable = (item?: BaseItemDto): item is BaseItemDto => !!item?.Id && !externalOf(item)

function planSoon() {
  if (planQueued) return
  planQueued = true
  queueMicrotask(() => {
    planQueued = false
    planCheck()
  })
}

/** Makes sure the plan (and a transition under way) is about the current track and the one that follows it. */
function planCheck() {
  const from = currentTrack()
  const fromUid = state.entries[state.index]?.uid
  const next = successorIndex()
  const to = next >= 0 ? state.queue[next] : undefined
  const toUid = next >= 0 ? state.entries[next]?.uid : undefined
  // The track coming in is no longer next (removed, moved, repeat one): the transition is called off.
  if (running && !running.handedOver && (running.plan.fromUid !== fromUid || running.plan.toUid !== toUid)) abortRunning()
  if (plan && plan.fromUid === fromUid && plan.toUid === toUid) return
  dropPlan()
  if (!transitionProvider || remoteSink || corsBlocked || masterFailed || pendingStart !== null || !connection) return
  if (!fromUid || !toUid || !mixable(from) || !mixable(to)) return
  // The transition into the next track is already playing.
  if (running && !running.handedOver) return
  const fresh: Plan = {
    fromUid,
    toUid,
    from,
    to,
    status: 'asking',
    transition: null,
    backToBack: false,
    buffered: null,
    loading: null,
    calibrating: false,
    element: null,
    sessionId: crypto.randomUUID(),
    offline: false,
    cacheKey: null,
    cancelCue: () => {},
  }
  plan = fresh
  const provider = transitionProvider
  void Promise.resolve()
    .then(() => provider(from, to, { source: state.source }))
    .then((result) => {
      if (plan !== fresh) return
      const transition = result ? asPlayed(result, ticksToSeconds(from.RunTimeTicks ?? 0)) : null
      if (!transition || !usable(transition, from, to)) return void (fresh.status = 'none')
      fresh.transition = transition
      fresh.backToBack = result?.preset === 'none'
      fresh.status = 'planned'
      mixerTick()
    })
    .catch(() => {
      if (plan === fresh) fresh.status = 'none'
    })
}

/** A transition the player can play (contract v2): for this pair, inside A, at rates a media element plays well. */
function usable(transition: Transition, from: BaseItemDto, to: BaseItemDto) {
  const duration = ticksToSeconds(from.RunTimeTicks ?? 0)
  const { aOut, bAt, bIn, length } = transition
  if (transition.v !== 2 || transition.from !== from.Id || transition.to !== to.Id) return false
  if (![bAt, bIn, length].every(Number.isFinite) || bAt < 0 || bIn < 0 || length < 0) return false
  const rates = [...(transition.rateA ?? []), ...(transition.rateB ?? [])]
  if (!rates.every((keyframe) => Number.isFinite(keyframe.t) && keyframe.v >= 0.5 && keyframe.v <= 2)) return false
  // Back to back follows A's real end, whatever its cue says now.
  if (transition.preset === 'none') return true
  return Number.isFinite(aOut) && aOut > 0 && (!duration || aOut < duration)
}

/** Forgets the plan; B's element is emptied unless a transition uses it. */
function dropPlan() {
  const old = plan
  plan = null
  if (!old) return
  old.cancelCue()
  dropBuffered(old)
  const element = old.element
  if (element && element !== audio && running?.a !== element && running?.b !== element) unload(element)
}

/** Seeking: a transition under way is called off (the track shown keeps playing) and the plan is made again. */
function mixerSeeking() {
  abortRunning()
  cancelEase()
  if (audio) audio.playbackRate = 1
  dropPlan()
  planSoon()
}

/** Moves the plan along with the current track's position (its timeupdates, and after each step). */
function mixerTick() {
  const current = plan
  const element = audio
  const transition = current?.transition
  if (!current || !transition || !element || pendingStart !== null || holds.get(element) !== current.from) return
  // Back to back: the cue is the element's real end, once it knows it (a transcoded stream may not; then A's 'ended').
  if (current.backToBack && Number.isFinite(element.duration) && element.duration > 0 && transition.aOut !== element.duration) {
    current.transition = { ...transition, aOut: element.duration }
    return mixerTick()
  }
  const position = element.currentTime
  const waiting = current.status === 'planned' || current.status === 'loading' || current.status === 'ready'
  // Past the cue before B could start: this track ends plainly (back to back: B still follows at A's end).
  if (waiting && !current.backToBack && position > transition.aOut + TOO_LATE_S) {
    current.status = 'none'
    if (current.element) unload(current.element)
    return
  }
  if (current.status === 'planned' && position >= transition.aOut - PRELOAD_S && !running && standbyFree()) void preload(current)
  const armAt = transition.aOut - (current.buffered ? BUFFER_ARM_S : ARM_S)
  if (current.status === 'ready' && !current.calibrating && !element.paused && position >= armAt && !sleepsAfterTrack()) arm(current)
}

/** Whether the standby element may take the next track (no transition's tail is still on it). */
function standbyFree() {
  if (!standby) return true
  return !retiring.has(standby) && (ringing.get(standby) ?? 0) <= (context?.currentTime ?? 0)
}

/** Loads B into the standby element and parks it at `bIn`, ready to start at once. */
async function preload(p: Plan) {
  const transition = p.transition!
  p.status = 'loading'
  const fail = () => {
    if (plan !== p) return
    p.status = 'none'
    if (p.element) unload(p.element)
  }
  // A goes through the graph as well (from its start when the clock ran then; otherwise from now on).
  if (!audio || !attach(audio)) return fail()
  const downloaded = await downloadedAudioUrl(downloadId(p.to))
  const key = downloaded ? null : cacheKey(p.to)
  const cached = key ? await cachedAudioUrl(key) : null
  const gain = await gainOf(p.to)
  if (plan !== p || running) {
    for (const url of [downloaded, cached]) if (url) release(url)
    // Another transition still sounds on the standby element: later.
    if (plan === p) p.status = 'planned'
    return
  }
  standby ??= createElement()
  const element = load(standby, downloaded ?? cached ?? streamUrl(p.to, p.sessionId), true)
  standby = element
  holds.set(element, p.to)
  p.element = element
  p.offline = !!(downloaded ?? cached)
  p.cacheKey = cached ? key : null
  trackGains.set(element, gainFactorOf(gain))
  element.preservesPitch = true
  const deck = attach(element)
  if (!deck || !safely(() => resetDeck(deck))) return fail()
  elementGain(element).gain.value = 1
  applyVolume()
  try {
    await parked(element, Math.max(0, transition.bIn))
  } catch {
    return fail()
  }
  if (plan !== p) return
  p.status = 'ready'
  mixerTick()
  // The buffers for a sample-exact transition load meanwhile; until they are ready it would play without.
  void loadBuffered(p)
}

/** Waits until an element stands at `at`, paused, with enough data to play on at once. */
function parked(element: HTMLAudioElement, at: number) {
  // Events of an earlier load (an 'emptied' or 'error' still queued from before) don't count.
  const src = element.src
  const ours = () => element.src === src
  return new Promise<void>((resolve, reject) => {
    const settle = (ok: boolean) => {
      for (const [type, listener] of listeners) element.removeEventListener(type, listener)
      window.clearTimeout(timeout)
      if (ok) resolve()
      else reject(new Error('Not loaded'))
    }
    const check = () => {
      if (!ours()) return settle(false)
      if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !element.seeking && Math.abs(element.currentTime - at) < 0.5) settle(true)
    }
    const listeners: Array<[string, () => void]> = [
      ['loadedmetadata', () => ours() && (element.currentTime = at)],
      ['seeked', check],
      ['canplay', check],
      ['error', () => ours() && element.error && settle(false)],
    ]
    for (const [type, listener] of listeners) element.addEventListener(type, listener)
    const timeout = window.setTimeout(() => settle(false), (PRELOAD_S + TOO_LATE_S) * 1000)
  })
}

/** Close to the cue: times the transition's start (buffered: lines the slice up with A first, a little earlier). */
function arm(p: Plan) {
  const element = audio
  if (!element || !p.transition) return
  p.status = 'armed'
  if (p.buffered) return void beginBuffered(p)
  p.cancelCue = waitForCue(context, element, p.transition.aOut, currentPlayLead(), (late) => begin(p, late))
}

/** The cue, without buffers: both elements play the transition (straight, no loops), A's element sets the clock. */
function begin(p: Plan, late: number) {
  const a = audio
  const b = p.element
  const transition = p.transition
  if (plan !== p || p.status !== 'armed') return
  p.cancelCue = () => {}
  const ended = p.backToBack && !!a?.ended
  if (!a || !b || !transition || !decks.get(a) || !decks.get(b) || !context || context.state !== 'running' || (a.paused && !ended) || (late > TOO_LATE_S && !p.backToBack)) {
    // No transition after all: the track ends plainly.
    p.status = 'none'
    if (b) unload(b)
    return
  }
  dropBuffered(p)
  plan = null
  // t = 0 is when A reaches aOut: in `lead` seconds when on time, in the past when late (B then starts further in).
  const toCue = ended ? 0 : (transition.aOut - a.currentTime) / (a.playbackRate || 1)
  startRunning(p, a, b, context.currentTime + toCue, null)
}

/**
 * The cue, buffered: where in A's slice A's element plays is measured (it plays at rate 1 now), which sets the clock
 * exactly; then A's sound moves to its buffer a little before t = 0 and B's comes from its buffer from `bAt`. If A
 * can't be found in its slice, or it is too late for it, the transition plays without buffers.
 */
async function beginBuffered(p: Plan) {
  const a = audio
  const buffered = p.buffered
  const transition = p.transition
  const source = a ? decks.get(a)?.source : null
  if (!a || !buffered || !transition || !source || !context) return
  const ctx = context
  const located = await locateElement(ctx, source, a, { slice: buffered.sliceA, mono: mono(buffered.sliceA.channels) }).catch(() => null)
  if (plan !== p || p.status !== 'armed' || p.buffered !== buffered) return
  const fallBack = () => {
    dropBuffered(p)
    p.status = 'ready'
    mixerTick()
  }
  if (!located || a.paused || ctx.state !== 'running') return fallBack()
  buffered.sliceA.start = calibratedStart(located, ctx.sampleRate)
  // A plays at rate 1 into the transition: t = 0 is when it reaches aOut, counted from the located frame.
  const zero = located.frame / ctx.sampleRate + (transition.aOut - located.position)
  const sideA = await openSide(ctx, elementInput(a), buffered.sliceA, buffered.kindA).catch(() => null)
  if (plan !== p || p.buffered !== buffered) return void (sideA && closeSide(sideA))
  if (!sideA || zero - ctx.currentTime < sideA.deck.latency + MIN_HANDOVER_LEAD_S) {
    if (sideA) closeSide(sideA)
    return fallBack()
  }
  plan = null
  p.cancelCue = () => {}
  startRunning(p, a, p.element!, zero, { a: sideA, b: buffered.sideB })
  p.buffered = null
}

/**
 * The transition starts (its t = 0 at context time `zero`). With `sides` the decks' sound comes from their buffers
 * (paths and loops as planned, see mix-buffers.ts) while the elements play on muted; without, the elements play it
 * themselves, straight (no loops) at the rate curves.
 */
function startRunning(p: Plan, a: HTMLAudioElement, b: HTMLAudioElement, zero: number, sides: Running['sides']) {
  const ctx = context!
  const transition = p.transition!
  const straight = (plan: DeckPlan): DeckPlan => (sides ? plan : { ...plan, lane: { start: plan.lane.start, path: [] } })
  const braked = withBrake(transition, straight(deckPlan(transition, 'a')))
  const r: Running = {
    plan: p,
    transition,
    a,
    b,
    start: zero,
    pausedAt: null,
    handover: handoverPoint(transition),
    handedOver: false,
    stops: [],
    learned: false,
    bStarted: false,
    planA: braked.plan,
    planB: straight(deckPlan(transition, 'b')),
    brake: braked.semitones ? transition.effects.find((effect) => effect.kind === 'brake')!.at : null,
    sides,
    handoverLead: 0,
    settled: bSettled(transition),
    trailing: false,
  }
  running = r
  cancelEase()
  // The limiter acts from now on (B isn't sounding yet) until B plays alone at its own tempo again.
  master?.engage(true)
  b.preservesPitch = true
  elementGain(b).gain.value = sides ? 0 : 1
  const deckA = decks.get(a)!
  const deckB = decks.get(b)!
  const from = Math.max(0, ctx.currentTime - zero)
  if (!safely(() => scheduleTransition({ a: deckA, b: deckB }, transition, zero, { from }))) return abortRunning()
  if (sides) {
    // A's sound moves to its buffer (lined up to the sample) a little before t = 0; B's buffer starts at bAt.
    r.handoverLead = Math.max(-HANDOVER_LEAD_S, ctx.currentTime - zero + sides.a.deck.latency + 0.05)
    sides.a.deck.play(r.planA, r.handoverLead, transition.length, zero, braked.semitones)
    crossfade(elementGain(a).gain, sides.a.gain.gain, zero + r.handoverLead)
    sides.b.gain.gain.setValueAtTime(1, zero + Math.max(0, transition.bAt))
    sides.b.deck.play(r.planB, Math.max(0, transition.bAt), r.settled + HANDBACK_AFTER_S + HANDBACK_SPAN_S, zero)
  }
  follow(r)
}

/** Starts what a running transition does over time, from where it is now: the elements on their plans, the timers. */
function follow(r: Running) {
  const ctx = context!
  const { transition } = r
  const now = () => ctx.currentTime - r.start
  const muted = !!r.sides
  if (!r.bStarted) startB(r)
  else r.stops.push(followB(r))
  // A follows its plan (muted: only once its sound comes from the buffer; until then it plays untouched at rate 1).
  const followA = () =>
    r.stops.push(
      followPlan(ctx, {
        element: r.a,
        clock: now,
        position: (t) => positionAt(r.planA, t),
        rate: (t) => rateOf(r.planA, t),
        pitchFollows: r.brake === null ? undefined : (t) => t >= r.brake!,
        muted,
      }),
    )
  if (!r.trailing) {
    if (!muted || now() >= r.handoverLead + 0.05) followA()
    else r.stops.push(wakeAfter(ctx, r.handoverLead + 0.05 - now(), followA))
  }
  if (!r.handedOver) r.stops.push(wakeAfter(ctx, r.handover - now(), () => handOver(r)))
  if (!r.trailing) r.stops.push(wakeAfter(ctx, transition.length - now(), () => finishRunning(r)))
  if (r.sides) r.stops.push(wakeAfter(ctx, r.settled + HANDBACK_AFTER_S - now(), () => void handBack(r)))
}

/** B's element starts at `bAt` (audible without buffers; muted with them, its sound comes from its buffer). */
function startB(r: Running) {
  const ctx = context!
  const { transition, b } = r
  const go = () => {
    if (running !== r || r.pausedAt !== null || r.bStarted) return
    const lead = currentPlayLead()
    const t = ctx.currentTime - r.start + lead
    if (t - transition.bAt > 0.01) b.currentTime = positionAt(r.planB, t)
    r.bStarted = true
    void b.play().catch(() => running === r && !r.handedOver && abortRunning())
    r.stops.push(followB(r))
  }
  const wait = r.start + transition.bAt - currentPlayLead() - ctx.currentTime
  if (wait <= 0.002) return go()
  r.stops.push(wakeAfter(ctx, wait, go))
}

function followB(r: Running) {
  const ctx = context!
  return followPlan(ctx, {
    element: r.b,
    clock: () => ctx.currentTime - r.start,
    position: (t) => positionAt(r.planB, t),
    rate: (t) => rateOf(r.planB, t),
    muted: !!r.sides,
    onStart: (error) => {
      if (r.learned || r.sides) return
      r.learned = true
      learnPlayLead(error)
    },
  })
}

/** B is louder now: it becomes the track playing (UI, reports, media session); A plays on until the overlap ends. */
function handOver(r: Running) {
  if (running !== r || r.handedOver) return
  // The sleep timer was set to the end of this track: it ends here, without the next one.
  if (stopsAfterTrack()) {
    abortRunning()
    fadeOut()
    return
  }
  const index = state.entries.findIndex((entry) => entry.uid === r.plan.toUid)
  if (index < 0) return abortRunning()
  r.handedOver = true
  const previous = currentTrack()
  // Played to the end, as far as counting goes: the outro the transition cut was part of the mix.
  if (previous) report('stopped', previous, 'trackdone', true)
  audio = r.b
  standby = r.a
  playSessionId = r.plan.sessionId
  setState({ index, buffering: false, playing: !r.b.paused && !fadingOut })
  setTime({ position: r.b.currentTime, duration: durationOf() })
  startContext = { reasonStart: 'trackdone', source: sourceOf(index), shuffle: state.shuffle, offline: r.plan.offline }
  if (r.plan.cacheKey) recordCachedPlay(r.plan.cacheKey)
  report('start')
  shareActivity(!r.b.paused && !fadingOut)
  restartProgress()
  updateMediaSession()
  void extendQueue().then(() => cacheAhead())
}

/**
 * A is gone (its echo may ring out). Without buffers B plays on as a plain deck, its rate easing back along its plan;
 * with them B stays on its buffer (muted element following) until it plays at its own tempo, then hands back.
 */
function finishRunning(r: Running) {
  if (running !== r || r.trailing) return
  if (!r.handedOver) {
    handOver(r)
    if (running !== r) return
  }
  for (const stop of r.stops) stop()
  r.stops = []
  r.sides?.a.deck.stopAt(context!.currentTime)
  retire(r.a, ECHO_TAIL_S)
  const deckB = decks.get(r.b)
  if (deckB) safely(() => resetDeck(deckB, deckB.ctx.currentTime, SETTLE_S))
  if (r.sides) {
    r.trailing = true
    follow(r)
    return
  }
  running = null
  // B alone and neutral again: the limiter lets go once B is back at its own tempo (its release run out).
  if (deckB) master?.engage(false, deckB.ctx.currentTime + Math.max(SETTLE_S, r.settled - (context!.currentTime - r.start)))
  trail(r)
  mixerTick()
}

/**
 * Buffered, after A is gone and B plays at its own tempo again: B's sound goes back to its element. The muted element
 * is found in B's slice and nudged (it can't be heard) until it plays what the buffer plays, to 2 ms; then a 10 ms
 * crossfade hands over and the buffers are let go.
 */
async function handBack(r: Running) {
  const ctx = context
  const sides = r.sides
  const source = decks.get(r.b)?.source
  if (running !== r || !sides || !ctx || !source || r.pausedAt !== null) return
  for (const stop of r.stops) stop()
  r.stops = []
  const b = r.b
  b.playbackRate = 1
  const stillOn = () => running === r && r.pausedAt === null
  for (let attempt = 0; attempt < HANDBACK_ATTEMPTS; attempt++) {
    await new Promise((resolve) => wakeAfter(ctx, 0.25, () => resolve(null)))
    if (!stillOn()) return
    const located = await locateElement(ctx, source, b, sides.b).catch(() => null)
    if (!stillOn()) return
    if (!located) continue
    // What the buffer played at the recorded frame, and how far the element is ahead of it.
    const t = located.frame / ctx.sampleRate - r.start
    const bufferIndex = (positionAt(r.planB, t) - sides.b.slice.start) * ctx.sampleRate
    const ahead = (located.index - bufferIndex) / ctx.sampleRate
    if (Math.abs(ahead) < HANDBACK_TOLERANCE_S) break
    if (Math.abs(ahead) > 0.2) b.currentTime -= ahead
    else {
      // Closed within a second by its rate (muted, so its pitch doesn't matter).
      b.playbackRate = 1 - ahead
      await new Promise((resolve) => wakeAfter(ctx, 1, () => resolve(null)))
      b.playbackRate = 1
      if (!stillOn()) return
    }
  }
  const at = ctx.currentTime + 0.05
  crossfade(sides.b.gain.gain, elementGain(b).gain, at)
  sides.b.deck.stopAt(at + 0.02)
  wakeAfter(ctx, 0.1, () => {
    if (running !== r) return
    running = null
    closeSides(r)
    master?.engage(false)
    mixerTick()
  })
}

function closeSides(r: Running) {
  if (!r.sides) return
  closeSide(r.sides.a)
  closeSide(r.sides.b)
  r.sides = null
}

/**
 * Calls off a transition under way. The element of the track shown (A before the handover, B after) keeps playing as
 * a plain deck at its own speed (with buffers: its sound back from its element, which followed it muted); the other
 * one fades out quickly and stops.
 */
function abortRunning() {
  const r = running
  if (!r) return
  running = null
  for (const stop of r.stops) stop()
  cancelEase()
  const keep = r.handedOver ? r.b : r.a
  const gone = r.handedOver ? r.a : r.b
  if (r.sides && context) {
    const now = context.currentTime
    const keepSide = keep === r.a ? r.sides.a : r.sides.b
    // Its sound back from the element (which followed muted), unless the element still sounds anyway.
    if (elementGain(keep).gain.value < 0.5) crossfade(keepSide.gain.gain, elementGain(keep).gain, now)
    r.sides.a.deck.stopAt(now + 0.01)
    r.sides.b.deck.stopAt(now + 0.01)
    const sides = r.sides
    r.sides = null
    wakeAfter(context, 0.05, () => {
      closeSide(sides.a)
      closeSide(sides.b)
    })
  }
  retire(gone, ABORT_TAIL_S)
  keep.preservesPitch = true
  keep.playbackRate = 1
  elementGain(keep).gain.value = 1
  const deck = decks.get(keep)
  if (deck) safely(() => resetDeck(deck, deck.ctx.currentTime, SETTLE_S))
  if (deck) master?.engage(false, deck.ctx.currentTime + SETTLE_S)
  planSoon()
}

/**
 * A deck leaves: a short fade (no click), then its element stops. An echo on it may ring on for `tail` seconds; the
 * element isn't loaded with anything new before it has died away.
 */
function retire(element: HTMLAudioElement, tail: number) {
  const deck = decks.get(element)
  element.preservesPitch = true
  if (!deck || element.paused) {
    unload(element)
    element.playbackRate = 1
    if (deck) safely(() => resetDeck(deck))
    return
  }
  retiring.add(element)
  const now = deck.ctx.currentTime
  const echoing = deck.echo.send.gain.value > 0.001 || deck.echo.feedback.gain.value > 0.001
  let quiet = now
  const fading = safely(() => {
    freezeDeck(deck, now)
    rampAt(deck.gain.gain, now + RETIRE_S, 0)
    if (echoing) quiet = releaseEcho(deck, now, tail)
  })
  wakeAfter(context, fading ? RETIRE_S + 0.02 : 0, () => {
    retiring.delete(element)
    if (element === audio) return
    // Stopped first, then back to neutral (once the echo has died away, on the audio clock): never audible again.
    unload(element)
    element.playbackRate = 1
    elementGain(element).gain.value = 1
    safely(() => resetDeck(deck, Math.max(deck.ctx.currentTime, quiet)))
    if (quiet > deck.ctx.currentTime) ringing.set(element, quiet)
    mixerTick()
  })
}

/** Without buffers, after A is gone: B's rate follows its plan back to 1, by B's own position (pitch kept). */
function trail(r: Running) {
  cancelEase()
  const element = r.b
  const planB = r.planB
  const start = planB.lane.start
  let stopped = false
  let cancel = () => {}
  const step = () => {
    if (stopped || element !== audio) return
    // The transition time at which B is where it is now (B plays straight here).
    const t = timeOfAdvance(planB, Math.max(0, element.currentTime - start))
    element.playbackRate = rateOf(planB, t)
    if (t < r.settled) cancel = wakeAfter(context, 0.25, step)
    else element.playbackRate = 1
  }
  cancelEase = () => {
    stopped = true
    cancel()
  }
  step()
}

/** The current track paused (by the user, the sleep timer or the system): a transition under way pauses with it. */
function mixerPaused() {
  if (plan?.status === 'armed') {
    plan.cancelCue()
    plan.cancelCue = () => {}
    plan.status = 'ready'
  }
  const r = running
  if (r && r.pausedAt === null && context) {
    const now = context.currentTime
    r.pausedAt = now - r.start
    for (const stop of r.stops) stop()
    r.stops = []
    ;(r.handedOver ? r.a : r.b).pause()
    if (r.sides && r.pausedAt < r.handoverLead) {
      // Paused before any of it came from the buffers: it goes on without them (the elements play it, straight).
      const sides = r.sides
      sides.a.deck.stopAt(now)
      sides.b.deck.stopAt(now)
      sides.a.gain.gain.cancelScheduledValues(0)
      sides.a.gain.gain.value = 0
      elementGain(r.a).gain.cancelScheduledValues(0)
      elementGain(r.a).gain.value = 1
      elementGain(r.b).gain.value = 1
      r.sides = null
      r.planA = { ...r.planA, lane: { start: r.planA.lane.start, path: [] } }
      r.planB = { ...r.planB, lane: { start: r.planB.lane.start, path: [] } }
      wakeAfter(context, 0.05, () => {
        closeSide(sides.a)
        closeSide(sides.b)
      })
    }
    r.sides?.a.deck.stopAt(now)
    r.sides?.b.deck.stopAt(now)
    for (const element of [r.a, r.b]) {
      const deck = decks.get(element)
      if (deck) safely(() => freezeDeck(deck))
    }
  }
  // An unused audio clock is stopped after a while; the next play starts it again.
  window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    if (context?.state === 'running' && (!audio || audio.paused) && !running) void context.suspend().catch(() => undefined)
  }, IDLE_SUSPEND_MS)
}

/** The current track plays again: the audio clock runs again, and a paused transition goes on where it was. */
function mixerPlayed() {
  window.clearTimeout(idleTimer)
  const element = audio
  if (context && context.state !== 'running' && element && decks.has(element)) {
    void context.resume().catch(() => undefined)
    rescueIfSilent()
  }
  const r = running
  if (!r || r.pausedAt === null || !context) return
  const at = r.pausedAt
  r.pausedAt = null
  // The transition's clock goes on with the elements, from where it stopped; the buffers are scheduled ahead of it.
  const lead = r.sides ? Math.max(r.sides.a.deck.latency, r.sides.b.deck.latency) + 0.05 : currentPlayLead()
  r.start = context.currentTime + lead - at
  const deckA = decks.get(r.a)
  const deckB = decks.get(r.b)
  if (!deckA || !deckB) return abortRunning()
  if (!r.trailing && !safely(() => scheduleTransition({ a: deckA, b: deckB }, r.transition, r.start, { from: Math.max(0, at) }))) return abortRunning()
  if (r.sides) {
    if (!r.trailing) r.sides.a.deck.play(r.planA, Math.max(at, r.handoverLead), r.transition.length, r.start)
    // B's buffer plays on from where it was (or starts at bAt as planned); it is silent until then anyway.
    r.sides.b.gain.gain.cancelScheduledValues(0)
    r.sides.b.gain.gain.value = 1
    r.sides.b.deck.play(r.planB, Math.max(at, r.transition.bAt), r.settled + HANDBACK_AFTER_S + HANDBACK_SPAN_S, r.start)
  }
  // B goes on with A if it had started; otherwise `follow` starts it on its cue.
  if (r.handedOver || r.bStarted) void (r.handedOver ? r.a : r.b).play().catch(() => running === r && abortRunning())
  follow(r)
}

/**
 * A's end, back to back: B (parked at `bIn`) starts now, if its cue didn't start it already. Not when the sleep timer
 * ends with this track. Whether B took over.
 */
function followsBackToBack(element: HTMLAudioElement) {
  const p = plan
  if (!p?.backToBack || holds.get(element) !== p.from || (p.status !== 'ready' && p.status !== 'armed') || sleepsAfterTrack()) return false
  p.cancelCue()
  p.status = 'armed'
  begin(p, 0)
  return running !== null
}

/** An element other than the current one failed: B while coming in (the transition is called off). */
function mixerElementFailed(element: HTMLAudioElement) {
  if (running && running.b === element && !running.handedOver) abortRunning()
}

// -- buffers (sample-exact transitions from decoded slices) --

/**
 * Loads both decks' slices for a planned transition (A's from a little before the cue through its path, B's through
 * its path until it can hand back), and lines B's up with its element by playing that a moment, muted. Ready when the
 * transition is armed: it then plays from the buffers; otherwise (too slow, not found, failed) without.
 */
async function loadBuffered(p: Plan) {
  const transition = p.transition
  const ctx = context
  const b = p.element
  const source = b ? decks.get(b)?.source : null
  if (!transition || !ctx || !b || !source || p.backToBack || !connection) return
  const abort = new AbortController()
  p.loading = abort
  try {
    const planA = withBrake(transition, deckPlan(transition, 'a')).plan
    const planB = deckPlan(transition, 'b')
    const settled = bSettled(transition)
    const spanA = trackSpan(planA, -BUFFER_ARM_S - 1, transition.length)
    const spanB = trackSpan(planB, Math.max(0, transition.bAt), settled + HANDBACK_AFTER_S + HANDBACK_SPAN_S + 2)
    const [sliceA, sliceB] = await Promise.all([
      sliceOf(p.from, spanA.from - SLICE_MARGIN_S, spanA.to + SLICE_MARGIN_S, ctx, abort.signal),
      sliceOf(p.to, spanB.from - SLICE_MARGIN_S, spanB.to + SLICE_MARGIN_S, ctx, abort.signal),
    ])
    if (plan !== p || p.status !== 'ready' || running) return
    // B's slice lined up with B's element: it plays a moment from bIn, muted, and is parked again (the transition
    // isn't armed meanwhile).
    p.calibrating = true
    const gain = elementGain(b)
    const found: Located[] = []
    try {
      gain.gain.value = 0
      b.playbackRate = 1
      await b.play()
      const side = { slice: sliceB, mono: mono(sliceB.channels) }
      for (let i = 0; i < B_CALIBRATIONS && plan === p; i++) {
        const located = await locateElement(ctx, source, b, side).catch(() => null)
        if (located) found.push(located)
      }
    } finally {
      // (It stays muted: parking may let a few samples through; the transition sets its level when it starts, a plain
      // start resets it.)
      b.pause()
      b.currentTime = Math.max(0, transition.bIn)
      await parked(b, Math.max(0, transition.bIn)).catch(() => undefined)
      p.calibrating = false
    }
    if (!found.length || plan !== p) return mixerTick()
    sliceB.start = medianStart(found, ctx.sampleRate)
    const kindB = bufferDeckKind(planB, Math.max(0, transition.bAt), settled, tempoChangeKind)
    const sideB = await openSide(ctx, elementInput(b), sliceB, kindB)
    if (plan !== p) return closeSide(sideB)
    p.buffered = { sliceA, sideB, kindA: bufferDeckKind(planA, -HANDOVER_LEAD_S, transition.length, tempoChangeKind) }
    mixerTick()
  } catch {
    // Without buffers then.
  } finally {
    if (p.loading === abort) p.loading = null
  }
}

/** Drops a plan's buffers (it plays without them, or not at all). */
function dropBuffered(p: Plan) {
  p.loading?.abort()
  p.loading = null
  if (p.buffered) closeSide(p.buffered.sideB)
  p.buffered = null
}

/** A stretch [from, to] of a track: from its download or the cache when it is there, else cut by Jellyfin. */
async function sliceOf(item: BaseItemDto, from: number, to: number, ctx: BaseAudioContext, signal: AbortSignal): Promise<Slice> {
  const start = Math.max(0, from)
  const downloaded = await downloadedAudioUrl(downloadId(item))
  const key = downloaded ? null : cacheKey(item)
  const cached = key ? await cachedAudioUrl(key) : null
  const blob = downloaded ?? cached
  if (blob) {
    try {
      return await blobSlice(blob, start, to, ctx)
    } finally {
      release(blob)
    }
  }
  return streamSlice(wavSliceUrl(item.Id!, start, ctx.sampleRate), start, to - start, ctx.sampleRate, signal)
}

/** Jellyfin cutting a track from `start` (seconds) as 16-bit stereo WAV at the context's sample rate. */
function wavSliceUrl(id: string, start: number, sampleRate: number) {
  const { api, userId, accessToken } = connection!
  const params = new URLSearchParams({
    UserId: userId,
    DeviceId: jellyfin.deviceInfo.id,
    AudioCodec: 'pcm_s16le',
    AudioSampleRate: String(sampleRate),
    AudioChannels: '2',
    StartTimeTicks: String(secondsToTicks(start)),
    Static: 'false',
    PlaySessionId: crypto.randomUUID(),
    ApiKey: accessToken,
  })
  return `${api.basePath}/Audio/${id}/stream.wav?${params}`
}


// ---- OS integration: media keys, lock screen, notification ----

let artwork: (item: BaseItemDto) => string | undefined = () => undefined

export function setArtworkResolver(resolve: typeof artwork) {
  artwork = resolve
}

function updateMediaSession() {
  updateAppSession()
  const item = currentTrack()
  if (!item) return
  const cover = artwork(item)
  const metadata = {
    title: item.Name ?? '',
    artist: (item.Artists ?? []).join(', ') || item.AlbumArtist || '',
    album: item.Album ?? '',
    artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
  }
  // Lumio's Android app: its WebView has no media session of its own; the plugin's keeps the music going in the
  // background and shows the notification.
  if (inCapacitor()) return void NativeMediaSession.setMetadata(metadata).catch(() => undefined)
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata(metadata)
}

const SESSION_HANDLERS: Array<[MediaSessionAction, (details: { seekTime?: number | null }) => void]> = [
  ['play', () => music.toggle()],
  ['pause', () => music.pause()],
  ['nexttrack', () => music.next()],
  ['previoustrack', () => music.previous()],
  ['seekto', (details) => details.seekTime != null && music.seek(details.seekTime)],
]

if (typeof navigator !== 'undefined' && inCapacitor()) {
  for (const [action, handler] of SESSION_HANDLERS) void NativeMediaSession.setActionHandler({ action: action as 'play' }, handler).catch(() => undefined)
} else if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
  for (const [action, handler] of SESSION_HANDLERS) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // Not supported by this browser.
    }
  }
}

/**
 * Jellyfin's Android app: its WebView has no `navigator.mediaSession`, so the notification (and with it playing on in
 * the background) goes through the app. It sends the notification's buttons back as jellyfin-web commands.
 */
function updateAppSession() {
  // The desktop app's tray: what plays, and whether.
  if (audio) {
    const item = currentTrack()
    const artist = item ? (item.Artists ?? []).join(', ') || item.AlbumArtist || '' : ''
    desktop()?.setNowPlaying({ title: item ? [item.Name, artist].filter(Boolean).join(' – ') : '', playing: !audio.paused, loaded: !!item })
  }
  if (inCapacitor() && audio) {
    const playing = !audio.paused
    void NativeMediaSession.setPlaybackState({ playbackState: currentTrack() ? (playing ? 'playing' : 'paused') : 'none' }).catch(() => undefined)
    const duration = durationOf()
    if (duration) void NativeMediaSession.setPositionState({ duration, position: Math.min(pendingStart ?? audio.currentTime, duration), playbackRate: 1 }).catch(() => undefined)
    return
  }
  if (!inJellyfinApp() || !audio) return
  const item = currentTrack()
  if (!item?.Id) return updateAppMediaSession(null)
  const position = pendingStart ?? audio.currentTime
  updateAppMediaSession({
    itemId: item.Id,
    title: item.Name ?? '',
    artist: (item.Artists ?? []).join(', ') || item.AlbumArtist || '',
    album: item.Album ?? '',
    imageUrl: artwork(item) ?? '',
    position: Math.round(position * 1000),
    duration: Math.round(durationOf() * 1000),
    canSeek: true,
    isPaused: audio.paused,
  })
}

if (inJellyfinApp()) {
  const SKIP_S = 10
  setAppPlaybackManager({
    unpause: () => music.resume(),
    pause: () => music.pause(),
    playPause: () => music.toggle(),
    previousTrack: () => music.previous(),
    nextTrack: () => music.next(),
    rewind: () => music.seekBy(-SKIP_S),
    fastForward: () => music.seekBy(SKIP_S),
    stop: () => music.stop(),
    seekMs: (ms) => music.seek(ms / 1000),
    volumeUp: () => music.setVolume(state.volume + 0.1),
    volumeDown: () => music.setVolume(state.volume - 0.1),
    sendCommand: (command) => {
      const volume = command.Arguments?.Volume
      if (command.Name === 'SetVolume' && typeof volume === 'number') music.setVolume(volume / 100)
    },
  })
}

setSleepHandler(() => music.pause())

// The desktop app's tray menu: play/pause and next.
desktop()?.onMediaCommand((command) => (command === 'next' ? music.next() : music.toggle()))
