import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models'
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { IconMicrophone2, IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { FadeImage } from '@/components/media/fade-image'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { lumioGet } from '@/features/social/social'
import { useDominantColor } from '@/lib/dominant-color'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { cn, tintWash } from '@/lib/utils'
import { TrackTableRow } from './album-view'
import { useArtistBio, useArtistPhoto } from './artist-photo'
import { useLastfmArtist } from './external'
import { playCircle } from './play-circle'
import { music, START } from './player/music-player'
import { useNowPlaying } from './player/player-controls'

const messages = defineMessages({
  de: {
    artist: 'Künstler*in',
    listeners: (n: string) => `${n} Hörer`,
    play: 'Abspielen',
    pause: 'Pausieren',
    performed: 'In deiner Bibliothek',
    credited: 'Mitgewirkt an',
    about: 'Informationen',
    nothing: 'In der Bibliothek gibt es noch keine Songs, auf denen diese*r Künstler*in genannt wird.',
    guestHint: 'Gast auf Songs deiner Bibliothek; mit eigenen Alben ist sie*er dort nicht.',
  },
  en: {
    artist: 'Artist',
    listeners: (n: string) => `${n} listeners`,
    play: 'Play',
    pause: 'Pause',
    performed: 'In your library',
    credited: 'Credited on',
    about: 'About',
    nothing: 'No song in the library names this artist yet.',
    guestHint: "A guest on songs in your library, without albums of their own there.",
  },
})

/** Tracks by their ids, in that order. */
function useTracks(ids: string[]) {
  const { api, session } = useAuthedSession()
  return useQuery({
    queryKey: ['tracks-by-id', session.userId, ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const items = (await getLibraryApi(api).getItems({ userId: session.userId, ids, fields: [ItemFields.PrimaryImageAspectRatio] })).data.Items ?? []
      const byId = new Map(items.map((item) => [item.Id, item]))
      return ids.map((id) => byId.get(id)).filter((item): item is BaseItemDto => !!item)
    },
  })
}

/**
 * An artist the library has no page for: a guest on its songs (named by MusicBrainz, left out of the file tags), or
 * someone who wrote or produced them. Their photo and biography from outside, and the library's songs they are on.
 */
export function GuestArtistPage() {
  const { name: encoded = '' } = useParams()
  const name = decodeURIComponent(encoded)
  const t = useMessages(messages)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const artist: BaseItemDto = { Name: name, Type: 'MusicArtist' }
  const photo = useArtistPhoto(artist, 480)
  const tint = useDominantColor(photo).data
  const bio = useArtistBio(artist)
  const lastfm = useLastfmArtist(name || undefined)
  const found = useQuery({
    queryKey: ['credits-by-artist', name],
    enabled: !!name,
    staleTime: 60_000,
    queryFn: async () => {
      const response = await lumioGet(`/credits/by-artist?name=${encodeURIComponent(name)}`)
      // Right after loading, the Lumio server's connection may not be there yet: asked again shortly.
      if (!response?.ok) throw new Error('Lumio server unavailable')
      return (await response.json()) as { performed: string[]; credited: string[] }
    },
  })
  const performed = useTracks(found.data?.performed ?? [])
  const credited = useTracks(found.data?.credited ?? [])
  const state = useNowPlaying()
  const source = `guest:${name}`
  const here = state.source === source
  const songs = performed.data ?? []
  const loading = found.isLoading || performed.isLoading

  return (
    <div className="pb-12">
      <div className="relative flex h-[22rem] items-end overflow-hidden pt-14 sm:h-[26rem]" style={{ background: tintWash(tint ?? 'rgb(64 64 64)') }}>
        <div className="relative flex items-end gap-6 px-4 pb-6 sm:px-8">
          <div className="size-40 shrink-0 overflow-hidden rounded-full bg-muted shadow-2xl shadow-black/50 sm:size-52">
            {photo ? (
              <FadeImage src={photo} alt="" className="size-full object-cover object-[50%_20%]" />
            ) : (
              <div className="grid size-full place-items-center text-muted-foreground">
                <IconMicrophone2 className="size-1/3" stroke={1.25} />
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-3">
            <p className="text-sm font-medium">{t.artist}</p>
            <h1 className="text-5xl font-black leading-none tracking-tight text-balance drop-shadow-lg sm:text-7xl">{name}</h1>
            {!!lastfm.data?.listeners && <p className="text-sm font-medium text-foreground/90">{t.listeners(number.format(lastfm.data.listeners))}</p>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-5 px-4 py-5 sm:px-8">
        <button
          type="button"
          aria-label={here && state.playing ? t.pause : t.play}
          onClick={() => (here ? state.toggle() : music.play(songs, START, { source }))}
          disabled={!songs.length}
          className={cn('size-14', playCircle.listen)}
        >
          {here && state.playing ? <IconPlayerPauseFilled className="size-6" /> : <IconPlayerPlayFilled className="size-6 translate-x-px" />}
        </button>
        <p className="text-sm text-muted-foreground">{t.guestHint}</p>
      </div>

      <div className="space-y-12">
        <section className="max-w-4xl px-4 sm:px-8">
          <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.performed}</h2>
          {loading && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="mb-1 h-14 rounded-md" />)}
          {!loading && !songs.length && <p className="text-sm text-muted-foreground">{t.nothing}</p>}
          {songs.map((track, index) => (
            <TrackTableRow key={track.Id} track={track} number={index + 1} cover onPlay={() => music.play(songs, index, { source })} />
          ))}
        </section>

        {!!credited.data?.length && (
          <section className="max-w-4xl px-4 sm:px-8">
            <h2 className="mb-3 text-2xl font-extrabold tracking-tight">{t.credited}</h2>
            {credited.data.map((track, index) => (
              <TrackTableRow key={track.Id} track={track} number={index + 1} cover onPlay={() => music.play(credited.data, index, { source: `${source}:credited` })} />
            ))}
          </section>
        )}

        {bio && (
          <section className="max-w-4xl space-y-3 px-4 sm:px-8">
            <h2 className="text-2xl font-extrabold tracking-tight">{t.about}</h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{bio}</p>
          </section>
        )}
      </div>
    </div>
  )
}
