import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Label, Localized, LocalizedMeta } from './languages.ts'

/**
 * What the Lumio server keeps (SQLite, one file): the people who used it (name and picture tag as Jellyfin reported
 * them, so others can see who they are), who follows whom, each person's privacy choices, what they last played, and
 * their Lumio settings that follow the account (the app decides which; the server keeps them as one JSON object),
 * the credits looked up for the library's tracks (see credits.ts), lyrics found outside Jellyfin, and films' and series' texts and pictures in both
 * languages (see languages.ts), shared by everyone.
 */
export interface Privacy {
  /** Others see the person's public playlists on their profile. */
  showPlaylists: boolean
  /** Others see whom the person follows. */
  showFollowing: boolean
  /** Others see who follows the person. */
  showFollowers: boolean
  /** Friends (people who follow each other) see what the person plays. */
  shareActivity: boolean
}

export const DEFAULT_PRIVACY: Privacy = { showPlaylists: true, showFollowing: true, showFollowers: true, shareActivity: true }

export interface Person {
  id: string
  name: string
  imageTag: string | null
}

export interface Activity {
  itemId: string
  name: string
  /** Artists (music) or the series (an episode). */
  subtitle?: string
  /** Album or season, with its id for a link. */
  context?: string
  contextId?: string
  kind: 'audio' | 'video'
  /** Still playing (false once paused or stopped). */
  playing: boolean
  /** When this was reported (ms). */
  at: number
}

export interface Play {
  session: string
  userId: string
  /** A podcast episode (Jellyfin never sees those), or a song (Jellyfin counts it; Lumio keeps how the play went). */
  kind: 'podcast' | 'audio' | 'video'
  /** The episode's feed GUID, or the song's Jellyfin id. */
  key: string
  title: string
  /** The podcast's name, or the song's artists. */
  subtitle?: string
  /** The podcast's id, or the album's. */
  contextId?: string
  image?: string
  client?: string
  startedAt: number
  seconds: number
  /** Where it was played from: `album:<id>`, `playlist:<id>`, `official:<slug>`, `liked`, `queue` (the user's), `autoplay` … */
  source?: string
  /** Why it started: clickrow, playbtn, fwdbtn, backbtn, trackdone, trackerror, remote, appload. */
  reasonStart?: string
  /** Why it ended: trackdone, fwdbtn, backbtn, clickrow, playbtn, remote, trackerror, endplay, logout. */
  reasonEnd?: string
  shuffle?: boolean
  /** Played from the device (downloaded or cached), not streamed. */
  offline?: boolean
  /** How long it waited for data while playing. */
  bufferingMs?: number
  /** A song's main artist and its album's name (for Wrapped; older plays only have `subtitle`). */
  artist?: string
  album?: string
}

/** A play from another service's history (`source` is `import:<service>`), handed in by the person. */
export interface ImportedPlay {
  session: string
  kind: 'podcast' | 'audio'
  key: string
  title: string
  subtitle?: string
  artist?: string
  album?: string
  contextId?: string
  client: string
  startedAt: number
  seconds: number
  reasonStart?: string
  reasonEnd?: string
  shuffle?: boolean
  offline?: boolean
}

/** What Wrapped reads of a play. */
export interface WrappedRow {
  kind: string
  key: string
  title: string
  subtitle: string | null
  artist: string | null
  album: string | null
  contextId: string | null
  startedAt: number
  seconds: number
  imported: boolean
}

/**
 * Plays brought in from another service belong to the person's own listening (Wrapped), but not to the administrators'
 * statistics, nor to the list of podcast episodes heard (they have no page here).
 */
const NOT_IMPORTED = "(source IS NULL OR source NOT LIKE 'import:%')"

