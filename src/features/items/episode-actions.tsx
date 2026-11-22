import { ContextMenu } from '@base-ui/react/context-menu'
import type { BaseItemDto, MediaSourceInfo, MediaStream } from '@jellyfin/sdk/lib/generated-client/models'
import { IconEye, IconEyeCheck, IconInfoCircle, IconRotate } from '@tabler/icons-react'
import { useState, type ReactElement } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRuntime } from '@/lib/format'
import { useMessages } from '@/lib/i18n'
import { audioLabel, labelStreams, subtitleLabel, videoLabel } from '@/lib/track-labels'
import { cn } from '@/lib/utils'
import { episodeActionMessages } from './messages'
import { useItem, useResetProgress, useSetPlayed } from './queries'

/** The quiet eye next to an episode's download button: marks it watched or unwatched. */
export function EpisodeWatchedButton({ episode, className }: { episode: BaseItemDto; className?: string }) {
  const t = useMessages(episodeActionMessages)
  const setPlayed = useSetPlayed(episode.Id!)
  const watched = !!episode.UserData?.Played
  const label = watched ? t.markUnwatched : t.markWatched
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={watched}
      disabled={setPlayed.isPending}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setPlayed.mutate(!watched)
      }}
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        // Only on hover with a mouse (the row stays clean); fingers can't hover, so there it is always shown.
        'opacity-0 focus-visible:opacity-100 group-hover/episode:opacity-100 pointer-coarse:opacity-100',
        watched && 'opacity-100',
        className,
      )}
    >
      {watched ? <IconEyeCheck className="size-6" /> : <IconEye className="size-6" />}
    </button>
  )
}

/**
 * Right-click (long press on touch) on an episode row: watched/unwatched, forget where it was stopped, and the file's
 * details (quality, languages). Kept out of sight on purpose; the row itself only shows the download and watched marks.
 */
export function EpisodeContextMenu({ episode, children }: { episode: BaseItemDto; children: ReactElement }) {
  const t = useMessages(episodeActionMessages)
  const setPlayed = useSetPlayed(episode.Id!)
  const resetProgress = useResetProgress(episode.Id!)
  const [infoOpen, setInfoOpen] = useState(false)
  const watched = !!episode.UserData?.Played
  const hasProgress = !!episode.UserData?.PlaybackPositionTicks
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger render={children} />
        <DropdownMenuContent className="w-60" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem onClick={() => setPlayed.mutate(!watched)}>
            {watched ? <IconEye /> : <IconEyeCheck />} {watched ? t.markUnwatched : t.markWatched}
          </DropdownMenuItem>
          {hasProgress && (
            <DropdownMenuItem onClick={() => resetProgress.mutate()}>
              <IconRotate /> {t.resetProgress}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setInfoOpen(true)}>
            <IconInfoCircle /> {t.fileInfo}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </ContextMenu.Root>
      {infoOpen && <FileInfoDialog itemId={episode.Id!} name={episode.Name ?? ''} onClose={() => setInfoOpen(false)} />}
    </>
  )
}

/** Quality and languages of an item's file(s), from Jellyfin's media info. */
function FileInfoDialog({ itemId, name, onClose }: { itemId: string; name: string; onClose: () => void }) {
  const t = useMessages(episodeActionMessages)
  // The single-item request carries the media sources with all their streams.
  const item = useItem(itemId)
  const sources = item.data?.MediaSources ?? []
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 overflow-hidden p-6 sm:max-w-lg">
        <div className="space-y-1 pr-8">
          <DialogTitle className="text-lg font-semibold">{t.fileInfo}</DialogTitle>
          <DialogDescription className="truncate">{name}</DialogDescription>
        </div>
        <div className="-mx-6 -mb-6 min-h-0 space-y-6 overflow-y-auto px-6 pb-6">
          {item.isLoading && <Skeleton className="h-40 rounded-lg" />}
          {!item.isLoading && sources.length === 0 && <p className="text-sm text-muted-foreground">{t.noInfo}</p>}
          {sources.map((source) => (
            <SourceInfo key={source.Id} source={source} titled={sources.length > 1} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SourceInfo({ source, titled }: { source: MediaSourceInfo; titled: boolean }) {
  const t = useMessages(episodeActionMessages)
  const streams = source.MediaStreams ?? []
  const of = (type: MediaStream['Type']) => streams.filter((stream) => stream.Type === type)
  const video = of('Video')[0]
  const audio = labelStreams(of('Audio'), audioLabel)
  const subtitles = labelStreams(of('Subtitle'), subtitleLabel)
  const videoDetails = video
    ? [
        videoLabel(video),
        video.Width && video.Height ? `${video.Width}×${video.Height}` : undefined,
        video.Codec?.toUpperCase(),
        video.VideoRangeType && video.VideoRangeType !== 'SDR' ? video.VideoRangeType : undefined,
        video.BitDepth ? `${video.BitDepth} bit` : undefined,
      ]
    : []
  const rows: Array<[string, string]> = [
    [t.video, videoDetails.filter(Boolean).join(' · ') || '–'],
    [t.audio, audio.map((entry) => entry.label).join('\n') || '–'],
    [t.subtitles, subtitles.map((entry) => entry.label).join('\n') || t.none],
    [t.file, [source.Container?.toUpperCase(), formatSize(source.Size), formatBitrate(source.Bitrate), formatRuntime(source.RunTimeTicks)].filter(Boolean).join(' · ') || '–'],
  ]
  return (
    <section className="space-y-2">
      {titled && <h3 className="text-sm font-medium">{source.Name}</h3>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-line break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function formatSize(bytes?: number | null) {
  if (!bytes) return undefined
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

function formatBitrate(bits?: number | null) {
  if (!bits) return undefined
  return bits >= 1e6 ? `${(bits / 1e6).toFixed(1)} Mbit/s` : `${Math.round(bits / 1e3)} kbit/s`
}
