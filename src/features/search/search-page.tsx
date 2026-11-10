import { useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { MediaRow } from '@/components/media/media-row'
import { useSearch } from '@/features/items/queries'
import { PodcastSearchRow } from '@/features/listen/podcast-pages'
import { useAppMode } from '@/lib/app-mode'
import { useMessages } from '@/lib/i18n'
import { HeaderSearch } from './header-search'
import { LyricsSearchSection } from './lyrics-search'
import { groupTitles, searchMessages } from './messages'

const GROUPS: Array<{ type: keyof (typeof groupTitles)['de']; shape?: 'poster' | 'landscape' }> = [
  { type: 'MusicArtist' },
  { type: 'Movie' },
  { type: 'Series' },
  { type: 'BoxSet' },
  { type: 'Episode', shape: 'landscape' },
  { type: 'MusicAlbum' },
  { type: 'Audio' },
  { type: 'Book' },
  { type: 'Playlist' },
]

/**
 * Results for the term in the address; the field is the one in the header (it writes the term there as you type). Phones
 * have no search in their header: the field sits on top of the page (the Search tab).
 */
export function SearchPage() {
  const [params] = useSearchParams()
  const t = useMessages(searchMessages)
  const titles = useMessages(groupTitles)
  const term = (params.get('q') ?? '').trim()
  const mode = useAppMode()
  const results = useSearch(term, mode)

  const groups = useMemo(
    () =>
      // An emptied field must not keep showing the previous term's results.
      !term ? [] : GROUPS.map((group) => ({ ...group, items: (results.data ?? []).filter((item) => item.Type === group.type) })).filter(
        (group) => group.items.length > 0,
      ),
    [term, results.data],
  )

  return (
    <div className="space-y-8 pb-12 pt-20">
      <div className="flex px-4 md:hidden">
        <HeaderSearch persistent />
      </div>
      {term && <h1 className="px-4 text-2xl font-extrabold tracking-tight sm:px-8">{t.results}</h1>}
      {!term && <p className="px-4 text-sm text-muted-foreground sm:px-8">{t.hint}</p>}
      {term && results.isLoading && <MediaRow title={t.searching} loading squareLoading={mode === 'listen'} />}
      {term && !results.isLoading && groups.length === 0 && mode !== 'listen' && (
        <p className="px-4 text-sm text-muted-foreground sm:px-8">{t.noResults(term)}</p>
      )}
      {groups.map((group) => (
        <MediaRow key={group.type} title={titles[group.type]} items={group.items} shape={group.shape} />
      ))}
      {/* Listen also finds songs by their lyrics, and searches the podcast directory. */}
      {mode === 'listen' && term && <LyricsSearchSection term={term} />}
      {mode === 'listen' && term && <PodcastSearchRow term={term} />}
    </div>
  )
}
