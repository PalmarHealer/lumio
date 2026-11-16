import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { IconChevronDown } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router'
import { ItemGrid } from '@/components/media/item-grid'
import { LoadMoreSentinel } from '@/components/media/load-more-sentinel'
import { MusicGrid, MusicRow } from '@/features/listen/music-card'
import { useLibrary, useLibraryArtists, useLibraryGenres, useMergedGenres, useMergedLibraries, type LibraryQuery } from '@/features/items/queries'
import { modeHome, useAppMode } from '@/lib/app-mode'
import { useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { CATEGORY_MODE, categoryPath, isCategoryId, useCategories } from './categories'
import { LibraryToolbar, useLibraryQuery, type LibraryKind } from './library-toolbar'
import { libraryMessages } from './messages'

/** How many merged titles are rendered at first and added per scroll step (they are all loaded already). */
const STEP = 60

/**
 * A navigation category ("Serien", "Filme", …): all its libraries as one list, with the usual sort and filters.
 * With more than one library, chips narrow it down to a single one (kept in the URL as `lib`).
 */
export function CategoryPage() {
  const { category = '' } = useParams()
  const t = useMessages(libraryMessages)
  const { categories, isLoading } = useCategories()
  const [params, setParams] = useSearchParams()
  const kind: LibraryKind = category === 'music' ? 'music' : 'video'
  const [query, setQuery] = useLibraryQuery(kind)
  const location = useLocation()

  const mode = useAppMode()
  const current = categories.find((entry) => entry.id === category)
  if (!isCategoryId(category) || (!isLoading && !current)) return <Navigate to={modeHome(mode)} replace />
  // Each category lives in one app (music in Listen); an address in the other one is corrected.
  if (CATEGORY_MODE[category] !== mode) return <Navigate to={`${categoryPath(category)}${location.search}`} replace />

  const views = current?.views ?? []
  const picked = views.find((view) => view.Id === params.get('lib'))
  const shown = picked ? [picked] : views

  const pick = (id: string | undefined) => {
    const next = new URLSearchParams(params)
    if (id) next.set('lib', id)
    else next.delete('lib')
    // Genres differ between libraries; a selection from the other one would only empty the grid.
    next.delete('genre')
    setParams(next, { replace: true, preventScrollReset: true })
  }

  return (
    <div className="space-y-6 px-4 pb-8 pt-20 sm:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{current?.label}</h1>
        {views.length > 1 && (
          <div role="group" aria-label={t.libraries} className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-0.5">
            <LibraryTab selected={!picked} onClick={() => pick(undefined)}>
              {t.allLibraries}
            </LibraryTab>
            {views.map((view) => (
              <LibraryTab key={view.Id} selected={picked?.Id === view.Id} onClick={() => pick(view.Id!)}>
                {view.Name}
              </LibraryTab>
            ))}
          </div>
        )}
      </div>
      {kind === 'music' && <ArtistsSection views={shown} />}
      {/* Keyed by the libraries shown: one library pages from the server, several are merged here. */}
      {kind === 'music' ? (
        <AlbumsSection>
          <Library shown={shown} query={query} onChange={setQuery} loading={isLoading} kind={kind} />
        </AlbumsSection>
      ) : (
        <Library shown={shown} query={query} onChange={setQuery} loading={isLoading} kind={kind} />
      )}
    </div>
  )
}

interface ListProps {
  query: LibraryQuery
  onChange: (patch: Partial<LibraryQuery>) => void
  loading: boolean
  kind: LibraryKind
}

function Library({ shown, ...props }: ListProps & { shown: BaseItemDto[] }) {
  return shown.length === 1 ? (
    <SingleLibrary key={shown[0]!.Id} view={shown[0]!} {...props} />
  ) : (
    <MergedLibraries key={shown.map((view) => view.Id).join()} views={shown} {...props} />
  )
}

function SingleLibrary({ view, query, onChange, loading, kind }: ListProps & { view: BaseItemDto }) {
  const collectionType = view.CollectionType ?? undefined
  const library = useLibrary(view.Id!, collectionType, true, query)
  const genres = useLibraryGenres(view.Id!, collectionType, true)
  const items = library.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <Results
      query={query}
      onChange={onChange}
      kind={kind}
      genres={genres.data ?? []}
      items={items}
      total={library.data?.pages[0]?.total}
      loading={loading || library.isLoading}
      stale={library.isPlaceholderData}
      done={library.isSuccess && !library.isPlaceholderData}
      hasMore={library.hasNextPage && !library.isPlaceholderData}
      loadingMore={library.isFetchingNextPage}
      onLoadMore={() => void library.fetchNextPage({ cancelRefetch: false })}
    />
  )
}

