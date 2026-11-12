import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { isJellyfinRequest, proxyToJellyfin, proxyUpgrade } from './proxy.ts'
import { isPrivateAddress } from './addresses.ts'
import { latestApps } from './apps.ts'
import { creditsOfRecording, lookupCredits, sameName, searchRecordings, type Failure, type JobState, type TrackCredits, type TrackMeta } from './credits.ts'
import { DEFAULT_PRIVACY, Store, type Activity, type ImportedPlay, type Person, type Privacy } from './store.ts'
import { tasteSignals, type TasteSignals } from './taste.ts'
import { SOUND_VERSION } from './sound-analysis.ts'
import { MIX_VERSION } from './mix-analysis.ts'
import { JellyfinError, analyzeTrack, parsePlaylistMixer, type BakedLookup, type MixTrack } from './mix.ts'
import { BAKED_PART_LIMIT, BakedClips, isBakedKey, serveFile, type BakedMeta } from './baked.ts'
import { STEMS, STEM_UPLOAD_LIMIT, Stems, sweepOriginals, windowAudio, windowOf, type Stem, type StemWindow } from './stems.ts'
import { StemWorkers } from './stem-workers.ts'
import { lyricsSearch } from './lyrics-search.ts'
import { artistTags, artistsOfTrack, measureTrack, trackTags, type SoundTrack } from './sound.ts'
import { validTimeZone, wrappedFor, wrappedReady, wrappedYears } from './wrapped.ts'
import { LANGS, detectLanguage, localizeTitle, type Lang, type LanguageDeps, type LocalImage, type LocalImageKind, type Localized, type LocalizedMeta, type Texts, type VideoItem } from './languages.ts'

/**
 * The Lumio server. It serves the Lumio web app itself and, under /api, what Jellyfin doesn't let users share with
 * each other: who follows whom, privacy choices, and what friends (people who follow each other) are playing, live.
 *
 * It keeps no accounts of its own: every API request carries the user's Jellyfin token, which it checks with the
 * Jellyfin server (and caches for a few minutes). Live updates go out as server-sent events.
 *
 * Settings (environment): JELLYFIN_URL (required), PORT (8097), DATA_DIR (./data), WEB_DIR (the built app, ../dist),
 * ALLOWED_ORIGINS (comma-separated; only needed when the app runs elsewhere, e.g. the Vite dev server; Lumio's own
 * apps are always allowed),
 * LASTFM_API_KEY, TICKETMASTER_API_KEY and TMDB_API_KEY (optional: the keys for those services, which the app then asks
 * through this server; an app built with keys of its own can use those instead), MUSICBRAINZ_CONTACT (optional;
 * how MusicBrainz can reach the operator), PROXY_JELLYFIN (true: Lumio is the public face and passes everything of
 * Jellyfin's through, see proxy.ts), SSO_PROVIDERS (the SSO plugin's providers for the sign-in page, as
 * `name:Button label` separated by commas, e.g. `authentik:Sign in with Nauren`), DISABLE_PASSWORD_LOGIN (true: the
 * sign-in page offers SSO and Quick Connect only, no Jellyfin password form; only with SSO providers set).
 */
const JELLYFIN_URL = (process.env.JELLYFIN_URL ?? '').replace(/\/+$/, '')
const PROXY_JELLYFIN = /^(1|true|yes)$/i.test(process.env.PROXY_JELLYFIN ?? '')
/** Signing in with a Jellyfin password is left off Lumio's sign-in page (SSO and Quick Connect only). */
const DISABLE_PASSWORD_LOGIN = /^(1|true|yes)$/i.test(process.env.DISABLE_PASSWORD_LOGIN ?? '')
const SSO_PROVIDERS = (process.env.SSO_PROVIDERS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [id = '', ...label] = entry.split(':')
    return { id: id.trim(), label: label.join(':').trim() || id.trim() }
  })
  .filter((provider) => /^[\w.-]+$/.test(provider.id))
/**
 * Searching songs by their lyrics, in Meilisearch (e.g. the one the Jellyfin plugin uses, in an index of Lumio's own):
 * its address and a key that may write and search that index. Without both, the search is off.
 */
const MEILI_URL = process.env.MEILI_URL?.trim()
const MEILI_KEY = process.env.MEILI_KEY?.trim()
const MEILI_LYRICS_INDEX = process.env.MEILI_LYRICS_INDEX?.trim() || 'lumio_lyrics'
const PORT = Number(process.env.PORT ?? 8097)
const DATA_DIR = process.env.DATA_DIR ?? './data'
/** Lumio's own apps, which carry the pages themselves: Android (Capacitor) is https://localhost, desktop app://lumio. */
const APP_ORIGINS = ['https://localhost', 'app://lumio']
const ALLOWED_ORIGINS = [...APP_ORIGINS, ...(process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)]
const WEB_DIR = resolve(process.env.WEB_DIR ?? join(import.meta.dirname, '../../dist'))
/** A token is checked with Jellyfin again after this long. */
const TOKEN_TTL_MS = 5 * 60_000
/** Largest request body accepted (bytes). */
const BODY_LIMIT = 16 * 1024
/** Largest lyrics body (a long medley has hundreds of timed lines). */
const LYRICS_BODY_LIMIT = 256 * 1024
/**
 * Hosts whose pictures the image relay fetches (podcast covers from Apple, artist photos from Deezer, posters and logos
 * in another language from TMDb, fanart.tv and TheTVDB); nothing else, so it is no open proxy.
 */
const IMAGE_HOSTS = /(^|\.)(mzstatic\.com|dzcdn\.net|epidemicsound\.com|image\.tmdb\.org|fanart\.tv|thetvdb\.com)$/
/** Largest picture relayed (bytes). */
const IMAGE_LIMIT = 8 * 1024 * 1024
const IMAGE_DIR = join(DATA_DIR, 'images')
/** Pictures administrators uploaded for one language of a film or series. */
const UPLOAD_DIR = join(DATA_DIR, 'localized-images')
/** Largest text body (an item's texts in both languages). */
const TEXT_BODY_LIMIT = 64 * 1024
/** Largest part of an imported listening history (the app sends it in parts of a few thousand plays). */
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024
/** Largest playlist mixer body (up to 1000 transitions of about 1 KB, at most 3 KB with long equal-power blends). */
const MIXER_BODY_LIMIT = 4 * 1024 * 1024
/** Most plays in one part of an import. */
const IMPORT_BATCH = 5000
/** Services whose listening history can be imported. */
const IMPORT_SOURCES = new Set(['spotify'])
const RELAY_DIR = join(DATA_DIR, 'relay')
/** Largest podcast feed, chapter list or transcript relayed (bytes). */
const FEED_LIMIT = 15 * 1024 * 1024
/** What the feed relay passes on: feeds, chapter lists and transcripts (text of some kind), nothing else. */
const FEED_TYPES = /xml|rss|atom|json|text\/|vtt|srt|subrip/i
const HOUR = 60 * 60_000
/**
 * How the server introduces itself to outside services. MusicBrainz asks for a way to reach whoever runs a client and
 * turns anonymous ones away sooner; MUSICBRAINZ_CONTACT (a URL or e-mail address) names the operator.
 */
const USER_AGENT = `Lumio/1.0 ( ${process.env.MUSICBRAINZ_CONTACT?.trim() || 'https://github.com/PalmarHealer/lumio'} )`

/**
 * The outside services the app asks through this server, which caches their answers on disk for everyone: what one
 * listener looked up (an artist's concerts, biography, links) is there at once for the next, survives restarts, and
 * each service's request limits are kept centrally. Each only allows its own paths, so the relay is no open proxy.
 */
interface RelayService {
  base: string
  paths: RegExp
  /** The query parameter that carries the API key, and the server's own key (else the app's is used). */
  key?: { param: string; value?: string }
  /**
   * How long an answer stays fresh (by its status and what was asked); older ones are fetched again, and still served
   * if the service fails. What hardly changes (lyrics, biographies, links) is kept for months.
   */
  ttl: number | ((status: number, path: string, params: URLSearchParams) => number)
  /** Time between two calls (the service's rate limit). */
  spacing: number
  headers?: Record<string, string>
  /** Whether an answer is worth keeping (not a rate limit or an outage reported inside a 200). */
  keep?: (status: number, body: string) => boolean
}

const RELAY_SERVICES: Record<string, RelayService> = {
  // Ticketmaster's Discovery API: events, artists, venues. Five calls a second per key.
  concerts: {
    base: 'https://app.ticketmaster.com/discovery/v2/',
    paths: /^(events|attractions|venues)(\/[A-Za-z0-9_-]+)?(\.json)?$/,
    key: { param: 'apikey', value: process.env.TICKETMASTER_API_KEY?.trim() },
    ttl: 6 * HOUR,
    spacing: 220,
    keep: (status) => status < 400 || status === 404,
  },
  // TMDb: a film's or series' rating, a film collection's parts, and texts and pictures in both languages (a season
  // brings its episodes). Ratings move slowly.
  tmdb: {
    base: 'https://api.themoviedb.org/3/',
    paths: /^(movie\/\d+(\/images)?|tv\/\d+(\/images|\/season\/\d+)?|collection\/\d+)$/,
    key: { param: 'api_key', value: process.env.TMDB_API_KEY?.trim() },
    ttl: 7 * 24 * HOUR,
    spacing: 50,
    keep: (status) => status < 400 || status === 404,
  },
  // Last.fm: artist info, top tracks, similar artists, charts. Its answers change slowly.
  lastfm: {
    base: 'https://ws.audioscrobbler.com/2.0/',
    paths: /^$/,
    key: { param: 'api_key', value: process.env.LASTFM_API_KEY?.trim() },
    // Charts move daily; an artist's biography, top tracks and similar artists hardly do.
    ttl: (_status, _path, params) => (/^artist\./.test(params.get('method') ?? '') ? 90 * 24 * HOUR : 24 * HOUR),
    spacing: 200,
    // Errors come inside a 200: "not found" (6) is an answer, being limited or down (8, 11, 16, 29) is not.
    keep: (status, body) => status < 400 && !/"error":\s*(8|11|16|29)\b/.test(body),
  },
  // MusicBrainz: an artist and their links, a recording's credits and its label. It asks for at most one call a second and a name for the caller.
  musicbrainz: {
    base: 'https://musicbrainz.org/ws/2/',
    paths: /^(artist|recording|release)(\/[0-9a-f-]{36})?$/,
    ttl: 180 * 24 * HOUR,
    spacing: 1100,
    headers: { 'User-Agent': USER_AGENT },
    keep: (status) => status < 400 || status === 404,
  },
  // Deezer: a photo for artists Jellyfin has none for (its search needs no key). Photos rarely change.
  deezer: {
    base: 'https://api.deezer.com/',
    paths: /^search\/artist$/,
    ttl: 180 * 24 * HOUR,
    spacing: 120,
  },
  // lrclib: lyrics (an exact match, else a search). A song's lyrics don't change: kept half a year; "none found" is
  // asked again after a week.
  lyrics: {
    base: 'https://lrclib.net/',
    paths: /^api\/(get|search)$/,
    // A search that finds nothing answers 200 with an empty list, so searches are asked again after a week too.
    ttl: (status, path) => (status === 404 || path === 'api/search' ? 7 * 24 * HOUR : 180 * 24 * HOUR),
    spacing: 100,
    headers: { 'User-Agent': USER_AGENT },
    keep: (status) => status < 400 || status === 404,
  },
}

if (!JELLYFIN_URL) {
  console.error('JELLYFIN_URL is required, e.g. JELLYFIN_URL=https://jellyfin.example.org')
  process.exit(1)
}

const store = new Store(DATA_DIR)
const lyricsIndex = MEILI_URL && MEILI_KEY ? lyricsSearch(MEILI_URL, MEILI_KEY, MEILI_LYRICS_INDEX) : null
const bakedClips = new BakedClips(DATA_DIR)
const stems = new Stems(DATA_DIR)
/** The separation workers and their sign-in (see stem-workers.ts). */
const stemWorkers = new StemWorkers(store)
setInterval(() => void stems.sweep().catch((error) => console.warn('Stems sweep:', error)), 3600_000).unref()
setInterval(() => void sweepOriginals().catch((error) => console.warn('Originals sweep:', error)), 300_000).unref()

/** Whether someone may see a library item (Jellyfin answers it for them); remembered for ten minutes. */
const itemAccess = new Map<string, number>()
async function canSeeItem(token: string, userId: string, item: string) {
  const key = `${token}|${item}`
  if ((itemAccess.get(key) ?? 0) > Date.now()) return true
  const response = await fetch(`${JELLYFIN_URL}/Users/${userId}/Items/${item}`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!response?.ok) return false
  if (itemAccess.size > 20_000) itemAccess.clear()
  itemAccess.set(key, Date.now() + 600_000)
  return true
}
// Clips no saved transition refers to any more (a reorder, an edit) are freed after a day; the quota is kept.
setInterval(() => void bakedClips.sweep(store.bakedKeysInUse()).catch((error) => console.warn('Baked clips sweep:', error)), 3600_000).unref()

// ---- authentication: the user's own Jellyfin token ----

const tokens = new Map<string, { person: Person; admin: boolean; until: number }>()

async function authenticate(token: string | null): Promise<Person | null> {
  if (!token) return null
  const cached = tokens.get(token)
  if (cached && cached.until > Date.now()) return cached.person
  tokens.delete(token)
  try {
    const response = await fetch(`${JELLYFIN_URL}/Users/Me`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    const user = (await response.json()) as { Id: string; Name: string; PrimaryImageTag?: string | null; Policy?: { IsAdministrator?: boolean } }
    const person = { id: user.Id, name: user.Name, imageTag: user.PrimaryImageTag ?? null }
    store.upsertPerson(person)
    tokens.set(token, { person, admin: !!user.Policy?.IsAdministrator, until: Date.now() + TOKEN_TTL_MS })
    return person
  } catch {
    return null
  }
}

/** Whether the token belongs to a Jellyfin administrator (checked by authenticate). */
function isAdmin(token: string | null) {
  return !!token && !!tokens.get(token)?.admin
}

function tokenOf(request: IncomingMessage, url: URL) {
  const header = request.headers.authorization ?? ''
  return header.match(/Token="([^"]+)"/)?.[1] ?? (header.startsWith('Bearer ') ? header.slice(7) : null) ?? url.searchParams.get('token')
}

// ---- live updates (server-sent events) ----

const streams = new Map<string, Set<ServerResponse>>()
/** The taste signals last made per person and time zone (see GET /me/taste). */
const tasteCache = new Map<string, TasteSignals>()

