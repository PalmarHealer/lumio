import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Section } from '@/features/settings/fields'
import { lumioGet } from '@/features/social/social'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** What people brought over from Spotify and Jellyfin doesn't have (GET /admin/wishlist), most wanted first. */
interface WishlistEntry {
  title: string
  artist?: string
  people: number
  songs: number
}

interface Wishlist {
  albums: WishlistEntry[]
  artists: WishlistEntry[]
  tracks: WishlistEntry[]
  people: number
}

const messages = defineMessages({
  de: {
    title: 'Wunschliste',
    description: (people: number) =>
      `Was ${people === 1 ? 'eine Person' : `${people} Personen`} aus Spotify mitgebracht ${people === 1 ? 'hat' : 'haben'} und in Jellyfin fehlt. Kommt es dazu, rückt es bei ihnen von selbst nach.`,
    albums: 'Alben',
    artists: 'Künstler*innen',
    tracks: 'Songs',
    people: (count: string) => `${count} ${count === '1' ? 'Person' : 'Personen'}`,
    songs: (count: string) => `${count} ${count === '1' ? 'Song' : 'Songs'}`,
  },
  en: {
    title: 'Wishlist',
    description: (people: number) =>
      `What ${people === 1 ? 'one person' : `${people} people`} brought over from Spotify that Jellyfin doesn’t have. Once it’s added, it moves into their library by itself.`,
    albums: 'Albums',
    artists: 'Artists',
    tracks: 'Songs',
    people: (count: string) => `${count} ${count === '1' ? 'person' : 'people'}`,
    songs: (count: string) => `${count} ${count === '1' ? 'song' : 'songs'}`,
  },
})

const TABS = ['albums', 'artists', 'tracks'] as const

/** Settings → Statistics (administrators): the wishlist; nothing when nobody waits for anything. */
export function WishlistSection() {
  const t = useMessages(messages)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const [tab, setTab] = useState<(typeof TABS)[number]>('albums')
  const wishlist = useQuery({
    queryKey: ['admin-wishlist'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<Wishlist | null> => {
      const response = await lumioGet('/admin/wishlist')
      return response?.ok ? ((await response.json()) as Wishlist) : null
    },
  })
  const data = wishlist.data
  if (!data?.people) return null
  const list = data[tab].slice(0, 30)
  return (
    <Section title={t.title} description={t.description(data.people)}>
      <div className="flex gap-1 px-4 pt-3">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={cn('rounded-full px-3 py-1 text-sm', tab === name ? 'bg-foreground text-background' : 'bg-foreground/[0.07] hover:bg-foreground/10')}
          >
            {t[name]}
          </button>
        ))}
      </div>
      <ol className="divide-y">
        {list.map((entry, index) => (
          <li key={`${entry.artist ?? ''}|${entry.title}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{entry.title}</p>
              {entry.artist && <p className="truncate text-xs text-muted-foreground">{entry.artist}</p>}
            </div>
            <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              <p>{t.people(number.format(entry.people))}</p>
              {tab !== 'tracks' && entry.songs > 0 && <p>{t.songs(number.format(entry.songs))}</p>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}
