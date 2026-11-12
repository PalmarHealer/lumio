import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Stems for the editor's smart filters ("Mix-Modus", Tier B): entering it pre-heats a playlist, i.e. asks for each
 * song's stems (vocals, drums, bass, other), the whole song or just windows around its transitions. A separation
 * worker (a separate, stateless process, here or on another machine) takes the jobs: it long-polls for the next one,
 * pulls the window's audio through this server (which streams it from Jellyfin with the asker's token, so no token and
 * no library copy leaves the server), separates it and uploads the four stems. They are kept under DATA_DIR/stems/
 * <item>/<window>/ while a playlist in Mix-Modus holds them (leaving it releases them; they are deleted then), at most
 * STEMS_TTL_HOURS after their last use and within STEMS_QUOTA_MB. Jobs live in memory: a restart forgets the queue
 * (the app pre-heats again), not the kept stems.
 */

export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const
export type Stem = (typeof STEMS)[number]
/** Longest window a job may cover (a whole song is the window 'whole', up to MAX_SONG seconds). */
export const MAX_WINDOW = 300
export const MAX_SONG = 20 * 60
/** Largest stem upload: a 20-minute song as 32-bit float WAV, plus headers. */
export const STEM_UPLOAD_LIMIT = MAX_SONG * 44_100 * 2 * 4 + 65_536
/** A worker's lease on a job: after this without all four stems the job goes back into the queue (at most 3 times). */
const LEASE_MS = 20 * 60_000
const MAX_ATTEMPTS = 3
/** A primary worker counts as present this long after it last asked for a job or uploaded. */
const PRIMARY_PRESENT_MS = 90_000

/**
 * Who asks for jobs: the primary worker (e.g. a GPU machine) takes everything; a fallback worker (the Lumio server's
 * own CPU, opt-in) takes only windows, and only while no primary worker is present.
 */
export type WorkerRole = 'primary' | 'fallback'

export interface StemWindow {
  /** 'whole' or '<startMs>-<endMs>'. */
  id: string
  start: number
  /** 0 for the whole song. */
  end: number
}

export const windowOf = (start: number, end: number): StemWindow | null => {
  if (!(start >= 0) || !(end >= 0)) return null
  if (end === 0 && start === 0) return { id: 'whole', start: 0, end: 0 }
  if (end <= start || end - start > MAX_WINDOW || end > MAX_SONG) return null
  return { id: `${Math.round(start * 1000)}-${Math.round(end * 1000)}`, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 }
}

export const parseWindowId = (id: string): StemWindow | null => {
  if (id === 'whole') return { id, start: 0, end: 0 }
  const match = id.match(/^(\d{1,7})-(\d{1,7})$/)
  return match ? windowOf(Number(match[1]) / 1000, Number(match[2]) / 1000) : null
}

export interface StemJob {
  id: string
  item: string
  window: StemWindow
  /** The Jellyfin token of who asked (used here only, to stream the audio; never handed to the worker). */
  token: string
  state: 'queued' | 'running' | 'failed'
  attempts: number
  leasedUntil: number
  received: Set<Stem>
  error?: string
}

interface WindowMeta {
  item: string
  window: StemWindow
  /** Playlists in Mix-Modus that hold these stems. */
  holders: string[]
  created: number
  stems: Stem[]
}

const ITEM = /^[0-9a-f]{32}$/

export class Stems {
  readonly dir: string
  private readonly quotaBytes: number
  private readonly ttl: number
  private readonly jobs = new Map<string, StemJob>()
  private readonly waiters: Array<{ role: WorkerRole; give: (job: StemJob | null) => void }> = []
  private primarySeen = 0

  constructor(dataDir: string, quotaMb = Number(process.env.STEMS_QUOTA_MB ?? 20_000), ttlHours = Number(process.env.STEMS_TTL_HOURS ?? 72)) {
    this.dir = join(dataDir, 'stems')
    this.quotaBytes = quotaMb * 1024 * 1024
    this.ttl = ttlHours * 3600_000
  }

  private path(item: string, window: string, file = '') {
    return join(this.dir, item, window, file)
  }

  private async meta(item: string, window: string): Promise<WindowMeta | null> {
    try {
      return JSON.parse(await readFile(this.path(item, window, 'meta.json'), 'utf8')) as WindowMeta
    } catch {
      return null
    }
  }

  private async writeMeta(meta: WindowMeta) {
    await mkdir(this.path(meta.item, meta.window.id), { recursive: true })
    await writeFile(this.path(meta.item, meta.window.id, 'meta.json'), JSON.stringify(meta))
  }

  private jobFor(item: string, window: string) {
    for (const job of this.jobs.values()) if (job.item === item && job.window.id === window) return job
    return null
  }

