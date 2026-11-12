import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Store, StemWorkerRow } from './store.ts'

/**
 * The separation workers (see stems.ts) and how they sign in, like Portainer's agents: an administrator adds a worker
 * (name, role) in Lumio's settings and gets a join key once, one string holding where to reach this server (the
 * address set for workers, e.g. a Tailscale IP: a container may not resolve tailnet names), the worker's id and its
 * secret. The worker sends `Authorization: Bearer <id>.<secret>`; only a hash of the secret is kept. Revoking or
 * deleting a worker cuts it off at its next request. Failed sign-ins are counted per address: ten within ten minutes
 * shut that address out for the rest of them, and they are logged (without what was sent).
 * The environment's STEMS_WORKER_TOKEN still works as one shared secret (deprecated: for development and as a
 * bootstrap); a worker signing in with it says its role itself.
 */

/** The prefix of a join key (its format's version). */
const KEY_PREFIX = 'lsw1.'
const FAILURES = 10
const FAILURE_WINDOW = 10 * 60_000
/** Last-seen is written at most this often per worker (it polls every half minute or so). */
const SEEN_EVERY = 30_000
const URL_SETTING = 'stems.workerUrl'

export interface WorkerIdentity {
  /** Null for the shared environment secret. */
  id: string | null
  name: string
  role: 'primary' | 'fallback'
}

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')

export class StemWorkers {
  private readonly failures = new Map<string, { count: number; first: number; logged: number }>()
  private readonly seenWritten = new Map<string, number>()

  private readonly store: Store
  private readonly sharedSecret: string
  private readonly defaultUrl: string

  constructor(store: Store, sharedSecret = process.env.STEMS_WORKER_TOKEN ?? '', defaultUrl = process.env.STEMS_WORKER_URL ?? '') {
    this.store = store
    this.sharedSecret = sharedSecret
    this.defaultUrl = defaultUrl
    if (sharedSecret) console.warn('STEMS_WORKER_TOKEN is deprecated: add workers in Lumio\'s settings (Stem-Worker) instead')
  }

  /** Whether any worker may sign in (an active one added, or the shared secret set). */
  enabled() {
    return !!this.sharedSecret || this.store.stemWorkers().some((worker) => !worker.revoked)
  }

  /** The address put into join keys: what an administrator set, else STEMS_WORKER_URL. */
  url() {
    return this.store.serverSetting(URL_SETTING) ?? this.defaultUrl
  }

  /** Sets the address for workers (an http(s) URL of this server's API, e.g. http://100.64.0.5:8097/api). */
  setUrl(value: string): string | null {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return 'Not a URL'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'http or https only'
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return 'Without credentials, query or fragment'
    this.store.setServerSetting(URL_SETTING, parsed.href.replace(/\/+$/, ''))
    return null
  }

  /** Adds a worker; returns it with its join key (the only time the secret is seen). */
  add(name: string, role: 'primary' | 'fallback', createdBy: string): { worker: StemWorkerRow; joinKey: string } | string {
    const url = this.url()
    if (!url) return 'Set the address for workers first'
    const clean = name.trim().slice(0, 60)
    if (!clean) return 'A name is needed'
    const id = randomBytes(8).toString('hex')
    const secret = randomBytes(32).toString('base64url')
    this.store.addStemWorker({ id, name: clean, role, secretHash: hash(secret), createdBy })
    const joinKey = KEY_PREFIX + Buffer.from(JSON.stringify({ u: url, i: id, s: secret })).toString('base64url')
    return { worker: this.store.stemWorker(id)!, joinKey }
  }

  list() {
    return this.store.stemWorkers()
  }

  revoke(id: string) {
    return this.store.revokeStemWorker(id)
  }

  remove(id: string) {
    return this.store.deleteStemWorker(id)
  }

  /** Counts a finished job for the worker. */
  jobDone(identity: WorkerIdentity) {
    if (identity.id) this.store.touchStemWorker(identity.id, { jobDone: true })
  }

  /**
   * Who sent this request (Authorization: Bearer <id>.<secret>, or the shared secret), or why not: 'limited' when the
   * address failed too often lately, 'denied' otherwise.
   */
  authenticate(authorization: string | undefined, address: string): WorkerIdentity | 'denied' | 'limited' {
    const now = Date.now()
    const record = this.failures.get(address)
    if (record && now - record.first > FAILURE_WINDOW) this.failures.delete(address)
    else if (record && record.count >= FAILURES) return 'limited'
    const sent = (authorization ?? '').replace(/^Bearer /, '').trim()
    const identity = sent ? this.identify(sent) : null
    if (identity) {
      if (identity.id && now - (this.seenWritten.get(identity.id) ?? 0) > SEEN_EVERY) {
        this.seenWritten.set(identity.id, now)
        this.store.touchStemWorker(identity.id, { seen: now })
      }
      return identity
    }
    this.fail(address, sent)
    return 'denied'
  }

  private identify(sent: string): WorkerIdentity | null {
    if (this.sharedSecret && equal(sent, this.sharedSecret)) return { id: null, name: 'STEMS_WORKER_TOKEN', role: 'primary' }
    const dot = sent.indexOf('.')
    if (dot < 0) return null
    const worker = this.store.stemWorker(sent.slice(0, dot))
    if (!worker || worker.revoked || !equal(hash(sent.slice(dot + 1)), worker.secretHash)) return null
    return { id: worker.id, name: worker.name, role: worker.role }
  }

  private fail(address: string, sent: string) {
    const now = Date.now()
    const record = this.failures.get(address) ?? { count: 0, first: now, logged: 0 }
    record.count++
    this.failures.set(address, record)
    if (this.failures.size > 10_000) this.failures.clear()
    // Logged without the secret: only which worker id it named (if any), at most once a minute per address.
    if (now - record.logged > 60_000) {
      record.logged = now
      const named = /^[0-9a-f]{16}\./.test(sent) ? `worker ${sent.slice(0, 16)}` : sent ? 'an unknown token' : 'no token'
      console.warn(`Stem worker sign-in failed from ${address} (${named}; ${record.count} in this window)`)
    }
  }
}

/** Parses a join key (for tests and tools): {url, id, secret}, or null. */
export function parseJoinKey(key: string): { url: string; id: string; secret: string } | null {
  if (!key.startsWith(KEY_PREFIX)) return null
  try {
    const value = JSON.parse(Buffer.from(key.slice(KEY_PREFIX.length), 'base64url').toString('utf8')) as { u?: unknown; i?: unknown; s?: unknown }
    return typeof value.u === 'string' && typeof value.i === 'string' && typeof value.s === 'string' ? { url: value.u, id: value.i, secret: value.s } : null
  } catch {
    return null
  }
}

function equal(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
