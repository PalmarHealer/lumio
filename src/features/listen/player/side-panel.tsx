import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconChevronLeft,
  IconLayoutSidebarRightCollapse,
  IconMenu2,
  IconPlayerPlayFilled,
  IconSettings,
  IconX,
} from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Link } from '@/components/link'
import { useTouch } from '@/lib/use-media-query'
import { FadeImage } from '@/components/media/fade-image'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { useBackLayer } from '@/lib/back'
import { useDominantColor } from '@/lib/dominant-color'
import { externalOf } from '@/lib/external-items'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { cn } from '@/lib/utils'
import { useLyrics } from './lyrics'
import { lyricsSourceName } from './lyrics-providers'
import { playerBarMessages } from './messages'
import { currentTrack, music, useMusic, type QueueKind } from './music-player'
import { closeListenPanel, openListenPanel, RIGHT_LIMITS, setListenLayout, setListenPanelExpanded, setListenPanelPeek, toggleListenPanel, type ListenPanel, useListenLayout, useListenPanel } from './panel'
import { useTrackQuality } from './quality'
import { ResizeHandle } from '../resize-handle'
import { usePlayerControls, usePlayerTime } from './player-controls'
import { endTrackDrag, QUEUE_MOVE_TYPE, startTrackDrag } from '../track-drag'
import { TrackContextMenu, TrackMenu } from '../track-menu'
import { NowPlaying } from './now-playing'
import { SourceLink } from './queue-source'
import { QueueDrop } from './player-bar'
import { TrackArtists } from '../track-artists'
import { useUnavailable } from '../availability'

const messages = defineMessages({
  de: {
    close: 'Schließen',
    open: 'Seitenleiste öffnen',
    resize: 'Breite der Seitenleiste ändern',
    aboutArtist: 'Über den Künstler',
    listeners: (n: string) => `${n} Hörer`,
    upNext: 'Als Nächstes',
    currentTrack: 'Aktueller Titel',
    nextInQueue: 'Nächster Titel in der Warteschlange',
    clearQueue: 'Warteschlange löschen',
    removeFromQueue: 'Aus Warteschlange entfernen',
    moveInQueue: (name: string) => `${name} verschieben`,
    nextOn: (device: string) => `Als Nächstes auf ${device}`,
    playThis: (name: string) => `${name} abspielen`,
    nextFrom: 'Nächster Titel von:',
    autoplayFrom: 'Ähnliche Titel, basierend auf',
    nowPlaying: 'Läuft gerade',
    emptyQueue: 'Danach kommt nichts mehr.',
    remove: 'Aus der Warteschlange entfernen',
    noLyrics: 'Für diesen Titel gibt es keinen Songtext.',
    lyricsFrom: (source: string) => `Songtext von ${source}`,
    fold: 'Seitenleiste einklappen',
    nothingPlaying: 'Gerade läuft nichts. Wähle einen Song, ein Album oder einen Podcast, dann siehst du hier Cover, Songtext und was als Nächstes kommt.',
    expand: 'Groß anzeigen',
    shrink: 'Normal anzeigen',
    quality: 'Wiedergabequalität',
    playingQuality: 'Aktuelle Qualität',
    lossless: (bits?: number) => (bits ? `Lossless ${bits} Bit` : 'Lossless'),
    losslessShort: 'Lossless',
    perHour: (amount: string) => `Bis zu ${amount} pro Stunde`,
    bestAvailable: 'Beste Qualität dieses Titels',
    delivery: 'So kommt er an',
    direct: 'Unverändert, direkt vom Server',
    convertedFormat: (codec: string) => `Vom Server in MP3 umgewandelt (dein Browser spielt ${codec} nicht ab)`,
    convertedLimit: 'Vom Server in MP3 umgewandelt (wegen deiner Qualitätsgrenze)',
    changeQuality: 'Qualitätseinstellungen ändern',
    podcastQuality: 'Podcasts kommen direkt vom Anbieter, so wie er sie veröffentlicht.',
    qualityExplained:
      'Lossless heißt: Du hörst genau das, was in der Datei steckt, ohne dass etwas weggelassen wurde (wie bei einer CD). MP3 und AAC sparen Daten, indem sie kaum hörbare Teile weglassen. Wandelt der Server um, geht verlustfreie Qualität dabei verloren.',
  },
  en: {
    close: 'Close',
    open: 'Open side panel',
    resize: 'Resize side panel',
    aboutArtist: 'About the artist',
    listeners: (n: string) => `${n} listeners`,
    upNext: 'Next up',
    currentTrack: 'Now playing',
    nextInQueue: 'Next in queue',
    clearQueue: 'Clear queue',
    removeFromQueue: 'Remove from queue',
    moveInQueue: (name: string) => `Move ${name}`,
    nextOn: (device: string) => `Next on ${device}`,
    playThis: (name: string) => `Play ${name}`,
    nextFrom: 'Next from:',
    autoplayFrom: 'Similar songs, based on',
    nowPlaying: 'Now playing',
    emptyQueue: 'Nothing comes after this.',
    remove: 'Remove from queue',
    noLyrics: 'There are no lyrics for this track.',
    lyricsFrom: (source: string) => `Lyrics from ${source}`,
    fold: 'Collapse side panel',
    nothingPlaying: 'Nothing is playing. Pick a song, album or podcast to see its cover, lyrics and what comes next here.',
    expand: 'Make big',
    shrink: 'Make normal',
    quality: 'Playback quality',
    playingQuality: 'Playing quality',
    lossless: (bits?: number) => (bits ? `Lossless ${bits}-bit` : 'Lossless'),
    losslessShort: 'Lossless',
    perHour: (amount: string) => `Up to ${amount} per hour`,
    bestAvailable: 'Best quality of this track',
    delivery: 'How it arrives',
    direct: 'Unchanged, straight from the server',
    convertedFormat: (codec: string) => `Converted to MP3 by the server (your browser can't play ${codec})`,
    convertedLimit: 'Converted to MP3 by the server (because of your quality limit)',
    changeQuality: 'Change quality settings',
    podcastQuality: 'Podcasts come straight from their publisher, as published.',
    qualityExplained:
      "Lossless means you hear exactly what's in the file, with nothing left out (like a CD). MP3 and AAC save data by leaving out barely audible parts. When the server converts, lossless quality is lost on the way.",
  },
})

