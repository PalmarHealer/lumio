import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { useQuery } from '@tanstack/react-query'
import { Fragment } from 'react'
import { useAuthedSession } from '@/features/auth/session'
import { TrackTableRow } from '@/features/listen/album-view'
import { music } from '@/features/listen/player/music-player'
import { useLumioFetch } from '@/features/social/social'
import { useMessages } from '@/lib/i18n'
import { usePublicConfig } from '@/lib/public-config'
import { searchMessages } from './messages'

/** Around a match in a snippet (as the server marks it, see server/src/lyrics-search.ts). */
const MARK = /([^]*)/

/** Songs whose lyrics have the term's words, with the lines around the match; only when the server can search lyrics. */
function useLyricsSearch(term: string) {
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

/** A snippet with its matches marked. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(MARK)
  // split with a group: every second part is a match.
  return (
    <span className="block truncate text-sm text-muted-foreground">
      {parts.map((part, index) =>
        index % 2 ? (
          <mark key={index} className="rounded-sm bg-listen/25 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </span>
  )
}

/** Listen's search: the songs whose lyrics have the term, each with the line it is in. */
export function LyricsSearchSection({ term }: { term: string }) {
  const t = useMessages(searchMessages)
  const results = useLyricsSearch(term)
  const items = results.data?.items ?? []
  if (!items.length) return null
  return (
    <section className="space-y-2 px-4 sm:px-8">
      <h2 className="text-xl font-bold tracking-tight">{t.inLyrics}</h2>
      <div>
        {items.map((track, index) => (
          <TrackTableRow
            key={track.Id}
            track={track}
            number={index + 1}
            cover
            note={<Snippet text={results.data?.snippets[track.Id!] ?? ''} />}
            onPlay={() => music.play(items, index, { source: 'search' })}
          />
        ))}
      </div>
    </section>
  )
}