function MergedLibraries({ views, query, onChange, loading, kind }: ListProps & { views: BaseItemDto[] }) {
  const library = useMergedLibraries(views, query)
  const genres = useMergedGenres(views)
  const [count, setCount] = useState(STEP)
  const all = library.data ?? []
  return (
    <Results
      query={query}
      onChange={onChange}
      kind={kind}
      genres={genres.data ?? []}
      items={all.slice(0, count)}
      total={library.data?.length}
      loading={loading || library.isLoading}
      stale={library.isPlaceholderData}
      done={library.isSuccess && !library.isPlaceholderData}
      hasMore={count < all.length}
      onLoadMore={() => setCount((value) => value + STEP)}
    />
  )
}

interface ResultsProps {
  kind: LibraryKind
  query: LibraryQuery
  onChange: (patch: Partial<LibraryQuery>) => void
  genres: BaseItemDto[]
  items: BaseItemDto[]
  total: number | undefined
  loading: boolean
  /** The previous result, shown while the new one loads. */
  stale: boolean
  done: boolean
  hasMore: boolean
  loadingMore?: boolean
  onLoadMore: () => void
}

function Results({ kind, query, onChange, genres, items, total, loading, stale, done, hasMore, loadingMore, onLoadMore }: ResultsProps) {
  const t = useMessages(libraryMessages)
  const mode = useAppMode()
  const narrowed = query.genreIds.length > 0 || query.filters.length > 0 || query.search !== ''
  return (
    <>
      <LibraryToolbar query={query} onChange={onChange} genres={genres} kind={kind} />
      {total != null && <p className="-mt-3 text-sm text-muted-foreground">{kind === 'music' ? t.albumCount(total) : t.count(total)}</p>}
      <div className={stale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        {/* Listen shows music cards; Watch its posters with previews. */}
        {mode === 'listen' ? (
          <>
            <MusicGrid items={items} loading={loading} />
            {hasMore && <LoadMoreSentinel loading={loadingMore} onLoadMore={onLoadMore} />}
          </>
        ) : (
          <ItemGrid items={items} loading={loading} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={onLoadMore} />
        )}
      </div>
      {done && items.length === 0 && <p className="text-sm text-muted-foreground">{narrowed ? t.noMatches : t.empty}</p>}
    </>
  )
}

function LibraryTab({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string | null | undefined }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** Whether a section of the music page is open; remembered on this device. */
function useSectionOpen(key: string, initial: boolean) {
  const storageKey = `lumio.music.section.${key}`
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      return stored === null ? initial : stored === '1'
    } catch {
      return initial
    }
  })
  const toggle = () =>
    setOpen((current) => {
      try {
        localStorage.setItem(storageKey, current ? '0' : '1')
      } catch {
        // Not remembered.
      }
      return !current
    })
  return [open, toggle] as const
}

/** A section heading that folds its content away (or brings it back), with an optional action on the right. */
function SectionHeader({ title, open, onToggle, action }: { title: string; open: boolean; onToggle: () => void; action?: ReactNode }) {
  const t = useMessages(libraryMessages)
  return (
    <div className="flex items-center justify-between gap-4">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t.collapse(title) : t.expand(title)}
        onClick={onToggle}
        className="group -ml-1 flex items-center gap-1.5 rounded-md px-1 text-2xl font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {title}
        <IconChevronDown className={cn('size-5 text-muted-foreground transition-transform group-hover:text-foreground', !open && '-rotate-90')} />
      </button>
      {open && action}
    </div>
  )
}

/**
 * Music: the artists above the albums. A row by default (the first page of them), which "Show all" opens into a grid
 * that loads further pages while scrolling; the heading folds the whole section away.
 */
function ArtistsSection({ views }: { views: BaseItemDto[] }) {
  const t = useMessages(libraryMessages)
  const artists = useLibraryArtists(views)
  const [open, toggleOpen] = useSectionOpen('artists', true)
  const [all, toggleAll] = useSectionOpen('artists-all', false)
  const pages = artists.data?.pages ?? []
  if (!artists.isLoading && !pages[0]?.items.length) return null
  return (
    <section className="space-y-4">
      <SectionHeader
        title={t.artists}
        open={open}
        onToggle={toggleOpen}
        action={
          <button type="button" onClick={toggleAll} className="text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline">
            {all ? t.showLess : t.showAll}
          </button>
        }
      />
      {open &&
        (all ? (
          <>
            <MusicGrid items={pages.flatMap((page) => page.items)} loading={artists.isLoading} />
            {artists.hasNextPage && <LoadMoreSentinel loading={artists.isFetchingNextPage} onLoadMore={() => void artists.fetchNextPage({ cancelRefetch: false })} />}
          </>
        ) : (
          // The page has its own side padding; the row brings its own, like on the home page.
          <div className="-mx-4 -mt-3 sm:-mx-8">
            <MusicRow title="" items={pages[0]?.items} loading={artists.isLoading} />
          </div>
        ))}
    </section>
  )
}

/** Music: the albums with their sort and filters, under a heading that folds them away. */
function AlbumsSection({ children }: { children: ReactNode }) {
  const t = useMessages(libraryMessages)
  const [open, toggle] = useSectionOpen('albums', true)
  return (
    <section className="space-y-6">
      <SectionHeader title={t.albums} open={open} onToggle={toggle} />
      {open && children}
    </section>
  )
}