/**
 * The right-hand panel of Listen (like Spotify's): what's playing, the queue, the lyrics or the sound quality. Closed,
 * it stays as a thin strip at the edge with an arrow; hovering lets it peek out a little, a click opens it. Opening
 * and closing slide (the frame animates the width); the content keeps its full width meanwhile, so it doesn't reflow.
 * Made big, it fills the window between header and player bar (the library sidebar hides), with the queue beside.
 */
export function SidePanel() {
  const panel = useListenPanel()
  const { track } = usePlayerControls()
  const t = useMessages(messages)
  const bar = useMessages(playerBarMessages)
  const layout = useListenLayout()
  const dragFrom = useRef(0)
  const { view, open, expanded, beside } = panel

  // Escape leaves the big panel.
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && setListenPanelExpanded(false)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded])
  // So does the system back button.
  useBackLayer(expanded, () => setListenPanelExpanded(false))

  if (!track) return <EmptySidePanel open={open} />
  const titles: Record<ListenPanel, string> = { nowPlaying: track.Album ?? bar.nowPlaying, queue: bar.queue, lyrics: bar.lyrics, quality: t.quality }
  const title = titles[view]
  return (
    <aside
      data-side-panel
      aria-label={title}
      onPointerEnter={() => !open && !expanded && setListenPanelPeek(true)}
      onPointerLeave={() => setListenPanelPeek(false)}
      className={cn(
        'group/panel fixed bottom-20 right-0 top-14 hidden overflow-hidden bg-background pb-2 pr-2 transition-[width] duration-300 ease-out lg:block [.cursor-col-resize_&]:transition-none',
        expanded ? 'z-40 w-screen' : 'z-30 w-(--listen-right)',
      )}
    >
      <div
        // Its own tone with a gap around it, rather than a border against the page.
        className={cn(
          'absolute bottom-2 left-0 top-0 flex overflow-hidden rounded-xl bg-surface [--background:var(--surface)] transition-[opacity,width] duration-300 ease-out',
          // Folded, it peeks over the grey strip while pointed at (clicks still reach the strip below).
          !open && 'pointer-events-none z-10 opacity-0 group-hover/panel:opacity-70',
          // Big, it spans the window with the same gap on both sides (or up to the queue beside it).
          expanded && 'left-2',
        )}
        // Showing the queue or the quality, this box is "the beside panel": it stays where it is when the panel grows.
        data-vt={!expanded && BESIDE_VIEWS.has(view) ? 'listen-beside' : 'listen-panel'}
        style={{ width: expanded ? (beside ? `calc(100% - ${layout.right + 16}px)` : 'calc(100% - 1rem)') : layout.right - 8 }}
      >
        <PanelColumn view={view} titles={titles} track={track} expanded={expanded} />
      </div>
      {/* In the big panel, the queue or the quality: a panel of its own at the right edge, exactly where the side
          panel is otherwise (it slides in from the right when opened there, and out again). */}
      <BesideColumn target={expanded ? beside : null} expanded={expanded} width={layout.right - 8} titles={titles} track={track} />
      {expanded ? null : open ? (
        <ResizeHandle
          edge="left"
          label={t.resize}
          onDragStart={() => (dragFrom.current = layout.right)}
          onDrag={(delta) => setListenLayout({ right: Math.min(RIGHT_LIMITS.max, Math.max(RIGHT_LIMITS.min, dragFrom.current - delta)) })}
        />
      ) : (
        <button
          type="button"
          aria-label={t.open}
          title={t.open}
          onClick={openListenPanel}
          className="absolute bottom-2 left-0 right-0 top-0 flex items-center justify-start rounded-l-xl bg-surface pl-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <IconChevronLeft className="size-5" />
        </button>
      )}
    </aside>
  )
}

/**
 * The panel's main column. Over the lyrics and the big cover it is "immersive": the whole column takes the cover's
 * colour and the header floats over it, transparent, with only a soft shade from the top to keep its icons readable.
 */
function PanelColumn({ view, titles, track, expanded }: { view: ListenPanel; titles: Record<ListenPanel, string>; track: BaseItemDto; expanded: boolean }) {
  // The big panel switches views in place.
  if (expanded) return <PanelLayer view={view} title={titles[view]} track={track} expanded />
  return <SlidingViews view={view} titles={titles} track={track} />
}

/**
 * The normal panel: "now playing" underneath; the queue, lyrics and quality slide up over it from the bottom and back
 * down when closed (the leaving view stays until it is out of sight).
 */
