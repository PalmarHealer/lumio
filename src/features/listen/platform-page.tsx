import { ModeTile } from '@/components/app-switcher'
import { useBranding } from '@/features/admin/branding'
import { defineMessages, useMessages } from '@/lib/i18n'
import { CardRow } from './music-card'
import { useOfficialPlaylists, type OfficialPlaylist } from './official'
import { OfficialCard } from './playlist-cards'
import { tintWash } from '@/lib/utils'

const messages = defineMessages({
  de: {
    profile: 'Profil',
    playlists: (n: number) => (n === 1 ? '1 Playlist' : `${n} Playlists`),
    tagline: 'Playlists aus der Bibliothek, jede Woche neu gemischt',
    madeForYou: 'Deine Mixe',
    charts: 'Charts',
    mixes: 'Mixes',
    thisIs: 'Das ist …',
  },
  en: {
    profile: 'Profile',
    playlists: (n: number) => (n === 1 ? '1 playlist' : `${n} playlists`),
    tagline: 'Playlists from the library, reshuffled every week',
    madeForYou: 'Your mixes',
    charts: 'Charts',
    mixes: 'Mixes',
    thisIs: 'This is …',
  },
})

/**
 * The platform's own account (as "Spotify" is on Spotify): the instance's name and mark, and every playlist it makes
 * (new and most played, the genre mixes and the "This is …" playlists). Reached from those playlists' byline.
 */
export function PlatformPage() {
  const t = useMessages(messages)
  const { appName, logo, avatar } = useBranding('listen')
  const { playlists, isLoading } = useOfficialPlaylists()
  const rows: Array<{ title: string; kinds: OfficialPlaylist['kind'][] }> = [
    { title: t.madeForYou, kinds: ['top', 'month', 'new', 'rediscover'] },
    { title: t.charts, kinds: ['chart'] },
    { title: t.mixes, kinds: ['genre'] },
    { title: t.thisIs, kinds: ['artist'] },
  ]
  return (
    <div className="pb-12">
      <div className="pt-14" style={{ background: tintWash('color-mix(in srgb, var(--color-listen) 45%, black)') }}>
        <div className="flex flex-col gap-6 px-4 pb-6 pt-10 sm:flex-row sm:items-end sm:px-8">
          <div className="grid size-48 shrink-0 place-items-center overflow-hidden rounded-full bg-background shadow-2xl shadow-black/50 sm:size-56">
            {avatar ? (
              <img src={avatar} alt="" className="size-full object-cover" />
            ) : logo ? (
              <img src={logo} alt="" className="size-2/3 object-contain" />
            ) : (
              <ModeTile mode="listen" className="size-full rounded-full [&_svg]:size-1/2" />
            )}
          </div>
          <div className="min-w-0 space-y-3">
            <p className="text-sm font-medium">{t.profile}</p>
            <h1 className="text-5xl font-black leading-none tracking-tight sm:text-7xl xl:text-8xl">{appName}</h1>
            <p className="text-sm text-foreground/80">
              {t.playlists(playlists.length)} • {t.tagline}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-6 space-y-10">
        {rows.map((row) => {
          const entries = playlists.filter((playlist) => row.kinds.includes(playlist.kind))
          if (!isLoading && !entries.length) return null
          return (
            <CardRow key={row.title} title={row.title} loading={isLoading}>
              {entries.map((playlist) => (
                <OfficialCard key={playlist.slug} playlist={playlist} />
              ))}
            </CardRow>
          )
        })}
      </div>
    </div>
  )
}
