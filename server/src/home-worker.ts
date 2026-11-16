import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { communityArtists, listenerArtists } from './community.ts'
import { artistIndex, genreIndex, homePlaylists, playlistBySlug, similarToFavourites, type Lastfm, type Listener, type Locale, type MixPlaylist } from './home-playlists.ts'
import { soundData, type SoundData } from './mix-sound.ts'
import { MusicCatalog, playlistTrackIds, userDataOf, type Track, type UserData } from './music-catalog.ts'
import { buildRadio, radioPlaylist, similarArtists } from './radio.ts'
import { Store } from './store.ts'
import { tasteSignals, tasteSittings } from './taste.ts'
import { buildTasteModel, localDate, slotOf } from './taste-model.ts'
import { pack, type WirePlaylists } from './wire.ts'

/**
 * Builds the home page's playlists and the radios off the server's main thread (see home.ts): it holds every music
 * library's songs (see music-catalog.ts), and working through 100,000 of them for each listener takes a few seconds of
 * arithmetic that would otherwise hold up every other request.
 */
export interface Who {
  userId: string
  token: string
  /** Their account limits what they may see inside a library (their own copy of its songs then). */
  restricted: boolean
  libraries: string[]
  timeZone: string
  locale: Locale
  /** Whether Last.fm can be asked (the server's key, or the app's: `lastfmKey`). */
  lastfm: boolean
  lastfmKey?: string
}

export type HomeJob =
  | { kind: 'home'; who: Who }
  | { kind: 'slug'; who: Who; slug: string }
  | { kind: 'continue'; who: Who; artistId: string; exclude: string[]; seed: string }
  | { kind: 'similar'; who: Who; artistId: string }
  | { kind: 'progress'; who: Who }


const { jellyfinUrl, dataDir } = workerData as { jellyfinUrl: string; dataDir: string }
const store = new Store(dataDir)
const catalog = new MusicCatalog(jellyfinUrl, join(dataDir, 'music-catalog'))

/** A listener's model is made again after this long (new plays count from then on). */
const LISTENER_TTL = 30 * 60_000
/** A home page's playlists are fresh this long; older ones are still shown while new ones are made. */
const HOME_TTL = 30 * 60_000
const SOUND_TTL = 60 * 60_000
const COMMUNITY_TTL = 6 * 60 * 60_000

// ---- Last.fm, asked through the main thread's relay ----

let rpcs = 0
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function lastfmFor(who: Who): Lastfm | null {
  if (!who.lastfm) return null
  return (params) =>
    new Promise((resolve, reject) => {
      const rpc = ++rpcs
      waiting.set(rpc, { resolve, reject })
      parentPort!.postMessage({ rpc, method: 'lastfm', params, key: who.lastfmKey })
    })
}

// ---- what's shared and what's per listener ----

let sound: { at: number; data: SoundData } | undefined
function currentSound() {
  if (!sound || Date.now() - sound.at > SOUND_TTL) sound = { at: Date.now(), data: soundData(store) }
  return sound.data
}

const communities = new Map<string, { at: number; artists: ReturnType<typeof listenerArtists> }>()
function everyone(librariesKey: string, byId: Map<string, Track>) {
  let entry = communities.get(librariesKey)
  if (!entry || Date.now() - entry.at > COMMUNITY_TTL) {
    entry = { at: Date.now(), artists: listenerArtists(store, (id) => byId.get(id)) }
    communities.set(librariesKey, entry)
  }
  return entry.artists
}

const listeners = new Map<string, { at: number; listener: Promise<Listener> }>()
const listenerKey = (who: Who) => `${who.userId}|${who.restricted ? 1 : 0}|${[...who.libraries].sort().join(',')}|${who.timeZone}`

interface Exclusions {
  artists: string[]
  albums: string[]
  tracks: string[]
  playlists: string[]
}

async function makeListener(who: Who): Promise<Listener> {
  const byId = new Map<string, Track>()
  for (const library of who.libraries) for (const [id, track] of await catalog.tracks(library, who.userId, who.token, who.restricted)) byId.set(id, track)
  const tracks = [...byId.values()]
  const userData = await userDataOf(jellyfinUrl, who.userId, who.token, who.libraries).catch((error) => {
    console.warn('Home playlists: user data:', error instanceof Error ? error.message : error)
    return new Map<string, UserData>()
  })
  // What the listener left out of their taste profile (their account settings): it doesn't count for their taste.
  const exclusions: Exclusions = { artists: [], albums: [], tracks: [], playlists: [], ...((store.settings(who.userId).data.tasteExclusions as Partial<Exclusions> | undefined) ?? {}) }
  const leftOut = {
    artists: new Set(exclusions.artists),
    albums: new Set(exclusions.albums),
    tracks: new Set([...exclusions.tracks, ...(exclusions.playlists.length ? await playlistTrackIds(jellyfinUrl, who.userId, who.token, exclusions.playlists) : [])]),
  }
  const counts = (track: Track) =>
    !leftOut.tracks.has(track.Id) &&
    !(track.AlbumId && leftOut.albums.has(track.AlbumId)) &&
    ![...(track.ArtistItems ?? []), ...(track.AlbumArtists ?? [])].some((artist) => artist.Id && leftOut.artists.has(artist.Id))
  const now = Date.now()
  const signals = tasteSignals(store, who.userId, who.timeZone, now)
  const sittings = tasteSittings(store, who.userId, now)
  const index = artistIndex(tracks)
  const byGenre = genreIndex(tracks)
  const addedAt = new Map<string, number>()
  for (const track of tracks) addedAt.set(track.Id, Date.parse(track.DateCreated ?? '') || 0)
  const data = (track: Track) => userData.get(track.Id)
  const base = { tracks, userData: data, signals, counts, now, sittings }
  const first = buildTasteModel(base)
  const lastfm = lastfmFor(who)
  const similar = await similarToFavourites({ index }, first, lastfm).catch(() => new Set<string>())
  // Listeners like them: from everyone's loved artists, this listener's own among them.
  const others = everyone([...who.libraries].sort().join(','), byId)
  const mine = others.get(who.userId) ?? new Map<string, number>()
  const community = communityArtists(store, who.userId, mine, others, (id) => first.artist(id) >= 0.3)
  const model = similar.size || community.size ? buildTasteModel({ ...base, similar, community }) : first
  return { userId: who.userId, tracks, byId, userData: data, counts, model, sound: currentSound(), index, byGenre, added: (track) => addedAt.get(track.Id) ?? 0 }
}

