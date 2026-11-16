import type { LumioFetch } from '@/features/social/social'

/**
 * What the listener played from lately (the player's source keys, e.g. `playlist:<id>`): minutes listened, fading with
 * a half-life of a week, and the last time (ms). For the home grid's "heavy rotation" (GET /me/taste/sources). Their
 * whole taste model lives on the Lumio server (server/src/taste-model.ts).
 */
export type TasteSources = Record<string, { w: number; t: number }>

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function tasteSourcesQuery(userId: string, fetcher: LumioFetch) {
  return {
    queryKey: ['taste-sources', userId],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<TasteSources | null> => {
      const response = await fetcher(`/me/taste/sources?tz=${encodeURIComponent(timeZone())}`).catch(() => null)
      return response?.ok ? ((await response.json()) as TasteSources) : null
    },
  }
}
