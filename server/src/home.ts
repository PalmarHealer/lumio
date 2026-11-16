import { Worker } from 'node:worker_threads'
import type { HomeJob } from './home-worker.ts'

/**
 * The main thread's side of home-worker.ts: sends it jobs and answers its questions to Last.fm (through the relay,
 * which keeps the answers and the service's pace for everyone). The worker is started when first needed and again when
 * it stopped.
 */
export class HomeMixes {
  private worker: Worker | null = null
  private jobs = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private jellyfinUrl: string
  private dataDir: string
  private lastfm: (params: Record<string, string>, key: string | undefined) => Promise<unknown>

  constructor(jellyfinUrl: string, dataDir: string, lastfm: (params: Record<string, string>, key: string | undefined) => Promise<unknown>) {
    this.jellyfinUrl = jellyfinUrl
    this.dataDir = dataDir
    this.lastfm = lastfm
  }

  private start() {
    if (this.worker) return this.worker
    const started = new Worker(new URL('./home-worker.ts', import.meta.url), {
      workerData: { jellyfinUrl: this.jellyfinUrl, dataDir: this.dataDir },
      // A library of 100,000 songs and a few listeners' indexes.
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    })
    started.on('message', (message: { id?: number; result?: unknown; error?: string; rpc?: number; method?: string; params?: Record<string, string>; key?: string }) => {
      if (message.rpc !== undefined) {
        const rpc = message.rpc
        this.lastfm(message.params ?? {}, message.key).then(
          (result) => started.postMessage({ rpc, result }),
          (error: unknown) => started.postMessage({ rpc, error: error instanceof Error ? error.message : String(error) }),
        )
        return
      }
      const job = this.pending.get(message.id!)
      this.pending.delete(message.id!)
      if (message.error !== undefined) job?.reject(new Error(message.error))
      else job?.resolve(message.result)
    })
    const fail = (error: Error) => {
      if (this.worker === started) this.worker = null
      for (const job of this.pending.values()) job.reject(error)
      this.pending.clear()
    }
    started.on('error', (error) => {
      console.warn('Home playlists worker:', error)
      fail(error)
    })
    started.on('exit', (code) => fail(new Error(`Home playlists worker stopped (${code})`)))
    started.unref()
    this.worker = started
    return started
  }

  run<T>(job: HomeJob): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.jobs
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.start().postMessage({ id, job })
    })
  }
}
