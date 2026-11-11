import { parentPort } from 'node:worker_threads'
import { analyzeMix, readWavChannels, type LyricLine } from './mix-analysis.ts'

/**
 * Runs the whole-track analysis (see mix-analysis.ts) off the server's main thread: a song takes one to several
 * seconds of arithmetic, which would otherwise hold up every other request. One job at a time, sent by mix.ts with the
 * WAV's bytes handed over (not copied).
 */
export interface MixJob {
  id: number
  wav: ArrayBuffer
  lyrics?: LyricLine[]
}

parentPort?.on('message', (job: MixJob) => {
  try {
    // The bytes are let go as soon as the samples are read (a 20-minute song is 50 MB of them).
    let bytes: Uint8Array | null = new Uint8Array(job.wav)
    job.wav = new ArrayBuffer(0)
    const wav = readWavChannels(bytes)
    bytes = null
    const mix = wav ? analyzeMix(wav.channels.slice(0, 2), wav.rate, job.lyrics) : null
    parentPort!.postMessage({ id: job.id, mix })
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) })
  }
})