function SlidingViews({ view, titles, track }: { view: ListenPanel; titles: Record<ListenPanel, string>; track: BaseItemDto }) {
  const over = view === 'nowPlaying' ? null : view
  const [shown, setShown] = useState<ListenPanel | null>(over)
  const [leaving, setLeaving] = useState(false)
  // A view already open when the panel appears (back from big) is simply there; one opened meanwhile slides in.
  const [slideIn, setSlideIn] = useState(false)
  // Switching from one view to another: the old one stays underneath until the new one has slid over it.
  const [below, setBelow] = useState<ListenPanel | null>(null)
  // Follow the panel's view during render: a new view slides in; closing lets the shown one slide out first.
  if (over && over !== shown) {
    setBelow(shown && !leaving ? shown : null)
    setShown(over)
    setLeaving(false)
    setSlideIn(true)
  } else if (!over && shown && !leaving) setLeaving(true)
  return (
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <PanelLayer key="now-playing" view="nowPlaying" title={titles.nowPlaying} track={track} expanded={false} />
      {/* Keyed by view: the one that was shown stays the same element underneath (not rebuilt). */}
      {below && below !== shown && (
        <div key={below} className="absolute inset-0 z-10 flex flex-col bg-surface">
          <PanelLayer view={below} title={titles[below]} track={track} expanded={false} />
        </div>
      )}
      {shown && (
        <div
          key={shown}
          onAnimationEnd={(event) => {
            // Only its own slide (animations inside it, such as the playing bars, bubble up too).
            if (event.target !== event.currentTarget) return
            setBelow(null)
            if (!leaving) return
            setShown(null)
            setLeaving(false)
          }}
          className={cn('absolute inset-0 z-20 flex flex-col bg-surface', leaving ? 'panel-slide-out' : slideIn && 'panel-slide-in')}
        >
          <PanelLayer view={shown} title={titles[shown]} track={track} expanded={false} />
        </div>
      )}
    </div>
  )
}

function PanelLayer({ view, title, track, expanded }: { view: ListenPanel; title: string; track: BaseItemDto; expanded: boolean }) {
  const { api } = useAuthedSession()
  const immersive = view === 'lyrics' || (expanded && view === 'nowPlaying')
  const tint = useDominantColor(immersive ? portraitImageUrl(api, track, { fillHeight: 64 }) : undefined).data
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col transition-colors duration-500" style={immersive ? { background: tint ?? 'var(--muted)' } : undefined}>
      <PanelHeader view={view} title={title} track={track} expanded={expanded} immersive={immersive} />
      <PanelBody view={view} track={track} expanded={expanded} immersive={immersive} />
    </div>
  )
}

/** The big panel's column at the right edge (queue or quality): it slides in from the right and out again when closed. */
const BESIDE_VIEWS = new Set<ListenPanel>(['queue', 'quality'])

