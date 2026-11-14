/** Types for signalsmith-stretch (MIT; the package ships none). Only what Lumio uses. */
declare module 'signalsmith-stretch' {
  export interface StretchChange {
    active?: boolean
    /** Position in the loaded buffers (seconds). */
    input?: number
    /** Context time the change applies at (the node compensates its own latency). */
    output?: number
    /**
     * The worklet drops every change at or after this time before adding the new one; without it, every change
     * still to come. Lumio always passes it (equal to `output`).
     */
    outputTime?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    loopStart?: number
    loopEnd?: number
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number
    schedule(change: StretchChange, adjustPrevious?: boolean): Promise<unknown>
    start(when?: number): Promise<unknown>
    stop(when?: number): Promise<unknown>
    addBuffers(channels: Float32Array[]): Promise<number>
    dropBuffers(toSeconds?: number): Promise<unknown>
    latency(): Promise<number>
    configure(config: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<void>
    setUpdateInterval(seconds: number, callback?: (time: number) => void): Promise<void>
  }

  export default function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>
}
