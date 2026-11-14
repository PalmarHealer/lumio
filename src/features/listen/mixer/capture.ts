/**
 * Records a short stretch of what goes through a node (an <audio> element's source, before its own gain), with the
 * context frame of its first sample: the material `xcorr.locate` needs to tell exactly where in a decoded slice the
 * element is. An AudioWorklet (loaded from a blob, like the limiter) that only records while asked to.
 */

const TAP_PROCESSOR = `
class LumioTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.want = 0
    this.buffer = null
    this.filled = 0
    this.frame = 0
    this.port.onmessage = (event) => {
      this.want = Math.round(event.data * sampleRate)
      this.buffer = new Float32Array(this.want)
      this.filled = 0
    }
  }
  process(inputs) {
    if (!this.buffer) return true
    const input = inputs[0]
    const length = input[0] ? input[0].length : 128
    if (this.filled === 0) this.frame = currentFrame
    for (let i = 0; i < length && this.filled < this.want; i++) {
      let sum = 0
      for (let c = 0; c < input.length; c++) sum += input[c][i]
      this.buffer[this.filled++] = input.length ? sum / input.length : 0
    }
    if (this.filled >= this.want) {
      this.port.postMessage({ frame: this.frame, samples: this.buffer }, [this.buffer.buffer])
      this.buffer = null
    }
    return true
  }
}
registerProcessor('lumio-tap', LumioTap)
`

export interface Recording {
  /** Context frame of the first sample. */
  frame: number
  /** Mono (the channels' mean). */
  samples: Float32Array
}

export interface Tap {
  /** Records the next `seconds` of the source. */
  record(seconds: number): Promise<Recording>
  dispose(): void
}

const modules = new WeakMap<BaseAudioContext, Promise<void>>()

export async function createTap(ctx: BaseAudioContext, source: AudioNode): Promise<Tap> {
  let loading = modules.get(ctx)
  if (!loading) {
    const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }))
    loading = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    modules.set(ctx, loading)
  }
  await loading
  // No outputs: the node is processed as a sink while something plays into it.
  const node = new AudioWorkletNode(ctx, 'lumio-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
  source.connect(node)
  let pending: ((recording: Recording) => void) | null = null
  node.port.onmessage = (event: MessageEvent<Recording>) => {
    pending?.(event.data)
    pending = null
  }
  return {
    record(seconds) {
      return new Promise<Recording>((resolve) => {
        pending = resolve
        node.port.postMessage(seconds)
      })
    },
    dispose() {
      pending = null
      node.port.onmessage = null
      source.disconnect(node)
    },
  }
}
