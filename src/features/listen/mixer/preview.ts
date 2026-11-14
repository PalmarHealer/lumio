import { createBufferDeck, type BufferDeck } from './buffer-deck.ts'
import { deckPlan, withBrake, type DeckPlan } from './deck-schedule.ts'
import { asPlayed, createDeck, createMaster, freezeDeck, releaseEcho, releaseReverb, resetDeck, scheduleTransition, switchToRealStem, type Deck, type Master } from './engine.ts'
import type { Transition } from './types.ts'

/**
 * The transition editor's live preview: a transition played in real time from decoded audio, through the same decks,
 * buffer decks (exact where a deck's rate is 1, time-stretched where it glides) and master as the player and the
 * renderer. It plays from any moment, loops a region seamlessly, scrubs, and takes edits while it plays: automation,
 * effects and stem lanes change from the current moment on; a change of timing (where a deck is: aOut, bAt, bIn, length,
 * paths, rates) restarts the decks at the current position.
 *
 * Times are transition time: 0 is A at `aOut`, `length` is A gone; the preview spans −`preRoll` … `length` + `postRoll`.
 */

export interface PreviewSource {
  /** The audio, one array per channel (a mono source plays on both sides). */
  channels: Float32Array[]
  /** Track position (seconds) of the first sample: the editor may decode only a window of the song. */
  origin: number
  sampleRate: number
}

export interface PreviewOptions {
  a: PreviewSource
  b: PreviewSource
  transition: Transition
  preRoll?: number
  postRoll?: number
  /** Plays into this context (else a new one, closed again by `dispose`). */
  context?: AudioContext
  /** Output volume, 0–1 (default 1). */
  volume?: number
  /** Where the sound goes (default: the context's destination; a meter or a recorder may sit in between). */
  destination?: AudioNode
}

/** Real stems of a song (windows like its own audio: each with its own `origin`). */
export type PreviewStems = Partial<Record<'drums' | 'vocals' | 'instrumental', PreviewSource>>

export interface TransitionPreview {
  readonly playing: boolean
  /** Plays from transition time `from` (default: where it is). */
  play(from?: number): void
  pause(): void
  /** Jumps to `t`: playing on from there, or (paused) just moving there. */
  seek(t: number): void
  /** A short snippet at `t` (dragging the playhead while paused); while playing, a seek. */
  scrub(t: number): void
  /** Loops [from, to] seamlessly while playing (null: no loop). */
  setLoop(region: { from: number; to: number } | null): void
  /** The edited transition: automation from the current moment on, timing by restarting at the current position. */
  setTransition(transition: Transition): void
  /** The transition time being heard now (output latency included). */
  position(): number
  /** Called every frame while playing, and on seek, pause and the end. Returns the unsubscribe. */
  onPosition(listener: (t: number, playing: boolean) => void): () => void
  setVolume(volume: number): void
  /**
   * New audio for a deck (an edit moved its reach outside the window decoded so far). Resolves once loaded; playing,
   * the preview goes on from where it is with it.
   */
  setSource(deck: 'a' | 'b', source: PreviewSource): Promise<void>
  /**
   * Real stems for a deck as they arrive (any of them; the others stay approximated). They take over from the
   * approximation with a 20 ms crossfade: at the next loop pass while looping (a seam already), else from the moment
   * just ahead (paused: at once).
   */
  setStems(deck: 'a' | 'b', stems: PreviewStems): Promise<void>
  dispose(): void
}

/** How long a scrub snippet sounds. */
const SCRUB_S = 0.08
/** Extra lead on top of the buffer decks' own (main-thread jitter). */
const LEAD_S = 0.05
/** A loop's next pass is scheduled this long before it starts (plus the lead). */
const LOOP_AHEAD_S = 0.25

/** Whether two transitions differ in where their decks are (anything that changes the decks' plans). */
function timingDiffers(x: Transition, y: Transition) {
  const timing = (t: Transition) => JSON.stringify([t.preset, t.aOut, t.bAt, t.bIn, t.length, t.pathA, t.pathB, t.rateA, t.rateB, t.effects.filter((effect) => effect.kind === 'brake')])
  return timing(x) !== timing(y)
}

const stereo = (source: PreviewSource) => [source.channels[0]!, source.channels[Math.min(1, source.channels.length - 1)]!] as Float32Array<ArrayBuffer>[]

