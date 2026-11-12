import { IconArrowLeft, IconArrowRight, IconDeviceFloppy, IconLoader2, IconMaximize, IconMinimize } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router'
import { toast } from 'sonner'
import { Link } from '@/components/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useItem } from '@/features/items/queries'
import { closeListenPanel, openListenPanel, setListenLayout, useListenLayout, useListenPanel } from '../../player/panel'
import { ticksToSeconds } from '@/lib/format'
import { defineMessages, useMessages } from '@/lib/i18n'
import { ENGINE_VERSION } from '../baked'
import { PLANNER_VERSION } from '../planner'
import { MixerSaveError, usePlaylistMixer, useSaveMixer, useStableLumioFetch, useTrackMixes } from '../queries'
import { transitionFor } from '../resolve'
import { pairKey, type Transition } from '../types'
import { editDiff } from './timeline-math'
import { TransitionEditor } from './transition-editor'
import { useSuggestions } from './use-assist'
import { useTransitionPreview } from './use-preview'
import { useDeckStems } from './use-stems'

const messages = defineMessages({
  de: {
    title: 'Übergang bearbeiten',
    back: 'Zurück zur Playlist',
    save: 'Speichern',
    saved: 'Übergang gespeichert',
    unsaved: 'Nicht gespeichert',
    loading: 'Analysen werden geladen …',
    noAnalysis: 'Für diese Songs gibt es noch keine Analyse. Lumio analysiert sie gerade; bis dahin zeigt der Editor eine einfache Überblendung ohne Wellenform.',
    forbidden: 'Nur wer die Playlist bearbeiten darf, kann Übergänge speichern.',
    conflict: 'Jemand anderes hat die Übergänge gerade geändert. Lade die Seite neu und versuch es noch einmal.',
    failed: 'Der Übergang konnte nicht gespeichert werden.',
    fullscreen: 'Ganzer Bildschirm',
    leaveFullscreen: 'Ganzen Bildschirm verlassen',
  },
  en: {
    title: 'Edit transition',
    back: 'Back to the playlist',
    save: 'Save',
    saved: 'Transition saved',
    unsaved: 'Not saved',
    loading: 'Loading the analyses …',
    noAnalysis: 'These songs have no analysis yet. Lumio is analysing them now; until then the editor shows a plain crossfade without a waveform.',
    forbidden: 'Only those who may edit the playlist can save transitions.',
    conflict: 'Someone else just changed the transitions. Reload the page and try again.',
    failed: 'The transition could not be saved.',
    fullscreen: 'Full screen',
    leaveFullscreen: 'Leave full screen',
  },
})

/**
 * `/listen/playlist/:id/mix/:from/:to`: the transition from one song of a mixer playlist into the next, in the editor.
 * It starts from the stored transition for the pair (or the automatic one) and saves it as the pair's hand-made one.
 */