function playOf(row: Record<string, string | number | null>): Play {
  return {
    session: String(row.session),
    userId: String(row.user_id),
    kind: row.kind === 'audio' ? 'audio' : row.kind === 'video' ? 'video' : 'podcast',
    key: String(row.item_key),
    title: String(row.title),
    subtitle: row.subtitle === null ? undefined : String(row.subtitle),
    contextId: row.context_id === null ? undefined : String(row.context_id),
    image: row.image === null ? undefined : String(row.image),
    client: row.client === null ? undefined : String(row.client),
    startedAt: Number(row.started_at),
    seconds: Number(row.seconds),
    source: row.source === null || row.source === undefined ? undefined : String(row.source),
    reasonStart: row.reason_start === null || row.reason_start === undefined ? undefined : String(row.reason_start),
    reasonEnd: row.reason_end === null || row.reason_end === undefined ? undefined : String(row.reason_end),
    shuffle: row.shuffle === null || row.shuffle === undefined ? undefined : !!row.shuffle,
    offline: row.offline === null || row.offline === undefined ? undefined : !!row.offline,
    bufferingMs: row.buffering_ms === null || row.buffering_ms === undefined ? undefined : Number(row.buffering_ms),
    artist: row.artist === null || row.artist === undefined ? undefined : String(row.artist),
    album: row.album === null || row.album === undefined ? undefined : String(row.album),
  }
}

