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
import { setSleepHandler, stopsAfterTrack } from './sleep-timer'

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

// ---- the audio element ----

const audio = typeof Audio !== 'undefined' ? new Audio() : null

/**
 * Volume normalization (Settings → Music): Jellyfin measures each track's and album's loudness (its "audio
 * normalization" task) and tells the gain in dB that brings it to a common level. Lumio can only turn the element
 * down, not up, so loud tracks are lowered and quiet ones stay as they are. Tracks without a measurement play unchanged.
 */
let gainFactor = 1
const albumGains = new Map<string, number | null>()

/** Pause and play fade (0 silent – 1 full), instead of cutting the sound off. */
let fadeLevel = 1
let fadeTimer = 0
const FADE_OUT_MS = 300
const FADE_IN_MS = 400

function applyVolume() {
  if (audio) audio.volume = Math.min(1, Math.max(0, loudness(state.volume * fadeLevel) * gainFactor))
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

/** Fades out, then pauses; the controls show the pause right away. */
function fadeOut() {
  if (!audio || audio.paused || fadingOut) return
  fadingOut = true
  setState({ playing: false })
  fade(0, FADE_OUT_MS, () => {
    audio.pause()
    unfade()
  })
}

/** Plays, fading in (also when a fade out is still under way: it turns back). */
function fadeIn() {
  if (!audio) return
  fadingOut = false
  if (audio.paused) {
    window.clearInterval(fadeTimer)
    fadeLevel = 0
    applyVolume()
    void audio.play().catch(() => unfade())
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
  if (item !== currentTrack()) return
  gainFactor = gain === null ? 1 : Math.min(1, 10 ** (gain / 20))
  applyVolume()
}

if (audio) {
  audio.preload = 'auto'
  applyVolume()
  audio.addEventListener('play', () => {
    setState({ playing: true })
    updateAppSession()
    shareActivity(true)
    // Listening time counts again from here (it stopped at the pause).
    const item = currentTrack()
    if (item) logPlay('progress', item, true, playSessionId)
  })
  audio.addEventListener('pause', () => {
    setState({ playing: false })
    updateAppSession()
    shareActivity(false)
    report('progress')
    writeSession()
  })
  audio.addEventListener('waiting', () => {
    setState({ buffering: true })
    logBuffering(true)
  })
  audio.addEventListener('playing', () => {
    setState({ buffering: false })
    logBuffering(false)
  })
  audio.addEventListener('canplay', () => setState({ buffering: false }))
  audio.addEventListener('timeupdate', () => {
    setTime({ position: audio.currentTime, duration: durationOf() })
    if (Date.now() - positionSavedAt > SAVE_POSITION_MS) writeSession()
  })
  audio.addEventListener('durationchange', () => {
    setTime({ position: audio.currentTime, duration: durationOf() })
    updateAppSession()
  })
  audio.addEventListener('seeked', updateAppSession)
  audio.addEventListener('ended', onEnded)
  audio.addEventListener('error', () => {
    setState({ buffering: false })
    // A track that can't be played is skipped rather than stopping the whole queue.
    if (state.index < state.queue.length - 1) void go(state.index + 1, undefined, 'trackerror')
  })
}

/** Transcoded streams don't always know their length; the library does. */
function durationOf() {
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration
  return ticksToSeconds(currentTrack()?.RunTimeTicks ?? 0)
}

// ---- reporting (play counts, "recently played", resume points) ----

function report(kind: 'start' | 'progress' | 'stopped', item = currentTrack(), reasonEnd?: EndReason) {
  if (!connection || !item?.Id || !audio) return
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
    PositionTicks: secondsToTicks(audio.currentTime),
    IsPaused: audio.paused,
    IsMuted: audio.muted,
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
  const keep = () => {
    if (kind !== 'stopped') return
    const duration = durationOf()
    const played = !!duration && audio!.currentTime >= duration * 0.9
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
  if (currentTrack() !== item) return
  audio.src = downloaded ?? cached ?? streamUrl(item)
  void normalize(item)
  startContext = { reasonStart: reason, source: sourceOf(index), shuffle: state.shuffle, offline: !!(downloaded ?? cached) }
  if (key && cached) recordCachedPlay(key)
  // The position can only be set once the stream's metadata is in.
  if (startAt) audio.addEventListener('loadedmetadata', () => (audio.currentTime = startAt), { once: true })
  unfade()
  try {
    await audio.play()
    report('start')
  } catch {
    // Autoplay blocked or the stream failed; the UI shows a play button again.
    setState({ playing: false, buffering: false })
  }
  window.clearInterval(progressTimer)
  progressTimer = window.setInterval(() => !audio.paused && report('progress'), PROGRESS_EVERY_MS)
  updateMediaSession()
  // Once the collection is through, autoplay keeps the next songs lined up (and shown), so it simply goes on.
  await extendQueue()
  void cacheAhead()
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
    audio.currentTime = Math.max(0, Math.min(seconds, durationOf() || seconds))
    setTime({ position: audio.currentTime, duration: durationOf() })
    report('progress')
  },
  setVolume(volume: number) {
    if (!audio) return
    const next = Math.min(1, Math.max(0, volume))
    setState({ volume: next, muted: next === 0 })
    audio.muted = next === 0
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
    audio.muted = !audio.muted
    setState({ muted: audio.muted })
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
  unfade()
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  window.clearInterval(progressTimer)
  setState({ queue: [], entries: [], index: -1, playing: false, buffering: false, unshuffled: null, source: null })
  setTime({ position: 0, duration: 0 })
  updateAppSession()
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
