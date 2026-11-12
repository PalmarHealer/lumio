import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api'
import { IconAlertTriangle, IconArrowsSort, IconLoader2, IconRefresh, IconVinyl } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAuthedSession } from '@/features/auth/session'
import { formatRuntime, secondsToTicks } from '@/lib/format'
import { defineMessages, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { analysable, MixerSaveError, usePlaylistMixer, useSaveMixer, useTrackMixes } from './queries'
import { entriesInOrder, hasSharedEntries, planMoves } from './reorder'
import type { SortMessage, SortRequest } from './sort-worker'
import type { MixStyle, PresetId, TrackMix } from './types'

/**
 * Every transition kind gets a name wherever one is shown. `reverbOut` is on its way into the planner's presets; the
 * union keeps its name ready, and a preset added to `PresetId` without a name here fails to compile.
 */
type LabelledPreset = PresetId

const PRESET_NAMES = {
  de: {
    auto: 'Automatisch',
    blend: 'Langer Mix',
    crossfade: 'Überblendung',
    fadeOut: 'Ausblenden',
    fadeIn: 'Einblenden',
    bassSwap: 'Bass-Tausch',
    filterBuild: 'Filter-Aufbau',
    echoOut: 'Echo-Ausklang',
    reverbOut: 'Hall-Ausklang',
    dropSwap: 'Drop-Wechsel',
    hardCut: 'Harter Schnitt',
    brake: 'Bremse',
    none: 'Direkt hintereinander',
  } satisfies Record<LabelledPreset, string>,
  en: {
    auto: 'Automatic',
    blend: 'Long blend',
    crossfade: 'Crossfade',
    fadeOut: 'Fade out',
    fadeIn: 'Fade in',
    bassSwap: 'Bass swap',
    filterBuild: 'Filter build',
    echoOut: 'Echo out',
    reverbOut: 'Reverb out',
    dropSwap: 'Drop swap',
    hardCut: 'Hard cut',
    brake: 'Brake',
    none: 'Back to back',
  } satisfies Record<LabelledPreset, string>,
}

const messages = defineMessages({
  de: {
    mixer: 'Mixer',
    mixerMode: 'Mixer-Modus',
    mixerOn: 'Mixer-Modus an: Songs gehen mit DJ-Übergängen ineinander über',
    build: 'Sortieren & Übergänge bauen',
    buildDescription: 'Lumio bringt die Songs in eine Reihenfolge, die sich gut mischen lässt, und plant jeden Übergang neu.',
    style: 'Stil',
    clean: 'Clean',
    cleanHint: 'Songs laufen ganz, sanfte Übergänge, sortiert nach Tonart, Tempo und Stimmung',
    party: 'Party',
    partyHint: 'Intros und Outros gekürzt, Einstieg auf Drop oder Refrain, Energiebogen',
    computing: 'Wird sortiert …',
    building: (done: number, total: number) => `Übergänge ${done}/${total}`,
    estimate: 'Schätzung, wird genauer, während die Übergänge entstehen',
    kinds: 'Übergänge',
    newAnalyses: (n: number) => (n === 1 ? '1 neue Analyse: neu berechnen' : `${n} neue Analysen: neu berechnen`),
    preset: (id: LabelledPreset) => PRESET_NAMES.de[id],
    shorter: (percent: number) => `Playlist wird ~${percent} % kürzer`,
    sameLength: 'Die Länge bleibt fast gleich',
    lengths: (from: string, to: string) => `${from} → ${to}`,
    analysed: (done: number, total: number) => `${done} von ${total} Songs analysiert`,
    missing: (n: number) =>
      `${n === 1 ? '1 Song ist' : `${n} Songs sind`} noch nicht analysiert. Lumio analysiert sie gerade; bis dahin behalten sie ihren Platz und bekommen einfache Überblendungen.`,
    check: 'Erneut prüfen',
    replaced: (n: number) => (n === 1 ? '1 eigener Übergang wird ersetzt' : `${n} eigene Übergänge werden ersetzt`),
    keepCustom: 'Eigene Übergänge behalten, wo das Paar bleibt',
    cancel: 'Abbrechen',
    apply: 'Sortieren & bauen',
    moving: (done: number, total: number) => `Reihenfolge wird gespeichert … ${done}/${total}`,
    saving: 'Übergänge werden gespeichert …',
    done: (n: number) => (n === 1 ? 'Playlist sortiert, 1 Übergang gebaut' : `Playlist sortiert, ${n} Übergänge gebaut`),
    failed: 'Konnte nicht berechnet werden.',
    changed: 'Die Playlist hat sich gerade geändert. Lumio rechnet mit der neuen Reihenfolge noch einmal.',
    partial: (done: number, total: number) =>
      `Die Reihenfolge wurde nur teilweise gespeichert (${done} von ${total} Verschiebungen). Die Übergänge sind noch nicht gespeichert; versuch es noch einmal.`,
    forbidden: 'Nur wer die Playlist bearbeiten darf, kann den Mixer ändern.',
    conflict: 'Jemand anderes hat die Mixer-Einstellungen gerade geändert. Versuch es noch einmal.',
    saveFailed: 'Die Mixer-Einstellungen konnten nicht gespeichert werden.',
    tooShort: 'Für Übergänge braucht die Playlist mindestens zwei Songs.',
    notReached:
      'Jellyfin hat die Songs nicht ganz in die neue Reihenfolge gebracht (vermutlich wegen Songs, die du nicht sehen kannst). Die Übergänge sind nicht gespeichert.',
    duplicates:
      'Diese Playlist enthält Songs doppelt. Jellyfin kann doppelte Einträge nicht einzeln verschieben, deshalb lässt sie sich nicht automatisch sortieren. Entferne die doppelten Songs und versuch es noch einmal.',
  },
  en: {
    mixer: 'Mixer',
    mixerMode: 'Mixer mode',
    mixerOn: 'Mixer mode on: songs flow into each other with DJ transitions',
    build: 'Sort & build transitions',
    buildDescription: 'Lumio puts the songs in an order that mixes well and plans every transition anew.',
    style: 'Style',
    clean: 'Clean',
    cleanHint: 'Songs play in full, smooth transitions, sorted by key, tempo and mood',
    party: 'Party',
    partyHint: 'Intros and outros shortened, entry on the drop or chorus, energy arc',
    computing: 'Sorting …',
    building: (done: number, total: number) => `Transitions ${done}/${total}`,
    estimate: 'Estimate, firms up as the transitions are built',
    kinds: 'Transitions',
    newAnalyses: (n: number) => (n === 1 ? '1 new analysis: work it out again' : `${n} new analyses: work it out again`),
    preset: (id: LabelledPreset) => PRESET_NAMES.en[id],
    shorter: (percent: number) => `Playlist gets ~${percent} % shorter`,
    sameLength: 'The length stays about the same',
    lengths: (from: string, to: string) => `${from} → ${to}`,
    analysed: (done: number, total: number) => `${done} of ${total} songs analysed`,
    missing: (n: number) =>
      `${n === 1 ? '1 song is' : `${n} songs are`} not analysed yet. Lumio is analysing them now; until then they keep their place and get plain crossfades.`,
    check: 'Check again',
    replaced: (n: number) => (n === 1 ? '1 custom transition will be replaced' : `${n} custom transitions will be replaced`),
    keepCustom: 'Keep custom transitions where the pair stays',
    cancel: 'Cancel',
    apply: 'Sort & build',
    moving: (done: number, total: number) => `Saving the order … ${done}/${total}`,
    saving: 'Saving the transitions …',
    done: (n: number) => (n === 1 ? 'Playlist sorted, 1 transition built' : `Playlist sorted, ${n} transitions built`),
    failed: 'Could not be worked out.',
    changed: 'The playlist just changed. Lumio works it out again with the new order.',
    partial: (done: number, total: number) =>
      `The order was only partly saved (${done} of ${total} moves). The transitions aren't saved yet; please try again.`,
    forbidden: 'Only those who may edit the playlist can change its mixer.',
    conflict: 'Someone else just changed the mixer settings. Please try again.',
    saveFailed: 'The mixer settings could not be saved.',
    tooShort: 'Transitions need at least two songs in the playlist.',
    notReached:
      "Jellyfin didn't quite put the songs in the new order (probably because of songs you can't see). The transitions aren't saved.",
    duplicates:
      "This playlist has songs in it twice. Jellyfin can't move repeated entries one by one, so it can't be sorted automatically. Remove the repeated songs and try again.",
  },
})

type Messages = (typeof messages)['de']

function saveErrorText(t: Messages, error: unknown) {
  if (error instanceof MixerSaveError && error.status === 403) return t.forbidden
  if (error instanceof MixerSaveError && error.status === 409) return t.conflict
  return t.saveFailed
}

/** The mark beside "Playlist" in a mixer playlist's header. */
export function MixerBadge() {
  const t = useMessages(messages)
  return (
    <span title={t.mixerOn} className="inline-flex items-center gap-1 rounded-full bg-listen/15 px-2 py-0.5 text-xs font-semibold text-listen">
      <IconVinyl className="size-3.5" stroke={2} />
      {t.mixer}
    </span>
  )
}

/** A switch drawn like the settings' (never a native checkbox), small enough for a menu row. */
function SwitchMark({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={cn('ml-auto inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors', checked ? 'bg-primary' : 'bg-input')}>
      <span className={cn('size-3 rounded-full shadow transition-transform', checked ? 'translate-x-3 bg-primary-foreground' : 'bg-background')} />
    </span>
  )
}

/**
 * The mixer's entries in a playlist's "…" menu, for those who may edit it: the mixer mode switch (the menu stays open)
 * and, while it is on, "Sort & build transitions".
 */
export function MixerMenuItems({ playlistId, onBuild }: { playlistId: string; onBuild: () => void }) {
  const t = useMessages(messages)
  const mixer = usePlaylistMixer(playlistId)
  const save = useSaveMixer(playlistId)
  // Without the Lumio server (or before it answered) there is nothing to switch.
  if (!mixer.isSuccess) return null
  const on = mixer.data.on
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={on}
        closeOnClick={false}
        indicator={<SwitchMark checked={on} />}
        onCheckedChange={(checked) => save.mutate({ on: checked }, { onError: (error) => void toast.error(saveErrorText(t, error)) })}
      >
        <IconVinyl /> {t.mixerMode}
      </DropdownMenuCheckboxItem>
      {/* Open with fewer than two songs too: the dialog says why there is nothing to build. */}
      {on && (
        <DropdownMenuItem onClick={onBuild}>
          <IconArrowsSort /> {t.build}
        </DropdownMenuItem>
      )}
    </>
  )
}

