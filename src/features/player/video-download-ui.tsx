import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { cloneElement, useEffect, type ReactElement, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAuthedSession } from '@/features/auth/session'
import { DownloadGlyph } from '@/features/listen/download-ui'
import { useLocalSettings } from '@/features/settings/local-settings'
import { useUserConfiguration } from '@/features/settings/use-user-configuration'
import { languageKey, languageName } from '@/lib/track-labels'
import { defineMessages, useMessages } from '@/lib/i18n'
import { useOffline } from '@/lib/network'
import { cn } from '@/lib/utils'
import { forgetVideo, useVideoStored, videoCacheAvailable } from './video-cache'
import {
  downloadVideos,
  removeEpisodeDownload,
  removeVideoDownload,
  setVideoDownloadSource,
  syncSeasonDownload,
  useSeasonDownload,
  useVideoDownload,
  type VideoDownloadState,
} from './video-downloads'

const MBIT = 1_000_000

const messages = defineMessages({
  de: {
    download: 'Herunterladen',
    downloaded: 'Heruntergeladen',
    remove: 'Download entfernen',
    loading: (percent: number) => `Wird heruntergeladen: ${percent} %`,
    queued: 'Wartet auf den Download',
    failed: (reason: string) => `Fehlgeschlagen: ${reason}. Wird gleich erneut versucht.`,
    failure_network: 'Verbindung unterbrochen',
    failure_storage: 'Speicher voll',
    failure_server: 'Fehler des Servers',
    failure_other: 'Unbekannter Fehler',
    downloadSeason: 'Staffel herunterladen',
    seasonDownloaded: 'Staffel heruntergeladen',
    seasonProgress: (done: number, total: number) => `${done} von ${total} heruntergeladen`,
    downloadEpisode: (name: string) => `„${name}“ herunterladen`,
    removeEpisode: (name: string) => `Download von „${name}“ entfernen`,
    unavailable: 'Offline nicht verfügbar',
    chooseLanguage: 'Tonspur zum Herunterladen',
    preferred: 'Bevorzugt',
    stored: 'Für dich vorbereitet (heruntergeladen)',
    removeStored: (name: string) => `Gespeicherte Kopie von „${name}“ entfernen`,
  },
  en: {
    download: 'Download',
    downloaded: 'Downloaded',
    remove: 'Remove download',
    loading: (percent: number) => `Downloading: ${percent}%`,
    queued: 'Waiting to download',
    failed: (reason: string) => `Failed: ${reason}. Trying again shortly.`,
    failure_network: 'connection lost',
    failure_storage: 'storage full',
    failure_server: 'server error',
    failure_other: 'unknown error',
    downloadSeason: 'Download season',
    seasonDownloaded: 'Season downloaded',
    seasonProgress: (done: number, total: number) => `${done} of ${total} downloaded`,
    downloadEpisode: (name: string) => `Download “${name}”`,
    removeEpisode: (name: string) => `Remove the download of “${name}”`,
    unavailable: 'Not available offline',
    chooseLanguage: 'Audio to download',
    preferred: 'Preferred',
    stored: 'Prepared for you (downloaded)',
    removeStored: (name: string) => `Remove the stored copy of “${name}”`,
  },
})

/** Hands the video downloads where to fetch from (and in which quality) while someone is signed in. */
export function VideoDownloadsHost() {
  const { api, session } = useAuthedSession()
  const { settings } = useLocalSettings()
  // 0: the original quality (see video-downloads).
  const bitrate = settings.videoDownloadMbit ? settings.videoDownloadMbit * MBIT : null
  useEffect(() => {
    setVideoDownloadSource({ api, session, bitrate })
    return () => setVideoDownloadSource(null)
  }, [api, session, bitrate])
  return null
}

/** Offline, a film or episode without a stored copy can't be played: shown greyed out (as songs are in Listen). */
export function useVideoUnavailable(itemId: string | null | undefined) {
  const offline = useOffline()
  const stored = useVideoStored(itemId)
  return !!itemId && offline && !stored
}

/**
 * A film's or episode's download as shown: a copy the cache stored ahead (the next episodes while watching) looks
 * exactly like a download; `stored` tells it apart (removing it forgets the copy instead of a download).
 */
