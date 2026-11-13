import { IconBrandSpotify, IconLoader2 } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { useAuthedSession } from '@/features/auth/session'
import { useLumioFetch } from '@/features/social/social'
import { importSpotify, removeSpotifyImport, spotifyImportSummary, type ImportStep } from '@/features/listen/spotify-import'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { Row, Section } from './fields'
import { useBranding } from '@/features/admin/branding'
import { SpotifyLibraryRow } from './spotify-library-row'

export const listeningHistoryMessages = defineMessages({
  de: {
    title: 'Hörverlauf',
    description: (app: string) => `Deine Wiedergaben in ${app}, und was du von Spotify mitbringst. Daraus entsteht dein Wrapped.`,
    spotifyLabel: 'Spotify-Verlauf importieren',
    spotifyHint:
      'Lade deinen Spotify-Datenexport hoch (die Zip-Datei oder die JSON-Dateien darin). Am vollständigsten ist der „Erweiterte Streamingverlauf“; anfordern kannst du ihn in deinem Spotify-Konto unter Datenschutz. Die Dateien werden auf diesem Gerät gelesen, hochgeladen werden nur die Wiedergaben.',
    requestLink: 'Export bei Spotify anfordern',
    choose: 'Dateien wählen',
    again: 'Erneut importieren',
    remove: 'Entfernen',
    imported: (count: string, from: string, to: string) => `${count} Wiedergaben von ${from} bis ${to}`,
    inLibrary: (percent: number) => `${percent} % der Songs sind in deiner Bibliothek.`,
    nothing: 'Noch nichts importiert.',
    reading: (done: number, total: number) => `Dateien lesen … ${done} von ${total}`,
    library: (done: number, total: number) => `Mit deiner Bibliothek abgleichen … ${done} von ${total} Songs`,
    uploading: (done: string, total: string) => `Hochladen … ${done} von ${total}`,
    done: (count: string) => `${count} Wiedergaben importiert`,
    noHistory: 'In den Dateien ist kein Spotify-Hörverlauf.',
    failed: 'Der Import hat nicht geklappt. Versuch es noch einmal.',
    unavailable: 'Der Server ist gerade nicht erreichbar.',
    removeTitle: 'Spotify-Verlauf entfernen?',
    removeDescription: (app: string) => `Alle importierten Spotify-Wiedergaben verschwinden aus deinem Verlauf und aus Wrapped. Was du in ${app} gehört hast, bleibt.`,
    cancel: 'Abbrechen',
    removed: 'Spotify-Verlauf entfernt',
    wrappedLabel: 'Wrapped',
    wrappedHint: 'Dein Jahr in Musik, aus deinem Verlauf. Das laufende Jahr gibt es ab dem 12. Dezember.',
    openWrapped: 'Wrapped öffnen',
  },
  en: {
    title: 'Listening history',
    description: (app: string) => `What you play in ${app}, and what you bring over from Spotify. Your Wrapped is made from it.`,
    spotifyLabel: 'Import your Spotify history',
    spotifyHint:
      'Upload your Spotify data export (the zip file or the JSON files in it). The “Extended streaming history” is the most complete; request it in your Spotify account under Privacy. The files are read on this device; only the plays are uploaded.',
    requestLink: 'Request the export from Spotify',
    choose: 'Choose files',
    again: 'Import again',
    remove: 'Remove',
    imported: (count: string, from: string, to: string) => `${count} plays from ${from} to ${to}`,
    inLibrary: (percent: number) => `${percent}% of the songs are in your library.`,
    nothing: 'Nothing imported yet.',
    reading: (done: number, total: number) => `Reading files … ${done} of ${total}`,
    library: (done: number, total: number) => `Matching your library … ${done} of ${total} songs`,
    uploading: (done: string, total: string) => `Uploading … ${done} of ${total}`,
    done: (count: string) => `${count} plays imported`,
    noHistory: 'There is no Spotify listening history in these files.',
    failed: 'The import didn’t work. Please try again.',
    unavailable: 'The server can’t be reached right now.',
    removeTitle: 'Remove your Spotify history?',
    removeDescription: (app: string) => `All imported Spotify plays disappear from your history and from Wrapped. What you played in ${app} stays.`,
    cancel: 'Cancel',
    removed: 'Spotify history removed',
    wrappedLabel: 'Wrapped',
    wrappedHint: 'Your year in music, from your history. The running year comes out on 12 December.',
    openWrapped: 'Open Wrapped',
  },
})

