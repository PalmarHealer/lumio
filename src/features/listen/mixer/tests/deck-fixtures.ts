/**
 * Fixtures for the engine and deck-schedule tests: a plain transition to vary, and a stand-in deck whose params only
 * record (the engine keeps its own copy of what it schedules, `valueOn`, which the tests read back).
 */
import type { Deck } from '../engine.ts'
import type { DeckAutomation, Transition } from '../types.ts'

/** The Web Audio types, taken from the engine's (the tests' tsconfig has no DOM library). */
type Param = Deck['gain']['gain']
type Gain = Deck['gain']
type Filter = Deck['lowpass']

export const neutral = (): DeckAutomation => ({ gain: [], low: [], mid: [], high: [], filter: [] })

export function transition(overrides: Partial<Transition> = {}): Transition {
  return {
    v: 2,
    from: 'a',
    to: 'b',
    style: 'party',
    preset: 'blend',
    aOut: 100,
    bAt: 2,
    bIn: 30,
    length: 16,
    pathA: [],
    pathB: [],
    rateA: [],
    rateB: [],
    tempo: { a: 128, b: 126 },
    a: neutral(),
    b: neutral(),
    effects: [],
    custom: false,
    confidence: 1,
    ...overrides,
  }
}

/** An AudioParam that accepts automation and does nothing else (the engine's own timeline is what is checked). */
function param(defaultValue: number): Param {
  return {
    defaultValue,
    value: defaultValue,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    cancelScheduledValues: () => undefined,
  } as unknown as Param
}

const node = (defaultValue: number) => ({ gain: param(defaultValue) }) as unknown as Gain
const filter = (frequency: number) => ({ frequency: param(frequency) }) as unknown as Filter

/**
 * A deck for `scheduleAutomation` (no reverb lane: that one makes real nodes). With `stems`, its stem split exists
 * already (a stand-in too), as it would once a transition had used it.
 */
export function fakeDeck(sampleRate = 48000, options: { stems?: boolean } = {}): Deck {
  return {
    ctx: { currentTime: 0, sampleRate } as Deck['ctx'],
    input: node(1),
    brake: node(1),
    gain: node(1),
    low: node(1),
    mid: node(1),
    high: node(1),
    highpass: filter(0),
    lowpass: filter(sampleRate / 2),
    kill: [filter(0), filter(0)],
    echo: { send: node(0), delay: { delayTime: param(0.5) } as unknown as Deck['echo']['delay'], feedback: node(0), wet: node(1) },
    reverb: null,
    post: node(1),
    paths: { dry: node(1), coloured: node(0) },
    direct: node(1),
    shaped: node(1),
    stems: options.stems ? { node: {} as Deck['post'], out: node(0), drums: param(1), vocals: param(1), instrumental: param(1) } : null,
    level: node(1),
    source: null,
    dispose: () => undefined,
  }
}
