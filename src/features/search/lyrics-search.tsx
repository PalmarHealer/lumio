import { Fragment } from 'react'
import { TrackTableRow } from '@/features/listen/album-view'
import { music } from '@/features/listen/player/music-player'
import { useMessages } from '@/lib/i18n'
import { useLyricsSearch } from './lyrics-query'
import { searchMessages } from './messages'

/** Around a match in a snippet (as the server marks it, see server/src/lyrics-search.ts). */
const MARK = /\uE000([^\uE001]*)\uE001/

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