export async function createTransitionPreview(options: PreviewOptions): Promise<TransitionPreview> {
  const ctx = options.context ?? new AudioContext({ latencyHint: 'interactive' })
  const owned = !options.context
  const preRoll = Math.max(0, options.preRoll ?? 8)
  const postRoll = Math.max(0, options.postRoll ?? 8)
  let aEnd = options.a.origin + options.a.channels[0]!.length / options.a.sampleRate
  const volume = new GainNode(ctx, { gain: options.volume ?? 1 })
  volume.connect(options.destination ?? ctx.destination)
  const master: Master = await createMaster(ctx, volume)
  const decks: { a: Deck; b: Deck } = { a: createDeck(ctx, master.input), b: createDeck(ctx, master.input) }
  // Hybrid buffer decks: exact where the rate is 1, stretched where it isn't (whatever the edits make of it).
  const [playerA, playerB]: BufferDeck[] = await Promise.all([createBufferDeck(ctx, decks.a.input, 'hybrid'), createBufferDeck(ctx, decks.b.input, 'hybrid')])
  await Promise.all([playerA.load(stereo(options.a), options.a.origin, options.a.sampleRate), playerB.load(stereo(options.b), options.b.origin, options.b.sampleRate)])
  const lead = Math.max(playerA.latency, playerB.latency) + LEAD_S

  let transition = asPlayed(options.transition, aEnd)
  let plans = plansOf(transition)
  let playing = false
  /** Where a paused preview stands. */
  let resting = -Math.min(preRoll, 1)
  let loop: { from: number; to: number } | null = null
  /** The passes scheduled (the last two): from context time `at` on, transition time = context time − `zero`. */
  let passes: Array<{ at: number; zero: number; from: number }> = []
  let cancelTimer: () => void = () => undefined
  const listeners = new Set<(t: number, playing: boolean) => void>()
  let frame = 0
  /** Real stems: their players (playing along with their deck's), and those still to switch to. */
  const stemPlayers = { a: new Map<string, BufferDeck>(), b: new Map<string, BufferDeck>() }
  let pendingStems: Array<{ deck: 'a' | 'b'; stem: 'drums' | 'vocals' | 'instrumental'; out: GainNode }> = []

  function plansOf(t: Transition): { a: DeckPlan; b: DeckPlan; semitones?: (t: number) => number } {
    const braked = withBrake(t, deckPlan(t, 'a'))
    return { a: braked.plan, b: deckPlan(t, 'b'), semitones: braked.semitones }
  }
  const end = () => Math.max(0, transition.length) + postRoll
  const clamp = (t: number) => Math.max(-preRoll, Math.min(end(), t))
  /** Context time minus what lies between scheduling and hearing (the limiter's lookahead, the device's latency). */
  const heardNow = () => ctx.currentTime - master.latency - (ctx.outputLatency || ctx.baseLatency || 0)

  function position() {
    if (!playing) return resting
    const heard = heardNow()
    const pass = [...passes].reverse().find((p) => p.at <= heard) ?? passes[0]
    if (!pass) return resting
    return clamp(Math.max(pass.from, heard - pass.zero))
  }

  function emit() {
    const t = position()
    for (const listener of listeners) listener(t, playing)
  }

  function tick() {
    emit()
    if (playing && listeners.size) frame = requestAnimationFrame(tick)
  }

  /** The automation of one pass: everything from transition time `from`, with `zero` its context time of t = 0. */
  function automate(zero: number, from: number) {
    scheduleTransition(decks, transition, zero, { from: Math.max(0, from) })
    const length = Math.max(0, transition.length)
    // As in the player: A's tails ring out after A is gone; B glides back to neutral and plays on.
    if (from < length) {
      releaseEcho(decks.a, zero + length)
      releaseReverb(decks.a, zero + length)
      resetDeck(decks.b, zero + length, 0.05)
    }
  }

  /** Starts a pass at context time `at` from transition time `from` (stopping what plays then), up to the loop's end. */
  function pass(at: number, from: number) {
    const zero = at - from
    const until = loop ? Math.min(loop.to, end()) : end()
    const length = Math.max(0, transition.length)
    const playersA = [playerA, ...stemPlayers.a.values()]
    const playersB = [playerB, ...stemPlayers.b.values()]
    for (const player of [...playersA, ...playersB]) player.stopAt(at)
    if (from < length) {
      for (const player of playersA) {
        player.play(plans.a, from, Math.min(until, length), zero, plans.semitones)
        player.stopAt(zero + Math.min(until, length) + 0.02)
      }
    }
    const bFrom = Math.max(from, transition.bAt)
    for (const player of playersB) {
      if (bFrom < until) player.play(plans.b, bFrom, until, zero)
      if (until < end() || loop) player.stopAt(zero + until)
    }
    // Stems that arrived take over as this pass starts.
    for (const { deck, stem, out } of pendingStems) switchToRealStem(decks[deck], stem, out, at, 0.02)
    pendingStems = []
    automate(zero, from)
    passes = [...passes.slice(-1), { at, zero, from }]
    cancelTimer()
    // Next: the loop's next pass, or the end.
    const next = zero + until
    if (loop && until > loop.from) cancelTimer = later(next - lead - LOOP_AHEAD_S, () => pass(next, loop!.from))
    else cancelTimer = later(next, () => {
      playing = false
      resting = until
      master.engage(false)
      emit()
    })
  }

  /** Calls `fn` at context time `time` (a timer, checked against the audio clock). */
  function later(time: number, fn: () => void) {
    let timer = 0
    const check = () => {
      const left = time - ctx.currentTime
      if (left <= 0.005) fn()
      else timer = window.setTimeout(check, Math.max(1, Math.min(left * 1000 - 5, 100)))
    }
    timer = window.setTimeout(check, 0)
    return () => window.clearTimeout(timer)
  }

  function start(from: number) {
    void ctx.resume()
    const at = ctx.currentTime + lead
    passes = []
    master.engage(true, at - 0.01)
    pass(at, clamp(from))
    if (!playing) {
      playing = true
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
  }

  function stop(fade = 0.01) {
    cancelTimer()
    const at = ctx.currentTime + fade
    for (const player of [playerA, playerB, ...stemPlayers.a.values(), ...stemPlayers.b.values()]) player.stopAt(at)
    for (const deck of [decks.a, decks.b]) {
      freezeDeck(deck, at)
      releaseEcho(deck, at, 0.1)
      releaseReverb(deck, at, 0.1)
    }
    master.engage(false, at + 0.15)
  }

  const preview: TransitionPreview = {
    get playing() {
      return playing
    },
    play(from) {
      start(from ?? resting)
    },
    pause() {
      if (!playing) return
      resting = position()
      playing = false
      stop()
      emit()
    },
    seek(t) {
      resting = clamp(t)
      if (playing) start(resting)
      else emit()
    },
    scrub(t) {
      if (playing) return preview.seek(t)
      resting = clamp(t)
      void ctx.resume()
      const at = ctx.currentTime + lead
      passes = []
      cancelTimer()
      master.engage(true, at - 0.01)
      pass(at, resting)
      cancelTimer()
      cancelTimer = later(at + SCRUB_S, () => stop(0.005))
      emit()
    },
    setLoop(region) {
      loop = region && region.to > region.from ? { from: clamp(region.from), to: clamp(region.to) } : null
      // Playing: the pass under way gets the new end (from the current position, after the lead).
      if (playing) start(loop && (position() < loop.from || position() >= loop.to) ? loop.from : position() + lead)
    },
    setTransition(next) {
      const played = asPlayed(next, aEnd)
      const restart = timingDiffers(played, transition)
      transition = played
      plans = plansOf(transition)
      if (!playing) return
      if (restart) return start(position() + lead)
      // Automation only: from a moment just ahead, on the pass under way.
      const current = passes[passes.length - 1]
      if (current) automate(current.zero, Math.max(current.from, ctx.currentTime + 0.02 - current.zero))
    },
    position,
    onPosition(listener) {
      listeners.add(listener)
      if (playing) {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(tick)
      }
      return () => listeners.delete(listener)
    },
    async setSource(deck, source) {
      await (deck === 'a' ? playerA : playerB).load(stereo(source), source.origin, source.sampleRate)
      if (deck === 'a') {
        aEnd = source.origin + source.channels[0]!.length / source.sampleRate
        transition = asPlayed(transition, aEnd)
        plans = plansOf(transition)
      }
      if (playing) start(position() + lead)
    },
    async setStems(deck, stems) {
      const entries = Object.entries(stems) as Array<['drums' | 'vocals' | 'instrumental', PreviewSource]>
      const loaded = await Promise.all(
        entries.map(async ([stem, source]) => {
          const out = new GainNode(ctx)
          const player = await createBufferDeck(ctx, out, 'hybrid')
          await player.load(stereo(source), source.origin, source.sampleRate)
          return { stem, out, player }
        }),
      )
      for (const { stem, out, player } of loaded) {
        stemPlayers[deck].get(stem)?.dispose()
        stemPlayers[deck].set(stem, player)
        pendingStems.push({ deck, stem, out })
      }
      if (!playing) {
        for (const { deck: d, stem, out } of pendingStems) switchToRealStem(decks[d], stem, out, ctx.currentTime, 0.02)
        pendingStems = []
      } else if (!loop) start(position() + lead)
      // Looping: the next pass picks them up (its seam is where they switch).
    },
    setVolume(value) {
      volume.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), ctx.currentTime, 0.01)
    },
    dispose() {
      playing = false
      cancelTimer()
      cancelAnimationFrame(frame)
      listeners.clear()
      playerA.dispose()
      playerB.dispose()
      for (const player of [...stemPlayers.a.values(), ...stemPlayers.b.values()]) player.dispose()
      decks.a.dispose()
      decks.b.dispose()
      master.dispose()
      volume.disconnect()
      if (owned) void ctx.close()
    },
  }
  return preview
}