function push(userId: string, event: string, data: unknown) {
  for (const response of streams.get(userId) ?? []) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Tells someone's friends what they play now (if they share it). */
function announceActivity(userId: string) {
  if (!store.privacy(userId).shareActivity) return
  const payload = { user: store.person(userId), activity: store.activity(userId) }
  for (const friend of store.friends(userId)) push(friend, 'activity', payload)
}

// ---- responses ----

function send(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson<T>(request: IncomingMessage, limit = BODY_LIMIT): Promise<T> {
  return JSON.parse((await readBody(request, limit)).toString('utf8') || '{}') as T
}

function cors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin
  // The app normally comes from this server (same origin); other origins only when listed.
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  response.setHeader('Access-Control-Max-Age', '600')
}

/** Someone's profile as `viewer` may see it: lists only where the owner allows (always for themselves). */
function profileFor(viewer: string, id: string) {
  const own = viewer === id
  const privacy = store.privacy(id)
  const following = store.following(id)
  const followers = store.followers(id)
  const friend = store.follows(viewer, id) && store.follows(id, viewer)
  return {
    person: store.person(id) ?? { id, name: '', imageTag: null },
    privacy: own ? privacy : { showPlaylists: privacy.showPlaylists },
    followingCount: following.length,
    followerCount: followers.length,
    following: own || privacy.showFollowing ? store.people(following) : null,
    followers: own || privacy.showFollowers ? store.people(followers) : null,
    followsYou: store.follows(id, viewer),
    youFollow: store.follows(viewer, id),
    friend,
    activity: own || (friend && privacy.shareActivity) ? store.activity(id) : null,
  }
}

const PRIVACY_KEYS = Object.keys(DEFAULT_PRIVACY) as Array<keyof Privacy>

// ---- the web app ----

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

/** A file of the built app; every other address gets index.html (the app routes itself). */
/** Whether the built app has a file at this path (not just its page, which every app address is). */
async function isAppFile(pathname: string) {
  if (pathname === '/' || pathname.endsWith('/')) return false
  const file = normalize(join(WEB_DIR, decodeURIComponent(pathname)))
  if (!file.startsWith(WEB_DIR + sep)) return false
  return stat(file).then((info) => info.isFile()).catch(() => false)
}

async function serveApp(request: IncomingMessage, response: ServerResponse, pathname: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405)
  const requested = normalize(join(WEB_DIR, decodeURIComponent(pathname)))
  // Never outside the app's folder.
  const inside = requested === WEB_DIR || requested.startsWith(WEB_DIR + sep)
  let file = inside ? requested : join(WEB_DIR, 'index.html')
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
  } catch {
    file = join(WEB_DIR, 'index.html')
  }
  try {
    const info = await stat(file)
    const hashed = pathname.startsWith('/assets/')
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // Built files carry a hash and never change; the page and the service worker are checked every time.
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      // Not to be framed by other sites (clicks steered over a hidden Lumio); addresses leave no paths behind elsewhere.
      'Content-Security-Policy': "frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    })
    if (request.method === 'HEAD') return response.end()
    createReadStream(file).pipe(response)
  } catch {
    send(response, 404, { error: 'The app is not built (run pnpm build) or WEB_DIR is wrong' })
  }
}

/**
 * GET /api/image?url=…: a podcast cover, fetched once and then kept on disk. Browsers get it from the app's own origin
 * (with CORS), so it is cached like the app's other pictures, works offline and can be drawn (drag images, colours).
 */
class ImageError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A picture from an allowed host, kept on disk (fetched the first time); throws an ImageError otherwise. */
async function keptImage(source: string | null): Promise<{ body: Buffer; type: string }> {
  let target: URL
  try {
    target = new URL(source ?? '')
  } catch {
    throw new ImageError(400, 'Bad url')
  }
  if (target.protocol !== 'https:' || !IMAGE_HOSTS.test(target.hostname)) throw new ImageError(403, 'Host not allowed')
  // Without query and fragment: anyone may ask (pictures load without a sign-in), and endless ?n=1, ?n=2… must not
  // each be kept.
  target.search = ''
  target.hash = ''
  const file = join(IMAGE_DIR, createHash('sha256').update(target.href).digest('hex'))
  try {
    const [body, type] = await Promise.all([readFile(file), readFile(`${file}.type`, 'utf8')])
    return { body, type }
  } catch {
    // Not kept yet.
  }
  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(15_000) })
    const type = upstream.headers.get('content-type') ?? ''
    if (!upstream.ok || !type.startsWith('image/')) throw new ImageError(502, 'Image unavailable')
    const body = await readLimited(upstream, IMAGE_LIMIT)
    if (!body) throw new ImageError(502, 'Image too large')
    await mkdir(IMAGE_DIR, { recursive: true })
    await Promise.all([writeFile(file, body), writeFile(`${file}.type`, type)])
    return { body, type }
  } catch (error) {
    throw error instanceof ImageError ? error : new ImageError(502, 'Image unavailable')
  }
}

/**
 * Headers for files from other sites served from Lumio's origin: never sniffed into something else, and opened on
 * their own (an SVG picture, an HTML "feed") they run in a sandbox without Lumio's storage, so they can't read tokens.
 */
const UNTRUSTED_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" }

/** A response's body, read only up to a limit (Content-Length can be missing or wrong); null when it is larger. */
async function readLimited(upstream: Response, limit: number): Promise<Buffer | null> {
  if (Number(upstream.headers.get('content-length') ?? 0) > limit) {
    await upstream.body?.cancel()
    return null
  }
  if (!upstream.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>)) {
    size += (chunk as Buffer).length
    if (size > limit) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function serveImage(response: ServerResponse, source: string | null) {
  return serveKept(response, () => keptImage(source))
}

async function serveKept(response: ServerResponse, load: () => Promise<{ body: Buffer; type: string }>) {
  try {
    const { body, type } = await load()
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      // The address names the picture; it never changes.
      'Cache-Control': 'public, max-age=2592000, immutable',
      'Access-Control-Allow-Origin': '*',
      ...UNTRUSTED_HEADERS,
    })
    response.end(body)
  } catch (error) {
    send(response, error instanceof ImageError ? error.status : 502, { error: error instanceof Error ? error.message : 'Image unavailable' })
  }
}

/** When each service may be called next. */
const nextSlot = new Map<string, number>()
/** How long a request waits for its turn at most: past that, the service is busy (no one can queue up hours). */
const RELAY_QUEUE_MS = 60_000
async function relaySlot(name: string, spacing: number) {
  const now = Date.now()
  const at = Math.max(now, nextSlot.get(name) ?? 0)
  if (at - now > RELAY_QUEUE_MS) throw new RelayError(429, 'Busy, try again later')
  nextSlot.set(name, at + spacing)
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now))
}

interface RelayEntry {
  at: number
  status: number
  type: string
  body: string
}

class RelayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A service's answer, from the cache while it is fresh (and when the service fails); throws a RelayError otherwise. */
async function relayGet(name: string, path: string, params: URLSearchParams): Promise<RelayEntry> {
  const service = RELAY_SERVICES[name]
  if (!service || !service.paths.test(path)) throw new RelayError(404, 'Unknown relay path')
  const key = service.key ? service.key.value || params.get(service.key.param) : undefined
  if (service.key && !key) throw new RelayError(503, `No ${name} key`)
  const query = new URLSearchParams([...params].filter(([param]) => param !== service.key?.param).sort(([a], [b]) => a.localeCompare(b)))
  const file = join(RELAY_DIR, name, createHash('sha256').update(`${path}?${query}`).digest('hex'))
  let cached: RelayEntry | null = null
  try {
    cached = JSON.parse(await readFile(file, 'utf8')) as RelayEntry
  } catch {
    // Not asked before.
  }
  const fresh = (entry: RelayEntry) => Date.now() - entry.at < (typeof service.ttl === 'number' ? service.ttl : service.ttl(entry.status, path, params))
  if (cached && fresh(cached)) return cached
  try {
    if (service.key && key) query.set(service.key.param, key)
    let upstream: Response
    // Turned away (too many calls, or the service is busy): everyone waits a little longer, then this is asked again.
    for (let attempt = 0; ; attempt++) {
      await relaySlot(name, service.spacing)
      upstream = await fetch(`${service.base}${path}?${query}`, { headers: service.headers, signal: AbortSignal.timeout(15_000) })
      if ((upstream.status !== 503 && upstream.status !== 429) || attempt >= 3) break
      nextSlot.set(name, Math.max(nextSlot.get(name) ?? 0, Date.now()) + 2_000 * (attempt + 1))
    }
    const entry: RelayEntry = { at: Date.now(), status: upstream.status, type: upstream.headers.get('content-type') ?? 'application/json', body: await upstream.text() }
    if (!(service.keep ?? ((status) => status < 400))(entry.status, entry.body)) {
      if (cached) return cached
      throw new RelayError(502, `${name} ${upstream.status}`)
    }
    await mkdir(join(RELAY_DIR, name), { recursive: true })
    await writeFile(file, JSON.stringify(entry))
    return entry
  } catch (error) {
    if (cached) return cached
    throw error instanceof RelayError ? error : new RelayError(502, `${name} unavailable`)
  }
}

/** GET /api/relay/<service>/<path>?…: a service's answer, from the cache while it is fresh. */
async function serveRelay(response: ServerResponse, name: string, path: string, params: URLSearchParams) {
  try {
    const entry = await relayGet(name, path, params)
    response.writeHead(entry.status, { 'Content-Type': entry.type, 'Cache-Control': 'private, max-age=3600' })
    response.end(entry.body)
  } catch (error) {
    send(response, error instanceof RelayError ? error.status : 502, { error: error instanceof Error ? error.message : 'Relay failed' })
  }
}

/**
 * GET /api/feed?url=…: a podcast's RSS feed, or a chapter list or transcript it points to. Most feeds don't let
 * browsers read them; through here they can, and are kept on disk for everyone (feeds 6 h, the files they point to,
 * which don't change, 30 days). Signed-in users only, https only, text only and size-limited.
 */
async function serveFeed(response: ServerResponse, source: string | null) {
  let target: URL
  try {
    target = new URL(source ?? '')
  } catch {
    return send(response, 400, { error: 'Bad url' })
  }
  if (target.protocol !== 'https:') return send(response, 403, { error: 'Only https' })
  target.hash = ''
  const file = join(RELAY_DIR, 'feeds', createHash('sha256').update(target.href).digest('hex'))
  let cached: RelayEntry | null = null
  try {
    cached = JSON.parse(await readFile(file, 'utf8')) as RelayEntry
  } catch {
    // Not asked before.
  }
  const reply = (entry: RelayEntry) => {
    response.writeHead(entry.status, { 'Content-Type': entry.type, 'Cache-Control': 'private, max-age=3600', ...UNTRUSTED_HEADERS })
    response.end(entry.body)
  }
  const ttl = (entry: RelayEntry) => (/xml|rss|atom/i.test(entry.type) ? 6 * HOUR : 30 * 24 * HOUR)
  if (cached && Date.now() - cached.at < ttl(cached)) return reply(cached)
  try {
    const upstream = await fetchPublic(target, 20_000, ['https:'])
    const type = upstream?.headers.get('content-type') ?? 'application/octet-stream'
    if (!upstream?.ok || !FEED_TYPES.test(type)) {
      await upstream?.body?.cancel()
      if (cached) return reply(cached)
      return send(response, upstream ? 502 : 403, { error: upstream ? 'Feed unavailable' : 'Not allowed' })
    }
    const body = await readLimited(upstream, FEED_LIMIT)
    if (!body) return send(response, 502, { error: 'Feed too large' })
    const entry: RelayEntry = { at: Date.now(), status: 200, type, body: body.toString('utf8') }
    await mkdir(join(RELAY_DIR, 'feeds'), { recursive: true })
    await writeFile(file, JSON.stringify(entry))
    reply(entry)
  } catch {
    if (cached) return reply(cached)
    send(response, 502, { error: 'Feed unavailable' })
  }
}

/** Whether an address is inside a private network (or this machine), which the audio relay never fetches from. */
async function isPrivateHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return true
  let addresses: string[]
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address)
  } catch {
    return true
  }
  return addresses.length === 0 || addresses.some(isPrivateAddress)
}

/**
 * Fetches an address of another site, following redirects itself so that each hop is checked: only the allowed
 * schemes, never into private networks (this server's own, the cloud's metadata address…). Null when not allowed.
 */
async function fetchPublic(target: URL, timeout: number, schemes = ['https:', 'http:']): Promise<Response | null> {
  // Podcast links usually go through a few tracking redirects.
  for (let hop = 0; hop < 8; hop++) {
    if (!schemes.includes(target.protocol) || (await isPrivateHost(target.hostname))) return null
    const answer = await fetch(target, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
    const next = answer.status >= 300 && answer.status < 400 ? answer.headers.get('location') : null
    if (!next) return answer
    await answer.body?.cancel()
    target = new URL(next, target)
  }
  return null
}

/** Largest podcast episode relayed (bytes). */
const EPISODE_LIMIT = 1024 * 1024 * 1024

/**
 * GET /api/podcast-audio?url=…: a podcast episode's audio file, passed through (not kept), for downloading it: most
 * podcast hosts don't let browsers read their files, and some still serve plain http. Signed-in users only, audio only,
 * size-limited, and never into private networks (each redirect is checked).
 */
async function servePodcastAudio(request: IncomingMessage, response: ServerResponse, source: string | null) {
  let target: URL
  try {
    target = new URL(source ?? '')
  } catch {
    return send(response, 400, { error: 'Bad url' })
  }
  try {
    const upstream = await fetchPublic(target, 30_000)
    if (!upstream) return send(response, 403, { error: 'Not allowed' })
    if (!upstream.ok || !upstream.body) return send(response, 502, { error: 'Episode unavailable' })
    const type = upstream.headers.get('content-type') ?? ''
    const length = Number(upstream.headers.get('content-length') ?? 0)
    if (!/^(audio\/|video\/mp4|application\/octet-stream)/i.test(type) || length > EPISODE_LIMIT) return send(response, 502, { error: 'Not an episode' })
    response.writeHead(200, { 'Content-Type': type, ...(length ? { 'Content-Length': String(length) } : {}), 'Cache-Control': 'private, no-store' })
    let sent = 0
    const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>)
    request.on('close', () => stream.destroy())
    for await (const chunk of stream) {
      sent += (chunk as Buffer).length
      if (sent > EPISODE_LIMIT) break
      response.write(chunk)
    }
    response.end()
  } catch {
    if (!response.headersSent) send(response, 502, { error: 'Episode unavailable' })
    else response.destroy()
  }
}

interface ArtistProfile {
  name: string
  description?: string
  image?: string
}

/**
 * GET /api/artist-profile/epidemic?name=…: an artist's profile on Epidemic Sound (description and photo), for artists
 * who publish there. Epidemic has no public API; its artist pages carry the profile as structured data (schema.org),
 * which is read and kept: asked again after 90 days (a miss after 14), and kept when the site fails. Only the artist's
 * page by name, nothing else.
 */