function useShownDownload(itemId: string | null | undefined): { download: VideoDownloadState; stored: boolean } {
  const download = useVideoDownload(itemId)
  const hasCopy = useVideoStored(itemId)
  if (download || !hasCopy) return { download, stored: false }
  return { download: { state: 'done' }, stored: true }
}

const glyphState = (download: VideoDownloadState) => (download ? download.state : 'none')
const shareOf = (download: VideoDownloadState) => (download?.state === 'loading' ? download.share : 0)

function labelOf(t: (typeof messages)['de'], download: VideoDownloadState) {
  if (!download) return t.download
  if (download.state === 'loading') return t.loading(Math.round(download.share * 100))
  if (download.state === 'queued') return download.error ? t.failed(t[`failure_${download.error.kind}`]) : t.queued
  return t.downloaded
}

/** The audio languages of some films or episodes (each once, as a file names it), in the order they come. */
function audioLanguagesOf(items: BaseItemDto[]) {
  const found = new Map<string, string>()
  for (const item of items) {
    for (const stream of item.MediaStreams ?? item.MediaSources?.[0]?.MediaStreams ?? []) {
      if (stream.Type !== 'Audio' || !stream.Language || stream.Language === 'und') continue
      const key = languageKey(stream.Language)
      if (!found.has(key)) found.set(key, stream.Language)
    }
  }
  return [...found.values()]
}

/** The languages to choose from (the account's preferred audio language first) and the one taken without asking. */
function useLanguageChoice(items: BaseItemDto[]) {
  const preferred = useUserConfiguration().data?.Configuration?.AudioLanguagePreference ?? null
  const isPreferred = (language: string) => Number(!!preferred && languageKey(language) === languageKey(preferred))
  const languages = audioLanguagesOf(items).sort((a, b) => isPreferred(b) - isPreferred(a))
  return { languages, preferred }
}

/**
 * With more than one audio language, starting a download asks which one (the file keeps one track: browsers can't
 * switch between the tracks of a file). `trigger` is the button, `children` what it shows.
 */
