import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useSession } from '@/features/auth/session'
import { itemOptions } from '@/features/items/queries'
import { externalOf } from '@/lib/external-items'
import { backdropImageUrl, portraitImageUrl } from '@/lib/images'
import { artistsOf } from '@/lib/item-links'
import { connectPlaybackOutbox } from '@/lib/playback-outbox'
import { connectPodcastProgress } from '../podcasts'
import { connectRecent } from '../recent'
import { lyricsOptions } from './lyrics'
import { useMessages } from '@/lib/i18n'
import { playerBarMessages } from './messages'
import { connectMusicPlayer, onQueued, setArtworkResolver, setAutoplayProvider, useMusic } from './music-player'
import { continuation } from '../radio'
import { useLibraryImportSync } from '../library-import-state'

/** How many of the next tracks get their pictures, artist and lyrics loaded ahead. */
const AHEAD_ASSETS = 2

/** Connects the music player to the signed-in server (stream URLs, play reporting, lock-screen artwork, podcast progress). */
export function MusicPlayerHost() {
  const { session, api } = useSession()
  const t = useMessages(playerBarMessages)
  // Wherever songs are queued (menus, dragging onto the queue), a short message says it worked.
  useEffect(() => onQueued((how, items) => void toast.success(how === 'next' ? t.playingNext(items.length) : t.addedToQueue(items.length))), [t])
  useEffect(() => {
    connectMusicPlayer(session && api ? { api, userId: session.userId, accessToken: session.accessToken } : null)
    if (api) setArtworkResolver((item) => portraitImageUrl(api, item, { fillHeight: 512 }))
  }, [session, api])
  // Podcast progress is kept per user.
  const userId = session?.userId
  useEffect(() => {
    void connectPodcastProgress(api && userId ? { api, userId } : null)
    // Plays kept while offline (music and video) are handed in now, and whenever the connection is back.
    connectPlaybackOutbox(api && userId ? { api, userId } : null)
    void connectRecent(api && userId ? { api, userId } : null)
  }, [api, userId])

  // What the Spotify import still waits for is looked for as Jellyfin gets new music.
  useLibraryImportSync(api ?? undefined, userId)

  // What the next tracks will show is fetched ahead: covers in the sizes the player and the side panel use, the
  // artist (with their picture) and the lyrics. When a track starts, its page and panel are ready at once.
  const queryClient = useQueryClient()
  const { queue, index } = useMusic()

  // Autoplay: after the queue, similar songs (around the last artist played).
  useEffect(() => {
    setAutoplayProvider(api && userId ? (played) => continuation(api, userId, queryClient, played) : null)
    return () => setAutoplayProvider(null)
  }, [api, userId, queryClient])
  useEffect(() => {
    if (!api || !userId || index < 0) return
    for (const item of queue.slice(index + 1, index + 1 + AHEAD_ASSETS)) {
      for (const size of [64, 128, 640, 1200]) {
        const url = portraitImageUrl(api, item, { fillHeight: size })
        if (url) new Image().src = url
      }
      if (externalOf(item)) continue
      void queryClient.prefetchQuery(lyricsOptions(api, item))
      const artistId = artistsOf(item)[0]?.id
      if (artistId)
        void queryClient.prefetchQuery(itemOptions(api, userId, artistId)).then(() => {
          const artist = queryClient.getQueryData(itemOptions(api, userId, artistId).queryKey)
          const picture = artist && (backdropImageUrl(api, artist, { fillWidth: 640 }) ?? portraitImageUrl(api, artist, { fillHeight: 400 }))
          if (picture) new Image().src = picture
        })
    }
  }, [api, userId, queue, index, queryClient])
  return null
}
