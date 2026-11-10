import { useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { useAuthedSession } from '@/features/auth/session'
import { albumTracksOptions, useItem } from '@/features/items/queries'
import { itemHref } from '@/lib/item-links'
import { music } from './music-player'

// The video player pulls in hls.js (~half a megabyte), so it is only fetched when a video is played.
const PlayerPage = lazy(() => import('@/features/player/player-page').then((module) => ({ default: module.PlayerPage })))

const AUDIO_TYPES = new Set(['Audio', 'AudioBook'])

/**
 * Everything that plays goes through /play/:id. Videos open the full-screen player; music and audiobooks don't: they
 * start in Listen's player bar (with the rest of their album queued) and the page shows the album instead.
 */
export function PlayEntry() {
  const { id = '' } = useParams()
  const item = useItem(id)
  // On to the next episode from the player: it is a video, so the player stays while it loads (replacing it with the
  // black page would end the fullscreen).
  const continuing = !!(useLocation().state as { continuing?: boolean } | null)?.continuing
  if (item.isLoading && !continuing) return <div className="h-svh bg-black" />
  if (item.data && AUDIO_TYPES.has(item.data.Type ?? '')) return <MusicHandoff key={id} id={id} />
  return (
    <Suspense fallback={<div className="h-svh bg-black" />}>
      <PlayerPage />
    </Suspense>
  )
}

function MusicHandoff({ id }: { id: string }) {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const item = useItem(id).data!
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const albumId = item.AlbumId ?? item.ParentId
    void (async () => {
      const tracks = albumId ? await queryClient.fetchQuery(albumTracksOptions(api, session.userId, albumId)).catch(() => []) : []
      const index = tracks.findIndex((track) => track.Id === item.Id)
      if (index >= 0) music.play(tracks, index, { source: `album:${albumId}` })
      else music.play([item])
      void navigate(itemHref(item), { replace: true })
    })()
  }, [api, item, navigate, queryClient, session.userId])

  if (!item) return <Navigate to="/" replace />
  return <div className="h-svh bg-background" />
}
