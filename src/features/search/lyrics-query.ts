import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { useQuery } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { useLumioFetch } from '@/features/social/social'
import { usePublicConfig } from '@/lib/public-config'

/** Songs whose lyrics have the term's words, with the lines around the match; only when the server can search lyrics. */
export function useLyricsSearch(term: string) {
  const { session } = useAuthedSession()
  const lumioFetch = useLumioFetch()
  const enabled = !!usePublicConfig().data?.lyricsSearch && term.length >= 3
  return useQuery({
    queryKey: ['lyrics-search', session.userId, term],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const response = await lumioFetch(`/music/lyrics-search?${new URLSearchParams({ q: term })}`).catch(() => null)
      if (!response?.ok) return { items: [], snippets: {} }
      return (await response.json()) as { items: BaseItemDto[]; snippets: Record<string, string> }
    },
  })
}