function listenerFor(who: Who) {
  const key = listenerKey(who)
  const kept = listeners.get(key)
  if (kept && Date.now() - kept.at < LISTENER_TTL) return kept.listener
  const listener = makeListener(who)
  listeners.set(key, { at: Date.now(), listener })
  // A failed one is made again next time; and only a few listeners are kept (each holds the library's indexes).
  listener.catch(() => listeners.delete(key))
  for (const [other, entry] of listeners) if (Date.now() - entry.at > LISTENER_TTL) listeners.delete(other)
  return listener
}

const contextOf = (who: Who) => ({ now: Date.now(), userId: who.userId, timeZone: who.timeZone, locale: who.locale, lastfm: lastfmFor(who) })

const wire = (listener: Listener, playlists: MixPlaylist[]) => pack(playlists, listener.userData)

/** A home page as made: its playlists (for asking for one of them), and packed for the app. */
interface Home {
  listener: Listener
  playlists: MixPlaylist[]
  packed: WirePlaylists
}

// ---- the home page ----

const homes = new Map<string, { at: number; result: Promise<Home> }>()
const refreshing = new Set<string>()

/** The playlists of the listener's day part (see slotOf): kept half an hour, then made again while the old are shown. */
function home(who: Who) {
  const now = Date.now()
  const key = `${listenerKey(who)}|${who.locale}|${localDate(now, who.timeZone)}|${slotOf(now, who.timeZone).part}`
  const kept = homes.get(key)
  const build = async () => {
    const listener = await listenerFor(who)
    const playlists = await homePlaylists(listener, contextOf(who))
    return { listener, playlists, packed: wire(listener, playlists) }
  }
  if (kept && now - kept.at < HOME_TTL) return kept.result
  if (kept) {
    // The old ones until the new ones are there (made once, however often they are asked for meanwhile).
    if (!refreshing.has(key)) {
      refreshing.add(key)
      const result = build()
      result.then(
        () => homes.set(key, { at: Date.now(), result }),
        (error: unknown) => console.warn('Home playlists:', error instanceof Error ? error.message : error),
      ).finally(() => refreshing.delete(key))
    }
    return kept.result
  }
  const result = build()
  homes.set(key, { at: now, result })
  result.catch(() => homes.delete(key))
  for (const [other, entry] of homes) if (now - entry.at > 2 * HOME_TTL) homes.delete(other)
  return result
}

/** One playlist: a radio (made on its own), one of the home page's, or one it doesn't list (see playlistBySlug). */
async function slug(who: Who, slug: string): Promise<WirePlaylists | null> {
  const listener = await listenerFor(who)
  const context = contextOf(who)
  if (slug.startsWith('radio-')) {
    const radio = await radioPlaylist(listener, slug.slice('radio-'.length), context.lastfm, who.locale, localDate(context.now, who.timeZone))
    return radio ? wire(listener, [radio]) : null
  }
  const all = await home(who)
  const listed = all.playlists.find((playlist) => playlist.slug === slug)
  if (listed) return wire(all.listener, [listed])
  const playlist = playlistBySlug(listener, context, slug)
  return playlist ? wire(listener, [playlist]) : null
}

async function run(job: HomeJob): Promise<unknown> {
  switch (job.kind) {
    case 'home':
      return (await home(job.who)).packed
    case 'slug':
      return slug(job.who, job.slug)
    case 'continue': {
      const listener = await listenerFor(job.who)
      const { tracks } = await buildRadio(listener, job.artistId, lastfmFor(job.who), job.seed, new Set(job.exclude))
      return wire(listener, [{ slug: 'continue', kind: 'radio', title: '', description: '', tracks: tracks.slice(0, 25) }])
    }
    case 'similar':
      return similarArtists(await listenerFor(job.who), job.artistId, lastfmFor(job.who))
    case 'progress': {
      let read = 0
      let total = 0
      for (const library of job.who.libraries) {
        const progress = catalog.progressOf(MusicCatalog.keyOf(library, job.who.userId, job.who.restricted))
        if (progress) {
          read += progress.read
          total += progress.total
        }
      }
      return { read, total }
    }
  }
}

parentPort?.on('message', (message: { id?: number; job?: HomeJob; rpc?: number; result?: unknown; error?: string }) => {
  if (message.rpc !== undefined) {
    const call = waiting.get(message.rpc)
    waiting.delete(message.rpc)
    if (message.error !== undefined) call?.reject(new Error(message.error))
    else call?.resolve(message.result)
    return
  }
  if (message.id === undefined || !message.job) return
  const id = message.id
  run(message.job).then(
    (result) => parentPort!.postMessage({ id, result }),
    (error: unknown) => parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  )
})
