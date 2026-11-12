import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAuthedSession } from '@/features/auth/session'
import { jellyfin } from '@/lib/jellyfin'
import { defineMessages, useMessages } from '@/lib/i18n'
import { bakeKey, sourceIdentity } from '../baked'
import { mixerKey, useStableLumioFetch } from '../queries'
import type { PlaylistMixer } from '../types'
import { attachBaked, bakePair, type BakeDeps } from './bake'
import { mixModeOf, releaseStems, setMixMode, useMixModes } from './mix-mode'

const messages = defineMessages({
  de: {
    done: (n: number) => (n === 1 ? 'Mix-Modus beendet, 1 Übergang gebacken' : `Mix-Modus beendet, ${n} Übergänge gebacken`),
    someFailed: (n: number) => (n === 1 ? '1 Übergang konnte nicht gebacken werden; er spielt live.' : `${n} Übergänge konnten nicht gebacken werden; sie spielen live.`),
  },
  en: {
    done: (n: number) => (n === 1 ? 'Mix mode left, 1 transition baked' : `Mix mode left, ${n} transitions baked`),
    someFailed: (n: number) => (n === 1 ? "1 transition couldn't be baked; it plays live." : `${n} transitions couldn't be baked; they play live.`),
  },
})

/**
 * Bakes the transitions of playlists leaving Mix-Modus, one after the other, in the background (whatever page is open),
 * and goes on after a reload where it stopped (what is still to bake is kept on the device). Each pair is baked from
 * the transition stored now; one whose clip already matches it is skipped, one that fails is left to play live.
 */
export function MixModeHost() {
  const t = useMessages(messages)
  const modes = useMixModes()
  const { api, session } = useAuthedSession()
  const lumioFetch = useStableLumioFetch()
  const queryClient = useQueryClient()
  const running = useRef(new Set<string>())
  const text = useRef(t)
  useEffect(() => {
    text.current = t
  }, [t])

  useEffect(() => {
    if (!api) return
    const deps: BakeDeps = { api, userId: session.userId, accessToken: session.accessToken, deviceId: jellyfin.deviceInfo.id, lumioFetch }
    for (const [playlistId, state] of Object.entries(modes)) {
      if (state.phase !== 'baking' || running.current.has(playlistId)) continue
      running.current.add(playlistId)
      void bakeAll(deps, playlistId)
        .then((outcome) => {
          if (!outcome) return
          void queryClient.invalidateQueries({ queryKey: mixerKey(playlistId) })
          if (outcome.failed) toast.warning(text.current.someFailed(outcome.failed))
          else toast.success(text.current.done(outcome.done))
        })
        .finally(() => running.current.delete(playlistId))
    }
  }, [modes, api, session.userId, session.accessToken, lumioFetch, queryClient])

  return null
}

/** Works through a playlist's pending pairs; returns how it went once all are through (null when it was stopped). */
async function bakeAll(deps: BakeDeps, playlistId: string): Promise<{ done: number; failed: number } | null> {
  for (;;) {
    const state = mixModeOf(playlistId)
    if (state?.phase !== 'baking') return null
    const [pair, ...rest] = state.pending
    if (!pair) {
      await releaseStems(deps.lumioFetch, playlistId)
      setMixMode(playlistId, null)
      return { done: state.done, failed: state.failed.length }
    }
    let outcome: 'baked' | 'skipped' | 'failed'
    try {
      outcome = await bakeOne(deps, playlistId, pair)
    } catch {
      outcome = 'failed'
    }
    const now = mixModeOf(playlistId)
    // Left meanwhile some other way (signed out, cleared): stop.
    if (now?.phase !== 'baking') return null
    setMixMode(playlistId, { ...now, pending: rest, done: now.done + (outcome === 'baked' ? 1 : 0), failed: outcome === 'failed' ? [...now.failed, pair] : now.failed })
  }
}

/**
 * One pair: 'baked' when its clip is stored (or already was), 'skipped' when there is nothing to bake (its transition
 * is gone, or was changed meanwhile and plays live). Throws on failure.
 */
async function bakeOne(deps: BakeDeps, playlistId: string, pair: string): Promise<'baked' | 'skipped'> {
  const [from, to] = pair.split('>') as [string, string]
  const mixer = (await (await deps.lumioFetch(`/music/mixer/${playlistId}`)).json()) as PlaylistMixer
  const transition = mixer.transitions?.[pair]
  if (!transition) return 'skipped'
  const library = getLibraryApi(deps.api)
  const [a, b] = await Promise.all([from, to].map(async (itemId) => (await library.getItem({ itemId, userId: deps.userId })).data))
  if (!a || !b) return 'skipped'
  const sources = { a: sourceIdentity(a), b: sourceIdentity(b) }
  // Baked as it is already: nothing to do.
  if (transition.baked?.key && transition.baked.key === (await bakeKey({ transition, ...sources }))) return 'baked'
  const key = await bakePair(deps, playlistId, { a, b }, transition)
  return (await attachBaked(deps.lumioFetch, playlistId, pair, key, sources)) ? 'baked' : 'skipped'
}