function BesideColumn({
  target,
  expanded,
  width,
  titles,
  track,
}: {
  target: 'queue' | 'quality' | null
  expanded: boolean
  width: number
  titles: Record<ListenPanel, string>
  track: BaseItemDto
}) {
  const t = useMessages(messages)
  const [shown, setShown] = useState(target)
  const [leaving, setLeaving] = useState(false)
  const [slideIn, setSlideIn] = useState(false)
  const [wasExpanded, setWasExpanded] = useState(expanded)
  if (expanded !== wasExpanded) {
    // The panel grew or shrank (the whole panel animates): the column comes or goes with it, without its own slide.
    setWasExpanded(expanded)
    setShown(target)
    setLeaving(false)
    setSlideIn(false)
  } else if (target && target !== shown) {
    setShown(target)
    setLeaving(false)
    setSlideIn(true)
  } else if (!target && shown && !leaving) setLeaving(true)
  if (!shown) return null
  return (
    <div
      onAnimationEnd={(event) => {
        if (!leaving || event.target !== event.currentTarget) return
        setShown(null)
        setLeaving(false)
      }}
      data-vt="listen-beside"
      style={{ width }}
      className={cn(
        'absolute bottom-2 right-2 top-0 z-10 flex flex-col overflow-hidden rounded-xl bg-surface [--background:var(--surface)]',
        leaving ? 'beside-out' : slideIn && 'beside-in',
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
          <h2 className="truncate text-base font-semibold">{titles[shown]}</h2>
          <IconButton label={t.close} onClick={() => toggleListenPanel(shown)}>
            <IconX className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-width:thin]">
          {shown === 'queue' ? (
            <QueueDrop className="-mx-2 min-h-full rounded-lg px-2">
              <Queue />
            </QueueDrop>
          ) : (
            <QualityView track={track} />
          )}
        </div>
      </div>
    </div>
  )
}

/** The side panel while nothing is loaded: folds and opens as usual, with an empty "now playing" placeholder. */
function EmptySidePanel({ open }: { open: boolean }) {
  const t = useMessages(messages)
  const bar = useMessages(playerBarMessages)
  return (
    <aside
      aria-label={bar.nowPlaying}
      onPointerEnter={() => !open && setListenPanelPeek(true)}
      onPointerLeave={() => setListenPanelPeek(false)}
      className={cn(
        'group/panel fixed bottom-20 right-0 top-14 z-30 hidden overflow-hidden bg-background pb-2 pr-2 transition-[width] duration-300 ease-out lg:block',
        'w-(--listen-right)',
      )}
    >
      {open ? (
        <div className="flex h-full flex-col rounded-xl bg-surface [--background:var(--surface)]">
          <div className="flex items-center gap-1 px-2 pb-2 pt-2.5">
            <IconButton label={t.fold} onClick={closeListenPanel}>
              <IconLayoutSidebarRightCollapse className="size-5" />
            </IconButton>
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{bar.nowPlaying}</h2>
          </div>
          <div aria-hidden className="space-y-4 px-4">
            <div className="aspect-square rounded-lg bg-muted" />
            <div className="space-y-2">
              <div className="h-5 w-3/4 rounded bg-muted" />
              <div className="h-3.5 w-1/2 rounded bg-muted/70" />
            </div>
            <div className="h-40 rounded-lg bg-muted/50" />
          </div>
          <p className="mt-6 px-4 text-sm text-muted-foreground">{t.nothingPlaying}</p>
        </div>
      ) : (
        <button
          type="button"
          aria-label={t.open}
          title={t.open}
          onClick={openListenPanel}
          className="absolute bottom-2 left-0 right-0 top-0 flex items-center justify-start rounded-l-xl bg-surface pl-2 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <IconChevronLeft className="size-5" />
        </button>
      )}
    </aside>
  )
}

/** Fold (left), the title, the track's menu and making the panel big or normal again (right), as in Spotify. */
function PanelHeader({ view, title, track, expanded, immersive }: { view: ListenPanel; title: string; track: BaseItemDto; expanded: boolean; immersive: boolean }) {
  const t = useMessages(messages)
  return (
    <div
      className={cn(
        'flex items-center gap-1 px-2 pb-2 pt-2.5',
        immersive && 'absolute inset-x-0 top-0 z-10 bg-linear-to-b from-black/45 to-transparent pb-6 text-white [&_button]:text-white/85 [&_button:hover]:bg-white/10 [&_button:hover]:text-white',
      )}
    >
      {/* Queue, lyrics and quality close (back to what was shown before); "now playing" folds the panel away. */}
      {!expanded &&
        (view === 'nowPlaying' ? (
          <IconButton label={t.fold} onClick={closeListenPanel}>
            <IconLayoutSidebarRightCollapse className="size-5" />
          </IconButton>
        ) : (
          <IconButton label={t.close} onClick={closeListenPanel}>
            <IconX className="size-5" />
          </IconButton>
        ))}
      <h2 className={cn('min-w-0 flex-1 truncate text-base font-semibold', expanded && 'pl-3')}>{title}</h2>
      {/* The queue's own rows are what counts there; the track's menu stays with "now playing" and the lyrics. */}
      {view !== 'queue' && <TrackMenu track={track} visible />}
      <IconButton label={expanded ? t.shrink : t.expand} onClick={() => setListenPanelExpanded(!expanded)}>
        {expanded ? <IconArrowsDiagonalMinimize2 className="size-4" /> : <IconArrowsDiagonal className="size-4" />}
      </IconButton>
    </div>
  )
}

function PanelBody({ view, track, expanded, immersive }: { view: ListenPanel; track: BaseItemDto; expanded: boolean; immersive: boolean }) {
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]',
        view === 'lyrics' ? 'pt-12' : 'px-4 pb-4',
        expanded && view !== 'lyrics' && 'px-8',
        // Under the floating header.
        immersive && view === 'nowPlaying' && 'pt-12 text-white',
      )}
    >
      {view === 'nowPlaying' && (expanded ? <BigNowPlaying track={track} /> : <NowPlaying track={track} />)}
      {view === 'queue' && (
        // Songs dragged here join the end of the queue.
        <QueueDrop className="-mx-2 min-h-full rounded-lg px-2">
          <Queue />
        </QueueDrop>
      )}
      {view === 'lyrics' && <LyricsView track={track} big={expanded} />}
      {view === 'quality' && (
        <div className={cn(expanded && 'mx-auto max-w-md pt-6')}>
          <QualityView track={track} />
        </div>
      )}
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}

/** How far the big cover tilts towards the pointer, at most (degrees). */
const TILT_DEG = 7

/**
 * The big panel's "now playing": just the cover, as large as the space allows, turning slightly towards the pointer
 * (a 3D tilt with a soft sheen where the light catches it). Title and artists are in the player bar already.
 */
function BigNowPlaying({ track }: { track: BaseItemDto }) {
  const { api } = useAuthedSession()
  const cover = portraitImageUrl(api, track, { fillHeight: 1200 })
  const card = useRef<HTMLDivElement>(null)
  const sheen = useRef<HTMLDivElement>(null)

  // Follows the pointer anywhere over the stage, written straight to the element (no re-render per move).
  const tilt = (event: PointerEvent<HTMLDivElement>) => {
    const element = card.current
    if (!element || event.pointerType === 'touch') return
    const rect = element.getBoundingClientRect()
    const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)))
    const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)))
    element.style.transform = `rotateX(${-y * TILT_DEG}deg) rotateY(${x * TILT_DEG}deg)`
    if (sheen.current) {
      sheen.current.style.opacity = '1'
      sheen.current.style.background = `radial-gradient(circle at ${50 + x * 40}% ${50 + y * 40}%, rgb(255 255 255 / 0.18), transparent 60%)`
    }
  }
  const reset = () => {
    if (card.current) card.current.style.transform = ''
    if (sheen.current) sheen.current.style.opacity = '0'
  }

  return (
    <div onPointerMove={tilt} onPointerLeave={reset} className="flex h-full items-center justify-center py-6 [perspective:1200px]">
      {/* Right-click: the song's menu. */}
      <TrackContextMenu track={track}>
        <div
          ref={card}
          // Flies in from the small cover (see setListenPanelExpanded).
          data-vt="listen-cover"
          className="relative aspect-square h-[min(72svh,50rem)] max-w-full overflow-hidden rounded-xl bg-muted shadow-2xl shadow-black/50 transition-transform duration-300 ease-out [transform-style:preserve-3d] motion-reduce:transition-none motion-reduce:[transform:none]"
        >
          {/* Not draggable: the cover is for looking at (and the drag would fight the tilt). */}
          {cover && <FadeImage key={cover} src={cover} alt="" draggable={false} className="size-full select-none object-cover" />}
          <div ref={sheen} className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300" />
        </div>
      </TrackContextMenu>
    </div>
  )
}