export function TransitionEditorPage() {
  const t = useMessages(messages)
  const { id = '', from = '', to = '' } = useParams()
  const a = useItem(from)
  const b = useItem(to)
  const mixer = usePlaylistMixer(id)
  const save = useSaveMixer(id)
  const ids = useMemo(() => [from, to], [from, to])
  const analyses = useTrackMixes(ids)
  const [edited, setEdited] = useState<Transition | null>(null)
  // The editor gets the width: the "Läuft gerade" panel folds and the library sidebar narrows while it is open, and
  // both come back as they were when leaving it.
  const panel = useListenPanel()
  const layout = useListenLayout()
  useEffect(() => {
    const panelWasOpen = panel.open
    const sidebarWasOpen = !layout.collapsed
    if (panelWasOpen) closeListenPanel()
    if (sidebarWasOpen) setListenLayout({ collapsed: true })
    return () => {
      if (panelWasOpen) openListenPanel()
      if (sidebarWasOpen) setListenLayout({ collapsed: false })
    }
    // Once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The editor over the whole window (tablets: the app's side panels take much of the width). Escape leaves it.
  const [full, setFull] = useState(false)
  const [host] = useState(() => document.createElement('div'))
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    host.className = full ? 'fixed inset-0 z-[60] overflow-auto bg-background p-4 sm:p-6' : ''
    ;(full ? document.body : slot.current)?.appendChild(host)
  }, [full, host])
  useEffect(() => () => host.remove(), [host])
  useEffect(() => {
    if (!full) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const aMix = analyses.mixes.get(from) ?? null
  const bMix = analyses.mixes.get(to) ?? null
  const aDuration = aMix?.duration ?? ticksToSeconds(a.data?.RunTimeTicks ?? 0)
  const bDuration = bMix?.duration ?? ticksToSeconds(b.data?.RunTimeTicks ?? 0)
  const ready = analyses.loaded && (mixer.isSuccess || mixer.isError) && !!a.data && !!b.data
  const initial = useMemo(
    () =>
      ready
        ? transitionFor(mixer.data ?? null, from, to, analyses.mixes, mixer.data?.style ?? 'clean', { durations: { [from]: aDuration, [to]: bDuration } })
        : null,
    // Worked out once, when everything has loaded: later refetches mustn't replace what is being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready],
  )

  // What is being edited right now (also mid-drag), for the preview.
  const [live, setLive] = useState<Transition | null>(null)
  const preview = useTransitionPreview({ fromId: from, toId: to, transition: live ?? initial, aDuration, bDuration })
  // Real stems in Mix-Modus, for the transition as last saved or edited (not every drag).
  const stems = useDeckStems({ playlistId: id, from, to, transition: edited ?? initial, preview })

  const suggestions = useSuggestions(aMix, bMix, { from, to }, mixer.data?.style ?? 'clean')

  // Where the edit started (for the training data): the stored or automatic plan, until another start is picked.
  const [start, setStart] = useState<{ variant: string | null; plan: Transition } | null>(null)
  const origin = start ?? (initial ? { variant: mixer.data?.transitions?.[pairKey(from, to)] ? 'stored' : 'auto', plan: initial } : null)
  const lumioFetch = useStableLumioFetch()

  /** What the person made, with what it started from: training data for the planner (best effort, never in the way). */
  const recordTraining = (final: Transition) => {
    if (!origin) return
    const body = {
      playlistId: id,
      pair: pairKey(from, to),
      start: origin.variant === null ? null : { variant: origin.variant, plan: origin.plan },
      final,
      diff: editDiff(origin.plan, final),
      versions: { a: aMix?.v ?? null, b: bMix?.v ?? null },
      engine: ENGINE_VERSION,
      planner: PLANNER_VERSION,
      style: mixer.data?.style ?? 'clean',
    }
    void lumioFetch('/music/mix/training', { method: 'POST', body: JSON.stringify(body) }).catch(() => undefined)
  }

  const onSave = () => {
    if (!edited) return
    // An edited transition plays live until it is baked again (leaving Mix-Modus): its old clip no longer fits.
    const { baked: _baked, ...rest } = edited
    const transition: Transition = { ...rest, custom: true }
    save.mutate(
      { transitions: { ...(mixer.data?.transitions ?? {}), [pairKey(from, to)]: transition } },
      {
        onSuccess: () => {
          recordTraining(transition)
          setEdited(null)
          toast.success(t.saved)
        },
        onError: (error) =>
          void toast.error(error instanceof MixerSaveError && error.status === 403 ? t.forbidden : error instanceof MixerSaveError && error.status === 409 ? t.conflict : t.failed),
      },
    )
  }

  const content = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to={`/listen/playlist/${id}`} aria-label={t.back} title={t.back} className={buttonVariants({ variant: 'ghost', size: 'icon' })}>
          <IconArrowLeft />
        </Link>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span className="truncate">{a.data?.Name ?? '…'}</span>
            <IconArrowRight className="size-4 shrink-0" />
            <span className="truncate">{b.data?.Name ?? '…'}</span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label={full ? t.leaveFullscreen : t.fullscreen} title={full ? t.leaveFullscreen : t.fullscreen} aria-pressed={full} onClick={() => setFull(!full)}>
            {full ? <IconMinimize /> : <IconMaximize />}
          </Button>
          {edited && <span className="text-sm text-muted-foreground">{t.unsaved}</span>}
          <Button disabled={!edited || save.isPending} onClick={onSave}>
            {save.isPending ? <IconLoader2 className="animate-spin" /> : <IconDeviceFloppy />}
            {t.save}
          </Button>
        </div>
      </div>

      {!initial ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t.loading}</p>
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      ) : (
        <>
          {(!aMix || !bMix) && <p className="text-sm text-muted-foreground">{t.noAnalysis}</p>}
          <TransitionEditor
            initial={initial}
            aMix={aMix}
            bMix={bMix}
            aTitle={a.data?.Name ?? ''}
            bTitle={b.data?.Name ?? ''}
            aDuration={aDuration}
            bDuration={bDuration}
            onChange={setEdited}
            onLive={setLive}
            preview={preview}
            suggestions={suggestions}
            onStart={setStart}
            stems={stems}
          />
        </>
      )}
    </div>
  )
  // The editor renders into a box of its own that moves: into the page, or over the whole window (out of the page's
  // stacking context, under which the app's panels would stay on top). Moving the box keeps the editor as it is (its
  // undo history, the loaded audio), where switching between two places in the tree would start it over.
  return (
    <div ref={slot} className={full ? undefined : 'px-4 pt-16 pb-12 sm:px-8'}>
      {createPortal(content, host)}
    </div>
  )
}
