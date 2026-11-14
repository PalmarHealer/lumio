import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { IconUserCheck, IconUserX, IconX } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAuthedSession } from '@/features/auth/session'
import { useItem } from '@/features/items/queries'
import { Section } from '@/features/settings/fields'
import { useLocalSettings, type TasteExclusions } from '@/features/settings/local-settings'
import { defineMessages, useMessages } from '@/lib/i18n'

/**
 * The taste profile: what the user listens to and likes, which the personal mixes, radios and the "your artists" rows
 * are built from. As on Spotify, artists, albums, songs and playlists can be left out of it (a child's audio plays,
 * a playlist for a party), so playing them doesn't shape what Lumio suggests. Kept with the account.
 */
export type TasteKind = keyof TasteExclusions

export const NO_EXCLUSIONS: TasteExclusions = { artists: [], albums: [], tracks: [], playlists: [] }

/** Whether a track counts for the taste profile: not left out itself, nor its album, artists or a playlist it is on. */
export function countsForTaste(track: BaseItemDto, exclusions: TasteExclusions, playlistTracks: ReadonlySet<string>) {
  if (track.Id && (exclusions.tracks.includes(track.Id) || playlistTracks.has(track.Id))) return false
  if (track.AlbumId && exclusions.albums.includes(track.AlbumId)) return false
  const artists = [...(track.ArtistItems ?? []), ...(track.AlbumArtists ?? [])]
  return !artists.some((artist) => artist.Id && exclusions.artists.includes(artist.Id))
}

/** The user's exclusions, and changing them. */
export function useTasteExclusions() {
  const { settings, update } = useLocalSettings()
  const exclusions = { ...NO_EXCLUSIONS, ...settings.tasteExclusions }
  const isExcluded = (kind: TasteKind, id: string | null | undefined) => !!id && exclusions[kind].includes(id)
  const toggle = (kind: TasteKind, id: string) =>
    update({ tasteExclusions: { ...exclusions, [kind]: isExcluded(kind, id) ? exclusions[kind].filter((entry) => entry !== id) : [...exclusions[kind], id] } })
  return { exclusions, isExcluded, toggle }
}

/**
 * Whether a track counts for the taste profile (see countsForTaste), with the songs of left-out playlists loaded.
 * Queries built from the profile read it when they build and leave the exclusions out of their keys: leaving something
 * out changes what is suggested from the next regular build on, not at once.
 */
export function useTasteFilter() {
  const { api, session } = useAuthedSession()
  const { exclusions } = useTasteExclusions()
  const playlists = useQuery({
    queryKey: ['taste-playlist-tracks', session.userId, exclusions.playlists],
    enabled: exclusions.playlists.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const lists = await Promise.all(
        exclusions.playlists.map(async (id) => (await getLibraryApi(api).getItems({ userId: session.userId, parentId: id, enableImages: false })).data.Items ?? []),
      )
      return new Set(lists.flat().map((track) => track.Id!).filter(Boolean))
    },
  })
  const playlistTracks = playlists.data ?? EMPTY
  const counts = (track: BaseItemDto) => countsForTaste(track, exclusions, playlistTracks)
  return {
    counts,
    exclusions,
    /** Ready once the left-out playlists' songs are known. */
    ready: !exclusions.playlists.length || playlists.isFetched,
  }
}

const EMPTY: ReadonlySet<string> = new Set()

const messages = defineMessages({
  de: { exclude: 'Aus Geschmacksprofil ausschließen', include: 'Wieder ins Geschmacksprofil aufnehmen' },
  en: { exclude: 'Exclude from your taste profile', include: 'Include in your taste profile again' },
})

/** The menu entry that leaves something out of the taste profile, or takes it back in. */
export function TasteMenuItem({ kind, id }: { kind: TasteKind; id: string | null | undefined }) {
  const t = useMessages(messages)
  const { isExcluded, toggle } = useTasteExclusions()
  if (!id) return null
  const excluded = isExcluded(kind, id)
  return (
    <DropdownMenuItem onClick={() => toggle(kind, id)}>
      {excluded ? <IconUserCheck /> : <IconUserX />} {excluded ? t.include : t.exclude}
    </DropdownMenuItem>
  )
}

const listMessages = defineMessages({
  de: {
    title: 'Geschmacksprofil',
    description:
      'Was du hier ausschließt, zählt nicht für deine Mixe, Radios und „Deine Künstler“, auch wenn du es oft hörst. Ausschließen geht im Menü (…) eines Songs, Albums, Künstlers oder einer Playlist.',
    empty: 'Nichts ausgeschlossen.',
    remove: (name: string) => `${name} wieder aufnehmen`,
    artists: 'Künstler*in',
    albums: 'Album',
    tracks: 'Song',
    playlists: 'Playlist',
  },
  en: {
    title: 'Taste profile',
    description:
      "What you exclude here doesn't count for your mixes, radios and \"your artists\", however often you play it. Exclude things from the menu (…) of a song, album, artist or playlist.",
    empty: 'Nothing excluded.',
    remove: (name: string) => `Include ${name} again`,
    artists: 'Artist',
    albums: 'Album',
    tracks: 'Song',
    playlists: 'Playlist',
  },
})

function ExcludedRow({ kind, id }: { kind: TasteKind; id: string }) {
  const t = useMessages(listMessages)
  const { toggle } = useTasteExclusions()
  const item = useItem(id).data
  const name = item?.Name ?? '…'
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{[t[kind], kind !== 'artists' ? item?.AlbumArtist : undefined].filter(Boolean).join(' · ')}</p>
      </div>
      <button
        type="button"
        aria-label={t.remove(name)}
        title={t.remove(name)}
        onClick={() => toggle(kind, id)}
        className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconX className="size-4" />
      </button>
    </div>
  )
}

/** The settings section listing what is left out of the taste profile, each to take back in. */
export function TasteExclusionsSection() {
  const t = useMessages(listMessages)
  const { exclusions } = useTasteExclusions()
  const entries = (Object.keys(exclusions) as TasteKind[]).flatMap((kind) => exclusions[kind].map((id) => ({ kind, id })))
  return (
    <Section anchor="taste" title={t.title} description={t.description} scope="account">
      {entries.length ? entries.map(({ kind, id }) => <ExcludedRow key={`${kind}:${id}`} kind={kind} id={id} />) : <p className="p-4 text-sm text-muted-foreground">{t.empty}</p>}
    </Section>
  )
}
