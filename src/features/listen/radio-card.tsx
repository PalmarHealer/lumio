import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { ModeTile } from '@/components/app-switcher'
import { FadeImage } from '@/components/media/fade-image'
import { useBranding } from '@/features/admin/branding'
import { defineMessages, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useArtistPhoto } from './artist-photo'
import { ArtistMenuItems } from './library-menu'
import { CardShell } from './music-card'
import { useFollowedArtists } from './playlists'
import { useListeningStats } from './profiles'
import { useNowPlaying } from './player/player-controls'
import { useArtistRadio, useSimilarLibraryArtists } from './radio'

const messages = defineMessages({
  de: { radio: 'Radio', subtitle: (names: string) => `Mit ${names}` },
  en: { radio: 'Radio', subtitle: (names: string) => `With ${names}` },
})

/** A stable soft colour per artist, like Spotify's radio covers. */
function hue(seed: string) {
  let hash = 0
  for (const char of seed) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
  return Math.abs(hash) % 360
}

/**
 * An artist's radio cover, as on Spotify: on a soft colour, the artist's round photo in the middle with two similar
 * artists half behind it, "RADIO" in the corner and the name at the bottom. Always three faces: when too few similar
 * artists are found, the ones listened to most (or followed) fill in.
 */
export function RadioCover({ artist, className }: { artist: BaseItemDto; className?: string }) {
  const similarFound = useSimilarLibraryArtists(artist).data ?? []
  const stats = useListeningStats()
  const followed = useFollowedArtists()
  const similar = [...similarFound, ...(stats.data?.topArtists ?? []), ...(followed.data ?? [])]
    .filter((other, position, list) => other.Id !== artist.Id && list.findIndex((entry) => entry.Id === other.Id) === position)
    .slice(0, 3)
  const h = hue(artist.Id ?? '')
  const { avatar } = useBranding('listen')
  const [left, right] = similar
  return (
    <div className={cn('relative size-full overflow-hidden @container', className)} style={{ background: `oklch(0.78 0.1 ${h})` }}>
      {avatar ? (
        <img src={avatar} alt="" className="absolute left-[6%] top-[6%] size-[clamp(14px,11cqw,26px)] rounded-full object-cover" />
      ) : (
        <ModeTile mode="listen" className="absolute left-[6%] top-[6%] size-[clamp(14px,11cqw,26px)] rounded-full" />
      )}
      <span className="absolute right-[6%] top-[6%] text-[clamp(9px,7cqw,14px)] font-black tracking-widest text-black/80">RADIO</span>
      {[left, right].map(
        (side, index) =>
          side && (
            <span key={side.Id} className="absolute top-[24%] size-[42%] overflow-hidden rounded-full bg-black/10 shadow-lg" style={index === 0 ? { left: '6%' } : { right: '6%' }}>
              <ArtistFace artist={side} />
            </span>
          ),
      )}
      <span className="absolute left-1/2 top-[18%] size-[54%] -translate-x-1/2 overflow-hidden rounded-full bg-black/10 shadow-xl ring-4" style={{ ['--tw-ring-color' as string]: `oklch(0.78 0.1 ${h})` }}>
        <ArtistFace artist={artist} />
      </span>
      <span className="absolute inset-x-[6%] bottom-[5%] truncate text-[clamp(12px,11cqw,24px)] font-black leading-tight text-black/85">{artist.Name}</span>
    </div>
  )
}

/** An artist's radio as a card: opens the radio's page (today's mix for this listener); playing starts it. */
export function RadioCard({ artist }: { artist: BaseItemDto }) {
  const t = useMessages(messages)
  const radio = useArtistRadio()
  const similarFound = useSimilarLibraryArtists(artist).data ?? []
  const state = useNowPlaying()
  const source = `official:radio-${artist.Id}`
  const here = state.source === source
  return (
    <CardShell
      href={`/listen/official/radio-${artist.Id}`}
      menu={<ArtistMenuItems artist={artist} />}
      title={t.radio + ': ' + (artist.Name ?? '')}
      subtitle={similarFound.length ? t.subtitle(similarFound.slice(0, 3).map((entry) => entry.Name).join(', ')) : undefined}
      here={here}
      playing={here && state.playing}
      onPlay={() => (here ? state.toggle() : void radio(artist))}
      cover={<RadioCover artist={artist} />}
    />
  )
}

/** A round artist photo: Jellyfin's, or one from Deezer; the artist's initial on the card's colour without either. */
function ArtistFace({ artist }: { artist: BaseItemDto }) {
  const photo = useArtistPhoto(artist, 240)
  if (!photo) return <span className="grid size-full place-items-center text-[clamp(12px,14cqw,32px)] font-black text-black/40">{artist.Name?.[0]}</span>
  return <FadeImage src={photo} alt="" className="size-full object-cover" />
}