/**
 * How the track sounds and why, as Spotify explains its quality: what plays (lossless or the bitrate), how much data
 * that is, the best the file in the library offers, whether the server converts it (and why), and the way to the
 * quality setting.
 */
function QualityView({ track }: { track: BaseItemDto }) {
  const t = useMessages(messages)
  const locale = getLocaleTag(useLocale())
  const quality = useTrackQuality(track)
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  if (externalOf(track)) return <p className="py-4 text-sm text-muted-foreground">{t.podcastQuality}</p>
  if (!quality) return <Skeleton className="h-48 rounded-xl" />
  const { playing, source } = quality
  const format = (info: { codec: string; bitDepth?: number; sampleRate?: number; bitrate?: number }, lossless: boolean) =>
    [
      lossless && info.bitDepth ? `${info.bitDepth} Bit` : undefined,
      info.sampleRate ? `${number.format(info.sampleRate / 1000)} kHz` : undefined,
      !lossless && info.bitrate ? `${Math.round(info.bitrate / 1000)} kbps` : undefined,
      info.codec.toUpperCase(),
    ]
      .filter(Boolean)
      .join(' · ')
  // Data per hour, as Spotify gives it: lossless at most what the PCM would be (FLAC never weighs more), rounded up
  // to a tenth of a GB; lossy from the bitrate.
  const pcm = quality.lossless && playing.bitDepth && playing.sampleRate ? playing.bitDepth * playing.sampleRate * (source.channels ?? 2) : 0
  const perHour = (pcm || playing.bitrate || source.bitrate || 0) * 3600 / 8
  const amount = pcm
    ? `${number.format(Math.ceil(perHour / 1e8) / 10)} GB`
    : perHour >= 1e9 ? `${number.format(perHour / 1e9)} GB` : `${Math.round(perHour / 1e6)} MB`
  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-xl bg-muted/60 p-5">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t.playingQuality}</p>
          <p className={cn('mt-1 text-2xl font-bold', quality.lossless && 'text-listen')}>{quality.lossless ? t.lossless(playing.bitDepth) : quality.label}</p>
          {perHour > 0 && <p className={cn('text-sm', quality.lossless ? 'text-listen' : 'text-muted-foreground')}>{t.perHour(amount)}</p>}
          <p className={cn('text-sm', quality.lossless ? 'text-listen' : 'text-muted-foreground')}>{format(playing, quality.lossless)}</p>
        </div>
        <div className="space-y-3 border-t pt-4 text-sm">
          <div>
            <p className="text-muted-foreground">{t.bestAvailable}</p>
            <p className="font-semibold">{source.codec ? `${quality.sourceLossless ? `${t.losslessShort} · ` : ''}${format(source, quality.sourceLossless)}` : '–'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{t.delivery}</p>
            <p className="font-semibold">{quality.converted ? (quality.reason === 'limit' ? t.convertedLimit : t.convertedFormat(source.codec.toUpperCase())) : t.direct}</p>
          </div>
        </div>
        <Link
          to="/listen/settings/playback"
          className="flex items-center gap-2 border-t pt-4 text-sm font-semibold hover:underline"
        >
          <IconSettings className="size-4" /> {t.changeQuality}
        </Link>
      </div>
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t.qualityExplained}</p>
    </div>
  )
}

/** How many autoplay songs the queue shows ahead. */
const AUTOPLAY_SHOWN = 10

/**
 * The queue, as in Spotify: the current track; the user's own queue (with a button to clear it); what comes next from
 * the collection that was started (named, as a link); and the similar songs autoplay has lined up after it. When a song
 * starts, the rows slide up into their new places.
 */
export function Queue() {
  const controls = usePlayerControls()
  // Steering another device: its queue, as far as it tells.
  if (controls.remote) return <RemoteQueue remote={controls.remote} />
  return <LocalQueue />
}