  /**
   * Pre-heats: holds these windows for the playlist and queues a job for each that isn't kept or queued yet. Returns
   * how many were queued and how many are ready.
   */
  async preheat(playlistId: string, token: string, wanted: Array<{ item: string; window: StemWindow }>) {
    let queued = 0
    let ready = 0
    for (const { item, window } of wanted) {
      if (!ITEM.test(item)) continue
      const meta = (await this.meta(item, window.id)) ?? { item, window, holders: [], created: Date.now(), stems: [] }
      if (!meta.holders.includes(playlistId)) meta.holders.push(playlistId)
      await this.writeMeta(meta)
      if (meta.stems.length === STEMS.length) {
        ready++
        continue
      }
      const existing = this.jobFor(item, window.id)
      if (existing && existing.state !== 'failed') {
        // A newer token keeps the audio stream working for long queues.
        existing.token = token
        queued++
        continue
      }
      if (existing) this.jobs.delete(existing.id)
      const job: StemJob = { id: randomUUID(), item, window, token, state: 'queued', attempts: 0, leasedUntil: 0, received: new Set() }
      this.jobs.set(job.id, job)
      queued++
      this.offer(job)
    }
    return { queued, ready }
  }

  /** Leaving Mix-Modus: the playlist lets go; windows nobody holds any more are deleted and their jobs dropped. */
  async release(playlistId: string) {
    let deleted = 0
    for (const item of await readdir(this.dir).catch(() => [] as string[])) {
      if (!ITEM.test(item)) continue
      for (const window of await readdir(join(this.dir, item)).catch(() => [] as string[])) {
        const meta = await this.meta(item, window)
        if (!meta || !meta.holders.includes(playlistId)) continue
        meta.holders = meta.holders.filter((holder) => holder !== playlistId)
        if (meta.holders.length) {
          await this.writeMeta(meta)
          continue
        }
        await rm(this.path(item, window), { recursive: true, force: true })
        const job = this.jobFor(item, window)
        if (job) this.jobs.delete(job.id)
        deleted++
      }
    }
    return { deleted }
  }

  /** Per item, its windows: queued/running/failed/ready and the stems there. */
  async status(items: string[]) {
    const out: Record<string, Array<{ window: StemWindow; state: string; stems: Stem[]; error?: string }>> = {}
    for (const item of items) {
      if (!ITEM.test(item)) continue
      const list: Array<{ window: StemWindow; state: string; stems: Stem[]; error?: string }> = []
      for (const window of await readdir(join(this.dir, item)).catch(() => [] as string[])) {
        const meta = await this.meta(item, window)
        if (!meta) continue
        const job = this.jobFor(item, window)
        const state = meta.stems.length === STEMS.length ? 'ready' : (job?.state ?? 'missing')
        list.push({ window: meta.window, state, stems: meta.stems, ...(job?.error ? { error: job.error } : {}) })
      }
      out[item] = list
    }
    return out
  }

  /** A kept stem file (FLAC), touched as used; null when it isn't there. */
  async file(item: string, window: string, stem: string) {
    if (!ITEM.test(item) || !parseWindowId(window) || !(STEMS as readonly string[]).includes(stem)) return null
    const path = this.path(item, window, `${stem}.flac`)
    if (!(await stat(path).catch(() => null))) return null
    void utimes(this.path(item, window, 'meta.json'), new Date(), new Date()).catch(() => {})
    return { path, type: 'audio/flac' }
  }

  // ---- the worker's side ----

  /** Whether a fallback worker may take this job now (a window, and no primary worker around). */
  private fallbackMay(job: StemJob) {
    return job.window.id !== 'whole' && Date.now() - this.primarySeen > PRIMARY_PRESENT_MS
  }

  private offer(job: StemJob) {
    const at = this.waiters.findIndex((waiter) => waiter.role === 'primary' || this.fallbackMay(job))
    if (at < 0) return
    const [waiter] = this.waiters.splice(at, 1)
    this.lease(job)
    waiter!.give(job)
  }

  /** A worker of this role showed up (asked for a job or delivered). */
  seen(role: WorkerRole) {
    if (role === 'primary') this.primarySeen = Date.now()
  }

  private lease(job: StemJob) {
    job.state = 'running'
    job.attempts++
    job.leasedUntil = Date.now() + LEASE_MS
  }

