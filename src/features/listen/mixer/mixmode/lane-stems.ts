/**
 * Which of the server's four stems feeds which stem lane. The bass stem feeds none: what isn't voice, drums or the
 * instrumental always plays and stays on the EQ's bass lane (the engine computes it as the mix minus the three), as
 * with the live approximation, whose "Rest" has no bass either. Otherwise real stems and the approximation would
 * behave differently and the bass would be controlled twice. Pure, so node can check it.
 */
export const LANE_STEMS = { vocals: 'vocals', drums: 'drums', instrumental: 'other' } as const

export type StemLane = keyof typeof LANE_STEMS
export type ServerStem = 'vocals' | 'drums' | 'bass' | 'other'

/** The server stems to load for the lanes (the bass is never among them). */
export const stemsToLoad = (): Array<(typeof LANE_STEMS)[StemLane]> => Object.values(LANE_STEMS)

/** The lanes' stems from the loaded ones, by lane. */
export function laneStems<T>(loaded: Partial<Record<ServerStem, T>>): Partial<Record<StemLane, T>> {
  const out: Partial<Record<StemLane, T>> = {}
  for (const [lane, stem] of Object.entries(LANE_STEMS) as Array<[StemLane, ServerStem]>) {
    const value = loaded[stem]
    if (value !== undefined) out[lane] = value
  }
  return out
}
