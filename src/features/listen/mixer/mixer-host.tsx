import { BaseItemKind, type BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { externalOf } from '@/lib/external-items'
import { ticksToSeconds } from '@/lib/format'
import { setTransitionProvider, useMusic, type TransitionProvider } from '../player/music-player'
import { analysable, fetchMixes, mixerKey, playlistOfSource, prefetchMixes, useStableLumioFetch, usePlaylistMixer } from './queries'
import { transitionFor } from './resolve'
import type { PlaylistMixer } from './types'

/** How long the player waits for analyses it doesn't have yet before it goes with what it has (a plain crossfade). */
const ANALYSIS_WAIT_MS = 4000
/** How many songs ahead of the one playing get their analyses loaded. */
const AHEAD = 3

/** A song from the Jellyfin library, which the Lumio server can analyse (not a podcast episode, not a video). */
const mixableTrack = (item: BaseItemDto | undefined): item is BaseItemDto & { Id: string } =>
  !!item && item.Type === BaseItemKind.Audio && !externalOf(item) && analysable(item.Id)

/**
 * Puts the mixer mode into the player: while the queue playing comes from a playlist with mixer mode on, it hands the
 * player a transition provider (see `setTransitionProvider`), and only then, as the provider makes library tracks load
 * through the Web Audio graph. Anyone who plays a mixer playlist hears its transitions, also those who may not change
 * it.
 *
 * The provider plays the playlist's stored transition for the pair when it still fits, else an automatic one in the
 * playlist's style (`transitionFor`). Shuffled, most pairs are new neighbours: they get automatic transitions, stored
 * ones still play where their exact pair comes up. Songs the user queued in between, or autoplay after the playlist,
 * are mixed automatically too, as long as both songs are library tracks; a podcast episode never is.
 *
 * Analyses for the next songs are loaded ahead. When one is still missing as the player asks, it waits a few seconds,
 * then goes on without: the planner falls back to a plain crossfade, and the server analyses the song meanwhile.
 */
export function MixerHost() {
  const { source, queue, index } = useMusic()
  const playlistId = playlistOfSource(source)
  const mixer = usePlaylistMixer(playlistId)
  const lumioFetch = useStableLumioFetch()
  const queryClient = useQueryClient()
  const on = !!playlistId && mixer.data?.on === true

  useEffect(() => {
    if (!on || !playlistId) return
    const provider: TransitionProvider = async (from, to, context) => {
      // The queue moved on to another collection in the meantime: that one decides (its own host run registers).
      if (playlistOfSource(context.source) !== playlistId) return null
      if (!mixableTrack(from) || !mixableTrack(to)) return null
      // Read when asked, so a save (style, "sort & build") counts from the next transition on.
      const settings = queryClient.getQueryData<PlaylistMixer>(mixerKey(playlistId))
      if (!settings?.on) return null
      const mixes = await fetchMixes(queryClient, lumioFetch, [from.Id, to.Id], ANALYSIS_WAIT_MS)
      const durations = { [from.Id]: ticksToSeconds(from.RunTimeTicks ?? 0), [to.Id]: ticksToSeconds(to.RunTimeTicks ?? 0) }
      return transitionFor(settings, from.Id, to.Id, mixes, settings.style, { durations })
    }
    setTransitionProvider(provider)
    return () => setTransitionProvider(null)
    // Registered once per playlist and switch: setting it again would call off a transition under way. A save (style,
    // "sort & build") counts from the next transition the player asks for.
  }, [on, playlistId, queryClient, lumioFetch])

  // The songs coming up get their analyses loaded ahead (the server queues those it hasn't done yet).
  useEffect(() => {
    if (!on || index < 0) return
    const ahead = queue.slice(index, index + 1 + AHEAD).filter(mixableTrack)
    prefetchMixes(queryClient, lumioFetch, ahead.map((item) => item.Id))
  }, [on, queue, index, queryClient, lumioFetch])

  return null
}