  /** The next job for a worker, waiting up to `waitMs` for one (long-poll); null when none came. */
  next(waitMs: number, role: WorkerRole = 'primary'): Promise<StemJob | null> {
    this.seen(role)
    const now = Date.now()
    for (const job of this.jobs.values()) {
      // A lease that ran out goes back to the queue (a worker that died), until it has been tried too often.
      if (job.state === 'running' && job.leasedUntil < now) {
        if (job.attempts >= MAX_ATTEMPTS) {
          job.state = 'failed'
          job.error = 'No worker finished it'
        } else job.state = 'queued'
      }
    }
    const queued = [...this.jobs.values()].find((job) => job.state === 'queued' && (role === 'primary' || this.fallbackMay(job)))
    if (queued) {
      this.lease(queued)
      return Promise.resolve(queued)
    }
    return new Promise((resolve) => {
      const waiter = {
        role,
        give: (job: StemJob | null) => {
          clearTimeout(timer)
          resolve(job)
        },
      }
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter)
        if (at >= 0) this.waiters.splice(at, 1)
        resolve(null)
      }, waitMs)
      this.waiters.push(waiter)
    })
  }

  job(id: string) {
    return this.jobs.get(id) ?? null
  }

  /** Keeps one stem a worker uploaded (FLAC); when all four are in, the window is ready and the job done. */
  async receive(job: StemJob, stem: Stem, flac: Buffer) {
    if (flac.toString('ascii', 0, 4) !== 'fLaC') return 'FLAC expected'
    const meta = await this.meta(job.item, job.window.id)
    if (!meta) return 'Released meanwhile'
    await writeFile(this.path(job.item, job.window.id, `${stem}.flac`), flac)
    job.received.add(stem)
    if (!meta.stems.includes(stem)) meta.stems.push(stem)
    await this.writeMeta(meta)
    if (meta.stems.length === STEMS.length) {
      this.jobs.delete(job.id)
      void this.sweep()
    }
    return null
  }

  fail(job: StemJob, error: string) {
    job.error = error.slice(0, 500)
    if (job.attempts >= MAX_ATTEMPTS) job.state = 'failed'
    else {
      job.state = 'queued'
      this.offer(job)
    }
  }

  /** Frees stems unused for longer than the TTL, then the least recently used over the quota. */
  async sweep() {
    const entries: Array<{ path: string; size: number; used: number }> = []
    for (const item of await readdir(this.dir).catch(() => [] as string[])) {
      for (const window of await readdir(join(this.dir, item)).catch(() => [] as string[])) {
        let size = 0
        let used = 0
        for (const file of await readdir(this.path(item, window)).catch(() => [] as string[])) {
          const info = await stat(this.path(item, window, file)).catch(() => null)
          if (!info) continue
          size += info.size
          if (file === 'meta.json') used = info.mtimeMs
        }
        entries.push({ path: this.path(item, window), size, used })
      }
    }
    const now = Date.now()
    let total = 0
    const kept: typeof entries = []
    for (const entry of entries) {
      if (now - entry.used > this.ttl) await rm(entry.path, { recursive: true, force: true })
      else {
        kept.push(entry)
        total += entry.size
      }
    }
    kept.sort((a, b) => a.used - b.used)
    for (const entry of kept) {
      if (total <= this.quotaBytes) break
      await rm(entry.path, { recursive: true, force: true })
      total -= entry.size
    }
  }
}

/**
 * Streams a window of a song as WAV (stereo, 44.1 kHz, 16-bit) from Jellyfin's transcoding stream: read from the
 * song's start and cut sample-accurately (Jellyfin's own seek isn't sample-exact), so the stems line up with the song.
 * Returns the WAV, or null when Jellyfin fails.
 */
export async function windowAudio(jellyfinUrl: string, token: string, item: string, window: StemWindow, signal: AbortSignal): Promise<Buffer | null> {
  const rate = 44_100
  const params = new URLSearchParams({ AudioCodec: 'pcm_s16le', AudioSampleRate: String(rate), AudioChannels: '2', MaxAudioChannels: '2' })
  const response = await fetch(`${jellyfinUrl}/Audio/${item}/stream.wav?${params}`, { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal })
  if (!response.ok || !response.body) return null
  const frameBytes = 4
  const skip = Math.round(window.start * rate) * frameBytes
  const want = window.end ? Math.round((window.end - window.start) * rate) * frameBytes : Infinity
  const chunks: Buffer[] = []
  let header: Buffer | null = null
  let pending = Buffer.alloc(0)
  let skipped = 0
  let taken = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      pending = Buffer.concat([pending, Buffer.from(value)])
      if (!header) {
        // The header ends where the data chunk starts.
        const at = pending.indexOf('data')
        if (at < 0 || pending.length < at + 8) continue
        header = pending.subarray(0, at + 8)
        pending = pending.subarray(at + 8)
      }
      if (skipped < skip) {
        const drop = Math.min(skip - skipped, pending.length)
        skipped += drop
        pending = pending.subarray(drop)
      }
      if (skipped >= skip && pending.length) {
        const take = Math.min(want - taken, pending.length)
        chunks.push(Buffer.from(pending.subarray(0, take)))
        taken += take
        pending = Buffer.alloc(0)
        if (taken >= want) break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!header || !taken) return null
  const data = Buffer.concat(chunks)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(2, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * frameBytes, 28)
  head.writeUInt16LE(frameBytes, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}
