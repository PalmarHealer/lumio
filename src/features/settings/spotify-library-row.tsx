import { IconBrandSpotify, IconLoader2 } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { useAuthedSession } from '@/features/auth/session'
import { useLumioFetch } from '@/features/social/social'
import { importLibrary, planLibraryImport, readSpotifyLibrary, refreshAfterImport, removeLibraryImport, type LibraryPart, type LibraryPlan, type LibraryStep } from '@/features/listen/library-import'
import { usePendingImports } from '@/features/listen/library-import-state'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { Row } from './fields'

const messages = defineMessages({
  de: {
    label: 'Spotify-Bibliothek importieren',
    hint: 'Lieblingssongs, gespeicherte Alben, Künstler, denen du folgst, Playlists und Podcasts aus deinem Spotify-Kontodatenexport (die Zip-Datei, oder YourLibrary.json und die Playlist-Dateien). Was in Jellyfin noch fehlt, bleibt ausgegraut in deiner Bibliothek und rückt nach, sobald es da ist.',
    choose: 'Dateien wählen',
    waiting: (count: string) => `${count} Titel warten noch auf Jellyfin.`,
    nothing: 'Nichts wartet auf Jellyfin.',
    forget: 'Import vergessen',
    reading: 'Dateien lesen …',
    library: (done: number, total: number) => `Mit deiner Bibliothek abgleichen … ${done} von ${total} Songs`,
    podcasts: (done: number, total: number) => `Podcasts suchen … ${done} von ${total}`,
    saving: (done: number, total: number) => `In deine Bibliothek übernehmen … ${done} von ${total}`,
    reviewTitle: 'Was soll mit?',
    reviewDescription: 'Gefunden heißt: schon in Jellyfin. Der Rest wartet ausgegraut, bis er da ist.',
    tracks: 'Lieblingssongs',
    albums: 'Alben',
    artists: 'Künstler*innen',
    playlists: (count: number) => `Playlists (${count})`,
    podcasts_: 'Podcasts und gespeicherte Folgen',
    found: (found: string, total: string) => `${found} von ${total} gefunden`,
    podcastsFound: (shows: string, showTotal: string, episodes: string, episodeTotal: string) => `${shows} von ${showTotal} Podcasts, ${episodes} von ${episodeTotal} Folgen gefunden`,
    importButton: 'Importieren',
    cancel: 'Abbrechen',
    done: (found: string, waiting: string) => `${found} übernommen, ${waiting} warten auf Jellyfin`,
    noLibrary: 'In den Dateien ist keine Spotify-Bibliothek (YourLibrary.json oder Playlist-Dateien).',
    failed: 'Der Import hat nicht geklappt. Versuch es noch einmal.',
    forgetTitle: 'Import vergessen?',
    forgetDescription: 'Ausgegraute Einträge verschwinden und rücken nicht mehr nach. Was schon in deiner Bibliothek ist (Favoriten, Playlists), bleibt.',
    forgotten: 'Import vergessen',
  },
  en: {
    label: 'Import your Spotify library',
    hint: 'Liked songs, saved albums, artists you follow, playlists and podcasts from your Spotify account data export (the zip file, or YourLibrary.json and the playlist files). What Jellyfin doesn’t have yet stays greyed out in your library and moves in once it arrives.',
    choose: 'Choose files',
    waiting: (count: string) => `${count} items are waiting for Jellyfin.`,
    nothing: 'Nothing is waiting for Jellyfin.',
    forget: 'Forget import',
    reading: 'Reading files …',
    library: (done: number, total: number) => `Matching your library … ${done} of ${total} songs`,
    podcasts: (done: number, total: number) => `Looking for podcasts … ${done} of ${total}`,
    saving: (done: number, total: number) => `Adding to your library … ${done} of ${total}`,
    reviewTitle: 'What should come along?',
    reviewDescription: 'Found means: already in Jellyfin. The rest waits, greyed out, until it arrives.',
    tracks: 'Liked songs',
    albums: 'Albums',
    artists: 'Artists',
    playlists: (count: number) => `Playlists (${count})`,
    podcasts_: 'Podcasts and saved episodes',
    found: (found: string, total: string) => `${found} of ${total} found`,
    podcastsFound: (shows: string, showTotal: string, episodes: string, episodeTotal: string) => `${shows} of ${showTotal} podcasts, ${episodes} of ${episodeTotal} episodes found`,
    importButton: 'Import',
    cancel: 'Cancel',
    done: (found: string, waiting: string) => `${found} added, ${waiting} waiting for Jellyfin`,
    noLibrary: 'There is no Spotify library in these files (YourLibrary.json or playlist files).',
    failed: 'The import didn’t work. Please try again.',
    forgetTitle: 'Forget the import?',
    forgetDescription: 'Greyed-out entries disappear and won’t move in anymore. What is already in your library (favourites, playlists) stays.',
    forgotten: 'Import forgotten',
  },
})