/** The controlled device's queue: the current song and what comes after it; a click plays from there. */
function RemoteQueue({ remote }: { remote: NonNullable<ReturnType<typeof usePlayerControls>['remote']> }) {
  const t = useMessages(messages)
  const { api } = useAuthedSession()
  const current = remote.queue[remote.index]
  const upcoming = remote.queue.slice(remote.index + 1)
  const row = (item: BaseItemDto, at: number, isCurrent?: boolean) => {
    const cover = portraitImageUrl(api, item, { fillHeight: 96 })
    return (
      <button
        key={`${item.Id}-${at}`}
        type="button"
        onClick={() => !isCurrent && remote.jump(at)}
        className="group flex w-full items-center gap-3 rounded-md p-1.5 text-left hover:bg-muted"
      >
        <span className="relative size-10 shrink-0 overflow-hidden rounded bg-muted">
          {cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}
          {!isCurrent && (
            <span className="absolute inset-0 grid place-items-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:hidden">
              <IconPlayerPlayFilled className="size-4" />
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className={cn('block truncate text-sm', isCurrent && 'text-listen')}>{item.Name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            <TrackArtists track={item} linked={false} />
          </span>
        </span>
      </button>
    )
  }
  return (
    <div className="space-y-5">
      {current && (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">{t.currentTrack}</h3>
          {row(current, remote.index, true)}
        </section>
      )}
      <section className="space-y-1">
        <h3 className="truncate text-sm font-semibold">{t.nextOn(remote.name)}</h3>
        {upcoming.length ? upcoming.map((item, offset) => row(item, remote.index + 1 + offset)) : <p className="py-2 text-sm text-muted-foreground">{t.emptyQueue}</p>}
      </section>
    </div>
  )
}

function LocalQueue() {
  const t = useMessages(messages)
  const state = useMusic()
  const track = currentTrack(state)
  const list = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())

  const ahead = (kind: 'user' | 'context' | 'autoplay') =>
    state.entries
      .map((entry, position) => ({ entry, position, item: state.queue[position]! }))
      .filter(({ entry, position }) => position > state.index && entry.kind === kind)
  const user = ahead('user')
  const context = ahead('context')
  const autoplay = ahead('autoplay').slice(0, AUTOPLAY_SHOWN)

  // Rows that moved since the last render glide from where they were (by their entry's id, across sections).
  useLayoutEffect(() => {
    const box = list.current
    if (!box) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const next = new Map<string, number>()
    for (const row of box.querySelectorAll<HTMLElement>('[data-uid]')) {
      const uid = row.dataset.uid!
      const top = row.offsetTop
      const before = positions.current.get(uid)
      if (!still && before !== undefined && before !== top) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      } else if (!still && before === undefined && positions.current.size) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 })
      }
      next.set(uid, top)
    }
    positions.current = next
  })

  const row = ({ entry, position, item }: { entry: { uid: string; kind: QueueKind }; position: number; item: BaseItemDto }) => (
    <QueueRow key={entry.uid} uid={entry.uid} item={item} index={position} kind={entry.kind} />
  )

  return (
    <div ref={list} data-queue-list className="relative space-y-5">
      {track && state.entries[state.index] && (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">{t.currentTrack}</h3>
          {/* Songs dropped on (below) the current one go to the front of the user's queue. */}
          <QueueRow uid={state.entries[state.index]!.uid} item={track} index={state.index} kind="user" current />
        </section>
      )}
      {user.length > 0 && (
        <section className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">{t.nextInQueue}</h3>
            <button type="button" onClick={() => music.clearQueue()} className="shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline">
              {t.clearQueue}
            </button>
          </div>
          {user.map(row)}
        </section>
      )}
      {context.length > 0 && (
        <section className="space-y-1">
          <h3 className="truncate text-sm font-semibold">
            {t.nextFrom} <SourceLink source={state.source} />
          </h3>
          {context.map(row)}
        </section>
      )}
      {autoplay.length > 0 && (
        <section className="space-y-1">
          <h3 className="truncate text-sm font-semibold">
            {t.autoplayFrom} <SourceLink source={state.source} />
          </h3>
          {autoplay.map(row)}
        </section>
      )}
      {!user.length && !context.length && !autoplay.length && <p className="py-2 text-sm text-muted-foreground">{t.emptyQueue}</p>}
    </div>
  )
}

/** The queue entry being dragged within the queue (the browser's drag data can't be read until the drop). */
const QUEUE_TYPE = QUEUE_MOVE_TYPE
let draggedQueueIndex: number | null = null

/**
 * One row of the queue: a click plays it; it can be dragged to another place in the queue (between the user's queue
 * and the collection too) or onto a playlist; right-clicking offers the track's menu, with removing it from the queue.
 */
