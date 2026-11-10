import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconBrandBandcamp,
  IconBrandBluesky,
  IconBrandFacebook,
  IconBrandInstagram,
  IconBrandSoundcloud,
  IconBrandThreads,
  IconBrandTiktok,
  IconBrandTwitch,
  IconBrandWikipedia,
  IconBrandX,
  IconBrandYoutube,
  IconChevronLeft,
  IconChevronRight,
  IconDisc,
  IconExternalLink,
  IconMicrophone2,
  IconMusic,
  IconWorld,
  IconX,
  type Icon,
} from '@tabler/icons-react'
import { useState } from 'react'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAuthedSession } from '@/features/auth/session'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { titlePath } from '@/lib/item-links'
import { slugOf, tagSlug } from './mood-mixes'
import { useOfficialPlaylists } from './official'
import { cn } from '@/lib/utils'
import { useArtistLinks, useArtistRanks, useLastfmArtist, type ArtistLink } from './external'
import { useArtistAlbums } from '@/features/items/queries'
import { useArtistBio, useArtistPhoto } from './artist-photo'

const messages = defineMessages({
  de: {
    about: 'Über den Künstler',
    close: 'Schließen',
    listeners: 'Hörer',
    plays: 'Wiedergaben',
    linkNames: (kind: string): string =>
      ({ website: 'Website', instagram: 'Instagram', x: 'X', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', twitch: 'Twitch', threads: 'Threads', bluesky: 'Bluesky', wikipedia: 'Wikipedia', genius: 'Songtexte auf Genius' })[kind] ?? kind,
    inLibrary: 'In deiner Bibliothek',
    libraryCounts: (albums: number, appears: number) =>
      `${albums === 1 ? '1 Album oder Single' : `${albums} Alben und Singles`}${appears ? `, dazu auf ${appears === 1 ? '1 weiteren Album' : `${appears} weiteren Alben`} zu hören` : ''} auf diesem Server.`,
    worldwide: 'weltweit',
    inCountry: (country: string) => `in ${country}`,
    popularIn: 'Beliebt in',
    place: (n: string) => `Platz ${n} der Charts`,
    previous: 'Vorheriges Bild',
    next: 'Nächstes Bild',
    openPage: 'Künstlerseite öffnen',
    lastfm: 'Auf Last.fm',
    noBio: 'Zu diesem Künstler gibt es noch keine Beschreibung.',
  },
  en: {
    about: 'About the artist',
    close: 'Close',
    listeners: 'Listeners',
    plays: 'Plays',
    linkNames: (kind: string): string =>
      ({ website: 'Website', instagram: 'Instagram', x: 'X', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', twitch: 'Twitch', threads: 'Threads', bluesky: 'Bluesky', wikipedia: 'Wikipedia', genius: 'Lyrics on Genius' })[kind] ?? kind,
    inLibrary: 'In your library',
    libraryCounts: (albums: number, appears: number) =>
      `${albums === 1 ? '1 album or single' : `${albums} albums and singles`}${appears ? `, and on ${appears === 1 ? '1 more album' : `${appears} more albums`}` : ''} on this server.`,
    worldwide: 'worldwide',
    inCountry: (country: string) => `in ${country}`,
    popularIn: 'Popular in',
    place: (n: string) => `No. ${n} in the charts`,
    previous: 'Previous image',
    next: 'Next image',
    openPage: 'Open artist page',
    lastfm: 'On Last.fm',
    noBio: "There's no description of this artist yet.",
  },
})

/** All of an artist's pictures: their backdrops (Jellyfin keeps several), then their photo (the best there is). */
function artistImages(api: { basePath: string }, artist: BaseItemDto, photo: string | undefined, width = 1600) {
  const backdrops = (artist.BackdropImageTags ?? []).map((tag, index) => `${api.basePath}/Items/${artist.Id}/Images/Backdrop/${index}?tag=${tag}&fillWidth=${width}&quality=90`)
  return photo ? [...backdrops, photo] : backdrops
}

/**
 * Spotify's "About" popup for an artist: their pictures to page through, listeners and plays, genres, and the full
 * biography. Opened from the artist page's about card and from the now-playing panel.
 */
export function ArtistAboutDialog({ artist, open, onOpenChange }: { artist: BaseItemDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const lastfm = useLastfmArtist(open ? (artist.Name ?? undefined) : undefined)
  const { ranks } = useArtistRanks(artist.Name ?? undefined, open)
  const links = useArtistLinks(artist.Name ?? undefined, artist.ProviderIds?.MusicBrainzArtist ?? undefined, open).data ?? []
  const albums = useArtistAlbums(open ? (artist.Id ?? undefined) : undefined).data
  const regions = new Intl.DisplayNames([getLocaleTag(useLocale())], { type: 'region' })
  // The badge: the place worldwide, or else the best one in a country.
  const best = ranks.world ? { rank: ranks.world, where: t.worldwide } : ranks.countries[0] ? { rank: ranks.countries[0].rank, where: t.inCountry(regions.of(ranks.countries[0].code) ?? ranks.countries[0].code) } : null
  const images = artistImages(api, artist, useArtistPhoto(artist, 1600))
  const [shown, setShown] = useState(0)
  const current = shown % Math.max(1, images.length)
  const bio = useArtistBio(artist)
  const genres = [...new Set([...(artist.Genres ?? []), ...(lastfm.data?.tags ?? []).slice(0, 5)])]
  const mixSlugs = useOfficialPlaylists()
    .playlists.filter((playlist) => playlist.kind === 'genre' || playlist.kind === 'tag')
    .map((playlist) => playlist.slug)

  const step = (by: number) => setShown((shown + by + images.length) % images.length)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="block max-h-[90svh] overflow-y-auto p-0 sm:max-w-3xl [scrollbar-width:thin]">
        <div className="group/gallery relative aspect-[16/9] w-full shrink-0 overflow-hidden rounded-t-xl bg-muted">
          {images.length ? (
            // All pictures side by side; the row slides to the one shown.
            <div className="flex size-full transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `translateX(-${current * 100}%)` }}>
              {images.map((src, index) => (
                <FadeImage key={src} src={src} alt="" loading={index === 0 ? 'eager' : 'lazy'} draggable={false} className="size-full shrink-0 object-cover object-[50%_25%]" />
              ))}
            </div>
          ) : (
            <div className="grid size-full place-items-center text-muted-foreground">
              <IconMicrophone2 className="size-16" stroke={1.25} />
            </div>
          )}
          {/* On the picture, so it needs its own backing to stay visible on light photos. */}
          <DialogClose aria-label={t.close} className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70">
            <IconX className="size-5" />
          </DialogClose>
          {images.length > 1 && (
            <>
              <GalleryButton side="left" label={t.previous} onClick={() => step(-1)} />
              <GalleryButton side="right" label={t.next} onClick={() => step(1)} />
              <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
                {images.map((_, index) => (
                  <span key={index} className={cn('size-1.5 rounded-full transition-colors', index === current ? 'bg-white' : 'bg-white/40')} />
                ))}
              </div>
            </>
          )}
        </div>
        <div className="grid gap-8 p-6 sm:grid-cols-[12rem_minmax(0,1fr)] sm:p-8">
          <div className="space-y-5">
            {/* The name names the dialog for screen readers only; the picture and numbers speak for themselves. */}
            <DialogTitle className="sr-only">{artist.Name}</DialogTitle>
            {best && (
              <div className="grid size-24 place-items-center rounded-full bg-primary text-center leading-tight text-primary-foreground">
                <span>
                  <span className="block text-2xl font-black">#{number.format(best.rank)}</span>
                  <span className="block px-2 text-[11px] font-semibold">{best.where}</span>
                </span>
              </div>
            )}
            {!!lastfm.data?.listeners && <Stat value={number.format(lastfm.data.listeners)} label={t.listeners} />}
            {!!lastfm.data?.playcount && <Stat value={number.format(lastfm.data.playcount)} label={t.plays} />}
            {/* Where they rank highest (country charts: the closest open data gets to Spotify's top cities). */}
            {ranks.countries.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t.popularIn}</p>
                {ranks.countries.slice(0, 5).map((entry) => (
                  <div key={entry.code} className="text-sm">
                    <p className="font-semibold">{regions.of(entry.code)}</p>
                    <p className="text-muted-foreground">{t.place(number.format(entry.rank))}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2 text-sm">
              <Link to={titlePath('MusicArtist', artist.Id!)} onClick={() => onOpenChange(false)} className="block font-semibold hover:underline">
                {t.openPage}
              </Link>
              {lastfm.data?.url && (
                <a href={lastfm.data.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
                  {t.lastfm} <IconExternalLink className="size-3.5" />
                </a>
              )}
            </div>
            {/* Their own channels, as Spotify lists them under the numbers. */}
            {links.length > 0 && (
              <ul className="space-y-2.5 text-sm">
                {links.map((link) => {
                  const Icon = LINK_ICONS[link.kind]
                  return (
                    <li key={link.kind}>
                      <a href={link.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2.5 font-semibold hover:underline">
                        <Icon className="size-5 shrink-0" /> {t.linkNames(link.kind)}
                      </a>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <div className="space-y-4">
            {genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {genres.map((genre) => {
                  // A genre or tag with its own mix leads there (e.g. "queer" to Queer Voices).
                  const mix = mixSlugs.find((slug) => slug === `genre-${slugOf(genre)}` || slug === tagSlug(genre))
                  const className = 'rounded-full bg-foreground/10 px-2.5 py-1 text-xs font-medium capitalize'
                  return mix ? (
                    <Link key={genre} to={`/listen/official/${mix}`} onClick={() => onOpenChange(false)} className={`${className} transition-colors hover:bg-foreground/20`}>
                      {genre}
                    </Link>
                  ) : (
                    <span key={genre} className={className}>
                      {genre}
                    </span>
                  )
                })}
              </div>
            )}
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">{bio || t.noBio}</p>
            {/* Where Spotify vouches for an artist, Lumio says what this server has of them. */}
            {!!albums?.albums.length && (
              <div className="rounded-lg bg-foreground/[0.06] p-4">
                <p className="flex items-center gap-2 text-sm font-bold">
                  <IconDisc className="size-5 text-listen" /> {t.inLibrary}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{t.libraryCounts(albums.albums.length, albums.appearsOn.length)}</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const LINK_ICONS: Record<ArtistLink['kind'], Icon> = {
  website: IconWorld,
  instagram: IconBrandInstagram,
  x: IconBrandX,
  facebook: IconBrandFacebook,
  youtube: IconBrandYoutube,
  tiktok: IconBrandTiktok,
  soundcloud: IconBrandSoundcloud,
  bandcamp: IconBrandBandcamp,
  twitch: IconBrandTwitch,
  threads: IconBrandThreads,
  bluesky: IconBrandBluesky,
  wikipedia: IconBrandWikipedia,
  genius: IconMusic,
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

function GalleryButton({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  const Icon = side === 'left' ? IconChevronLeft : IconChevronRight
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 focus-visible:opacity-100 group-hover/gallery:opacity-100',
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      <Icon className="size-5" />
    </button>
  )
}