/** Settings → Music: bringing the Spotify library over (see library-import.ts). */
export function SpotifyLibraryRow() {
  const { api, session } = useAuthedSession()
  const t = useMessages(messages)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const request = useLumioFetch()
  const queryClient = useQueryClient()
  const pending = usePendingImports()
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<LibraryStep | 'reading' | null>(null)
  const [plan, setPlan] = useState<LibraryPlan | null>(null)
  const [parts, setParts] = useState<Set<LibraryPart>>(new Set(['tracks', 'albums', 'artists', 'playlists', 'podcasts']))
  const [forgetting, setForgetting] = useState(false)

  const read = async (files: File[]) => {
    if (!files.length) return
    setStep('reading')
    try {
      const library = await readSpotifyLibrary(files)
      setPlan(await planLibraryImport(api, session.userId, library, setStep))
    } catch (error) {
      toast.error(error instanceof Error && error.message === 'no-library' ? t.noLibrary : t.failed)
    } finally {
      setStep(null)
    }
  }

  const run = async () => {
    if (!plan) return
    const chosen = parts
    setPlan(null)
    setStep({ step: 'saving', done: 0, total: 0 })
    try {
      const result = await importLibrary(api, session.userId, request, plan, chosen, setStep)
      toast.success(t.done(number.format(result.found), number.format(result.waiting)))
    } catch {
      toast.error(t.failed)
    } finally {
      setStep(null)
      refreshAfterImport(queryClient, session.userId)
    }
  }

  const progress =
    step === 'reading'
      ? t.reading
      : step?.step === 'library'
        ? t.library(step.done, step.total)
        : step?.step === 'podcasts'
          ? t.podcasts(step.done, step.total)
          : step
            ? t.saving(step.done, step.total)
            : null
  const fraction = step && step !== 'reading' && step.total ? step.done / step.total : 0
  const found = <T extends { id?: string }>(list: T[]) => t.found(number.format(list.filter((entry) => entry.id).length), number.format(list.length))
  const songs = plan?.playlists.flatMap((playlist) => playlist.entries) ?? []
  const choices: Array<{ part: LibraryPart; label: string; detail: string; empty: boolean }> = plan
    ? [
        { part: 'tracks', label: t.tracks, detail: found(plan.tracks), empty: !plan.tracks.length },
        { part: 'albums', label: t.albums, detail: found(plan.albums), empty: !plan.albums.length },
        { part: 'artists', label: t.artists, detail: found(plan.artists), empty: !plan.artists.length },
        { part: 'playlists', label: t.playlists(plan.playlists.length), detail: found(songs), empty: !plan.playlists.length },
        {
          part: 'podcasts',
          label: t.podcasts_,
          detail: t.podcastsFound(
            number.format(plan.shows.filter((show) => show.podcast).length),
            number.format(plan.shows.length),
            number.format(plan.episodes.filter((episode) => episode.episode).length),
            number.format(plan.episodes.length),
          ),
          empty: !plan.shows.length && !plan.episodes.length,
        },
      ]
    : []

  return (
    <Row label={t.label} hint={t.hint} htmlFor="spotify-library-import">
      <div className="space-y-2">
        <input
          ref={input}
          id="spotify-library-import"
          type="file"
          multiple
          accept=".zip,.json,application/zip,application/json"
          className="hidden"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void read(files)
          }}
        />
        {step ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-2 text-sm">
              <IconLoader2 className="size-4 animate-spin" />
              {progress}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-listen transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{pending.count ? t.waiting(number.format(pending.count)) : t.nothing}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => input.current?.click()}>
                <IconBrandSpotify />
                {t.choose}
              </Button>
              {pending.count > 0 && (
                <Button size="sm" variant="outline" onClick={() => setForgetting(true)}>
                  {t.forget}
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog open={!!plan} onOpenChange={(open) => !open && setPlan(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{t.reviewTitle}</DialogTitle>
          <DialogDescription>{t.reviewDescription}</DialogDescription>
          <div className="space-y-1">
            {choices
              .filter((choice) => !choice.empty)
              .map((choice) => (
                <label key={choice.part} className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-foreground/5">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--color-listen)]"
                    checked={parts.has(choice.part)}
                    onChange={(event) =>
                      setParts((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(choice.part)
                        else next.delete(choice.part)
                        return next
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{choice.label}</span>
                    <span className="block text-xs text-muted-foreground">{choice.detail}</span>
                  </span>
                </label>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlan(null)}>
              {t.cancel}
            </Button>
            <Button disabled={!choices.some((choice) => !choice.empty && parts.has(choice.part))} onClick={() => void run()}>
              {t.importButton}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={forgetting} onOpenChange={setForgetting}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{t.forgetTitle}</DialogTitle>
          <DialogDescription>{t.forgetDescription}</DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgetting(false)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setForgetting(false)
                void removeLibraryImport(request)
                  .then(() => toast.success(t.forgotten))
                  .catch(() => toast.error(t.failed))
                  .finally(() => refreshAfterImport(queryClient, session.userId))
              }}
            >
              {t.forget}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Row>
  )
}