function QueueRow({ uid, item, index, kind, current }: { uid: string; item: BaseItemDto; index: number; kind: QueueKind; current?: boolean }) {
  const { api } = useAuthedSession()
  const t = useMessages(messages)
  // Fingers move rows by their handle or by resting on them (the browser's drag and drop is mouse only); the menu is a
  // longer press there.
  const touch = useTouch()
  const drag = useQueueRowDrag(index, touch && !current)
  const cover = portraitImageUrl(api, item, { fillHeight: 96 })
  // Offline, songs that need the network are greyed out (the player skips them).
  const unavailable = useUnavailable(item)
  const [mark, setMark] = useState<'before' | 'after' | null>(null)
  const takes = (event: DragEvent) => event.dataTransfer.types.includes(QUEUE_TYPE)
  // On the current track only "after" makes sense (nothing goes before what is playing).
  const partAt = (event: DragEvent) => {
    if (current) return 'after'
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  }
  return (
    <TrackContextMenu track={item} onRemove={current ? undefined : () => music.remove(index)} removeLabel={t.removeFromQueue}>
      <div
        {...drag.row}
        data-uid={uid}
        data-queue-index={index}
        data-queue-kind={kind}
        data-queue-current={current || undefined}
        draggable={!current && !touch}
        onDragStart={(event) => {
          startTrackDrag(event, [item])
          event.dataTransfer.setData(QUEUE_TYPE, uid)
          event.dataTransfer.effectAllowed = 'copyMove'
          draggedQueueIndex = index
        }}
        onDragEnd={() => {
          endTrackDrag()
          draggedQueueIndex = null
        }}
        onDragOver={(event) => {
          if (!takes(event) || draggedQueueIndex === index) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          const next = partAt(event)
          if (next !== mark) setMark(next)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setMark(null)
        }}
        onDrop={(event) => {
          setMark(null)
          if (!takes(event) || draggedQueueIndex === null) return
          event.preventDefault()
          event.stopPropagation()
          music.reorder(draggedQueueIndex, partAt(event) === 'after' ? index + 1 : index, kind)
          draggedQueueIndex = null
        }}
        className={cn(
          'group relative flex items-center gap-3 rounded-md p-1.5 hover:bg-muted data-popup-open:bg-muted',
          unavailable && 'opacity-40',
          // Where the dragged song would land: a line between the rows.
          mark && 'after:pointer-events-none after:absolute after:inset-x-1 after:h-0.5 after:rounded-full after:bg-listen',
          mark === 'before' ? 'after:-top-px' : mark === 'after' ? 'after:-bottom-px' : '',
          // The same line while a finger moves a row (set by QueueHandle on the row it would land at).
          'data-[drop]:after:pointer-events-none data-[drop]:after:absolute data-[drop]:after:inset-x-1 data-[drop]:after:h-0.5 data-[drop]:after:rounded-full data-[drop]:after:bg-listen data-[drop=after]:after:-bottom-px data-[drop=before]:after:-top-px',
        )}
      >
        {/* The cover turns into a play button on hover (as in Spotify); the title plays too, the artists lead to them. */}
        <button
          type="button"
          aria-label={current ? item.Name ?? '' : t.playThis(item.Name ?? '')}
          onClick={() => !current && music.jump(index)}
          className="group/cover relative size-10 shrink-0 overflow-hidden rounded bg-muted"
        >
          {cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}
          {!current && (
            <span className="absolute inset-0 grid place-items-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:hidden">
              <IconPlayerPlayFilled className="size-4" />
            </span>
          )}
        </button>
        <span className="min-w-0 flex-1">
          <button type="button" onClick={() => !current && music.jump(index)} className={cn('block max-w-full truncate text-left text-sm', current && 'text-listen')}>
            {item.Name}
          </button>
          <span className="block truncate text-xs text-muted-foreground">
            <TrackArtists track={item} />
          </span>
        </span>
        {touch ? (
          !current && (
            <button
              type="button"
              aria-label={t.moveInQueue(item.Name ?? '')}
              {...drag.handle}
              className="grid size-10 shrink-0 cursor-grab touch-none place-items-center text-muted-foreground"
            >
              <IconMenu2 className="size-5" />
            </button>
          )
        ) : (
          <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-data-popup-open:opacity-100">
            <TrackMenu track={item} visible onRemove={current ? undefined : () => music.remove(index)} removeLabel={t.removeFromQueue} />
          </span>
        )}
      </div>
    </TrackContextMenu>
  )
}

/** How long a finger rests on a queue row before it lifts the row (moving earlier scrolls the list instead). */
const LIFT_DELAY = 280

/**
 * Moving a queue row with a finger: from its handle at once, or from anywhere on the row after resting there a moment
 * (it lifts; held still longer, the row's menu opens instead). Pulled up or down, the row follows and a line shows where
 * it would land (before or after the row under the finger, in that row's part of the queue); letting go moves it there.
 * Gives the row's ref and handlers, and the handle's handlers.
 */
