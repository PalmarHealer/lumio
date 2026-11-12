import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Baked transitions (the app's Transition.baked): leaving "Mix-Modus" renders each transition's overlap in the
 * browser (the engine) into two stereo parts, deck A's and deck B's output before the player's level and limiter, and
 * uploads them here. Kept per clip key (A, B, the transition's hash, engine version; the app computes it) under
 * DATA_DIR/baked/<key>/: meta.json, the parts as 24-bit FLAC (a.flac, b.flac; as uploaded, at gain 0.5), and lossy
 * copies made on demand for the player's quality setting (a.<kbps>.m4a, AAC-LC). Without ffmpeg the parts are kept as
 * the uploaded WAV and served as they are at every quality. A clip lives while a saved playlist mixer's transition
 * refers to it (a reorder or an edit that drops the reference frees it after a day); over the quota the least recently
 * played go first.
 */

/** A part may be this long at most (a 32-bar transition at 90 BPM is about 85 s, plus loops and seam margins). */
export const BAKED_MAX_SECONDS = 120
const MAX_RATE = 48_000
/** The biggest part upload: 120 s of 48 kHz stereo 32-bit, plus headers. */
export const BAKED_PART_LIMIT = BAKED_MAX_SECONDS * MAX_RATE * 2 * 4 + 65_536
/** Lossy qualities served (kbps); a request is rounded to the nearest. */
const QUALITIES = [96, 128, 160, 192, 256]
/** Unreferenced clips are kept this long (a transition saved after its clip was uploaded still finds it). */
const UNREFERENCED_TTL = 24 * 3600_000
const KEY = /^[0-9a-f]{32}$/
const ID = /^[0-9a-f]{32}$/i

export interface BakedMeta {
  key: string
  playlistId: string
  from: string
  to: string
  /** Transition time of the clip's first sample, and its duration (seconds), as rendered. */
  start: number
  length: number
  engine: number
  userId: string
  created: number
  /** The format the parts are kept in. */
  format?: 'flac' | 'wav'
}

export const isBakedKey = (key: string) => KEY.test(key)

/** What a WAV upload holds (16/24/32-bit PCM or 32-bit float), or why it is turned down. */
export function wavInfo(bytes: Buffer): { channels: number; rate: number; bits: number; seconds: number } | string {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return 'Not a WAV file'
  let at = 12
  let fmt: { channels: number; rate: number; bits: number; format: number } | null = null
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      let format = bytes.readUInt16LE(at + 8)
      if (format === 0xfffe && size >= 26) format = bytes.readUInt16LE(at + 32)
      fmt = { format, channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) }
    } else if (id === 'data') {
      if (!fmt) return 'No format before the data'
      if (fmt.channels !== 2) return 'Two channels expected'
      if (fmt.rate < 8000 || fmt.rate > MAX_RATE) return `Sample rate ${fmt.rate} not allowed`
      const pcm = fmt.format === 1 && [16, 24, 32].includes(fmt.bits)
      const float = fmt.format === 3 && fmt.bits === 32
      if (!pcm && !float) return 'PCM 16/24/32-bit or 32-bit float expected'
      const dataSize = Math.min(size, bytes.length - at - 8)
      const seconds = dataSize / (fmt.rate * fmt.channels * (fmt.bits / 8))
      if (seconds > BAKED_MAX_SECONDS + 0.5) return `Longer than ${BAKED_MAX_SECONDS} s`
      return { channels: fmt.channels, rate: fmt.rate, bits: fmt.bits, seconds }
    }
    at += 8 + size + (size % 2)
  }
  return 'No audio data'
}