async function epidemicProfile(name: string | null): Promise<ArtistProfile | null> {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug || slug.length > 80) throw new RelayError(400, 'Bad name')
  const file = join(RELAY_DIR, 'epidemic', `${slug}.json`)
  let cached: { at: number; profile: ArtistProfile | null } | null = null
  try {
    cached = JSON.parse(await readFile(file, 'utf8')) as { at: number; profile: ArtistProfile | null }
  } catch {
    // Not asked before.
  }
  // Profiles change rarely: asked again after 90 days (a miss after 14); kept for good meanwhile.
  if (cached && Date.now() - cached.at < (cached.profile ? 90 : 14) * 24 * HOUR) return cached.profile
  try {
    await relaySlot('epidemic', 600)
    const page = await fetch(`https://www.epidemicsound.com/artists/${slug}/`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    })
    let profile: ArtistProfile | null = null
    if (page.ok) {
      const html = await page.text()
      // The page's schema.org data names the artist (a MusicGroup) and describes them.
      for (const match of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
          const data = JSON.parse(match[1]!) as { mainEntity?: { '@type'?: string; name?: string; description?: string } }
          const entity = data.mainEntity
          if (entity?.['@type'] === 'MusicGroup' && entity.name) profile = { name: entity.name, description: entity.description?.trim() || undefined }
        } catch {
          // Not this one.
        }
      }
      const image = html.match(/https:\/\/cdn\.epidemicsound\.com\/curation-assets\/artist-profile-images\/[0-9a-f-]+\/original\.jpg/)?.[0]
      if (profile && image) profile.image = image
    } else if (page.status !== 404) {
      // The site is down or blocks us: what was found before beats nothing.
      if (cached) return cached.profile
      throw new RelayError(502, 'Epidemic Sound unavailable')
    }
    // A page that no longer carries a profile (the site changed): keep the one found before.
    if (!profile && cached?.profile && page.ok) return cached.profile
    await mkdir(join(RELAY_DIR, 'epidemic'), { recursive: true })
    await writeFile(file, JSON.stringify({ at: Date.now(), profile }))
    return profile
  } catch (error) {
    if (cached) return cached.profile
    throw error instanceof RelayError ? error : new RelayError(502, 'Epidemic Sound unavailable')
  }
}

async function serveEpidemicProfile(response: ServerResponse, name: string | null) {
  try {
    const profile = await epidemicProfile(name)
    send(response, profile ? 200 : 404, profile ?? { error: 'Not on Epidemic Sound' })
  } catch (error) {
    send(response, error instanceof RelayError ? error.status : 502, { error: error instanceof Error ? error.message : 'Epidemic Sound unavailable' })
  }
}

// ---- track credits (MusicBrainz), looked up once per track and kept for everyone ----

/** A MusicBrainz call through the relay: the answer, null when MusicBrainz has nothing; throws when it can't answer. */
async function musicbrainz(path: string, query: Record<string, string>): Promise<unknown> {
  const entry = await relayGet('musicbrainz', path, new URLSearchParams({ ...query, fmt: 'json' }))
  return entry.status < 400 ? (JSON.parse(entry.body) as unknown) : null
}

/** Lookups under way, so a track asked for twice at once is looked up once. */
const creditLookups = new Map<string, Promise<TrackCredits | null>>()

/** A track's credits: stored, or looked up now (a miss is asked again after 30 days). Throws when MusicBrainz fails. */
async function creditsFor(id: string, meta: TrackMeta): Promise<TrackCredits | null> {
  const stored = store.trackCredits([id])[id]
  if (stored && (stored.data || Date.now() - stored.at < 30 * 24 * HOUR)) return stored.data as TrackCredits | null
  const running = creditLookups.get(id)
  if (running) return running
  const lookup = lookupCredits(meta, musicbrainz)
    .then((credits) => {
      store.setTrackCredits(id, credits, meta)
      return credits
    })
    .finally(() => creditLookups.delete(id))
  creditLookups.set(id, lookup)
  return lookup
}

type JobName = 'credits' | 'artists' | 'languages' | 'sound' | 'lyrics' | 'mix'

/** The administrators' tasks on the library, each running on its own (one run at a time). */
const jobs: Record<JobName, JobState & { stop?: boolean }> = {
  credits: { running: false, total: 0, done: 0, found: 0, failed: 0, failures: [] },
  artists: { running: false, total: 0, done: 0, found: 0, failed: 0, failures: [] },
  languages: { running: false, total: 0, done: 0, found: 0, failed: 0, failures: [] },
  sound: { running: false, total: 0, done: 0, found: 0, failed: 0, failures: [] },
  lyrics: { running: false, total: 0, done: 0, found: 0, failed: 0, failures: [] },
  mix: { running: false, total: 0, done: 0, found: 0, failed: 0, failures: [] },
}

/**
 * Everything of a kind in some libraries (all when none are named), read with an administrator's token; each entry
 * once, even when it is in several of them.
 */
async function libraryItems<T extends { Id: string }>(token: string, userId: string, path: string, query: Record<string, string>, libraries?: string[]): Promise<T[]> {
  const items = new Map<string, T>()
  for (const parent of libraries?.length ? libraries : [undefined]) {
    let read = 0
    for (let start = 0; ; start += 500) {
      const params = new URLSearchParams({ ...query, ...(parent ? { ParentId: parent } : {}), StartIndex: String(start), Limit: '500', EnableImages: 'false', EnableUserData: 'false' })
      const response = await fetch(`${JELLYFIN_URL}${path.replace('{user}', userId)}?${params}`, { headers: { Authorization: `MediaBrowser Token="${token}"` } })
      if (!response.ok) throw new Error(`Jellyfin ${response.status}`)
      const page = (await response.json()) as { Items?: T[]; TotalRecordCount?: number }
      for (const item of page.Items ?? []) items.set(item.Id, item)
      read += page.Items?.length ?? 0
      if (!page.Items?.length || read >= (page.TotalRecordCount ?? 0)) break
    }
  }
  return [...items.values()]
}

/**
 * Runs a task over a list: each entry once (once more after a pause when a service turned it away), counting what was
 * found, keeping what failed. The administrator's token is held only while it runs.
 */
async function runJob<T>(job: JobState & { stop?: boolean }, load: () => Promise<T[]>, each: (item: T) => Promise<boolean>, describe: (item: T) => Omit<Failure, 'error'>) {
  Object.assign(job, { running: true, stop: false, total: 0, done: 0, found: 0, failed: 0, failures: [], startedAt: Date.now(), finishedAt: undefined, error: undefined })
  try {
    const items = await load()
    job.total = items.length
    for (const item of items) {
      if (job.stop) break
      for (let attempt = 0; ; attempt++) {
        try {
          if (await each(item)) job.found++
          break
        } catch (error) {
          if (attempt < 1) {
            await new Promise((resolve) => setTimeout(resolve, 10_000))
            continue
          }
          const failure = { ...describe(item), error: error instanceof Error ? error.message : String(error) }
          console.warn(`${failure.title}${failure.artist ? ` (${failure.artist})` : ''}: ${failure.error}`)
          job.failures.push(failure)
          job.failed++
          break
        }
      }
      job.done++
    }
  } catch (error) {
    job.error = error instanceof Error ? error.message : 'Failed'
  } finally {
    job.running = false
    job.finishedAt = Date.now()
  }
}

type Track = { Id: string; Name?: string; Artists?: string[]; AlbumArtist?: string; Album?: string; AlbumId?: string; RunTimeTicks?: number; Genres?: string[] }
type Artist = { Id: string; Name?: string; ProviderIds?: Record<string, string>; Genres?: string[] }

/** What the tasks go through: some libraries (all when none are named), without some artists and genres. */
interface Scope {
  libraries?: string[]
  /** Artist names whose tracks (as artist or album artist) are left out. */
  artists: string[]
  genres: string[]
}

const NO_SCOPE: Scope = { artists: [], genres: [] }

/** Whether a track or artist is left out by the scope's artists or genres. */
function leftOut(scope: Scope, names: Array<string | undefined>, genres: string[] | undefined) {
  return names.some((name) => scope.artists.some((excluded) => sameName(excluded, name))) || (genres ?? []).some((genre) => scope.genres.some((excluded) => sameName(excluded, genre)))
}

const trackMeta = (track: Track): TrackMeta => ({
  title: track.Name!,
  artist: track.Artists?.[0] ?? track.AlbumArtist!,
  album: track.Album,
  albumId: track.AlbumId,
  seconds: track.RunTimeTicks ? track.RunTimeTicks / 10_000_000 : undefined,
})

/** Looks up the credits of every track that wasn't yet (about three seconds a track, at MusicBrainz's pace). */
function scanCredits(token: string, userId: string, scope: Scope = NO_SCOPE) {
  return runJob<Track>(
    jobs.credits,
    async () => {
      const tracks = await libraryItems<Track>(token, userId, '/Users/{user}/Items', { Recursive: 'true', IncludeItemTypes: 'Audio', Fields: 'Genres' }, scope.libraries)
      const known = store.trackCredits(tracks.map((track) => track.Id))
      return tracks.filter(
        (track) => !known[track.Id] && track.Name && (track.Artists?.[0] ?? track.AlbumArtist) && !leftOut(scope, [...(track.Artists ?? []), track.AlbumArtist], track.Genres),
      )
    },
    async (track) => !!(await creditsFor(track.Id, trackMeta(track))),
    (track) => ({ id: track.Id, title: track.Name ?? '', artist: track.Artists?.[0] ?? track.AlbumArtist ?? '', album: track.Album, albumId: track.AlbumId }),
  )
}

/**
 * Fetches everything the app shows about an artist into the caches, exactly as the app asks for it (so its next look is
 * answered at once): Last.fm's biography (German and English), top tracks and similar artists, the Epidemic Sound
 * profile, the Deezer photo, the MusicBrainz links, and the photos themselves. Each service on its own; what failed is
 * named in `failed`.
 */