function useQueueRowDrag(index: number, enabled: boolean) {
  const rowRef = useRef<HTMLDivElement>(null)
  const start = useRef<{ y: number; x: number; id: number; lifted: boolean; timer: number } | null>(null)
  const target = useRef<{ row: HTMLElement; after: boolean } | null>(null)
  // A tap that lifted the row is no tap (it doesn't play the song).
  const swallowClick = useRef(false)

  const clearMark = () => {
    target.current?.row.removeAttribute('data-drop')
    target.current = null
  }
  const markAt = (y: number, dragged: HTMLElement) => {
    // The row the finger is over, among the others (the dragged one moves along with it).
    const rows = [...(dragged.closest('[data-queue-list]') ?? document).querySelectorAll<HTMLElement>('[data-queue-index]')].filter((row) => row !== dragged)
    const row = rows.find((candidate) => y < candidate.getBoundingClientRect().bottom) ?? rows.at(-1)
    clearMark()
    if (!row) return
    const rect = row.getBoundingClientRect()
    // Nothing goes before what is playing.
    const after = row.hasAttribute('data-queue-current') || y > rect.top + rect.height / 2
    row.dataset.drop = after ? 'after' : 'before'
    target.current = { row, after }
  }
  const lift = (pointerId: number) => {
    const row = rowRef.current
    const at = start.current
    if (!row || !at) return
    at.lifted = true
    swallowClick.current = true
    try {
      row.setPointerCapture(pointerId)
    } catch {
      // The finger already left.
    }
    row.style.zIndex = '10'
    row.style.background = 'var(--muted)'
    row.style.boxShadow = '0 8px 24px rgb(0 0 0 / 0.35)'
    navigator.vibrate?.(10)
  }
  const reset = () => {
    const at = start.current
    start.current = null
    if (at) window.clearTimeout(at.timer)
    clearMark()
    const row = rowRef.current
    if (row) row.style.transform = row.style.zIndex = row.style.background = row.style.boxShadow = ''
  }

  // While a row is lifted the list must not scroll under the finger (only a listener that may cancel can stop it).
  useEffect(() => {
    const row = rowRef.current
    if (!row || !enabled) return
    const hold = (event: TouchEvent) => {
      if (start.current?.lifted && event.cancelable) event.preventDefault()
    }
    row.addEventListener('touchmove', hold, { passive: false })
    return () => row.removeEventListener('touchmove', hold)
  }, [enabled])

  const move = (event: PointerEvent) => {
    const at = start.current
    if (!at || event.pointerId !== at.id) return
    if (!at.lifted) {
      // Moved before resting: the list scrolls.
      if (Math.abs(event.clientY - at.y) > 8 || Math.abs(event.clientX - at.x) > 8) reset()
      return
    }
    rowRef.current!.style.transform = `translateY(${event.clientY - at.y}px)`
    markAt(event.clientY, rowRef.current!)
  }
  const up = (event: PointerEvent) => {
    const at = start.current
    if (!at || event.pointerId !== at.id) return
    const drop = at.lifted ? target.current : null
    reset()
    if (!drop) return
    const to = Number(drop.row.dataset.queueIndex)
    music.reorder(index, drop.after ? to + 1 : to, drop.row.dataset.queueKind as QueueKind)
  }

  const row = enabled
    ? {
        ref: rowRef,
        // The sheet around the queue must not take these drags for closing it.
        'data-base-ui-swipe-ignore': '',
        onPointerDown: (event: PointerEvent) => {
          if (event.pointerType !== 'touch' || !event.isPrimary) return
          swallowClick.current = false
          reset()
          const timer = window.setTimeout(() => lift(event.pointerId), LIFT_DELAY)
          start.current = { y: event.clientY, x: event.clientX, id: event.pointerId, lifted: false, timer }
        },
        onPointerMove: move,
        onPointerUp: up,
        onPointerCancel: reset,
        // Held still past the lift, the row's menu opens: the row goes back to its place.
        onContextMenu: () => {
          if (start.current && !target.current) reset()
        },
        onClickCapture: (event: MouseEvent) => {
          if (!swallowClick.current) return
          swallowClick.current = false
          event.stopPropagation()
          event.preventDefault()
        },
      }
    : { ref: rowRef }

  const handle = {
    'data-base-ui-swipe-ignore': '',
    onPointerDown: (event: PointerEvent) => {
      if (!rowRef.current) return
      event.stopPropagation()
      reset()
      start.current = { y: event.clientY, x: event.clientX, id: event.pointerId, lifted: false, timer: 0 }
      lift(event.pointerId)
    },
  }

  return { row, handle }
}

/**
 * Lyrics on the cover's colour; synced ones follow the music (the current line lit, scrolled into view) and a click on
 * a line jumps there. In the big panel they are set large for singing along.
 */
export function LyricsView({ track, big }: { track: BaseItemDto; big: boolean }) {
  const t = useMessages(messages)
  const lyrics = useLyrics(track)
  const { position } = usePlayerTime()
  const { seek } = usePlayerControls()
  const list = useRef<HTMLDivElement>(null)
  const lines = lyrics.data?.lines ?? []
  const synced = !!lyrics.data?.synced
  let current = -1
  if (synced) for (let i = 0; i < lines.length; i++) if ((lines[i]!.time ?? Infinity) <= position + 0.2) current = i

  // The first time (the view just opened, or grew or shrank) the current line is simply there, before anything is
  // drawn; after that the lyrics glide along with the music.
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (current < 0) return
    // Only the lyrics' own scroll box moves (scrollIntoView would also shift the layers around it, mid-slide).
    const line = list.current?.querySelector<HTMLElement>(`[data-line="${current}"]`)
    const box = list.current?.parentElement
    if (line && box) {
      const offset = line.getBoundingClientRect().top - box.getBoundingClientRect().top - (box.clientHeight - line.offsetHeight) / 2
      box.scrollTo({ top: box.scrollTop + offset, behavior: placed.current ? 'smooth' : 'instant' })
    }
    placed.current = true
  }, [current])

  const frame = cn('text-white', big ? 'mx-auto max-w-4xl px-10 py-12' : 'px-5 py-5')
  if (lyrics.isLoading) return <div className={cn(frame, 'space-y-3')}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-6 bg-white/10" />)}</div>
  if (!lines.length) return <p className={cn(frame, 'text-sm text-white/70')}>{t.noLyrics}</p>
  return (
    <div ref={list} className={cn(frame, big ? 'space-y-5' : 'space-y-3')}>
      {lines.map((line, index) => (
        <p
          key={index}
          data-line={index}
          onClick={() => synced && line.time !== undefined && seek(line.time)}
          className={cn(
            'font-bold leading-snug transition-colors duration-300',
            big ? 'text-3xl sm:text-4xl xl:text-5xl' : 'text-xl',
            !synced ? 'text-white' : index === current ? 'text-white' : index < current ? 'text-white/55' : 'text-white/35',
            synced && 'cursor-pointer hover:text-white/90',
          )}
        >
          {line.text || '♪'}
        </p>
      ))}
      <p className="pt-4 text-xs text-white/60">{t.lyricsFrom(lyricsSourceName(lyrics.data?.source ?? 'jellyfin'))}</p>
    </div>
  )
}