/** Runs ffmpeg with these arguments, `input` piped in (or none); rejects when it fails or isn't there. */
function ffmpeg(args: string[], input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG ?? 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr?.on('data', (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${errors.trim()}`))))
    if (input) child.stdin!.end(input)
  })
}

let ffmpegChecked: Promise<boolean> | null = null
/** Whether ffmpeg runs here (asked once). */
export function hasFfmpeg() {
  ffmpegChecked ??= ffmpeg(['-version']).then(
    () => true,
    () => false,
  )
  return ffmpegChecked
}

export class BakedClips {
  readonly dir: string
  private readonly quotaBytes: number
  private sweeping = false

  constructor(dataDir: string, quotaMb = Number(process.env.BAKED_QUOTA_MB ?? 4096)) {
    this.dir = join(dataDir, 'baked')
    this.quotaBytes = quotaMb * 1024 * 1024
  }

  private path(key: string, file = '') {
    return join(this.dir, key, file)
  }

  async meta(key: string): Promise<BakedMeta | null> {
    if (!isBakedKey(key)) return null
    try {
      return JSON.parse(await readFile(this.path(key, 'meta.json'), 'utf8')) as BakedMeta
    } catch {
      return null
    }
  }

  /** Checks and keeps a clip's description (before its parts); a new one replaces the old one and its parts. */
  async putMeta(key: string, body: unknown, userId: string): Promise<BakedMeta | string> {
    if (!isBakedKey(key)) return 'Bad key'
    const value = body as Record<string, unknown> | null
    const number = (input: unknown, min: number, max: number) => (typeof input === 'number' && Number.isFinite(input) && input >= min && input <= max ? input : null)
    if (!value || typeof value !== 'object') return 'Bad body'
    const playlistId = typeof value.playlistId === 'string' && ID.test(value.playlistId) ? value.playlistId.toLowerCase() : null
    const from = typeof value.from === 'string' && ID.test(value.from) ? value.from : null
    const to = typeof value.to === 'string' && ID.test(value.to) ? value.to : null
    const start = number(value.start, -10, 300)
    const length = number(value.length, 0.5, BAKED_MAX_SECONDS)
    const engine = number(value.engine, 1, 1_000_000)
    if (!playlistId || !from || !to || start === null || length === null || engine === null || !Number.isInteger(engine)) return 'Bad clip description'
    const meta: BakedMeta = { key, playlistId, from, to, start, length, engine, userId, created: Date.now() }
    await rm(this.path(key), { recursive: true, force: true })
    await mkdir(this.path(key), { recursive: true })
    await writeFile(this.path(key, 'meta.json'), JSON.stringify(meta))
    return meta
  }

  /** Keeps one part (a WAV upload): as 24-bit FLAC when ffmpeg is there, else as the WAV. */
  async putPart(key: string, part: 'a' | 'b', wav: Buffer): Promise<string | null> {
    const meta = await this.meta(key)
    if (!meta) return 'Describe the clip first (PUT its JSON)'
    const info = wavInfo(wav)
    if (typeof info === 'string') return info
    const flac = await hasFfmpeg()
    if (flac) {
      await ffmpeg(['-f', 'wav', '-i', 'pipe:0', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', this.path(key, `${part}.flac`)], wav)
    } else {
      await writeFile(this.path(key, `${part}.wav`), wav)
    }
    // Lossy copies of an earlier upload are stale now.
    for (const file of await readdir(this.path(key))) if (file.startsWith(`${part}.`) && file.endsWith('.m4a')) await rm(this.path(key, file), { force: true })
    if (meta.format !== (flac ? 'flac' : 'wav')) await writeFile(this.path(key, 'meta.json'), JSON.stringify({ ...meta, format: flac ? 'flac' : 'wav' }))
    void this.sweep()
    return null
  }

  /**
   * The file to serve for a part at a quality ('original' or kbps), made (AAC-LC .m4a) when it isn't there yet; null
   * when the clip or part is missing.
   */
  async file(key: string, part: 'a' | 'b', quality: string): Promise<{ path: string; type: string } | null> {
    const meta = await this.meta(key)
    if (!meta) return null
    const original = meta.format === 'wav' ? { path: this.path(key, `${part}.wav`), type: 'audio/wav' } : { path: this.path(key, `${part}.flac`), type: 'audio/flac' }
    if (!(await stat(original.path).catch(() => null))) return null
    const touch = () => utimes(this.path(key, 'meta.json'), new Date(), new Date()).catch(() => {})
    const kbps = Number(quality)
    if (quality === 'original' || !Number.isFinite(kbps) || meta.format === 'wav' || !(await hasFfmpeg())) {
      void touch()
      return original
    }
    const nearest = QUALITIES.reduce((best, value) => (Math.abs(value - kbps) < Math.abs(best - kbps) ? value : best))
    const lossy = this.path(key, `${part}.${nearest}.m4a`)
    if (!(await stat(lossy).catch(() => null))) {
      const temporary = `${lossy}.${process.pid}.${Date.now()}.tmp.m4a`
      // The FLAC holds the deck at gain 0.5 already: no headroom is lost and nothing clips in the AAC.
      await ffmpeg(['-i', original.path, '-c:a', 'aac', '-b:a', `${nearest}k`, '-movflags', '+faststart', temporary])
      await rename(temporary, lossy)
    }
    void touch()
    return { path: lossy, type: 'audio/mp4' }
  }

  async remove(key: string) {
    if (isBakedKey(key)) await rm(this.path(key), { recursive: true, force: true })
  }

  /**
   * Frees clips: those no saved transition refers to after a day, then the least recently played over the quota.
   * `inUse` are the keys saved transitions refer to.
   */
  async sweep(inUse?: Set<string>) {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const entries: Array<{ key: string; size: number; used: number; created: number }> = []
      for (const key of await readdir(this.dir).catch(() => [] as string[])) {
        if (!isBakedKey(key)) continue
        let size = 0
        let used = 0
        let created = 0
        for (const file of await readdir(this.path(key)).catch(() => [] as string[])) {
          const info = await stat(this.path(key, file)).catch(() => null)
          if (!info) continue
          size += info.size
          if (file === 'meta.json') {
            used = info.mtimeMs
            created = info.birthtimeMs || info.mtimeMs
          }
        }
        entries.push({ key, size, used, created })
      }
      const now = Date.now()
      let total = 0
      const kept: typeof entries = []
      for (const entry of entries) {
        if (inUse && !inUse.has(entry.key) && now - Math.max(entry.used, entry.created) > UNREFERENCED_TTL) await this.remove(entry.key)
        else {
          kept.push(entry)
          total += entry.size
        }
      }
      kept.sort((a, b) => a.used - b.used)
      for (const entry of kept) {
        if (total <= this.quotaBytes) break
        await this.remove(entry.key)
        total -= entry.size
      }
    } finally {
      this.sweeping = false
    }
  }
}

/** Streams a kept file as the answer (with its length; no ranges, the player loads clips whole). */
export async function serveFile(response: import('node:http').ServerResponse, file: { path: string; type: string }) {
  const info = await stat(file.path)
  response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': info.size, 'Cache-Control': 'private, max-age=86400' })
  createReadStream(file.path).pipe(response)
}