async function precacheArtist(artist: Artist, lastfmKey: string | undefined): Promise<{ found: boolean; failed: string[] }> {
  const lastfm = async (params: Record<string, string>) => {
    const entry = await relayGet('lastfm', '', new URLSearchParams({ ...params, ...(lastfmKey ? { api_key: lastfmKey } : {}), format: 'json', autocorrect: '1' }))
    return entry.body ? (JSON.parse(entry.body) as { error?: number; artist?: { bio?: { content?: string } } }) : null
  }
    const name = artist.Name ?? ''
    if (!name) return { found: false, failed: [] }
    let found = false
    const failed: string[] = []
    // Each service on its own: one that fails doesn't keep the others from being fetched.
    const step = async (service: string, run: () => Promise<void>) => {
      try {
        await run()
      } catch (error) {
        failed.push(`${service}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const json = <T,>(entry: RelayEntry) => (entry.body ? (JSON.parse(entry.body) as T) : null)
    if (lastfmKey || process.env.LASTFM_API_KEY) {
      await step('Last.fm', async () => {
        const info = await lastfm({ method: 'artist.getinfo', artist: name, lang: 'de' })
        found ||= !!info?.artist?.bio?.content
        await lastfm({ method: 'artist.getinfo', artist: name, lang: 'en' })
        await lastfm({ method: 'artist.gettoptracks', artist: name, limit: '50' })
        await lastfm({ method: 'artist.getsimilar', artist: name, limit: '30' })
      })
    }
    await step('Epidemic Sound', async () => {
      const profile = await epidemicProfile(name)
      if (profile?.image) await keptImage(profile.image)
      found ||= !!profile?.description
    })
    await step('Deezer', async () => {
      const deezer = json<{ data?: Array<{ name: string; picture_xl?: string; picture_big?: string }> }>(
        await relayGet('deezer', 'search/artist', new URLSearchParams({ q: name, limit: '5' })),
      )
      const match = deezer?.data?.find((entry) => sameName(entry.name, name))
      const picture = match?.picture_xl ?? match?.picture_big
      if (picture && !picture.includes('/artist//')) await keptImage(picture)
    })
    await step('MusicBrainz', async () => {
      let id = artist.ProviderIds?.MusicBrainzArtist
      if (!id) {
        const search = json<{ artists?: Array<{ id: string; name: string; score: number }> }>(
          await relayGet('musicbrainz', 'artist', new URLSearchParams({ query: `artist:"${name}"`, fmt: 'json', limit: '3' })),
        )
        id = search?.artists?.find((entry) => entry.score >= 95 && sameName(entry.name, name))?.id
      }
      if (id) await relayGet('musicbrainz', `artist/${id}`, new URLSearchParams({ inc: 'url-rels', fmt: 'json' }))
    })
    return { found, failed }
}

/** Fetches every artist's information into the caches (see precacheArtist). */
function scanArtists(token: string, userId: string, lastfmKey: string | undefined, scope: Scope = NO_SCOPE) {
  return runJob<Artist>(
    jobs.artists,
    async () => (await libraryItems<Artist>(token, userId, '/Artists', { userId, Fields: 'ProviderIds,Genres' }, scope.libraries)).filter((artist) => !leftOut(scope, [artist.Name], artist.Genres)),
    async (artist) => {
      const { found, failed } = await precacheArtist(artist, lastfmKey)
      if (failed.length) throw new Error(failed.join(' · '))
      return found
    },
    (artist) => ({ id: artist.Id, title: artist.Name ?? '' }),
  )
}

// ---- what songs sound like, and their tags (see sound.ts), for the mood and tag mixes ----

const SOUND_FIELDS = 'Genres'

/** Last.fm through the relay (its answers kept), with the app's key when the server has none. */
function lastfmVia(lastfmKey: string | undefined) {
  return async (params: Record<string, string>) => {
    const entry = await relayGet('lastfm', '', new URLSearchParams({ ...params, ...(lastfmKey ? { api_key: lastfmKey } : {}), format: 'json', autocorrect: '1' }))
    return entry.body ? (JSON.parse(entry.body) as unknown) : null
  }
}

const canLastfm = (lastfmKey: string | undefined) => !!(lastfmKey || process.env.LASTFM_API_KEY)

/**
 * Measures a song and fetches its tags (and its artists' tags, once a month), then keeps them. Without Last.fm, only
 * the sound; Last.fm failing leaves the tags empty but keeps the measurement. Returns whether it could be measured.
 */
async function soundOf(token: string, track: SoundTrack, lastfmKey: string | undefined, known: Record<string, { at: number }>) {
  const features = await measureTrack(JELLYFIN_URL, token, track)
  let tags: string[] = []
  if (canLastfm(lastfmKey)) {
    const lastfm = lastfmVia(lastfmKey)
    tags = await trackTags(lastfm, track).catch(() => [])
    for (const artist of artistsOfTrack(track)) {
      if (known[artist.id] && Date.now() - known[artist.id]!.at < 30 * 24 * HOUR) continue
      const found = await artistTags(lastfm, artist.name).catch(() => null)
      if (found) {
        store.setArtistTags(artist.id, artist.name, found)
        known[artist.id] = { at: Date.now() }
      }
    }
  }
  store.setTrackSound(track.Id, features, tags)
  return !!features
}

/** Measures every song not measured yet (with this version of the analysis); a second or so each. */
function scanSound(token: string, userId: string, lastfmKey: string | undefined, scope: Scope = NO_SCOPE) {
  const known = store.artistTags()
  return runJob<SoundTrack & { Genres?: string[] }>(
    jobs.sound,
    async () => {
      const done = new Set(store.trackSounds().filter((entry) => !entry.data || (entry.data as { v?: number }).v === SOUND_VERSION).map((entry) => entry.id))
      const tracks = await libraryItems<SoundTrack & { Genres?: string[] }>(token, userId, '/Users/{user}/Items', { Recursive: 'true', IncludeItemTypes: 'Audio', Fields: SOUND_FIELDS }, scope.libraries)
      return tracks.filter((track) => !done.has(track.Id) && !leftOut(scope, [...(track.Artists ?? []), track.AlbumArtist], track.Genres))
    },
    (track) => soundOf(token, track, lastfmKey, known),
    (track) => ({ id: track.Id, title: track.Name ?? '', artist: track.Artists?.[0] ?? track.AlbumArtist ?? '' }),
  )
}

/**
 * Songs someone just played that weren't measured yet, done one after another in the background with their token (so
 * the library fills in by itself as people listen, without an administrator's run).
 */
const soundQueue = new Map<string, string>()
let soundRunning = false

function queueSound(id: string, token: string) {
  if (soundQueue.has(id) || jobs.sound.running || store.hasTrackSound(id)) return
  soundQueue.set(id, token)
  if (soundRunning) return
  soundRunning = true
  void (async () => {
    const known = store.artistTags()
    try {
      while (soundQueue.size) {
        const [next, nextToken] = soundQueue.entries().next().value as [string, string]
        soundQueue.delete(next)
        try {
          const person = tokens.get(nextToken)?.person
          if (!person || store.hasTrackSound(next)) continue
          const item = await fetch(`${JELLYFIN_URL}/Users/${person.id}/Items/${next}?${new URLSearchParams({ Fields: SOUND_FIELDS })}`, {
            headers: { Authorization: `MediaBrowser Token="${nextToken}"` },
          })
          if (!item.ok) continue
          await soundOf(nextToken, (await item.json()) as SoundTrack, undefined, known)
        } catch (error) {
          console.warn(`Sound of ${next}: ${error instanceof Error ? error.message : String(error)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } finally {
      soundRunning = false
    }
  })()
}

// ---- whole songs analysed for the mixer mode (see mix.ts, mix-analysis.ts) ----

/** A song that couldn't be analysed is tried again after a week (Jellyfin may have been away, the file replaced). */
const MIX_RETRY = 7 * 24 * HOUR
/** Songs being analysed right now (by the library run or the queue), by lower-case id, so none is done twice at once. */
const mixing = new Set<string>()
/**
 * Songs whose analysis failed for a passing reason (Jellyfin away, a timeout, the worker failing), by lower-case id,
 * with until when they aren't asked again (an hour), so the apps' asking doesn't retry them on every request.
 */
const mixBackoff = new Map<string, number>()
const MIX_BACKOFF = HOUR

/**
 * Analyses a song and keeps the result (null: it can't be, also when Jellyfin says the song can't be fetched at all).
 * Returns whether it could be analysed; throws on a passing failure (after noting it for the backoff).
 */
async function mixOf(token: string, track: MixTrack) {
  const id = track.Id.toLowerCase()
  if (mixing.has(id)) return false
  mixing.add(id)
  try {
    const mix = await analyzeTrack(JELLYFIN_URL, token, track, store.lyrics(id)?.data as Parameters<typeof analyzeTrack>[3])
    store.setTrackMix(id, mix)
    mixBackoff.delete(id)
    return !!mix
  } catch (error) {
    if (error instanceof JellyfinError && error.definitive) {
      store.setTrackMix(id, null)
      return false
    }
    if (mixBackoff.size > 10_000) mixBackoff.clear()
    mixBackoff.set(id, Date.now() + MIX_BACKOFF)
    throw error
  } finally {
    mixing.delete(id)
  }
}

/** Analyses every song not analysed yet (with this version of the analysis); a few seconds each. */
function scanMix(token: string, userId: string, scope: Scope = NO_SCOPE) {
  return runJob<MixTrack & { Genres?: string[] }>(
    jobs.mix,
    async () => {
      const done = store.currentTrackMixes(MIX_VERSION, MIX_RETRY)
      const tracks = await libraryItems<MixTrack & { Genres?: string[] }>(token, userId, '/Users/{user}/Items', { Recursive: 'true', IncludeItemTypes: 'Audio', Fields: 'Genres' }, scope.libraries)
      return tracks.filter((track) => !done.has(track.Id.toLowerCase()) && !leftOut(scope, [...(track.Artists ?? []), track.AlbumArtist], track.Genres))
    },
    (track) => (store.hasTrackMix(track.Id.toLowerCase(), MIX_VERSION, MIX_RETRY) ? Promise.resolve(true) : mixOf(token, track)),
    (track) => ({ id: track.Id, title: track.Name ?? '', artist: track.Artists?.[0] ?? track.AlbumArtist ?? '' }),
  )
}

/**
 * Songs the apps asked for (GET /music/mix) that aren't analysed yet, done one after another in the background with
 * the asker's token (a mixer-mode playlist fills in as it is played, without an administrator's run). Bounded, so a
 * flood of requests can't grow it without end; what didn't fit is asked for again by the apps later.
 */
const mixQueue = new Map<string, string>()
const MIX_QUEUE_MAX = 2000
let mixRunning = false

/** Queues a song (by lower-case id) unless it is queued, under way, backing off, or the queue is full. */
function queueMix(id: string, token: string) {
  if (mixQueue.has(id) || mixing.has(id) || (mixBackoff.get(id) ?? 0) > Date.now() || mixQueue.size >= MIX_QUEUE_MAX) return
  mixQueue.set(id, token)
  if (mixRunning) return
  mixRunning = true
  void (async () => {
    try {
      while (mixQueue.size) {
        const [next, nextToken] = mixQueue.entries().next().value as [string, string]
        mixQueue.delete(next)
        try {
          const person = tokens.get(nextToken)?.person
          if (!person || store.hasTrackMix(next, MIX_VERSION, MIX_RETRY)) continue
          const item = await fetch(`${JELLYFIN_URL}/Users/${person.id}/Items/${next}`, { headers: { Authorization: `MediaBrowser Token="${nextToken}"` }, signal: AbortSignal.timeout(15_000) })
          if (!item.ok) {
            // Not there for this person (or not at all): asked again only after the backoff.
            mixBackoff.set(next, Date.now() + MIX_BACKOFF)
            continue
          }
          const track = (await item.json()) as MixTrack & { Type?: string }
          if (track.Type !== 'Audio') {
            mixBackoff.set(next, Date.now() + MIX_BACKOFF)
            continue
          }
          await mixOf(nextToken, track)
        } catch (error) {
          mixBackoff.set(next, Date.now() + MIX_BACKOFF)
          console.warn(`Mix of ${next}: ${error instanceof Error ? error.message : String(error)}`)
        }
        // A breath between songs, for Jellyfin's transcoder and the other requests.
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } finally {
      mixRunning = false
    }
  })()
}

/**
 * What someone may do with a playlist, as Jellyfin decides it with their token: see it (it is a playlist they can
 * open), and edit it (they own it, or it is shared with them for editing). Only a playlist someone may see is
 * remembered, for a minute and for reading only: saving always asks Jellyfin afresh, and a Jellyfin error is never
 * taken for a no (it throws).
 */
const playlistAccess = new Map<string, { see: boolean; edit: boolean; until: number }>()

async function accessToPlaylist(token: string, userId: string, playlistId: string, fresh: boolean) {
  const key = `${token}|${playlistId}`
  const cached = playlistAccess.get(key)
  if (!fresh && cached && cached.until > Date.now()) return cached
  const headers = { Authorization: `MediaBrowser Token="${token}"` }
  const access = { see: false, edit: false, until: Date.now() + 60_000 }
  const item = await fetch(`${JELLYFIN_URL}/Users/${userId}/Items/${playlistId}?${new URLSearchParams({ Fields: 'CanDelete' })}`, { headers, signal: AbortSignal.timeout(15_000) })
  if (item.status >= 500) throw new Error(`Jellyfin ${item.status}`)
  if (item.ok) {
    const playlist = (await item.json()) as { Type?: string; CanDelete?: boolean }
    access.see = playlist.Type === 'Playlist'
    // Who may delete a playlist owns it (or administers the server); others edit it when it is shared with them so.
    if (access.see && playlist.CanDelete) access.edit = true
    else if (access.see) {
      const share = await fetch(`${JELLYFIN_URL}/Playlists/${playlistId}/Users/${userId}`, { headers, signal: AbortSignal.timeout(15_000) })
      if (share.status >= 500) throw new Error(`Jellyfin ${share.status}`)
      access.edit = share.ok && !!((await share.json()) as { CanEdit?: boolean }).CanEdit
    }
  }
  if (playlistAccess.size > 5000) playlistAccess.clear()
  if (access.see) playlistAccess.set(key, access)
  else playlistAccess.delete(key)
  return access
}

// ---- finding songs by their lyrics (see lyrics-search.ts) ----

/**
 * A song's lyrics as the app shows them: Jellyfin's (embedded, .lrc files, a lyrics plugin's), else what the server
 * kept from a source outside Jellyfin. Null when there are none.
 */
async function songLyrics(token: string, id: string): Promise<string[] | null> {
  const response = await fetch(`${JELLYFIN_URL}/Audio/${id}/Lyrics`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(15_000) })
  if (response.ok) {
    const lines = ((await response.json()) as { Lyrics?: Array<{ Text?: string | null }> }).Lyrics?.map((line) => line.Text ?? '') ?? []
    if (lines.some((line) => line.trim())) return lines
  } else if (response.status !== 404) throw new Error(`Jellyfin ${response.status}`)
  const kept = store.lyrics(id.toLowerCase())?.data as { lines?: Array<{ text?: string }> } | undefined
  const lines = kept?.lines?.map((line) => line.text ?? '') ?? []
  return lines.some((line) => line.trim()) ? lines : null
}

/** Puts every song's lyrics into the search index that isn't there yet (songs Jellyfin and the server have none for are skipped at once). */
function scanLyrics(token: string, userId: string, scope: Scope = NO_SCOPE) {
  type LyricsTrack = Track & { HasLyrics?: boolean }
  return runJob<LyricsTrack>(
    jobs.lyrics,
    async () => {
      if (!lyricsIndex) throw new Error('Meilisearch is not set up (MEILI_URL, MEILI_KEY)')
      await lyricsIndex.load()
      const kept = store.lyricsIndex()
      const tracks = await libraryItems<LyricsTrack>(token, userId, '/Users/{user}/Items', { Recursive: 'true', IncludeItemTypes: 'Audio', Fields: 'Genres' }, scope.libraries)
      // Jellyfin says which songs have lyrics (older versions don't: then each is asked).
      const knows = tracks.some((track) => track.HasLyrics !== undefined)
      return tracks.filter(
        (track) =>
          (!knows || track.HasLyrics || kept[track.Id.toLowerCase()]) && !lyricsIndex.has(track.Id) && !leftOut(scope, [...(track.Artists ?? []), track.AlbumArtist], track.Genres),
      )
    },
    async (track) => {
      const lines = await songLyrics(token, track.Id)
      if (lines) await lyricsIndex!.put([{ id: track.Id, lines }])
      return !!lines
    },
    (track) => ({ id: track.Id, title: track.Name ?? '', artist: track.Artists?.[0] ?? track.AlbumArtist ?? '' }),
  )
}

/** Songs someone played that aren't in the lyrics index yet, put in one after another with their token. */
const lyricsQueue = new Map<string, string>()
let lyricsRunning = false
/** When songs were last found without lyrics (asked again a day later, not on every play). */
const withoutLyrics = new Map<string, number>()

function queueLyrics(id: string, token: string) {
  if (!lyricsIndex || lyricsQueue.has(id) || jobs.lyrics.running || Date.now() - (withoutLyrics.get(id) ?? 0) < 24 * HOUR) return
  lyricsQueue.set(id, token)
  if (lyricsRunning) return
  lyricsRunning = true
  void (async () => {
    try {
      await lyricsIndex.load()
      while (lyricsQueue.size) {
        const [next, nextToken] = lyricsQueue.entries().next().value as [string, string]
        lyricsQueue.delete(next)
        if (lyricsIndex.has(next)) continue
        try {
          const lines = await songLyrics(nextToken, next)
          if (lines) await lyricsIndex.put([{ id: next, lines }])
          else withoutLyrics.set(next, Date.now())
        } catch (error) {
          console.warn(`Lyrics of ${next}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      console.warn(`Lyrics index: ${error instanceof Error ? error.message : String(error)}`)
      lyricsQueue.clear()
    } finally {
      lyricsRunning = false
    }
  })()
}

// ---- films and series in two languages (see languages.ts) ----

/** TMDb and Jellyfin as the language task reads them, with the caller's token (and the app's TMDb key, if it has one). */
function languageDeps(token: string, userId: string, tmdbKey: string | undefined): LanguageDeps {
  return {
    canTmdb: !!(RELAY_SERVICES.tmdb?.key?.value || tmdbKey),
    tmdb: async (path, params) => {
      const entry = await relayGet('tmdb', path, new URLSearchParams({ ...params, ...(tmdbKey ? { api_key: tmdbKey } : {}) }))
      return entry.status === 404 ? null : (JSON.parse(entry.body) as unknown)
    },
    jellyfin: async <T,>(path: string, query: Record<string, string>) => {
      const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, value.replace('{user}', userId)]))
      const response = await fetch(`${JELLYFIN_URL}${path.replace('{user}', userId)}?${params}`, { headers: { Authorization: `MediaBrowser Token="${token}"` } })
      if (!response.ok) throw new Error(`Jellyfin ${response.status}`)
      return (await response.json()) as T
    },
    get: (ids) => store.localized(ids),
    put: (id, data, meta) => store.setLocalized(id, data, meta),
  }
}

/** Fills in every film and series not done yet in both languages (a few TMDb calls per film, two per season). */
function scanLanguages(token: string, userId: string, tmdbKey: string | undefined, libraries: string[] | undefined) {
  const deps = languageDeps(token, userId, tmdbKey)
  return runJob<VideoItem>(
    jobs.languages,
    () => libraryItems<VideoItem>(token, userId, '/Users/{user}/Items', { Recursive: 'true', IncludeItemTypes: 'Movie,Series', Fields: 'Overview,Taglines,ProviderIds' }, libraries),
    async (title) => !!(await localizeTitle(title, deps, true)),
    (title) => ({ id: title.Id, title: title.Name ?? '' }),
  )
}

const titleLookups = new Map<string, Promise<boolean | null>>()

/** The film or series an item belongs to, filled in now if it wasn't (when someone opens it). */
async function lookupTitle(token: string, userId: string, itemId: string, tmdbKey: string | undefined) {
  const deps = languageDeps(token, userId, tmdbKey)
  const item = await deps.jellyfin<VideoItem>(`/Users/{user}/Items/${itemId}`, {})
  const title = item.Type === 'Movie' || item.Type === 'Series' ? item : item.SeriesId ? await deps.jellyfin<VideoItem>(`/Users/{user}/Items/${item.SeriesId}`, {}) : null
  if (!title) return null
  const running = titleLookups.get(title.Id)
  if (running) return running
  const lookup = localizeTitle(title, deps, true).finally(() => titleLookups.delete(title.Id))
  titleLookups.set(title.Id, lookup)
  return lookup
}

/** An item's entry, made from what Jellyfin says when there is none yet (for an administrator's first change). */
async function ensureLocalized(token: string, userId: string, id: string): Promise<{ data: Localized; meta: LocalizedMeta }> {
  const known = store.localized([id])[id]
  const meta = store.localizedMeta(id)
  if (known && meta) return { data: known, meta }
  const item = await languageDeps(token, userId, undefined).jellyfin<VideoItem>(`/Users/{user}/Items/${id}`, {})
  return {
    data: { label: detectLanguage(item.Overview), tmdb: {}, edited: {}, images: {} },
    meta: { name: item.Name ?? '', type: item.Type ?? '', series: item.SeriesName, year: item.ProductionYear },
  }
}

/**
 * What the app gets of an entry: texts, and the pictures to show per language, by when they changed (their address is
 * fixed, see /localized-image). An automatic picture only counts where Jellyfin's text, and so presumably its
 * pictures, are in the other language; an administrator's choice always does (null: Jellyfin's).
 */
function publicLocalized(entry: Localized) {
  const images: Partial<Record<Lang, Partial<Record<LocalImageKind, number | null>>>> = {}
  const otherLanguage = (lang: Lang) => isLang(entry.label) && entry.label !== lang
  for (const [lang, kinds] of Object.entries(entry.images) as Array<[Lang, Localized['images'][Lang]]>) {
    const shown = Object.entries(kinds ?? {}).filter(([, image]) => image === null || image?.manual || otherLanguage(lang))
    if (shown.length) images[lang] = Object.fromEntries(shown.map(([kind, image]) => [kind, image ? image.at : null]))
  }
  return { label: entry.label, tmdb: entry.tmdb, edited: entry.edited, images }
}

async function uploadedImage(name: string): Promise<{ body: Buffer; type: string }> {
  if (!/^[0-9a-f]{64}$/.test(name)) throw new ImageError(404, 'Not found')
  try {
    const file = join(UPLOAD_DIR, name)
    const [body, type] = await Promise.all([readFile(file), readFile(`${file}.type`, 'utf8')])
    return { body, type }
  } catch {
    throw new ImageError(404, 'Not found')
  }
}

const isLang = (value: unknown): value is Lang => LANGS.includes(value as Lang)
const isItemId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{32,36}$/i.test(value)
const isTmdbKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value)

/** Texts an administrator wrote, trimmed and bounded; empty fields are left out. */
function cleanTexts(value: unknown): Partial<Record<Lang, Texts>> {
  const result: Partial<Record<Lang, Texts>> = {}
  if (!value || typeof value !== 'object') return result
  for (const lang of LANGS) {
    const given = (value as Record<string, unknown>)[lang]
    if (!given || typeof given !== 'object') continue
    const field = (key: keyof Texts, max: number) => {
      const entry = (given as Record<string, unknown>)[key]
      return typeof entry === 'string' && entry.trim() ? entry.trim().slice(0, max) : undefined
    }
    const texts: Texts = {}
    for (const [key, max] of [['name', 300], ['tagline', 500], ['overview', 10_000]] as const) {
      const entry = field(key, max)
      if (entry) texts[key] = entry
    }
    if (Object.keys(texts).length) result[lang] = texts
  }
  return result
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  // Everything outside /api is the app.
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
    // In front of Jellyfin: what is Jellyfin's goes through to it, the rest is the app.
    if (PROXY_JELLYFIN && isJellyfinRequest(request, url.pathname, await isAppFile(url.pathname))) return proxyToJellyfin(JELLYFIN_URL, request, response, url)
    return serveApp(request, response, url.pathname)
  }

  cors(request, response)
  if (request.method === 'OPTIONS') return send(response, 204)
  const path = url.pathname.slice(4).replace(/\/+$/, '') || '/'
  if (path === '/health') return send(response, 200, { ok: true })
  // What the sign-in page needs before anyone is signed in: the SSO providers, and whether Lumio fronts Jellyfin.
  if (path === '/public' && request.method === 'GET') {
    // Which outside services this server has keys for: the app asks them through it then (it needs no keys of its own).
    const services = Object.fromEntries((['lastfm', 'concerts', 'tmdb'] as const).map((name) => [name, !!RELAY_SERVICES[name]?.key?.value]))
    return send(response, 200, { sso: SSO_PROVIDERS, proxy: PROXY_JELLYFIN, services, passwordLogin: !DISABLE_PASSWORD_LOGIN, lyricsSearch: !!lyricsIndex })
  }
  // Lumio's apps from the newest GitHub Release: the list (download dialog, update checks), and each file by its kind
  // (the browser is sent on to it, so a link here always gives the newest).
  if (path === '/apps' && request.method === 'GET') {
    const release = await latestApps()
    return release ? send(response, 200, release) : send(response, 502, { error: 'Releases unavailable' })
  }
  if (path.startsWith('/apps/download/') && request.method === 'GET') {
    const asset = (await latestApps())?.assets.find((entry) => entry.kind === path.slice('/apps/download/'.length))
    if (!asset) return send(response, 404, { error: 'No such app' })
    response.writeHead(302, { Location: asset.url, 'Cache-Control': 'no-store' })
    return response.end()
  }
  // Pictures load from <img> tags, which carry no token; the host list keeps this to podcast covers.
  if (path === '/image' && request.method === 'GET') return serveImage(response, url.searchParams.get('url'))
  // GET /localized-image/<item>/<lang>/<kind>: a film's or series' picture for one language (also from <img> tags, as
  // Jellyfin's own pictures are).
  const localImage = path.match(/^\/localized-image\/([0-9a-f-]{32,36})\/(de|en)\/(Primary|Logo|Thumb|Banner)$/)
  if (localImage && request.method === 'GET') {
    const image = store.localized([localImage[1]!])[localImage[1]!]?.images[localImage[2] as Lang]?.[localImage[3] as LocalImageKind]
    if (!image) return send(response, 404, { error: 'No picture' })
    return serveKept(response, () => (image.src.startsWith('upload:') ? uploadedImage(image.src.slice('upload:'.length)) : keptImage(image.src)))
  }

  // The separation worker (see stems.ts), with its own secret instead of a Jellyfin sign-in. GET
  // /music/stems/jobs/next?wait=<s>[&role=fallback]: the next job ({id, item, window}), waiting up to 30 s for one
  // (204: none); a fallback worker gets windows only, and nothing while a primary worker is around.
  // GET /music/stems/jobs/<id>/audio: the job's window as WAV (stereo, 44.1 kHz, 16-bit), streamed from Jellyfin here.
  // PUT /music/stems/jobs/<id>/<vocals|drums|bass|other>: one stem as FLAC. POST /music/stems/jobs/<id>/fail {error}.
  if (path.startsWith('/music/stems/jobs/')) {
    const worker = stemWorkers.authenticate(request.headers.authorization, request.socket.remoteAddress ?? 'unknown')
    if (worker === 'limited') return send(response, 429, { error: 'Too many failed sign-ins' })
    if (worker === 'denied') return send(response, 401, { error: 'Worker sign-in required' })
    // An added worker's role is the one it was added with; the shared (deprecated) secret says its own.
    const role = worker.id ? worker.role : url.searchParams.get('role') === 'fallback' ? 'fallback' : 'primary'
    if (path === '/music/stems/jobs/next' && request.method === 'GET') {
      const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0)) * 1000
      // A worker that hangs up while waiting must not be handed a job (it would sit leased for 20 minutes).
      const gone = new AbortController()
      response.on('close', () => !response.writableFinished && gone.abort())
      const job = await stems.next(wait, role, { id: worker.id, name: worker.name }, gone.signal)
      if (job && gone.signal.aborted) {
        stems.giveBack(job)
        return
      }
      return job ? send(response, 200, { id: job.id, item: job.item, window: job.window, stems: STEMS, role }) : send(response, 204)
    }
    const jobPath = path.match(/^\/music\/stems\/jobs\/([0-9a-f-]{36})\/(audio|fail|vocals|drums|bass|other)$/)
    const job = jobPath ? stems.job(jobPath[1]!) : null
    if (!jobPath || !job) return send(response, 404, { error: 'No such job' })
    const action = jobPath[2]!
    if (action === 'audio' && request.method === 'GET') {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5 * 60_000)
      try {
        const wav = await windowAudio(JELLYFIN_URL, job.token, job.item, job.window, controller.signal).catch(() => null)
        if (!wav) return send(response, 502, { error: 'Jellyfin gave no audio' })
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length })
        return response.end(wav)
      } finally {
        clearTimeout(timer)
      }
    }
    if (action === 'fail' && request.method === 'POST') {
      const body = await readJson<{ error?: unknown }>(request).catch(() => ({ error: undefined }))
      stems.fail(job, typeof body.error === 'string' ? body.error : 'Worker failed')
      return send(response, 204)
    }
    if (request.method === 'PUT' && (STEMS as readonly string[]).includes(action)) {
      if (role === 'primary') stems.seen('primary')
      const flac = await readBody(request, STEM_UPLOAD_LIMIT).catch(() => null)
      if (!flac) return send(response, 413, { error: 'Too large' })
      const received = await stems.receive(job, action as Stem, flac)
      if (received.done) stemWorkers.jobDone(worker)
      return received.error ? send(response, 400, { error: received.error }) : send(response, 204)
    }
    return send(response, 405, { error: 'Not allowed' })
  }

  const me = await authenticate(tokenOf(request, url))
  if (!me) return send(response, 401, { error: 'Not signed in' })

  // GET /artist-profile/epidemic?name=…: an artist's description and photo from Epidemic Sound.
  if (path === '/artist-profile/epidemic' && request.method === 'GET') return serveEpidemicProfile(response, url.searchParams.get('name'))

  // POST /credits {ids}: the credits known for these tracks (left out: not looked up yet; null: none found).
  if (path === '/credits' && request.method === 'POST') {
    const { ids } = await readJson<{ ids?: unknown }>(request).catch(() => ({ ids: undefined }))
    if (!Array.isArray(ids) || ids.length > 300 || !ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{32,36}$/i.test(id))) return send(response, 400, { error: 'Bad ids' })
    const known = store.trackCredits(ids as string[])
    return send(response, 200, Object.fromEntries(Object.entries(known).map(([id, entry]) => [id, entry.data])))
  }

  // POST /playlists/adds {playlistId, itemIds}: the user added these songs to a playlist (sent after Jellyfin took
  // them). GET /playlists/adds?playlistId=…: who added which song, for shared playlists.
  if (path === '/playlists/adds') {
    const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{32,36}$/i.test(value)
    if (request.method === 'POST') {
      const body = await readJson<{ playlistId?: unknown; itemIds?: unknown }>(request).catch(() => null)
      if (!isId(body?.playlistId) || !Array.isArray(body.itemIds) || body.itemIds.length > 400 || !body.itemIds.every(isId)) return send(response, 400, { error: 'Bad songs' })
      store.recordPlaylistAdds(body.playlistId, body.itemIds, me.id)
      return send(response, 204)
    }
    if (request.method === 'GET') {
      const playlistId = url.searchParams.get('playlistId')
      if (!isId(playlistId)) return send(response, 400, { error: 'Bad playlist' })
      return send(response, 200, store.playlistAdds(playlistId))
    }
  }

  // GET /credits/by-artist?name=…: the tracks someone is on (as an artist) or credited on (wrote, produced …), for
  // artists the library has no page for (guests the file tags leave out).
  if (path === '/credits/by-artist' && request.method === 'GET') {
    const name = (url.searchParams.get('name') ?? '').trim().slice(0, 200)
    if (!name) return send(response, 400, { error: 'Bad name' })
    const performed: string[] = []
    const credited: string[] = []
    for (const { id, data } of store.creditsMentioning(name)) {
      const credits = data as TrackCredits
      if (credits.artists?.some((entry) => sameName(entry, name))) performed.push(id)
      else if ([credits.writers, credits.composers, credits.lyricists, credits.producers, credits.mixers, credits.engineers].some((list) => list?.some((entry) => sameName(entry, name)))) {
        credited.push(id)
      }
    }
    return send(response, 200, { performed, credited })
  }

  // POST /credits/lookup {id, title, artist, album, seconds}: one track's credits, looked up now if they weren't.
  if (path === '/credits/lookup' && request.method === 'POST') {
    const body = await readJson<Partial<TrackMeta> & { id?: string }>(request).catch(() => null)
    if (!body || typeof body.id !== 'string' || !/^[0-9a-f-]{32,36}$/i.test(body.id) || typeof body.title !== 'string' || typeof body.artist !== 'string') {
      return send(response, 400, { error: 'Bad track' })
    }
    try {
      const credits = await creditsFor(body.id, {
        title: body.title.slice(0, 300),
        artist: body.artist.slice(0, 300),
        album: typeof body.album === 'string' ? body.album.slice(0, 300) : undefined,
        albumId: typeof body.albumId === 'string' && /^[0-9a-f-]{32,36}$/i.test(body.albumId) ? body.albumId : undefined,
        seconds: typeof body.seconds === 'number' ? body.seconds : undefined,
      })
      return send(response, 200, { credits })
    } catch {
      return send(response, 502, { error: 'MusicBrainz unavailable' })
    }
  }

  // POST /localized {ids}: films', series', seasons' and episodes' texts in both languages and which pictures differ
  // by language (left out: not filled in yet).
  if (path === '/localized' && request.method === 'POST') {
    const { ids } = await readJson<{ ids?: unknown }>(request).catch(() => ({ ids: undefined }))
    if (!Array.isArray(ids) || ids.length > 300 || !ids.every(isItemId)) return send(response, 400, { error: 'Bad ids' })
    return send(response, 200, Object.fromEntries(Object.entries(store.localized(ids)).map(([id, entry]) => [id, publicLocalized(entry)])))
  }

  // POST /localized/lookup {id, tmdbKey?}: the film or series of an item filled in now, if it wasn't.
  if (path === '/localized/lookup' && request.method === 'POST') {
    const body = await readJson<{ id?: unknown; tmdbKey?: unknown }>(request).catch(() => null)
    if (!isItemId(body?.id)) return send(response, 400, { error: 'Bad item' })
    try {
      await lookupTitle(tokenOf(request, url)!, me.id, body.id, isTmdbKey(body.tmdbKey) ? body.tmdbKey : undefined)
      const entry = store.localized([body.id])[body.id]
      return send(response, 200, { entry: entry ? publicLocalized(entry) : null })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Lookup failed' })
    }
  }

  // GET /admin/localized?label=…&search=…&offset=…: the entries for review (e.g. the unclear ones), with counts per label.
  if (path === '/admin/localized' && request.method === 'GET') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const label = url.searchParams.get('label')
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    const page = store.localizedPage(label === 'de' || label === 'en' || label === 'unclear' || label === 'none' ? label : null, (url.searchParams.get('search') ?? '').slice(0, 200).trim(), offset, 50)
    return send(response, 200, { ...page, counts: store.localizedCounts() })
  }

  // GET /admin/localized/<id>: an item's full entry. POST {label?, edited?, tmdbKey?}: an administrator's label (de,
  // en, or null to find it again) and texts (replacing the written ones; TMDb's stay). The other language is fetched
  // from TMDb right away when it wasn't yet (e.g. the task ran without a key).
  const localizedId = path.match(/^\/admin\/localized\/([0-9a-f-]{32,36})$/)?.[1]
  if (localizedId && (request.method === 'GET' || request.method === 'POST')) {
    const token = tokenOf(request, url)
    if (!isAdmin(token)) return send(response, 403, { error: 'Administrators only' })
    try {
      const { data, meta } = await ensureLocalized(token!, me.id, localizedId)
      if (request.method === 'GET') return send(response, 200, { ...publicLocalized(data), labelManual: !!data.labelManual, meta })
      const body = await readJson<{ label?: unknown; edited?: unknown; tmdbKey?: unknown }>(request, TEXT_BODY_LIMIT).catch(() => null)
      if (!body) return send(response, 400, { error: 'Bad body' })
      const next: Localized = { ...data }
      if (isLang(body.label)) Object.assign(next, { label: body.label, labelManual: true })
      else if (body.label === null) {
        const item = await languageDeps(token!, me.id, undefined).jellyfin<VideoItem>(`/Users/{user}/Items/${localizedId}`, {})
        next.label = detectLanguage(item.Overview)
        delete next.labelManual
      }
      if ('edited' in body) next.edited = cleanTexts(body.edited)
      store.setLocalized(localizedId, next, meta)
      // A failed lookup leaves the label saved; the task tries again.
      await lookupTitle(token!, me.id, localizedId, isTmdbKey(body.tmdbKey) ? body.tmdbKey : undefined).catch(() => null)
      const saved = store.localized([localizedId])[localizedId] ?? next
      return send(response, 200, { ...publicLocalized(saved), labelManual: !!saved.labelManual, meta })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Failed' })
    }
  }

  // /admin/localized-image/<id>/<lang>/<kind>: POST an image (its bytes, as image/…) or {url} (a provider's picture)
  // for one language; DELETE: Jellyfin's picture for that language (no automatic one either).
  const imageTarget = path.match(/^\/admin\/localized-image\/([0-9a-f-]{32,36})\/(de|en)\/(Primary|Logo|Thumb|Banner)$/)
  if (imageTarget && (request.method === 'POST' || request.method === 'DELETE')) {
    const token = tokenOf(request, url)
    if (!isAdmin(token)) return send(response, 403, { error: 'Administrators only' })
    const id = imageTarget[1]!
    const lang = imageTarget[2] as Lang
    const kind = imageTarget[3] as LocalImageKind
    try {
      const { data, meta } = await ensureLocalized(token!, me.id, id)
      let image: LocalImage | null = null
      if (request.method === 'POST') {
        const type = request.headers['content-type'] ?? ''
        if (type.startsWith('image/')) {
          const body = await readBody(request, IMAGE_LIMIT)
          const name = createHash('sha256').update(body).digest('hex')
          await mkdir(UPLOAD_DIR, { recursive: true })
          await Promise.all([writeFile(join(UPLOAD_DIR, name), body), writeFile(join(UPLOAD_DIR, `${name}.type`), type)])
          image = { src: `upload:${name}`, manual: true, at: Date.now() }
        } else {
          const given = await readJson<{ url?: unknown }>(request).catch(() => null)
          if (typeof given?.url !== 'string') return send(response, 400, { error: 'Bad picture' })
          // Fetched now: an address the relay won't serve is turned away at once.
          await keptImage(given.url)
          image = { src: given.url, manual: true, at: Date.now() }
        }
      }
      const next: Localized = { ...data, images: { ...data.images, [lang]: { ...data.images[lang], [kind]: image } } }
      store.setLocalized(id, next, meta)
      return send(response, 200, publicLocalized(next))
    } catch (error) {
      return send(response, error instanceof ImageError ? error.status : 502, { error: error instanceof Error ? error.message : 'Failed' })
    }
  }

  // /admin/jobs/<credits|artists|languages|sound|lyrics|mix>: an admin's task on the whole library (POST starts,
  // DELETE stops, GET tells how far it is): looking up every track's credits, fetching every artist's information into
  // the caches, filling in films and series in both languages, measuring every song's sound and fetching its tags,
  // putting every song's lyrics into the search index, or analysing every whole song for the mixer mode.
  const jobName = path.match(/^\/admin\/jobs\/(credits|artists|languages|sound|lyrics|mix)$/)?.[1] as JobName | undefined
  if (jobName) {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const job = jobs[jobName]
    if (request.method === 'POST' && !job.running) {
      const token = tokenOf(request, url)!
      // What to go through: an admin can leave libraries, artists and genres out (e.g. audio plays).
      type Body = { lastfmKey?: unknown; tmdbKey?: unknown; libraries?: unknown; excludeArtists?: unknown; excludeGenres?: unknown }
      const body = await readJson<Body>(request).catch(() => ({}) as Body)
      const texts = (value: unknown, pattern?: RegExp) =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && (!pattern || pattern.test(entry))).map((entry) => entry.slice(0, 200)).slice(0, 500) : []
      const scope: Scope = {
        libraries: Array.isArray(body.libraries) ? texts(body.libraries, /^[0-9a-f-]{32,36}$/i) : undefined,
        artists: texts(body.excludeArtists),
        genres: texts(body.excludeGenres),
      }
      if (jobName === 'credits') void scanCredits(token, me.id, scope)
      else if (jobName === 'lyrics') void scanLyrics(token, me.id, scope)
      else if (jobName === 'mix') void scanMix(token, me.id, scope)
      else if (jobName === 'languages') void scanLanguages(token, me.id, isTmdbKey(body.tmdbKey) ? body.tmdbKey : undefined, scope.libraries)
      else {
        const lastfmKey = typeof body.lastfmKey === 'string' && /^[0-9a-f]{32}$/i.test(body.lastfmKey) ? body.lastfmKey : undefined
        if (jobName === 'sound') void scanSound(token, me.id, lastfmKey, scope)
        else void scanArtists(token, me.id, lastfmKey, scope)
      }
    }
    if (request.method === 'DELETE') job.stop = true
    const { stop: _stop, ...state } = job
    return send(response, 200, state)
  }

  // POST /admin/credits/search {title, artist}: recordings on MusicBrainz to pick from by hand.
  if (path === '/admin/credits/search' && request.method === 'POST') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const body = await readJson<{ title?: unknown; artist?: unknown }>(request).catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.slice(0, 300).trim() : ''
    const artist = typeof body?.artist === 'string' ? body.artist.slice(0, 300).trim() : ''
    if (!title && !artist) return send(response, 400, { error: 'Nothing to search for' })
    try {
      return send(response, 200, await searchRecordings(title, artist, musicbrainz))
    } catch {
      return send(response, 502, { error: 'MusicBrainz unavailable' })
    }
  }

  // POST /admin/credits/fix {id, meta, recording?}: a track looked up again now, or given the recording an admin picked.
  if (path === '/admin/credits/fix' && request.method === 'POST') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const body = await readJson<{ id?: unknown; recording?: unknown; meta?: Partial<TrackMeta> }>(request).catch(() => null)
    const id = typeof body?.id === 'string' && /^[0-9a-f-]{32,36}$/i.test(body.id) ? body.id : null
    const meta = body?.meta
    if (!id || typeof meta?.title !== 'string' || typeof meta.artist !== 'string') return send(response, 400, { error: 'Bad track' })
    const clean: TrackMeta = {
      title: meta.title.slice(0, 300),
      artist: meta.artist.slice(0, 300),
      album: typeof meta.album === 'string' ? meta.album.slice(0, 300) : undefined,
      albumId: typeof meta.albumId === 'string' && /^[0-9a-f-]{32,36}$/i.test(meta.albumId) ? meta.albumId : undefined,
      seconds: typeof meta.seconds === 'number' ? meta.seconds : undefined,
    }
    const recording = typeof body?.recording === 'string' && /^[0-9a-f-]{36}$/i.test(body.recording) ? body.recording : null
    try {
      const credits = recording ? await creditsOfRecording(recording, clean.album, musicbrainz) : await lookupCredits(clean, musicbrainz)
      store.setTrackCredits(id, credits, { ...clean, ...(recording ? { picked: true } : {}) })
      jobs.credits.failures = jobs.credits.failures.filter((failure) => failure.id !== id)
      return send(response, 200, { credits })
    } catch {
      return send(response, 502, { error: 'MusicBrainz unavailable' })
    }
  }

  // POST /admin/artists/fix {id, name, musicBrainzId?, lastfmKey?}: one artist's information fetched again now.
  if (path === '/admin/artists/fix' && request.method === 'POST') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const body = await readJson<{ id?: unknown; name?: unknown; musicBrainzId?: unknown; lastfmKey?: unknown }>(request).catch(() => null)
    if (typeof body?.id !== 'string' || typeof body.name !== 'string' || !body.name.trim()) return send(response, 400, { error: 'Bad artist' })
    const artist: Artist = {
      Id: body.id,
      Name: body.name.slice(0, 300),
      ProviderIds: typeof body.musicBrainzId === 'string' && /^[0-9a-f-]{36}$/i.test(body.musicBrainzId) ? { MusicBrainzArtist: body.musicBrainzId } : {},
    }
    const result = await precacheArtist(artist, typeof body.lastfmKey === 'string' && /^[0-9a-f]{32}$/i.test(body.lastfmKey) ? body.lastfmKey : undefined)
    if (!result.failed.length) jobs.artists.failures = jobs.artists.failures.filter((failure) => failure.id !== body.id)
    return send(response, 200, result)
  }

  // GET /admin/credits?search=…&offset=…: the looked-up tracks, for browsing.
  if (path === '/admin/credits' && request.method === 'GET') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
    return send(response, 200, store.creditsPage((url.searchParams.get('search') ?? '').slice(0, 200).trim(), offset, 50))
  }

  // POST /admin/credits/edit {id, meta, credits}: credits an admin wrote by hand (kept; no lookup replaces them).
  if (path === '/admin/credits/edit' && request.method === 'POST') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const body = await readJson<{ id?: unknown; meta?: Record<string, unknown>; credits?: Record<string, unknown> }>(request).catch(() => null)
    const id = typeof body?.id === 'string' && /^[0-9a-f-]{32,36}$/i.test(body.id) ? body.id : null
    if (!id || !body?.credits || typeof body.credits !== 'object') return send(response, 400, { error: 'Bad credits' })
    const names = (value: unknown) =>
      Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === 'string').map((name) => name.trim().slice(0, 200)).filter(Boolean))].slice(0, 50) : []
    const given = body.credits
    const credits: TrackCredits = {
      recording: typeof given.recording === 'string' ? given.recording.slice(0, 36) : '',
      artists: names(given.artists),
      writers: names(given.writers),
      composers: names(given.composers),
      lyricists: names(given.lyricists),
      producers: names(given.producers),
      mixers: names(given.mixers),
      engineers: names(given.engineers),
      publishers: names(given.publishers),
      labels: names(given.labels),
      isrc: typeof given.isrc === 'string' && given.isrc.trim() ? given.isrc.trim().slice(0, 15) : undefined,
    }
    const meta = body.meta ?? {}
    const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 300) : undefined)
    store.setTrackCredits(id, credits, { title: text(meta.title), artist: text(meta.artist), album: text(meta.album), albumId: text(meta.albumId), edited: true })
    jobs.credits.failures = jobs.credits.failures.filter((failure) => failure.id !== id)
    return send(response, 200, { credits })
  }

  // GET /admin/credits-missing: the tracks MusicBrainz had nothing for.
  if (path === '/admin/credits-missing' && request.method === 'GET') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    return send(response, 200, store.tracksWithoutCredits())
  }

  // GET /podcast-audio?url=…: a podcast episode's audio, passed through for downloading it.
  if (path === '/podcast-audio' && request.method === 'GET') return servePodcastAudio(request, response, url.searchParams.get('url'))

  // GET /feed?url=…: podcast feeds and the files they point to.
  if (path === '/feed' && request.method === 'GET') return serveFeed(response, url.searchParams.get('url'))

  // GET /relay/<service>/…: outside services, relayed and cached (for signed-in users only, as it may use the server's
  // keys). /concerts/… is the older address of the Ticketmaster relay.
  if (request.method === 'GET' && (path.startsWith('/relay/') || path.startsWith('/concerts/'))) {
    const [name = '', ...rest] = path.startsWith('/concerts/') ? ['concerts', path.slice('/concerts/'.length)] : path.slice('/relay/'.length).split(/\/(.*)/s)
    return serveRelay(response, name, rest.join(''), url.searchParams)
  }

  // GET /me: the user's own follows and privacy.
  if (path === '/me' && request.method === 'GET') {
    return send(response, 200, { ...profileFor(me.id, me.id), friends: store.people(store.friends(me.id)) })
  }

  // GET /me/settings: the user's settings that follow the account (theme of the player, subtitles, concert location …).
  if (path === '/me/settings' && request.method === 'GET') return send(response, 200, store.settings(me.id))

  // PATCH /me/settings { key: value | null }: changes some; the user's other devices hear of it at once.
  if (path === '/me/settings' && request.method === 'PATCH') {
    const patch = await readJson<Record<string, unknown>>(request)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return send(response, 400, { error: 'Expected an object' })
    const settings = store.updateSettings(me.id, patch)
    push(me.id, 'settings', settings)
    return send(response, 200, settings)
  }

  // PUT /me/privacy
  if (path === '/me/privacy' && request.method === 'PUT') {
    const body = await readJson<Partial<Privacy>>(request)
    const change = Object.fromEntries(PRIVACY_KEYS.filter((key) => typeof body[key] === 'boolean').map((key) => [key, body[key]]))
    const privacy = store.setPrivacy(me.id, change)
    if (!privacy.shareActivity) for (const friend of store.friends(me.id)) push(friend, 'activity', { user: me, activity: null })
    return send(response, 200, privacy)
  }

  // POST /me/follows/import { ids }: follows kept by Lumio before the server existed.
  if (path === '/me/follows/import' && request.method === 'POST') {
    const { ids = [] } = await readJson<{ ids?: string[] }>(request)
    for (const id of ids.slice(0, 500)) if (typeof id === 'string' && /^[0-9a-f-]{32,36}$/i.test(id)) store.follow(me.id, id)
    return send(response, 204)
  }

  // PUT/DELETE /follows/:id
  const follow = path.match(/^\/follows\/([0-9a-f-]{32,36})$/i)
  if (follow && (request.method === 'PUT' || request.method === 'DELETE')) {
    const target = follow[1]!
    if (request.method === 'PUT') {
      store.follow(me.id, target)
      push(target, 'follow', { user: me })
    } else store.unfollow(me.id, target)
    return send(response, 200, profileFor(me.id, target))
  }

  // GET /users/:id
  const user = path.match(/^\/users\/([0-9a-f-]{32,36})$/i)
  if (user && request.method === 'GET') return send(response, 200, profileFor(me.id, user[1]!))

  // POST /me/plays {session, kind, key, title, subtitle, contextId, image, client, startedAt, seconds, source,
  // reasonStart, reasonEnd, shuffle, offline, bufferingMs}: a listening session, sent while it plays. Podcasts (which
  // Jellyfin never sees) are counted here; for songs Jellyfin counts the play and Lumio keeps how it went; videos
  // (kind "video") are films and episodes watched offline, which Jellyfin's Playback Reporting never saw.
  // GET /me/plays?limit=&before=: their plays, newest first.
  if (path === '/me/plays') {
    if (request.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(request).catch(() => null)
      const text = (value: unknown, max = 300) => (typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined)
      const session = text(body?.session, 64)
      const key = text(body?.key, 500)
      const title = text(body?.title)
      const startedAt = Number(body?.startedAt)
      const seconds = Math.round(Number(body?.seconds))
      if (!session || !key || !title || !Number.isFinite(startedAt) || !Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 3600) return send(response, 400, { error: 'Bad play' })
      const reason = (value: unknown) => (typeof value === 'string' && /^[a-z]{2,20}$/.test(value) ? value : undefined)
      store.recordPlay({
        session,
        userId: me.id,
        kind: body?.kind === 'audio' || body?.kind === 'video' ? body.kind : 'podcast',
        key,
        title,
        subtitle: text(body?.subtitle),
        contextId: text(body?.contextId, 100),
        image: text(body?.image, 1000),
        client: text(body?.client, 100),
        startedAt: Math.min(startedAt, Date.now()),
        seconds,
        source: text(body?.source, 200),
        reasonStart: reason(body?.reasonStart),
        reasonEnd: reason(body?.reasonEnd),
        shuffle: typeof body?.shuffle === 'boolean' ? body.shuffle : undefined,
        offline: typeof body?.offline === 'boolean' ? body.offline : undefined,
        bufferingMs: Number.isFinite(Number(body?.bufferingMs)) ? Math.max(0, Math.round(Number(body?.bufferingMs))) : undefined,
        artist: text(body?.artist),
        album: text(body?.album),
      })
      // A song not measured yet is measured now, in the background (for the mood mixes).
      if (body?.kind === 'audio' && /^[0-9a-f]{32}$/i.test(key)) {
        queueSound(key, tokenOf(request, url)!)
        // And its lyrics go into the search index.
        queueLyrics(key, tokenOf(request, url)!)
      }
      return send(response, 204)
    }
    if (request.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const before = Number(url.searchParams.get('before')) || undefined
      return send(response, 200, store.plays(me.id, limit, before))
    }
  }

  // GET /me/taste?tz=: the person's listening per song (plays now and over time, skips, times of day), which the app
  // builds its mixes and radios from. Made at most every two minutes.
  if (path === '/me/taste' && request.method === 'GET') {
    const timeZone = validTimeZone(url.searchParams.get('tz'))
    const key = `${me.id}|${timeZone}`
    const cached = tasteCache.get(key)
    if (cached && Date.now() - cached.at < 2 * 60_000) return send(response, 200, cached)
    const signals = tasteSignals(store, me.id, timeZone)
    tasteCache.set(key, signals)
    return send(response, 200, signals)
  }

  // GET /music/sound: every measured song's sound (an array: bpm, pulse, key, minor 0/1, key clarity, loudness,
  // dynamics, brightness, onsets; null when it couldn't be measured) and Last.fm tags, and every artist's tags.
  if (path === '/music/sound' && request.method === 'GET') {
    type Features = { bpm: number; pulse: number; key: number; minor: boolean; keyClarity: number; loudness: number; dynamics: number; brightness: number; onsets: number }
    const tracks: Record<string, [number[] | null, string[]]> = {}
    for (const entry of store.trackSounds()) {
      const f = entry.data as Features | null
      tracks[entry.id] = [f ? [f.bpm, f.pulse, f.key, f.minor ? 1 : 0, f.keyClarity, f.loudness, f.dynamics, f.brightness, f.onsets] : null, entry.tags]
    }
    const artists = Object.fromEntries(Object.entries(store.artistTags()).map(([id, entry]) => [id, entry.tags]))
    return send(response, 200, { tracks, artists })
  }

  // GET /music/mix?ids=a,b,c: the whole-track analyses of up to 200 songs ({id: TrackMix | null}, see mix-analysis.ts).
  // null: not analysed yet (it is now queued, with the asker's token) or it can't be (too long, silent). With
  // summary=1 only {bpm, bpmConfidence, key, minor, keyClarity, duration} per song (for lists; the whole analysis is
  // some 50 KB a song), queued alike.
  if (path === '/music/mix' && request.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
    if (!ids.length || ids.length > 200 || !ids.every((id) => /^[0-9a-f]{32}$/i.test(id))) return send(response, 400, { error: 'Bad ids' })
    // Kept and queued by lower-case id; answered by the ids as asked.
    const known = store.trackMixes(ids.map((id) => id.toLowerCase()), url.searchParams.get('summary') === '1')
    const token = tokenOf(request, url)!
    const entries = ids.map((id) => {
      const entry = known[id.toLowerCase()]
      const current = entry?.json && entry.version === MIX_VERSION
      if (!current && !(entry && !entry.json && Date.now() - entry.at < MIX_RETRY)) queueMix(id.toLowerCase(), token)
      // The kept JSON as it is (it is large: no parsing and writing again).
      return `${JSON.stringify(id)}:${current ? entry.json : 'null'}`
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    return response.end(`{${entries.join(',')}}`)
  }

  // GET /music/mixer/<playlistId>: a playlist's mixer settings and transitions (PlaylistMixer; off and empty when never
  // saved), for anyone who can see the playlist. PUT: saves them, for its owner and those it is shared with for editing.
  // Once settings are kept, a PUT must name the `updated` it started from; an older one (or none) is turned down with
  // 409 and the kept settings: someone else saved in between. Transitions that don't pass the checks are left out
  // (their pairs get automatic ones); the answer says how many in `dropped`.
  const mixer = path.match(/^\/music\/mixer\/([0-9a-f]{32})$/i)
  if (mixer && (request.method === 'GET' || request.method === 'PUT')) {
    const playlistId = mixer[1]!.toLowerCase()
    const token = tokenOf(request, url)!
    let access: { see: boolean; edit: boolean }
    try {
      access = await accessToPlaylist(token, me.id, playlistId, request.method === 'PUT')
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Jellyfin unavailable' })
    }
    if (!access.see) return send(response, 404, { error: 'No such playlist' })
    const kept = () => {
      const stored = store.playlistMixer(playlistId)
      return { stored, current: stored ? { ...(stored.data as object), updated: stored.updated } : { on: false, style: 'clean', transitions: {}, updated: 0 } }
    }
    if (request.method === 'GET') return send(response, 200, kept().current)
    if (!access.edit) return send(response, 403, { error: 'Only those who may edit the playlist' })
    const body = await readJson<Record<string, unknown>>(request, MIXER_BODY_LIMIT).catch(() => null)
    // The baked clips the transitions name, read first (the check itself doesn't wait).
    const clips = new Map<string, BakedMeta>()
    const transitions = body && typeof body.transitions === 'object' && body.transitions ? Object.values(body.transitions as Record<string, unknown>) : []
    for (const entry of transitions.slice(0, 1000)) {
      const key = (entry as { baked?: { key?: unknown } } | null)?.baked?.key
      if (typeof key === 'string' && isBakedKey(key) && !clips.has(key)) {
        const meta = await bakedClips.meta(key)
        if (meta && meta.playlistId === playlistId) clips.set(key, meta)
      }
    }
    const lookup: BakedLookup = (key) => clips.get(key) ?? null
    const parsed = parsePlaylistMixer(body, lookup)
    if (!parsed) return send(response, 400, { error: 'Bad mixer settings' })
    // Read again now that the body is in (another save may have landed meanwhile); from here on nothing waits.
    const { stored, current } = kept()
    if (stored && (typeof body?.updated !== 'number' || body.updated < stored.updated)) return send(response, 409, current)
    if (parsed.dropped) console.warn(`Mixer of ${playlistId}: ${parsed.dropped} transition(s) left out`)
    const updated = Math.max(Date.now(), (stored?.updated ?? 0) + 1)
    store.setPlaylistMixer(playlistId, parsed.settings, me.id, updated)
    return send(response, 200, { ...parsed.settings, updated, dropped: parsed.dropped })
  }

  // Baked transitions (see baked.ts). PUT /music/mix/baked/<key> {playlistId, from, to, start, length, engine}: describes a
  // clip (replacing an earlier one and its parts), for those who may edit the playlist; then PUT …?part=a|b with the
  // part as WAV (stereo, at most 48 kHz and 120 s). GET …?part=a|b&quality=original|<kbps>: the part as kept (24-bit
  // FLAC) or as AAC at about that bitrate, for those who can see the playlist. DELETE: frees the clip (editors).
  const baked = path.match(/^\/music\/mix\/baked\/([0-9a-f]{32})$/)
  if (baked && ['GET', 'PUT', 'DELETE'].includes(request.method ?? '')) {
    const key = baked[1]!
    const part = url.searchParams.get('part')
    if (part !== null && part !== 'a' && part !== 'b') return send(response, 400, { error: 'part is a or b' })
    const token = tokenOf(request, url)!
    const existing = await bakedClips.meta(key)
    if (request.method === 'PUT' && part === null) {
      const body = await readJson<Record<string, unknown>>(request, 16_384).catch(() => null)
      const playlistId = typeof body?.playlistId === 'string' ? body.playlistId.toLowerCase() : ''
      if (!/^[0-9a-f]{32}$/.test(playlistId)) return send(response, 400, { error: 'Bad playlistId' })
      try {
        if (!(await accessToPlaylist(token, me.id, playlistId, true)).edit) return send(response, 403, { error: 'Only those who may edit the playlist' })
        if (existing && existing.playlistId !== playlistId && !(await accessToPlaylist(token, me.id, existing.playlistId, true)).edit) return send(response, 403, { error: 'The clip belongs to another playlist' })
      } catch (error) {
        return send(response, 502, { error: error instanceof Error ? error.message : 'Jellyfin unavailable' })
      }
      const meta = await bakedClips.putMeta(key, body, me.id)
      return typeof meta === 'string' ? send(response, 400, { error: meta }) : send(response, 200, meta)
    }
    if (!existing) return send(response, 404, { error: 'No such clip' })
    let access: { see: boolean; edit: boolean }
    try {
      access = await accessToPlaylist(token, me.id, existing.playlistId, request.method !== 'GET')
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Jellyfin unavailable' })
    }
    if (!access.see) return send(response, 404, { error: 'No such clip' })
    if (request.method === 'GET') {
      if (part === null) return send(response, 200, existing)
      const file = await bakedClips.file(key, part, url.searchParams.get('quality') ?? 'original').catch((error) => {
        console.warn(`Baked clip ${key}:`, error)
        return null
      })
      return file ? serveFile(response, file) : send(response, 404, { error: 'No such part' })
    }
    if (!access.edit) return send(response, 403, { error: 'Only those who may edit the playlist' })
    if (request.method === 'DELETE') {
      await bakedClips.remove(key)
      return send(response, 204)
    }
    if (part === null) return send(response, 400, { error: 'part is a or b' })
    const wav = await readBody(request, BAKED_PART_LIMIT).catch(() => null)
    if (!wav) return send(response, 413, { error: 'Too large' })
    try {
      const failed = await bakedClips.putPart(key, part, wav)
      return failed ? send(response, 400, { error: failed }) : send(response, 204)
    } catch (error) {
      console.warn(`Baked clip ${key}:`, error)
      return send(response, 500, { error: 'Could not keep the part' })
    }
  }

  // Stems ("Mix-Modus", see stems.ts). POST /music/stems/preheat {playlistId, items: [{id, windows?: [{start, end}]}]}:
  // asks for the songs' stems (whole songs without windows; windows up to 300 s), held for the playlist, for those who
  // may edit it ({queued, ready}; 503 when no worker is configured). POST /music/stems/release {playlistId}: lets go of
  // them (deleted unless another playlist holds them). GET /music/stems/status?ids=…: per song its windows' state.
  // GET /music/stems/<item>/<window>/<stem>: one stem as FLAC, for those who can see the song.
  if ((path === '/music/stems/preheat' || path === '/music/stems/release') && request.method === 'POST') {
    const body = await readJson<{ playlistId?: unknown; items?: unknown }>(request, 262_144).catch(() => null)
    const playlistId = typeof body?.playlistId === 'string' ? body.playlistId.toLowerCase() : ''
    if (!/^[0-9a-f]{32}$/.test(playlistId)) return send(response, 400, { error: 'Bad playlistId' })
    const token = tokenOf(request, url)!
    try {
      if (!(await accessToPlaylist(token, me.id, playlistId, true)).edit) return send(response, 403, { error: 'Only those who may edit the playlist' })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Jellyfin unavailable' })
    }
    if (path === '/music/stems/release') return send(response, 200, await stems.release(playlistId))
    if (!stemWorkers.enabled()) return send(response, 503, { error: 'No stem worker configured' })
    const items = Array.isArray(body?.items) ? body.items : null
    if (!items || items.length > 400) return send(response, 400, { error: 'Bad items' })
    const wanted: Array<{ item: string; window: StemWindow }> = []
    for (const entry of items as Array<{ id?: unknown; windows?: unknown }>) {
      const item = typeof entry?.id === 'string' ? entry.id.toLowerCase() : ''
      if (!/^[0-9a-f]{32}$/.test(item)) return send(response, 400, { error: 'Bad item id' })
      const windows = entry.windows === undefined ? [{ start: 0, end: 0 }] : entry.windows
      if (!Array.isArray(windows) || windows.length > 8) return send(response, 400, { error: 'Bad windows' })
      for (const value of windows as Array<{ start?: unknown; end?: unknown }>) {
        const window = windowOf(Number(value?.start), Number(value?.end))
        if (!window) return send(response, 400, { error: 'Bad window' })
        wanted.push({ item, window })
      }
    }
    return send(response, 200, await stems.preheat(playlistId, token, wanted))
  }
  if (path === '/music/stems/status' && request.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '').toLowerCase().split(',').filter(Boolean)
    if (!ids.length || ids.length > 400 || !ids.every((id) => /^[0-9a-f]{32}$/.test(id))) return send(response, 400, { error: 'Bad ids' })
    return send(response, 200, await stems.status(ids))
  }
  const stemFile = path.match(/^\/music\/stems\/([0-9a-f]{32})\/(whole|\d{1,7}-\d{1,7})\/(vocals|drums|bass|other)$/i)
  if (stemFile && request.method === 'GET') {
    const item = stemFile[1]!.toLowerCase()
    if (!(await canSeeItem(tokenOf(request, url)!, me.id, item))) return send(response, 404, { error: 'No such song' })
    const file = await stems.file(item, stemFile[2]!, stemFile[3]!)
    return file ? serveFile(response, file) : send(response, 404, { error: 'No such stem' })
  }

  // Stem workers, for administrators (see stem-workers.ts). GET /admin/stem-workers: {url, workers} (with each one's
  // current jobs). PUT /admin/stem-workers/config {url}: the address put into join keys. POST /admin/stem-workers
  // {name, role}: adds a worker and answers its join key, the only time it is shown. POST
  // /admin/stem-workers/<id>/revoke and DELETE /admin/stem-workers/<id>: cut it off (its jobs go back to the queue).
  if (path.startsWith('/admin/stem-workers')) {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    if (path === '/admin/stem-workers' && request.method === 'GET') {
      const workers = stemWorkers.list().map(({ secretHash: _hash, ...worker }) => ({ ...worker, jobs: stems.heldBy(worker.id).map((job) => ({ item: job.item, window: job.window })) }))
      return send(response, 200, { url: stemWorkers.url(), workers })
    }
    if (path === '/admin/stem-workers/config' && request.method === 'PUT') {
      const body = await readJson<{ url?: unknown }>(request).catch(() => null)
      const failed = typeof body?.url === 'string' ? stemWorkers.setUrl(body.url) : 'url missing'
      return failed ? send(response, 400, { error: failed }) : send(response, 200, { url: stemWorkers.url() })
    }
    if (path === '/admin/stem-workers' && request.method === 'POST') {
      const body = await readJson<{ name?: unknown; role?: unknown }>(request).catch(() => null)
      const role = body?.role === 'fallback' ? 'fallback' : body?.role === 'primary' ? 'primary' : null
      if (typeof body?.name !== 'string' || !role) return send(response, 400, { error: 'name and role (primary or fallback) needed' })
      const added = stemWorkers.add(body.name, role, me.id)
      if (typeof added === 'string') return send(response, 400, { error: added })
      const { secretHash: _hash, ...worker } = added.worker
      return send(response, 200, { worker, joinKey: added.joinKey })
    }
    const one = path.match(/^\/admin\/stem-workers\/([0-9a-f]{16})(\/revoke)?$/)
    if (one && ((one[2] && request.method === 'POST') || (!one[2] && request.method === 'DELETE'))) {
      const done = one[2] ? stemWorkers.revoke(one[1]!) : stemWorkers.remove(one[1]!)
      if (!done) return send(response, 404, { error: 'No such worker' })
      stems.dropWorker(one[1]!)
      return send(response, 204)
    }
    return send(response, 404, { error: 'Not found' })
  }

  // POST /music/mix/training {playlistId, pair, …}: one transition someone saved in the editor, kept as training data
  // for the planner (what it started from, the result, the edit, versions; the app decides the fields, at most 256 KB),
  // for those who may edit the playlist. GET /admin/mix/training?after=<id>&limit=<n>: the kept rows as JSON lines,
  // oldest first (administrators).
  if (path === '/music/mix/training' && request.method === 'POST') {
    const body = await readJson<Record<string, unknown>>(request, 262_144).catch(() => null)
    const playlistId = typeof body?.playlistId === 'string' ? body.playlistId.toLowerCase() : ''
    const pair = typeof body?.pair === 'string' ? body.pair : ''
    if (!/^[0-9a-f]{32}$/.test(playlistId) || !/^[0-9a-f-]{32,36}>[0-9a-f-]{32,36}$/i.test(pair)) return send(response, 400, { error: 'Bad playlistId or pair' })
    try {
      if (!(await accessToPlaylist(tokenOf(request, url)!, me.id, playlistId, true)).edit) return send(response, 403, { error: 'Only those who may edit the playlist' })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Jellyfin unavailable' })
    }
    store.addMixTraining(me.id, playlistId, pair, body)
    return send(response, 204)
  }
  if (path === '/admin/mix/training' && request.method === 'GET') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0)
    const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get('limit')) || 1000))
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    return response.end(store.mixTraining(after, limit).map((row) => JSON.stringify(row)).join('\n') + '\n')
  }

  // GET /music/lyrics-search?q=…: songs whose lyrics have these words ({items, snippets: {id: lines around the match}}),
  // only those the person may see (Jellyfin is asked for them with their token). 404 when the search is off.
  if (path === '/music/lyrics-search' && request.method === 'GET') {
    if (!lyricsIndex) return send(response, 404, { error: 'Lyrics search is off' })
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
    if (query.length < 3) return send(response, 200, { items: [], snippets: {} })
    try {
      const hits = await lyricsIndex.search(query, 30)
      if (!hits.length) return send(response, 200, { items: [], snippets: {} })
      const params = new URLSearchParams({ Ids: hits.map((hit) => hit.id).join(','), Fields: 'PrimaryImageAspectRatio', EnableUserData: 'true' })
      const found = await fetch(`${JELLYFIN_URL}/Users/${me.id}/Items?${params}`, { headers: { Authorization: `MediaBrowser Token="${tokenOf(request, url)}"` }, signal: AbortSignal.timeout(15_000) })
      if (!found.ok) return send(response, 502, { error: `Jellyfin ${found.status}` })
      const byId = new Map((((await found.json()) as { Items?: Array<{ Id: string }> }).Items ?? []).map((item) => [item.Id, item]))
      // In Meilisearch's order (the best match first).
      const visible = hits.filter((hit) => byId.has(hit.id))
      return send(response, 200, { items: visible.map((hit) => byId.get(hit.id)), snippets: Object.fromEntries(visible.map((hit) => [hit.id, hit.snippet])) })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Failed' })
    }
  }

  // GET /admin/lyrics: every track with kept lyrics ({id: {synced, source}}), for tools that fill the gaps.
  if (path === '/admin/lyrics' && request.method === 'GET') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    return send(response, 200, store.lyricsIndex())
  }

  // GET /music/lyrics/:id: a track's lyrics as a source outside Jellyfin (lrclib, a plugin's) gave them once.
  // PUT /music/lyrics/:id {lines: [{time?, text}], synced, source, sourceName?}: kept for everyone. Anyone may fill a
  // gap or turn plain lyrics into synced ones; only administrators replace what is there. DELETE: see below.
  const lyrics = path.match(/^\/music\/lyrics\/([0-9a-f-]{32,36})$/i)
  if (lyrics) {
    const id = lyrics[1]!.toLowerCase()
    const stored = store.lyrics(id)
    if (request.method === 'GET') return stored ? send(response, 200, { ...(stored.data as object), source: stored.source }) : send(response, 404, { error: 'No lyrics' })
    // DELETE: administrators take wrong lyrics out again (the apps then look them up anew).
    if (request.method === 'DELETE') {
      if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
      store.deleteLyrics(id)
      return send(response, 204)
    }
    if (request.method === 'PUT') {
      const body = await readJson<{ lines?: unknown; synced?: unknown; source?: unknown; sourceName?: unknown }>(request, LYRICS_BODY_LIMIT).catch(() => null)
      const source = typeof body?.source === 'string' && /^[a-z0-9][a-z0-9_.-]{0,59}$/i.test(body.source) ? body.source : null
      if (!source || !Array.isArray(body?.lines) || !body.lines.length || body.lines.length > 2000) return send(response, 400, { error: 'Bad lyrics' })
      const lines = (body.lines as Array<{ time?: unknown; text?: unknown }>).map((line) => ({
        ...(typeof line?.time === 'number' && Number.isFinite(line.time) && line.time >= 0 ? { time: line.time } : {}),
        text: typeof line?.text === 'string' ? line.text.slice(0, 500) : '',
      }))
      const synced = body.synced === true && lines.some((line) => line.time !== undefined)
      const upgrade = !!stored && synced && !(stored.data as { synced?: boolean }).synced
      if (stored && !upgrade && !isAdmin(tokenOf(request, url))) return send(response, 409, { error: 'Lyrics are kept already' })
      const sourceName = typeof body?.sourceName === 'string' && body.sourceName.trim() ? body.sourceName.trim().slice(0, 60) : undefined
      store.setLyrics(id, { lines, synced, ...(sourceName ? { sourceName } : {}) }, source)
      // Searchable at once.
      void lyricsIndex?.put([{ id, lines: lines.map((line) => line.text) }]).catch((error: unknown) => console.warn(`Lyrics index: ${error instanceof Error ? error.message : String(error)}`))
      return send(response, 204)
    }
  }

  // POST /me/imports/:source {plays: [...]}: a part of the person's listening history from another service (Spotify),
  // read from its export by the app, which also found the songs in the library. Imported again, nothing doubles.
  // GET /me/imports/:source: how much was brought in. DELETE /me/imports/:source: takes it all out again.
  const imports = path.match(/^\/me\/imports\/([a-z]+)$/)
  if (imports) {
    const source = imports[1]!
    if (!IMPORT_SOURCES.has(source)) return send(response, 404, { error: 'Unknown service' })
    if (request.method === 'GET') return send(response, 200, store.importedSummary(me.id, source))
    if (request.method === 'DELETE') {
      store.deleteImported(me.id, source)
      return send(response, 204)
    }
    if (request.method === 'POST') {
      const body = await readJson<{ plays?: unknown }>(request, IMPORT_BODY_LIMIT).catch(() => null)
      if (!Array.isArray(body?.plays) || body.plays.length > IMPORT_BATCH) return send(response, 400, { error: 'Bad import' })
      const text = (value: unknown, max = 300) => (typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined)
      const reason = (value: unknown) => (typeof value === 'string' && /^[a-z]{2,20}$/.test(value) ? value : undefined)
      const plays: ImportedPlay[] = []
      for (const raw of body.plays as Array<Record<string, unknown>>) {
        const id = text(raw?.id, 120)
        const key = text(raw?.key, 200)
        const title = text(raw?.title)
        const startedAt = Number(raw?.startedAt)
        const seconds = Math.round(Number(raw?.seconds))
        if (!id || !key || !title || !Number.isFinite(startedAt) || startedAt > Date.now() || !Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) continue
        plays.push({
          // The same play imported again (same time and track) keeps its session.
          session: `import:${source}:${createHash('sha1').update(`${me.id}|${id}`).digest('hex')}`,
          kind: raw.kind === 'podcast' ? 'podcast' : 'audio',
          key,
          title,
          subtitle: text(raw.subtitle),
          artist: text(raw.artist),
          album: text(raw.album),
          contextId: text(raw.contextId, 100),
          client: text(raw.client, 100) ?? source,
          startedAt,
          seconds,
          reasonStart: reason(raw.reasonStart),
          reasonEnd: reason(raw.reasonEnd),
          shuffle: typeof raw.shuffle === 'boolean' ? raw.shuffle : undefined,
          offline: typeof raw.offline === 'boolean' ? raw.offline : undefined,
        })
      }
      store.importPlays(me.id, source, plays)
      return send(response, 200, { imported: plays.length })
    }
  }

  // GET /me/wrapped?tz=: the years whose Wrapped is ready (the running one from 12 December on).
  // GET /me/wrapped/:year?tz=: that year's Wrapped (404 when there was nothing, 403 before it is ready).
  if (path === '/me/wrapped' && request.method === 'GET') {
    return send(response, 200, { years: wrappedYears(store, me.id, new Date(), validTimeZone(url.searchParams.get('tz'))) })
  }
  const wrappedYear = path.match(/^\/me\/wrapped\/(\d{4})$/)
  if (wrappedYear && request.method === 'GET') {
    const year = Number(wrappedYear[1])
    const timeZone = validTimeZone(url.searchParams.get('tz'))
    if (!wrappedReady(year, new Date(), timeZone)) return send(response, 403, { error: 'Not yet' })
    const wrapped = wrappedFor(store, me.id, year, timeZone)
    return wrapped ? send(response, 200, wrapped) : send(response, 404, { error: 'Nothing played that year' })
  }

  // GET /admin/plays?from=&to=: everyone's plays in a time span (ms), with who played them.
  if (path === '/admin/plays' && request.method === 'GET') {
    if (!isAdmin(tokenOf(request, url))) return send(response, 403, { error: 'Administrators only' })
    const to = Number(url.searchParams.get('to')) || Date.now()
    const from = Number(url.searchParams.get('from')) || to - 30 * 24 * HOUR
    const plays = store.playsBetween(from, to)
    const people = Object.fromEntries(store.people([...new Set(plays.map((play) => play.userId))]).map((person) => [person.id, person.name]))
    return send(response, 200, plays.map((play) => ({ ...play, userName: people[play.userId] ?? '' })))
  }

  // GET /friends/activity: what friends play (those who share it), newest first.
  if (path === '/friends/activity' && request.method === 'GET') {
    const list = store
      .friends(me.id)
      .filter((id) => store.privacy(id).shareActivity)
      .map((id) => ({ user: store.person(id), activity: store.activity(id) }))
      .filter((entry) => entry.user && entry.activity)
      .sort((a, b) => b.activity!.at - a.activity!.at)
    return send(response, 200, list)
  }

  // POST /me/activity: what the user plays now (or null when they stop).
  if (path === '/me/activity' && request.method === 'POST') {
    const body = await readJson<Partial<Activity> | null>(request)
    if (!body?.itemId) {
      const last = store.activity(me.id)
      if (last) store.setActivity(me.id, { ...last, playing: false, at: Date.now() })
    } else {
      store.setActivity(me.id, {
        itemId: String(body.itemId).slice(0, 64),
        name: String(body.name ?? '').slice(0, 300),
        subtitle: body.subtitle ? String(body.subtitle).slice(0, 300) : undefined,
        context: body.context ? String(body.context).slice(0, 300) : undefined,
        contextId: body.contextId ? String(body.contextId).slice(0, 64) : undefined,
        kind: body.kind === 'video' ? 'video' : 'audio',
        playing: body.playing !== false,
        at: Date.now(),
      })
    }
    announceActivity(me.id)
    return send(response, 204)
  }

  // GET /events?token=…: live updates (friends' activity, new followers).
  if (path === '/events' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    response.write(': connected\n\n')
    const set = streams.get(me.id) ?? new Set()
    set.add(response)
    streams.set(me.id, set)
    // A comment now and then keeps proxies from closing a quiet connection.
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000)
    request.on('close', () => {
      clearInterval(keepAlive)
      set.delete(response)
    })
    return
  }

  send(response, 404, { error: 'Not found' })
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    console.error(error)
    if (!response.headersSent) send(response, 500, { error: 'Server error' })
    else response.end()
  })
})
// Jellyfin's WebSockets (live updates, remote control) go through too when Lumio fronts it.
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (PROXY_JELLYFIN && !pathname.startsWith('/api/')) proxyUpgrade(JELLYFIN_URL, request, socket as Socket, head)
  else socket.destroy()
})
server.listen(PORT, () => console.log(`Lumio on :${PORT} (app from ${WEB_DIR}), Jellyfin at ${JELLYFIN_URL}${PROXY_JELLYFIN ? ' (proxied)' : ''}`))