/** While the dialog is open, songs without an analysis are asked for again this often (the server works on them). */
const POLL_MS = 10_000

type Phase = { kind: 'idle' } | { kind: 'moving'; done: number; total: number } | { kind: 'saving' } | { kind: 'error'; text: string }

const trackSignature = (tracks: readonly BaseItemDto[]) => tracks.map((track) => `${track.PlaylistItemId}:${track.Id}`).join(',')

/**
 * "Sort & build transitions": asks for the style, shows what it does (how much shorter the playlist gets, how many
 * songs aren't analysed yet, which custom transitions go), then saves the new order to Jellyfin and the transitions
 * and style to the Lumio server.
 *
 * The order is saved with as few moves as possible (see reorder.ts), one after the other. Should one fail, the rest
 * isn't tried, the playlist shows what Jellyfin has now, and the transitions aren't saved (they belong to the order
 * that wasn't reached); trying again works it out from the order as it is.
 */
export function SortBuildDialog({ playlistId, tracks, open, onOpenChange }: { playlistId: string; tracks: BaseItemDto[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(messages)
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const mixer = usePlaylistMixer(playlistId)
  const save = useSaveMixer(playlistId)
  const [style, setStyle] = useState<MixStyle>(mixer.data?.style ?? 'clean')
  const [keepCustom, setKeepCustom] = useState(false)
  /** The answers for the newest ask, as they come: the order first, then progress, then everything. */
  const [ordered, setOrdered] = useState<Extract<SortMessage, { kind: 'order' }> | null>(null)
  const [progress, setProgress] = useState<Extract<SortMessage, { kind: 'progress' }> | null>(null)
  const [result, setResult] = useState<Extract<SortMessage, { kind: 'done' }> | null>(null)
  const [computeFailed, setComputeFailed] = useState(false)
  const applying = useRef(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const busy = phase.kind === 'moving' || phase.kind === 'saving'

  const ids = useMemo(() => tracks.map((track) => track.Id ?? '').filter(analysable), [tracks])
  const analyses = useTrackMixes(ids, { enabled: open, pollMs: POLL_MS })
  const signature = trackSignature(tracks)
  const duplicates = useMemo(() => hasSharedEntries(tracks.map((track) => track.PlaylistItemId)), [tracks])
  /**
   * The analyses the order is worked out from. Taken once they have all answered, and again only when asked: songs
   * analysed meanwhile would otherwise start the sorting and the long build over and over while the server works.
   */
  const [basis, setBasis] = useState<Map<string, TrackMix | null> | null>(null)

  // Each opening starts from the playlist's own style and the analyses as they are then.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    setBasis(null)
    setOrdered(null)
    setProgress(null)
    setResult(null)
    if (open) {
      setStyle(mixer.data?.style ?? 'clean')
      setKeepCustom(false)
      setComputeFailed(false)
      setPhase({ kind: 'idle' })
    }
  }
  if (open && analyses.loaded && basis === null) setBasis(analyses.mixes)
  const newAnalyses = basis ? [...analyses.mixes.entries()].filter(([id, mix]) => mix && !basis.get(id)).length : 0

  // The worker lives while the dialog is open; closing it stops a build under way.
  const worker = useRef<Worker | null>(null)
  const ask = useRef(0)
  /** The order found for a style, these songs and these analyses, so "keep custom" only builds the transitions again. */
  const sorted = useRef<{ key: string; order: string[] } | null>(null)
  const askedKey = useRef('')
  useEffect(() => {
    if (!open) return
    const created = new Worker(new URL('./sort-worker.ts', import.meta.url), { type: 'module' })
    created.onmessage = (event: MessageEvent<SortMessage>) => {
      const message = event.data
      if (message.ask !== ask.current) return
      if (message.kind === 'order') {
        sorted.current = { key: askedKey.current, order: message.order }
        setOrdered(message)
      } else if (message.kind === 'progress') setProgress(message)
      else if (message.kind === 'done') setResult(message)
      else setComputeFailed(true)
    }
    created.onerror = () => setComputeFailed(true)
    worker.current = created
    return () => {
      created.terminate()
      worker.current = null
      sorted.current = null
    }
  }, [open])

  const existing = mixer.data ?? null
  // What the result must have been worked out from to be applied: an answer for an older style or "keep custom" (the
  // newer one is on its way) must not be saved.
  const sortKey = basis ? `${style}|${signature}|${[...basis.entries()].map(([id, mix]) => (mix ? id : '')).join(',')}` : ''
  const inputs = `${sortKey}|${keepCustom}|${existing?.updated ?? 0}`
  useEffect(() => {
    if (!open || !worker.current || !basis || tracks.length < 2 || duplicates) return
    const sameOrder = sorted.current?.key === sortKey
    const request: SortRequest = {
      ask: ++ask.current,
      inputs,
      tracks: tracks.map((track) => ({ id: track.Id ?? '', mix: basis.get(track.Id ?? '') ?? null })),
      style,
      existing,
      keepCustom,
      durations: Object.fromEntries(tracks.map((track) => [track.Id ?? '', (track.RunTimeTicks ?? 0) / 10_000_000])),
      order: sameOrder ? sorted.current!.order : undefined,
    }
    askedKey.current = sortKey
    if (!sameOrder) setOrdered(null)
    setProgress(null)
    setResult(null)
    setComputeFailed(false)
    worker.current.postMessage(request)
  }, [open, basis, tracks, style, keepCustom, existing, duplicates, sortKey, inputs])

  const apply = async () => {
    // A second click before the dialog shows it is busy must not start a second round of moves.
    if (!result || result.inputs !== inputs || applying.current) return
    applying.current = true
    try {
      await applyResult(result)
    } finally {
      applying.current = false
    }
  }

  const applyResult = async (result: Extract<SortMessage, { kind: 'done' }>) => {
    const basis = signature
    setPhase({ kind: 'moving', done: 0, total: 0 })
    const tracksKey = ['playlist-tracks', session.userId, playlistId]
    try {
      // What Jellyfin has now must be the order that was sorted (someone may have changed it meanwhile).
      const playlists = getPlaylistApi(api)
      const fresh = (await playlists.getPlaylistItems({ playlistId, userId: session.userId })).data.Items ?? []
      if (hasSharedEntries(fresh.map((track) => track.PlaylistItemId))) {
        void queryClient.invalidateQueries({ queryKey: tracksKey })
        setPhase({ kind: 'error', text: t.duplicates })
        return
      }
      if (trackSignature(fresh) !== basis) {
        void queryClient.invalidateQueries({ queryKey: tracksKey })
        setPhase({ kind: 'error', text: t.changed })
        return
      }
      const entries = fresh.map((track) => ({ id: track.Id ?? '', entry: track.PlaylistItemId ?? '' }))
      const moves = planMoves(
        entries.map((entry) => entry.entry),
        entriesInOrder(entries, result.order),
      )
      let done = 0
      setPhase({ kind: 'moving', done, total: moves.length })
      for (const move of moves) {
        try {
          await playlists.moveItem({ playlistId, itemId: move.entry, newIndex: move.index })
        } catch {
          void queryClient.invalidateQueries({ queryKey: tracksKey })
          setPhase({ kind: 'error', text: t.partial(done, moves.length) })
          return
        }
        done++
        setPhase({ kind: 'moving', done, total: moves.length })
      }
      if (moves.length) {
        // Jellyfin counts positions among the songs this person can see; with hidden ones in the playlist a move can
        // land elsewhere than planned. Transitions are only saved for the order that was really reached.
        const after = (await playlists.getPlaylistItems({ playlistId, userId: session.userId })).data.Items ?? []
        await queryClient.invalidateQueries({ queryKey: tracksKey })
        if (after.map((track) => track.Id).join(',') !== result.order.join(',')) {
          setPhase({ kind: 'error', text: t.notReached })
          return
        }
      }
    } catch {
      setPhase({ kind: 'error', text: t.saveFailed })
      return
    }
    setPhase({ kind: 'saving' })
    save.mutate(
      { on: true, style, transitions: result.transitions },
      {
        onSuccess: () => {
          toast.success(t.done(Object.keys(result.transitions).length))
          onOpenChange(false)
        },
        onError: (error) => setPhase({ kind: 'error', text: saveErrorText(t, error) }),
      },
    )
  }

  const missing = analyses.total - analyses.analysed
  const shorterBy = result ? Math.round(result.length.shorterBy * 100) : progress?.shorterBy != null ? Math.round(progress.shorterBy * 100) : null
  const ready = !!result && result.inputs === inputs && !computeFailed && tracks.length >= 2 && !duplicates
  const building = !!ordered && !result && !computeFailed
  const builtCount = result ? (ordered?.pairs ?? 0) : (progress?.done ?? 0)
  // The kinds of transitions built, most used first.
  const kinds = useMemo(() => {
    if (!result) return []
    const counts = new Map<PresetId, number>()
    for (const transition of Object.values(result.transitions)) counts.set(transition.preset, (counts.get(transition.preset) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [result])
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-5 overflow-y-auto p-6 sm:max-w-lg">
        <div className="space-y-1 pr-8">
          <DialogTitle className="text-xl font-bold">{t.build}</DialogTitle>
          <DialogDescription>{t.buildDescription}</DialogDescription>
        </div>

        <div role="radiogroup" aria-label={t.style} className="grid gap-2 sm:grid-cols-2">
          {(['clean', 'party'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={style === option}
              // One tab stop for the group; the arrow keys move between the styles (as with native radio buttons).
              tabIndex={style === option ? 0 : -1}
              disabled={busy}
              onClick={() => setStyle(option)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
                event.preventDefault()
                const next = option === 'clean' ? 'party' : 'clean'
                setStyle(next)
                const sibling = option === 'clean' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
                ;(sibling as HTMLElement | null)?.focus()
              }}
              className={cn(
                'rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
                style === option ? 'border-listen bg-listen/10' : 'border-border hover:bg-muted',
              )}
            >
              <span className={cn('block font-semibold', style === option && 'text-listen')}>{option === 'clean' ? t.clean : t.party}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{option === 'clean' ? t.cleanHint : t.partyHint}</span>
            </button>
          ))}
        </div>

        <div className="space-y-2" aria-live="polite">
          {computeFailed ? (
            <p className="text-sm text-destructive">{t.failed}</p>
          ) : ordered ? (
            <>
              {shorterBy !== null && (
                <div>
                  <p className="text-lg font-semibold">{shorterBy >= 1 ? t.shorter(shorterBy) : t.sameLength}</p>
                  {result ? (
                    result.length.original > 0 &&
                    shorterBy >= 1 && (
                      <p className="text-sm text-muted-foreground tabular-nums">
                        {t.lengths(formatRuntime(secondsToTicks(result.length.original)) ?? '', formatRuntime(secondsToTicks(result.length.mixed)) ?? '')}
                      </p>
                    )
                  ) : (
                    <p className="text-sm text-muted-foreground">{t.estimate}</p>
                  )}
                </div>
              )}
              {ordered.pairs > 0 && (
                <div className="space-y-1.5">
                  <p className="flex items-center gap-2 text-sm tabular-nums">
                    {building && <IconLoader2 className="size-4 animate-spin text-muted-foreground" />}
                    {t.building(builtCount, ordered.pairs)}
                  </p>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={t.kinds}
                    aria-valuemin={0}
                    aria-valuemax={ordered.pairs}
                    aria-valuenow={builtCount}
                  >
                    <div className="h-full rounded-full bg-listen transition-[width] duration-300" style={{ width: `${(builtCount / ordered.pairs) * 100}%` }} />
                  </div>
                  {kinds.length > 0 && <p className="text-sm text-muted-foreground">{kinds.map(([preset, count]) => `${count}× ${t.preset(preset)}`).join(' · ')}</p>}
                </div>
              )}
            </>
          ) : (
            tracks.length >= 2 &&
            !duplicates && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <IconLoader2 className="size-4 animate-spin" /> {t.computing}
              </p>
            )
          )}
          {tracks.length < 2 && <p className="text-sm text-muted-foreground">{t.tooShort}</p>}
          {duplicates && <p className="text-sm text-destructive">{t.duplicates}</p>}
        </div>

        {analyses.total > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="tabular-nums">{t.analysed(analyses.analysed, analyses.total)}</span>
              {missing > 0 && (
                <Button size="sm" variant="ghost" onClick={analyses.refresh} disabled={busy}>
                  <IconRefresh /> {t.check}
                </Button>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={analyses.total} aria-valuenow={analyses.analysed}>
              <div className="h-full rounded-full bg-listen transition-[width] duration-500" style={{ width: `${(analyses.analysed / analyses.total) * 100}%` }} />
            </div>
            {missing > 0 && analyses.loaded && <p className="text-sm text-muted-foreground">{t.missing(missing)}</p>}
            {newAnalyses > 0 && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setBasis(analyses.mixes)}>
                <IconRefresh /> {t.newAnalyses(newAnalyses)}
              </Button>
            )}
          </div>
        )}

        {ordered && (ordered.replacedCustom > 0 || keepCustom) && (
          <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            {ordered.replacedCustom > 0 && (
              <p className="flex items-center gap-2 text-sm font-medium">
                <IconAlertTriangle className="size-4 shrink-0 text-amber-500" /> {t.replaced(ordered.replacedCustom)}
              </p>
            )}
            <button
              type="button"
              role="switch"
              aria-checked={keepCustom}
              disabled={busy}
              onClick={() => setKeepCustom(!keepCustom)}
              className="flex w-full items-center gap-3 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex-1">{t.keepCustom}</span>
              <SwitchMark checked={keepCustom} />
            </button>
          </div>
        )}

        {phase.kind === 'error' && <p className="text-sm text-destructive">{phase.text}</p>}

        <DialogFooter className="items-center gap-2">
          {phase.kind === 'moving' && phase.total > 0 && <span className="mr-auto text-sm text-muted-foreground tabular-nums">{t.moving(phase.done, phase.total)}</span>}
          {phase.kind === 'saving' && <span className="mr-auto text-sm text-muted-foreground">{t.saving}</span>}
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button disabled={!ready || busy} onClick={() => void apply()}>
            {busy && <IconLoader2 className="animate-spin" />}
            {t.apply}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