/** Settings → Music: bringing in the Spotify history, and the way to Wrapped. */
export function ListeningHistorySection() {
  const { api, session } = useAuthedSession()
  const t = useMessages(listeningHistoryMessages)
  const { appName } = useBranding()
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  const month = new Intl.DateTimeFormat(getLocaleTag(useLocale()), { month: 'short', year: 'numeric' })
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<ImportStep | null>(null)
  const [confirming, setConfirming] = useState(false)
  const request = useLumioFetch()
  const summary = useQuery({ queryKey: ['spotify-import', session.userId], queryFn: () => spotifyImportSummary(request), retry: false })
  const busy = !!step

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['spotify-import', session.userId] })
    void queryClient.invalidateQueries({ queryKey: ['wrapped'] })
  }

  const start = async (files: File[]) => {
    if (!files.length) return
    setStep({ step: 'reading', done: 0, total: files.length })
    try {
      const result = await importSpotify(api, session.userId, request, files, setStep)
      toast.success(t.done(number.format(result.plays)))
    } catch (error) {
      toast.error(error instanceof Error && error.message === 'no-history' ? t.noHistory : t.failed)
    } finally {
      setStep(null)
      refresh()
    }
  }

  const progress = !step
    ? null
    : step.step === 'reading'
      ? t.reading(step.done, step.total)
      : step.step === 'library'
        ? t.library(step.done, step.total)
        : t.uploading(number.format(step.done), number.format(step.total))
  const fraction = step && step.total ? step.done / step.total : 0
  const data = summary.data

  return (
    <Section anchor="listening-history" title={t.title} description={t.description(appName)} scope="account">
      <Row label={t.spotifyLabel} hint={t.spotifyHint} htmlFor="spotify-import">
        <div className="space-y-2">
          <input
            ref={input}
            id="spotify-import"
            type="file"
            multiple
            accept=".zip,.json,application/zip,application/json"
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              void start(files)
            }}
          />
          {busy ? (
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
              <p className="text-sm text-muted-foreground">
                {summary.isError
                  ? t.unavailable
                  : data?.count && data.first && data.last
                    ? t.imported(number.format(data.count), month.format(data.first), month.format(data.last))
                    : summary.isLoading
                      ? '…'
                      : t.nothing}
              </p>
              {!!data?.count && <p className="text-xs text-muted-foreground">{t.inLibrary(Math.round((data.matched / data.count) * 100))}</p>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={summary.isError} onClick={() => input.current?.click()}>
                  <IconBrandSpotify />
                  {data?.count ? t.again : t.choose}
                </Button>
                {!!data?.count && (
                  <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
                    {t.remove}
                  </Button>
                )}
              </div>
              <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer" className="block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                {t.requestLink}
              </a>
            </>
          )}
        </div>
      </Row>
      <SpotifyLibraryRow />
      <Row label={t.wrappedLabel} hint={t.wrappedHint}>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/listen/wrapped" />}>
          {t.openWrapped}
        </Button>
      </Row>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{t.removeTitle}</DialogTitle>
          <DialogDescription>{t.removeDescription(appName)}</DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                void removeSpotifyImport(request)
                  .then(() => toast.success(t.removed))
                  .catch(() => toast.error(t.unavailable))
                  .finally(refresh)
              }}
            >
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  )
}
