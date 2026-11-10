import { useQuery } from '@tanstack/react-query'
import { useSocialUrl } from '@/features/social/social'

export interface PublicConfig {
  /** The Jellyfin SSO plugin's providers to offer on the sign-in page (when Lumio fronts Jellyfin). */
  sso: Array<{ id: string; label: string }>
  /** Whether Lumio is the public face of Jellyfin (it passes Jellyfin's API and administration through). */
  proxy: boolean
  /** Whether the sign-in page offers a Jellyfin password form (off: SSO and Quick Connect only). */
  passwordLogin?: boolean
  /** Whether songs can be found by their lyrics (the server has Meilisearch). */
  lyricsSearch?: boolean
}

/** What the Lumio server tells before anyone is signed in; nothing when there is no Lumio server. */
export function usePublicConfig() {
  const base = useSocialUrl()
  return useQuery({
    queryKey: ['lumio-public', base],
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async (): Promise<PublicConfig> => {
      const response = await fetch(`${base}/public`).catch(() => null)
      if (!response?.ok) return { sso: [], proxy: false }
      return (await response.json()) as PublicConfig
    },
  })
}