export class Store {
  private db: DatabaseSync

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'lumio.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, image_tag TEXT, privacy TEXT, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS follows (follower TEXT NOT NULL, followee TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (follower, followee));
      CREATE INDEX IF NOT EXISTS follows_followee ON follows (followee);
      CREATE TABLE IF NOT EXISTS activity (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS track_credits (item_id TEXT PRIMARY KEY, data TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plays (session TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT, context_id TEXT, image TEXT, client TEXT, started_at INTEGER NOT NULL, seconds INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS plays_user_started ON plays (user_id, started_at);
      CREATE INDEX IF NOT EXISTS plays_started ON plays (started_at);
      CREATE TABLE IF NOT EXISTS localized (item_id TEXT PRIMARY KEY, label TEXT NOT NULL, data TEXT NOT NULL, meta TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS localized_label ON localized (label);
      CREATE TABLE IF NOT EXISTS track_sound (item_id TEXT PRIMARY KEY, data TEXT, tags TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artist_tags (artist_id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lyrics (item_id TEXT PRIMARY KEY, data TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS playlist_adds (playlist_id TEXT NOT NULL, item_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (playlist_id, item_id));
    `)
    // How a play went (music too): why it started and ended, where it came from, shuffle, from the device, buffering.
    const playColumns = (this.db.prepare('PRAGMA table_info(plays)').all() as Array<{ name: string }>).map((column) => column.name)
    for (const [name, type] of [['source', 'TEXT'], ['reason_start', 'TEXT'], ['reason_end', 'TEXT'], ['shuffle', 'INTEGER'], ['offline', 'INTEGER'], ['buffering_ms', 'INTEGER'], ['artist', 'TEXT'], ['album', 'TEXT']]) {
      if (!playColumns.includes(name!)) this.db.exec(`ALTER TABLE plays ADD COLUMN ${name} ${type}`)
    }
    // What the track was (title, artist, album), so a list of misses can name them.
    const columns = this.db.prepare('PRAGMA table_info(track_credits)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'meta')) this.db.exec('ALTER TABLE track_credits ADD COLUMN meta TEXT')
  }

  /** Remembers who someone is (on every sign-in, so names and pictures stay current). */
  upsertPerson(person: Person) {
    this.db
      .prepare('INSERT INTO users (id, name, image_tag, seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, image_tag = excluded.image_tag, seen = excluded.seen')
      .run(person.id, person.name, person.imageTag, Date.now())
  }

  person(id: string): Person | null {
    const row = this.db.prepare('SELECT id, name, image_tag FROM users WHERE id = ?').get(id) as { id: string; name: string; image_tag: string | null } | undefined
    return row ? { id: row.id, name: row.name, imageTag: row.image_tag } : null
  }

  people(ids: string[]): Person[] {
    return ids.map((id) => this.person(id) ?? { id, name: '', imageTag: null })
  }

  privacy(id: string): Privacy {
    const row = this.db.prepare('SELECT privacy FROM users WHERE id = ?').get(id) as { privacy: string | null } | undefined
    return { ...DEFAULT_PRIVACY, ...(row?.privacy ? (JSON.parse(row.privacy) as Partial<Privacy>) : {}) }
  }

  setPrivacy(id: string, privacy: Partial<Privacy>) {
    const next = { ...this.privacy(id), ...privacy }
    this.db.prepare('UPDATE users SET privacy = ? WHERE id = ?').run(JSON.stringify(next), id)
    return next
  }

  follow(follower: string, followee: string) {
    if (follower === followee) return
    this.db.prepare('INSERT OR IGNORE INTO follows (follower, followee, at) VALUES (?, ?, ?)').run(follower, followee, Date.now())
  }

  unfollow(follower: string, followee: string) {
    this.db.prepare('DELETE FROM follows WHERE follower = ? AND followee = ?').run(follower, followee)
  }

  following(id: string): string[] {
    return (this.db.prepare('SELECT followee FROM follows WHERE follower = ? ORDER BY at DESC').all(id) as Array<{ followee: string }>).map((row) => row.followee)
  }

  followers(id: string): string[] {
    return (this.db.prepare('SELECT follower FROM follows WHERE followee = ? ORDER BY at DESC').all(id) as Array<{ follower: string }>).map((row) => row.follower)
  }

  follows(follower: string, followee: string) {
    return !!this.db.prepare('SELECT 1 FROM follows WHERE follower = ? AND followee = ?').get(follower, followee)
  }

  /** People who follow each other with `id`. */
  friends(id: string): string[] {
    return (
      this.db.prepare('SELECT a.followee AS id FROM follows a JOIN follows b ON b.follower = a.followee AND b.followee = a.follower WHERE a.follower = ?').all(id) as Array<{ id: string }>
    ).map((row) => row.id)
  }

  /** The person's account settings, and when they last changed (0: never saved). */
  settings(id: string): { data: Record<string, unknown>; updated: number } {
    const row = this.db.prepare('SELECT data, updated FROM settings WHERE user_id = ?').get(id) as { data: string; updated: number } | undefined
    return row ? { data: JSON.parse(row.data) as Record<string, unknown>, updated: row.updated } : { data: {}, updated: 0 }
  }

  /** Merges changed settings in (a null value removes one). */
  updateSettings(id: string, patch: Record<string, unknown>) {
    const data = this.settings(id).data
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete data[key]
      else data[key] = value
    }
    const updated = Date.now()
    this.db
      .prepare('INSERT INTO settings (user_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
      .run(id, JSON.stringify(data), updated)
    return { data, updated }
  }

  setActivity(id: string, activity: Activity) {
    this.db.prepare('INSERT INTO activity (user_id, payload) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload').run(id, JSON.stringify(activity))
  }

  activity(id: string): Activity | null {
    const row = this.db.prepare('SELECT payload FROM activity WHERE user_id = ?').get(id) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as Activity) : null
  }

  clearActivity(id: string) {
    this.db.prepare('DELETE FROM activity WHERE user_id = ?').run(id)
  }

  /**
   * Records how long something Jellyfin doesn't know was played (podcast episodes, which Lumio plays from their hosts):
   * one row per listening session, its seconds growing while it plays.
   */
  recordPlay(play: Play) {
    this.db
      .prepare(
        `INSERT INTO plays (session, user_id, kind, item_key, title, subtitle, context_id, image, client, started_at, seconds, updated_at, source, reason_start, reason_end, shuffle, offline, buffering_ms, artist, album)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session) DO UPDATE SET seconds = MAX(plays.seconds, excluded.seconds), updated_at = excluded.updated_at,
           reason_end = COALESCE(excluded.reason_end, plays.reason_end), buffering_ms = MAX(COALESCE(plays.buffering_ms, 0), COALESCE(excluded.buffering_ms, 0))
         WHERE plays.user_id = excluded.user_id`,
      )
      .run(
        play.session,
        play.userId,
        play.kind,
        play.key,
        play.title,
        play.subtitle ?? null,
        play.contextId ?? null,
        play.image ?? null,
        play.client ?? null,
        play.startedAt,
        play.seconds,
        Date.now(),
        play.source ?? null,
        play.reasonStart ?? null,
        play.reasonEnd ?? null,
        play.shuffle === undefined ? null : Number(play.shuffle),
        play.offline === undefined ? null : Number(play.offline),
        play.bufferingMs ?? null,
        play.artist ?? null,
        play.album ?? null,
      )
  }

  /**
   * Brings in plays from another service's history, in one go. Each keeps its own session (its time and track), so the
   * same file imported again adds nothing; a song found in the library since then now points to it.
   */
  importPlays(userId: string, source: string, plays: ImportedPlay[]) {
    const statement = this.db.prepare(
      `INSERT INTO plays (session, user_id, kind, item_key, title, subtitle, context_id, client, started_at, seconds, updated_at, source, reason_start, reason_end, shuffle, offline, artist, album)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET item_key = excluded.item_key, context_id = excluded.context_id
       WHERE plays.user_id = excluded.user_id`,
    )
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      for (const play of plays) {
        statement.run(
          play.session,
          userId,
          play.kind,
          play.key,
          play.title,
          play.subtitle ?? null,
          play.contextId ?? null,
          play.client,
          play.startedAt,
          play.seconds,
          now,
          `import:${source}`,
          play.reasonStart ?? null,
          play.reasonEnd ?? null,
          play.shuffle === undefined ? null : Number(play.shuffle),
          play.offline === undefined ? null : Number(play.offline),
          play.artist ?? null,
          play.album ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** How much of a service's history someone brought in: plays, how many of them are songs in the library, first, last. */
  importedSummary(userId: string, source: string) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count, MIN(started_at) AS first, MAX(started_at) AS last, SUM(kind = 'audio' AND item_key NOT LIKE ?) AS matched FROM plays WHERE user_id = ? AND source = ?",
      )
      .get(`${source}:%`, userId, `import:${source}`) as { count: number; first: number | null; last: number | null; matched: number | null }
    return { count: row.count, first: row.first, last: row.last, matched: row.matched ?? 0 }
  }

  deleteImported(userId: string, source: string) {
    this.db.prepare('DELETE FROM plays WHERE user_id = ? AND source = ?').run(userId, `import:${source}`)
  }

  /** Someone's songs and podcast episodes in a time span, for Wrapped (imported ones too). */
  wrappedRows(userId: string, from: number, to: number): WrappedRow[] {
    const rows = this.db
      .prepare(
        `SELECT kind, item_key, title, subtitle, artist, album, context_id, started_at, seconds, source FROM plays
         WHERE user_id = ? AND started_at >= ? AND started_at < ? AND kind IN ('audio', 'podcast') AND seconds > 0 ORDER BY started_at`,
      )
      .all(userId, from, to) as Array<Record<string, string | number | null>>
    return rows.map((row) => ({
      kind: String(row.kind),
      key: String(row.item_key),
      title: String(row.title),
      subtitle: row.subtitle === null ? null : String(row.subtitle),
      artist: row.artist === null ? null : String(row.artist),
      album: row.album === null ? null : String(row.album),
      contextId: row.context_id === null ? null : String(row.context_id),
      startedAt: Number(row.started_at),
      seconds: Number(row.seconds),
      imported: typeof row.source === 'string' && row.source.startsWith('import:'),
    }))
  }

  /** When someone first played each artist (as the plays name them), for Wrapped's discoveries. */
  firstPlaysByArtist(userId: string, before: number) {
    return this.db
      .prepare("SELECT artist, subtitle, MIN(started_at) AS first FROM plays WHERE user_id = ? AND kind = 'audio' AND seconds > 0 AND started_at < ? GROUP BY artist, subtitle")
      .all(userId, before) as Array<{ artist: string | null; subtitle: string | null; first: number }>
  }

  /** Someone's song plays since a moment, oldest first (imported ones too), for the taste signals the mixes are built from. */
  tasteRows(userId: string, since: number) {
    const rows = this.db
      .prepare("SELECT item_key, started_at, seconds, reason_start, reason_end FROM plays WHERE user_id = ? AND kind = 'audio' AND started_at >= ? ORDER BY started_at")
      .all(userId, since) as Array<{ item_key: string; started_at: number; seconds: number; reason_start: string | null; reason_end: string | null }>
    return rows.map((row) => ({ key: row.item_key, startedAt: row.started_at, seconds: row.seconds, reasonStart: row.reason_start, reasonEnd: row.reason_end }))
  }

  /** What someone played from (album, playlist …) since a moment: the player's source per play, and how long it ran. */
  sourceRows(userId: string, since: number) {
    const rows = this.db
      .prepare("SELECT source, started_at, seconds FROM plays WHERE user_id = ? AND started_at >= ? AND (source LIKE '%:%' OR source = 'liked') AND source NOT LIKE 'import:%'")
      .all(userId, since) as Array<{ source: string; started_at: number; seconds: number }>
    return rows.map((row) => ({ source: row.source, startedAt: row.started_at, seconds: row.seconds }))
  }

  /** The distinct songs someone heard before a moment (key, and title and artist for imported ones). */
  songsBefore(userId: string, before: number) {
    return this.db
      .prepare("SELECT DISTINCT item_key AS key, title, artist, subtitle FROM plays WHERE user_id = ? AND kind = 'audio' AND seconds >= 30 AND started_at < ?")
      .all(userId, before) as Array<{ key: string; title: string; artist: string | null; subtitle: string | null }>
  }

  /** The years someone listened to songs in (as UTC years; Wrapped settles the edges in the person's time zone). */
  listeningYears(userId: string): number[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT CAST(strftime('%Y', started_at / 1000, 'unixepoch') AS INTEGER) AS year FROM plays WHERE user_id = ? AND kind = 'audio' AND seconds > 0 ORDER BY year DESC",
      )
      .all(userId) as Array<{ year: number }>
    return rows.map((row) => row.year)
  }

  /** Someone's plays, newest first (for their history). */
  plays(userId: string, limit: number, before = Number.MAX_SAFE_INTEGER): Play[] {
    const rows = this.db
      .prepare(`SELECT * FROM plays WHERE user_id = ? AND started_at < ? AND ${NOT_IMPORTED} ORDER BY started_at DESC LIMIT ?`)
      .all(userId, before, limit) as Array<Record<string, string | number | null>>
    return rows.map(playOf)
  }

  /** Everyone's plays in a time span (for the administrators' statistics). */
  playsBetween(from: number, to: number): Play[] {
    return (this.db.prepare(`SELECT * FROM plays WHERE started_at >= ? AND started_at < ? AND ${NOT_IMPORTED} ORDER BY started_at`).all(from, to) as Array<Record<string, string | number | null>>).map(playOf)
  }

  /** Remembers who added songs to a playlist (Jellyfin doesn't keep it), for shared playlists' "Added by". */
  recordPlaylistAdds(playlistId: string, itemIds: string[], userId: string) {
    const statement = this.db.prepare(
      'INSERT INTO playlist_adds (playlist_id, item_id, user_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(playlist_id, item_id) DO UPDATE SET user_id = excluded.user_id, at = excluded.at',
    )
    const at = Date.now()
    for (const itemId of itemIds) statement.run(playlistId, itemId, userId, at)
  }

  /** Who added each song of a playlist and when, as far as it was added through Lumio. */
  playlistAdds(playlistId: string): Record<string, { person: Person; at: number }> {
    const rows = this.db.prepare('SELECT item_id, user_id, at FROM playlist_adds WHERE playlist_id = ?').all(playlistId) as Array<{ item_id: string; user_id: string; at: number }>
    return Object.fromEntries(rows.map((row) => [row.item_id, { person: this.person(row.user_id) ?? { id: row.user_id, name: '', imageTag: null }, at: row.at }]))
  }

  /** What a song sounds like (see sound-analysis.ts; null: couldn't be measured) and its Last.fm tags. */
  setTrackSound(id: string, data: unknown, tags: string[]) {
    this.db
      .prepare('INSERT INTO track_sound (item_id, data, tags, at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET data = excluded.data, tags = excluded.tags, at = excluded.at')
      .run(id, data === null ? null : JSON.stringify(data), JSON.stringify(tags), Date.now())
  }

  /** Every measured song: its features (null: couldn't be measured), tags and when. */
  trackSounds(): Array<{ id: string; data: unknown; tags: string[]; at: number }> {
    const rows = this.db.prepare('SELECT item_id, data, tags, at FROM track_sound').all() as Array<{ item_id: string; data: string | null; tags: string | null; at: number }>
    return rows.map((row) => ({ id: row.item_id, data: row.data ? (JSON.parse(row.data) as unknown) : null, tags: row.tags ? (JSON.parse(row.tags) as string[]) : [], at: row.at }))
  }

  hasTrackSound(id: string) {
    return !!this.db.prepare('SELECT 1 FROM track_sound WHERE item_id = ?').get(id)
  }

  setArtistTags(id: string, name: string, tags: string[]) {
    this.db
      .prepare('INSERT INTO artist_tags (artist_id, name, tags, at) VALUES (?, ?, ?, ?) ON CONFLICT(artist_id) DO UPDATE SET name = excluded.name, tags = excluded.tags, at = excluded.at')
      .run(id, name, JSON.stringify(tags), Date.now())
  }

  /** Every artist's Last.fm tags, by artist id, with when they were fetched. */
  artistTags(): Record<string, { tags: string[]; at: number }> {
    const rows = this.db.prepare('SELECT artist_id, tags, at FROM artist_tags').all() as Array<{ artist_id: string; tags: string; at: number }>
    return Object.fromEntries(rows.map((row) => [row.artist_id, { tags: JSON.parse(row.tags) as string[], at: row.at }]))
  }

  /** A track's lyrics as an outside source gave them once (kept for good, so they stay when the source goes away). */
  lyrics(id: string): { data: unknown; source: string; at: number } | null {
    const row = this.db.prepare('SELECT data, source, at FROM lyrics WHERE item_id = ?').get(id) as { data: string; source: string; at: number } | undefined
    return row ? { data: JSON.parse(row.data) as unknown, source: row.source, at: row.at } : null
  }

  /** Every track with kept lyrics: whether they are synced, and where they came from. */
  lyricsIndex(): Record<string, { synced: boolean; source: string }> {
    const rows = this.db.prepare("SELECT item_id, json_extract(data, '$.synced') AS synced, source FROM lyrics").all() as Array<{ item_id: string; synced: number | null; source: string }>
    return Object.fromEntries(rows.map((row) => [row.item_id, { synced: !!row.synced, source: row.source }]))
  }

  deleteLyrics(id: string) {
    this.db.prepare('DELETE FROM lyrics WHERE item_id = ?').run(id)
  }

  setLyrics(id: string, data: unknown, source: string) {
    this.db
      .prepare('INSERT INTO lyrics (item_id, data, source, at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET data = excluded.data, source = excluded.source, at = excluded.at')
      .run(id, JSON.stringify(data), source, Date.now())
  }

  /** The credits looked up for these tracks (null: looked up, none found); tracks never looked up are left out. */
  trackCredits(ids: string[]): Record<string, { data: unknown; at: number }> {
    const result: Record<string, { data: unknown; at: number }> = {}
    const query = this.db.prepare('SELECT data, at FROM track_credits WHERE item_id = ?')
    for (const id of ids) {
      const row = query.get(id) as { data: string | null; at: number } | undefined
      if (row) result[id] = { data: row.data ? (JSON.parse(row.data) as unknown) : null, at: row.at }
    }
    return result
  }

  setTrackCredits(id: string, data: unknown, meta: unknown) {
    this.db
      .prepare('INSERT INTO track_credits (item_id, data, at, meta) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET data = excluded.data, at = excluded.at, meta = excluded.meta')
      .run(id, data === null ? null : JSON.stringify(data), Date.now(), JSON.stringify(meta))
  }

  /** Looked-up tracks for browsing, newest first; `search` matches title, artist, album or anyone credited. */
  creditsPage(search: string, offset: number, limit: number): { total: number; rows: Array<{ id: string; at: number; data: unknown; meta: unknown }> } {
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    const where = search ? "WHERE meta LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\'" : ''
    const params = search ? [pattern, pattern] : []
    const { total } = this.db.prepare(`SELECT count(*) AS total FROM track_credits ${where}`).get(...params) as { total: number }
    const rows = this.db.prepare(`SELECT item_id, at, data, meta FROM track_credits ${where} ORDER BY at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{
      item_id: string
      at: number
      data: string | null
      meta: string | null
    }>
    return {
      total,
      rows: rows.map((row) => ({ id: row.item_id, at: row.at, data: row.data ? (JSON.parse(row.data) as unknown) : null, meta: row.meta ? (JSON.parse(row.meta) as unknown) : null })),
    }
  }

  /** Tracks whose credits mention a text anywhere (a name), with their credits, for a closer look by the caller. */
  creditsMentioning(text: string): Array<{ id: string; data: unknown }> {
    const pattern = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    const rows = this.db.prepare("SELECT item_id, data FROM track_credits WHERE data LIKE ? ESCAPE '\\'").all(pattern) as Array<{ item_id: string; data: string }>
    return rows.map((row) => ({ id: row.item_id, data: JSON.parse(row.data) as unknown }))
  }

  /** The tracks looked up without a result, most recent first. */
  tracksWithoutCredits(): Array<{ id: string; at: number; meta: unknown }> {
    const rows = this.db.prepare('SELECT item_id, at, meta FROM track_credits WHERE data IS NULL ORDER BY at DESC').all() as Array<{ item_id: string; at: number; meta: string | null }>
    return rows.map((row) => ({ id: row.item_id, at: row.at, meta: row.meta ? (JSON.parse(row.meta) as unknown) : null }))
  }

  /** The two-language entries of these items; items without one are left out. */
  localized(ids: string[]): Record<string, Localized> {
    const result: Record<string, Localized> = {}
    const query = this.db.prepare('SELECT data FROM localized WHERE item_id = ?')
    for (const id of ids) {
      const row = query.get(id) as { data: string } | undefined
      if (row) result[id] = JSON.parse(row.data) as Localized
    }
    return result
  }

  localizedMeta(id: string): LocalizedMeta | null {
    const row = this.db.prepare('SELECT meta FROM localized WHERE item_id = ?').get(id) as { meta: string } | undefined
    return row ? (JSON.parse(row.meta) as LocalizedMeta) : null
  }

  setLocalized(id: string, data: Localized, meta: LocalizedMeta) {
    this.db
      .prepare('INSERT INTO localized (item_id, label, data, meta, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET label = excluded.label, data = excluded.data, meta = excluded.meta, at = excluded.at')
      .run(id, data.label, JSON.stringify(data), JSON.stringify(meta), Date.now())
  }

  /**
   * Entries for the administrators' lists, newest first: those with one label (e.g. the unclear ones), or all;
   * `search` matches the name or series.
   */
  localizedPage(label: Label | null, search: string, offset: number, limit: number): { total: number; rows: Array<{ id: string; label: Label; meta: LocalizedMeta; at: number }> } {
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    const conditions = [...(label ? ['label = ?'] : []), ...(search ? ["meta LIKE ? ESCAPE '\\'"] : [])]
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const params = [...(label ? [label] : []), ...(search ? [pattern] : [])]
    const { total } = this.db.prepare(`SELECT count(*) AS total FROM localized ${where}`).get(...params) as { total: number }
    const rows = this.db.prepare(`SELECT item_id, label, meta, at FROM localized ${where} ORDER BY at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{
      item_id: string
      label: Label
      meta: string
      at: number
    }>
    return { total, rows: rows.map((row) => ({ id: row.item_id, label: row.label, meta: JSON.parse(row.meta) as LocalizedMeta, at: row.at })) }
  }

  /** How many entries have each label. */
  localizedCounts(): Partial<Record<Label, number>> {
    const rows = this.db.prepare('SELECT label, count(*) AS n FROM localized GROUP BY label').all() as Array<{ label: Label; n: number }>
    return Object.fromEntries(rows.map((row) => [row.label, row.n]))
  }
}
