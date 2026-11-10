/**
 * Finding songs by a line of their lyrics: the lyrics go into an index of their own in Meilisearch (the one the Jellyfin
 * plugin uses can serve, under another name), one document per song ({id, text}). Meilisearch knows nothing of who may
 * see what, so it is asked only by the server, and what it finds is checked against Jellyfin with the person's token.
 * Plain fetch against its REST API, no dependencies.
 */
export interface LyricsSearch {
  /** Puts songs' lyrics into the index (replacing what was there); in the background on Meilisearch's side. */
  put(documents: Array<{ id: string; lines: string[] }>): Promise<void>
  /** Whether a song is in the index (known once the index was read, see load). */
  has(id: string): boolean
  /** Reads which songs are in the index (once; later calls wait for the same read). */
  load(): Promise<void>
  /** Songs whose lyrics match, best first, each with the lines around the match (matches between MARK_START and MARK_END). */
  search(query: string, limit: number): Promise<Array<{ id: string; snippet: string }>>
}

/** Around a match in a snippet (characters lyrics don't have). */
export const MARK_START = ''
export const MARK_END = ''

/** Ids as Jellyfin's API gives them: 32 hex digits, lower case. */
export const lyricsId = (id: string) => id.replace(/-/g, '').toLowerCase()

/** A song's lines as they go into the index: without empty lines and timing marks, one per line. */
export function lyricsText(lines: string[]) {
  return lines
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

export function lyricsSearch(url: string, key: string, index: string): LyricsSearch {
  const base = url.replace(/\/+$/, '')
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok && response.status !== 404) throw new Error(`Meilisearch ${response.status}: ${(await response.text()).slice(0, 200)}`)
    return response
  }

  // The index and its settings, made on first use (again after a failure).
  let setup: Promise<void> | null = null
  const ready = () =>
    (setup ??= (async () => {
      const found = await request('GET', `/indexes/${index}`)
      if (found.status === 404) await request('POST', '/indexes', { uid: index, primaryKey: 'id' })
      await request('PATCH', `/indexes/${index}/settings`, { searchableAttributes: ['text'], displayedAttributes: ['id', 'text'] })
    })().catch((error: unknown) => {
      setup = null
      throw error
    }))

  const indexed = new Set<string>()
  let loading: Promise<void> | null = null
  const load = () =>
    (loading ??= (async () => {
      await ready()
      for (let offset = 0; ; offset += 1000) {
        const response = await request('GET', `/indexes/${index}/documents?${new URLSearchParams({ fields: 'id', limit: '1000', offset: String(offset) })}`)
        // A new index can answer 404 until Meilisearch has made it.
        if (response.status === 404) break
        const page = (await response.json()) as { results?: Array<{ id: string }>; total?: number }
        for (const entry of page.results ?? []) indexed.add(entry.id)
        if (!page.results?.length || offset + page.results.length >= (page.total ?? 0)) break
      }
    })().catch((error: unknown) => {
      loading = null
      throw error
    }))

  return {
    load,
    has: (id) => indexed.has(lyricsId(id)),
    async put(documents) {
      const entries = documents.map((entry) => ({ id: lyricsId(entry.id), text: lyricsText(entry.lines) })).filter((entry) => entry.text)
      if (!entries.length) return
      await ready()
      await request('POST', `/indexes/${index}/documents`, entries)
      for (const entry of entries) indexed.add(entry.id)
    },
    async search(query, limit) {
      await ready()
      const response = await request('POST', `/indexes/${index}/search`, {
        q: query,
        limit,
        // Every word has to be there (a typo each is forgiven): single common words would match half the library.
        matchingStrategy: 'all',
        // The text too: _formatted only has what is retrieved.
        attributesToRetrieve: ['id', 'text'],
        attributesToHighlight: ['text'],
        attributesToCrop: ['text'],
        cropLength: 16,
        highlightPreTag: MARK_START,
        highlightPostTag: MARK_END,
      })
      if (response.status === 404) return []
      const result = (await response.json()) as { hits?: Array<{ id: string; _formatted?: { text?: string } }> }
      return (result.hits ?? []).map((hit) => ({ id: hit.id, snippet: (hit._formatted?.text ?? '').replace(/\n+/g, ' / ') }))
    },
  }
}