function LanguageMenu({
  languages,
  preferred,
  onPick,
  trigger,
  children,
}: {
  languages: string[]
  preferred: string | null
  onPick: (language: string) => void
  trigger: ReactElement
  children: ReactNode
}) {
  const t = useMessages(messages)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t.chooseLanguage}</DropdownMenuLabel>
          {languages.map((language) => (
            <DropdownMenuItem key={language} onClick={() => onPick(language)}>
              <span className="flex-1">{languageName(language)}</span>
              {!!preferred && languageKey(language) === languageKey(preferred) && <span className="text-xs text-muted-foreground">{t.preferred}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The film's download, beside its play button. */
export function MovieDownloadButton({ movie }: { movie: BaseItemDto }) {
  const t = useMessages(messages)
  const { download, stored } = useShownDownload(movie.Id)
  const { languages, preferred } = useLanguageChoice([movie])
  if (!videoCacheAvailable || !movie.Id) return null
  const key = `movie:${movie.Id}`
  const start = (language: string | null) => downloadVideos(key, 'movie', movie.Name ?? '', [movie], [], language)
  const ask = !download && languages.length > 1
  const button = (
    <Button
      size="lg"
      variant="outline"
      aria-pressed={!!download}
      title={stored ? t.removeStored(movie.Name ?? '') : download ? t.remove : t.download}
      onClick={ask ? undefined : () => (stored ? void forgetVideo(movie.Id!) : download ? removeVideoDownload(key) : start(preferred))}
      className={cn(download && 'text-listen hover:text-listen')}
    />
  )
  const content = (
    <>
      <DownloadGlyph state={glyphState(download)} share={shareOf(download)} className="size-5" /> {labelOf(t, download)}
    </>
  )
  if (!ask) return cloneElement(button, undefined, content)
  return (
    <LanguageMenu languages={languages} preferred={preferred} onPick={start} trigger={button}>
      {content}
    </LanguageMenu>
  )
}

/** A season's download, beside the season picker. Brings a downloaded season up to date with its episodes. */
export function SeasonDownloadButton({ series, seasons, season, episodes }: { series?: BaseItemDto; seasons: BaseItemDto[]; season?: BaseItemDto; episodes: BaseItemDto[] | undefined }) {
  const t = useMessages(messages)
  const download = useSeasonDownload(season?.Id)
  const seasonId = season?.Id
  const { languages, preferred } = useLanguageChoice(episodes ?? [])
  useEffect(() => {
    if (seasonId && episodes?.length) syncSeasonDownload(seasonId, episodes)
  }, [seasonId, episodes])
  if (!videoCacheAvailable || !season?.Id) return null
  const key = `season:${season.Id}`
  const done = !!download && download.done >= download.total
  const label = !download ? t.downloadSeason : done ? t.seasonDownloaded : t.seasonProgress(download.done, download.total)
  const start = (language: string | null) =>
    downloadVideos(key, 'season', `${series?.Name ?? ''} · ${season.Name ?? ''}`, episodes ?? [], [...(series ? [series] : []), ...seasons], language)
  const ask = !download && languages.length > 1
  const button = (
    <Button
      size="sm"
      variant="outline"
      aria-pressed={!!download}
      title={download ? t.remove : t.downloadSeason}
      disabled={!download && !episodes?.length}
      onClick={ask ? undefined : () => (download ? removeVideoDownload(key) : start(preferred))}
      className={cn(download && 'text-listen hover:text-listen')}
    />
  )
  const content = (
    <>
      <DownloadGlyph state={!download ? 'none' : done ? 'done' : 'loading'} share={download?.share ?? 0} className="size-4" /> {label}
    </>
  )
  if (!ask) return cloneElement(button, undefined, content)
  return (
    <LanguageMenu languages={languages} preferred={preferred} onPick={start} trigger={button}>
      {content}
    </LanguageMenu>
  )
}

/**
 * An episode's download, in its card (series page). `context`: the series, its seasons and the season's episodes, kept
 * for offline use with it.
 */
export function EpisodeDownloadButton({ episode, context, className }: { episode: BaseItemDto; context: BaseItemDto[]; className?: string }) {
  const t = useMessages(messages)
  const { download, stored } = useShownDownload(episode.Id)
  const { languages, preferred } = useLanguageChoice([episode])
  if (!videoCacheAvailable || !episode.Id) return null
  const label = stored
    ? `${t.stored} · ${t.removeStored(episode.Name ?? '')}`
    : download
      ? `${labelOf(t, download)} · ${t.removeEpisode(episode.Name ?? '')}`
      : t.downloadEpisode(episode.Name ?? '')
  const start = (language: string | null) => downloadVideos(`episode:${episode.Id}`, 'episode', episode.Name ?? '', [episode], context, language)
  const ask = !download && languages.length > 1
  const button = (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={!!download}
      onClick={
        ask
          ? undefined
          : (event) => {
              event.preventDefault()
              event.stopPropagation()
              if (stored) void forgetVideo(episode.Id!)
              else if (download) removeEpisodeDownload(episode.Id!)
              else start(preferred)
            }
      }
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-full outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring',
        !download
          ? 'text-muted-foreground hover:text-foreground'
          : download.state === 'queued'
            ? download.error
              ? 'text-amber-500'
              : 'text-muted-foreground'
            : 'text-listen',
        className,
      )}
    />
  )
  const content = <DownloadGlyph state={glyphState(download)} share={shareOf(download)} className="size-7" />
  if (!ask) return cloneElement(button, undefined, content)
  return (
    <LanguageMenu languages={languages} preferred={preferred} onPick={start} trigger={button}>
      {content}
    </LanguageMenu>
  )
}

/** The small mark of a downloaded (or downloading) episode, e.g. in the player's episode list. */
export function VideoDownloadMark({ itemId, className }: { itemId: string | null | undefined; className?: string }) {
  const t = useMessages(messages)
  const { download, stored } = useShownDownload(itemId)
  if (!download) return null
  const label = stored ? t.stored : labelOf(t, download)
  return (
    <span role="img" aria-label={label} title={label} className={cn('inline-grid', download.state === 'queued' ? 'text-white/60' : 'text-listen', className)}>
      <DownloadGlyph state={download.state} share={shareOf(download)} className="size-4" />
    </span>
  )
}

export function useVideoDownloadMessages() {
  return useMessages(messages)
}
