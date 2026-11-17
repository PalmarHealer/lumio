import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import {
  IconArrowsShuffle,
  IconCast,
  IconHeadphones,
  IconHeart,
  IconHeartFilled,
  IconLoader2,
  IconMicrophone2,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconPlaylist,
  IconRepeat,
  IconRepeatOnce,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconX,
} from '@tabler/icons-react'
import { Fragment, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Link } from '@/components/link'
import { FadeImage } from '@/components/media/fade-image'
import { Slider } from '@/components/ui/slider'
import { useAuthedSession } from '@/features/auth/session'
import { useSetFavorite } from '@/features/items/queries'
import { modeHome } from '@/lib/app-mode'
import { formatClock } from '@/lib/format'
import { useMessages } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { externalOf } from '@/lib/external-items'
import { artistsOf, itemHref } from '@/lib/item-links'
import { cn } from '@/lib/utils'
import { playerBarMessages } from './messages'
import { currentTrack, music, useMusic } from './music-player'
import { useLyrics } from './lyrics'
import { useTrackQuality } from './quality'
import { toggleListenPanel, useListenPanel, type ListenPanel } from './panel'
import { playCircle } from '../play-circle'
import { endTrackDrag, startTrackDrag, useTrackDrop } from '../track-drag'
import { TrackContextMenu } from '../track-menu'
import { SleepTimerMenu } from './sleep-timer-menu'
import { usePlayerControls, usePlayerTime } from './player-controls'
import { lengthLabel, toggleRemainingTime, useRemainingTime } from '@/lib/remaining-time'
import { artistHref, useTrackArtists } from '../credits'
import { TrackArtists } from '../track-artists'
import { DownloadedMark } from '../download-ui'

/** Listen's player bar along the bottom: the track, the transport with its progress, and queue, lyrics and volume. */
export function PlayerBar() {
  return <Bar />
}

function Bar() {
  const t = useMessages(playerBarMessages)
  const { track } = usePlayerControls()
  return (
    <div
      role="region"
      aria-label={t.player}
      // Phones have PhoneMiniPlayer above the tabs instead.
      className="fixed inset-x-0 bottom-0 z-40 hidden h-20 items-center gap-4 bg-background px-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,40rem)_minmax(0,1fr)]"
    >
      {track ? <TrackInfo track={track} /> : <EmptyTrackInfo />}
      {/* Nothing loaded: the controls stay in place but can't be used. */}
      <div className={cn(!track && 'pointer-events-none opacity-40')}>
        <Transport />
      </div>
      <Extras />
    </div>
  )
}

/** Where the playing track shows, while there is none: a quiet placeholder of the same shape. */
function EmptyTrackInfo() {
  return (
    <div aria-hidden className="flex min-w-0 items-center gap-3">
      <span className="size-14 shrink-0 rounded-md bg-muted" />
      <span className="space-y-2">
        <span className="block h-3 w-32 rounded bg-muted" />
        <span className="block h-2.5 w-20 rounded bg-muted/70" />
      </span>
    </div>
  )
}

function TrackInfo({ track }: { track: BaseItemDto }) {
  const { api } = useAuthedSession()
  const t = useMessages(playerBarMessages)
  const { remote } = usePlayerControls()
  const cover = portraitImageUrl(api, track, { fillHeight: 128 })
  const liked = !!track.UserData?.IsFavorite
  const [likedNow, setLikedNow] = useState<{ id: string; value: boolean } | null>(null)
  const isLiked = likedNow && likedNow.id === track.Id ? likedNow.value : liked
  const favorite = useSetFavorite(track.Id!)
  // Podcast episodes aren't Jellyfin items: nothing to like.
  const external = !!externalOf(track)
  return (
    // The playing track can be dragged onto a playlist, and right-clicked, like any song row.
    <TrackContextMenu track={track}>
      <div draggable onDragStart={(event) => startTrackDrag(event, [track])} onDragEnd={endTrackDrag} className="flex min-w-0 items-center gap-3">
        <Link to={itemHref(track)} className="size-14 shrink-0 overflow-hidden rounded-md bg-muted">
          {cover && <FadeImage key={cover} src={cover} alt="" className="size-full object-cover" />}
        </Link>
        <div className="min-w-0">
          <Link to={itemHref(track)} className="block truncate text-sm font-medium hover:underline">
            {track.Name}
          </Link>
          <ArtistLine item={track} />
          {remote ? (
            <p className="flex items-center gap-1 truncate text-xs font-semibold text-listen">
              <IconCast className="size-3.5 shrink-0" /> {t.playingOn(remote.name)}
            </p>
          ) : (
            <QualityLine track={track} />
          )}
        </div>
        {!external && (
          <button
            type="button"
            aria-label={isLiked ? t.unlike : t.like}
            title={isLiked ? t.unlike : t.like}
            onClick={() => {
              setLikedNow({ id: track.Id!, value: !isLiked })
              favorite.mutate(!isLiked)
            }}
            className={cn('hidden shrink-0 rounded-full p-1.5 transition-colors sm:block', isLiked ? 'text-listen' : 'text-muted-foreground hover:text-foreground')}
          >
            {isLiked ? <IconHeartFilled className="size-4" /> : <IconHeart className="size-4" />}
          </button>
        )}
      </div>
    </TrackContextMenu>
  )
}

/** The sound quality under the artists ("Lossless" in the accent colour); a click explains it in the side panel. */
function QualityLine({ track }: { track: BaseItemDto }) {
  const quality = useTrackQuality(track)
  const panel = useListenPanel()
  if (!quality) return null
  return (
    <button
      type="button"
      onClick={() => toggleListenPanel('quality')}
      aria-pressed={panel.expanded ? panel.beside === 'quality' : panel.open && panel.view === 'quality'}
      className={cn('block max-w-full truncate text-left text-[11px] font-semibold leading-tight hover:underline', quality.lossless ? 'text-listen' : 'text-muted-foreground')}
    >
      {quality.label}
    </button>
  )
}

/** "Kygo, Tom Odell", each a link to the artist's page. */
export function ArtistLine({ item, className }: { item: BaseItemDto; className?: string }) {
  // With the featured artists MusicBrainz names that the file's tags leave out (looked up now for what plays).
  const credited = useTrackArtists(item.Type === 'Audio' ? item : undefined, true)
  const artists = item.Type === 'Audio' ? credited : artistsOf(item)
  return (
    <p className={cn('truncate text-xs text-muted-foreground', className)}>
      <DownloadedMark item={item} />
      {artists.map((artist, index) => (
        <Fragment key={artist.id ?? artist.name}>
          {index > 0 && ', '}
          <Link to={artistHref(artist)} className="hover:text-foreground hover:underline">
            {artist.name}
          </Link>
        </Fragment>
      ))}
    </p>
  )
}

function Transport() {
  const t = useMessages(playerBarMessages)
  const state = usePlayerControls()
  const RepeatIcon = state.repeat === 'one' ? IconRepeatOnce : IconRepeat
  const repeatLabel = state.repeat === 'off' ? t.repeatOff : state.repeat === 'all' ? t.repeatAll : t.repeatOne
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <ToggleButton label={state.shuffle ? t.shuffleOn : t.shuffleOff} active={state.shuffle} onClick={state.toggleShuffle} className="hidden sm:grid">
          <IconArrowsShuffle className="size-4" />
        </ToggleButton>
        <IconButton label={t.previous} onClick={state.previous}>
          <IconPlayerSkipBackFilled className="size-4" />
        </IconButton>
        <button
          type="button"
          aria-label={state.playing ? t.pause : t.play}
          onClick={state.toggle}
          className={cn('size-9', playCircle.light)}
        >
          {state.buffering && !state.playing ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : state.playing ? (
            <IconPlayerPauseFilled className="size-4" />
          ) : (
            <IconPlayerPlayFilled className="size-4 translate-x-px" />
          )}
        </button>
        <IconButton label={t.next} onClick={state.next}>
          <IconPlayerSkipForwardFilled className="size-4" />
        </IconButton>
        <ToggleButton label={repeatLabel} active={state.repeat !== 'off'} onClick={state.cycleRepeat} className="hidden sm:grid">
          <RepeatIcon className="size-4" />
        </ToggleButton>
      </div>
      <Progress />
    </div>
  )
}

/** Time, a slim seek bar (dragging previews the position, letting go seeks) and the length. */
function Progress() {
  const t = useMessages(playerBarMessages)
  const { seek } = usePlayerControls()
  const { position, duration } = usePlayerTime()
  const showRemaining = useRemainingTime()
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const fractionAt = (event: PointerEvent) => {
    const rect = track.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  }
  const shown = drag ?? (duration ? position / duration : 0)
  return (
    <div className="hidden w-full items-center gap-2 text-[11px] tabular-nums text-muted-foreground sm:flex">
      <span className="w-10 text-right">{formatClock(drag !== null ? drag * duration : position)}</span>
      <div
        ref={track}
        role="slider"
        aria-label={t.position}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={formatClock(position)}
        tabIndex={0}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -5, ArrowRight: 5 }[event.key]
          if (step === undefined) return
          event.preventDefault()
          seek(position + step)
        }}
        onPointerDown={(event) => {
          if (!duration) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setDrag(fractionAt(event))
        }}
        onPointerMove={(event) => drag !== null && setDrag(fractionAt(event))}
        onPointerUp={(event) => {
          if (drag === null) return
          seek(fractionAt(event) * duration)
          setDrag(null)
        }}
        onPointerCancel={() => setDrag(null)}
        className="group relative flex h-4 flex-1 cursor-pointer touch-none items-center outline-none"
      >
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/20">
          <div className="h-full rounded-full bg-foreground group-hover:bg-listen-hover" style={{ width: `${shown * 100}%` }} />
        </div>
        <div
          className={cn('absolute size-3 -translate-x-1/2 rounded-full bg-foreground shadow transition-opacity', drag !== null ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
          style={{ left: `${shown * 100}%` }}
        />
      </div>
      {/* A click switches between the length and the time left (also in the video player). */}
      <button type="button" onClick={toggleRemainingTime} title={t.lengthToggle} className="w-10 text-left outline-none hover:text-foreground focus-visible:underline">
        {lengthLabel(drag !== null ? drag * duration : position, duration, showRemaining)}
      </button>
    </div>
  )
}

function Extras() {
  const t = useMessages(playerBarMessages)
  const state = usePlayerControls()
  const panel = useListenPanel()
  const lyrics = useLyrics(state.track)
  const noLyrics = !lyrics.isLoading && !lyrics.data?.lines.length
  const VolumeIcon = state.muted || state.volume === 0 ? IconVolume3 : state.volume < 0.5 ? IconVolume2 : IconVolume
  const toggles: Array<{ target: Exclude<ListenPanel, 'nowPlaying'>; label: string; icon: ReactNode; disabled?: boolean }> = [
    { target: 'lyrics', label: noLyrics ? t.noLyrics : t.lyrics, icon: <IconMicrophone2 className="size-4" />, disabled: noLyrics },
    { target: 'queue', label: t.queue, icon: <IconPlaylist className="size-4" /> },
  ]
  return (
    <div className="hidden items-center justify-end gap-1 md:flex">
      {/* Steering another device: the way back, beside its lyrics and queue. */}
      {state.remote && (
        <button
          type="button"
          onClick={state.remote.disconnect}
          className="mr-1 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconX className="size-3.5" /> {t.disconnect}
        </button>
      )}
      {toggles.map((toggle) =>
        toggle.target === 'queue' ? (
          <QueueDrop key={toggle.target} className="rounded-full">
            <ToggleButton label={toggle.label} active={panel.expanded ? panel.beside === 'queue' : panel.open && panel.view === toggle.target} onClick={() => toggleListenPanel(toggle.target)}>
              {toggle.icon}
            </ToggleButton>
          </QueueDrop>
        ) : (
          <ToggleButton
            key={toggle.target}
            label={toggle.label}
            active={panel.open && panel.view === toggle.target}
            disabled={toggle.disabled}
            onClick={() => toggleListenPanel(toggle.target)}
          >
            {toggle.icon}
          </ToggleButton>
        ),
      )}
      <SleepTimerMenu className="size-8" />
      <IconButton label={state.muted ? t.unmute : t.mute} onClick={state.toggleMute}>
        <VolumeIcon className="size-4" />
      </IconButton>
      {/* The slider fills its parent; the wrapper gives it its width. */}
      <div className="w-24">
        <Slider
          aria-label={t.volume}
          // Looks and behaves like the progress bar beside it: a light bar (rounded at its end), its knob centred on the
          // level; the accent and the knob only while pointing at it, dragging, or focused by keyboard.
          thumbAlignment="center"
          className={cn(
            // The bar stays thin, but the whole height around it can be grabbed.
            '[&>div]:py-2.5',
            '[&_[data-slot=slider-track]]:bg-foreground/20 [&_[data-slot=slider-range]]:rounded-full [&_[data-slot=slider-range]]:bg-foreground',
            '[&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-foreground [&_[data-slot=slider-thumb]]:shadow [&_[data-slot=slider-thumb]]:ring-0!',
            '[&_[data-slot=slider-thumb]]:opacity-0 [&_[data-slot=slider-thumb]]:transition-opacity',
            'hover:[&_[data-slot=slider-range]]:bg-listen-hover hover:[&_[data-slot=slider-thumb]]:opacity-100',
            'data-dragging:[&_[data-slot=slider-range]]:bg-listen-hover data-dragging:[&_[data-slot=slider-thumb]]:opacity-100',
            '[&:has(:focus-visible)_[data-slot=slider-thumb]]:opacity-100',
            // Pressing goes to the bar, never the (often invisible) knob: the knob would keep the distance it was
            // grabbed at and follow the pointer offset, the bar puts the level right under it.
            '[&_[data-slot=slider-thumb]]:pointer-events-none',
          )}
          min={0}
          max={100}
          value={[state.muted ? 0 : Math.round(state.volume * 100)]}
          onValueChange={(value) => state.setVolume((Array.isArray(value) ? value[0]! : value) / 100)}
        />
      </div>
    </div>
  )
}

/** Songs dropped here are added to the end of the queue (the queue button, and the open queue panel). */
export function QueueDrop({ className, children }: { className?: string; children: ReactNode }) {
  // Songs moved within the queue are placed by their rows, not added again.
  const drop = useTrackDrop((tracks) => music.addToQueue(tracks), true, { queueMoves: false })
  return (
    <div
      {...drop.handlers}
      className={cn(drop.over && 'bg-foreground/10 shadow-[inset_0_0_0_2px_var(--color-listen)]', className)}
    >
      {children}
    </div>
  )
}

function IconButton({ label, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', className)}
    >
      {children}
    </button>
  )
}

/** A button that stays lit (with a dot below, as in Spotify) while its feature is on. */
function ToggleButton({
  label,
  active,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative grid size-8 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35',
        active ? 'text-listen' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
      {active && <span className="absolute bottom-0.5 size-1 rounded-full bg-listen" />}
    </button>
  )
}

/**
 * In Watch, music that keeps playing shows as a small card in the corner: what's on, play/pause, next, and a way back
 * to Listen. Watch's own player (films) pauses it.
 */
export function MiniPlayer() {
  const { api } = useAuthedSession()
  const t = useMessages(playerBarMessages)
  const navigate = useNavigate()
  const state = useMusic()
  const track = currentTrack(state)
  if (!track) return null
  const cover = portraitImageUrl(api, track, { fillHeight: 96 })
  return (
    <div
      role="region"
      aria-label={t.player}
      // Phones have PhoneMiniPlayer above the tabs instead.
      className="fixed bottom-4 right-4 z-40 flex w-80 items-center gap-3 rounded-xl border bg-popover/95 p-2 pr-3 shadow-2xl backdrop-blur animate-in slide-in-from-bottom-4 fade-in-0 duration-300 max-md:hidden"
    >
      <button type="button" onClick={() => void navigate(modeHome('listen'))} aria-label={t.openListen} title={t.openListen} className="group relative size-11 shrink-0 overflow-hidden rounded-md bg-muted">
        {cover && <FadeImage src={cover} alt="" className="size-full object-cover" />}
        <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
          <IconHeadphones className="size-5 text-white" />
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{track.Name}</p>
        <p className="truncate text-xs text-muted-foreground">
          <TrackArtists track={track} linked={false} />
        </p>
      </div>
      <button type="button" aria-label={state.playing ? t.pause : t.play} onClick={music.toggle} className={cn('size-8 shrink-0', playCircle.light)}>
        {state.playing ? <IconPlayerPauseFilled className="size-4" /> : <IconPlayerPlayFilled className="size-4 translate-x-px" />}
      </button>
      <IconButton label={t.next} onClick={music.next}>
        <IconPlayerSkipForwardFilled className="size-4" />
      </IconButton>
      <IconButton label={t.stop} onClick={music.stop} className="-mr-1">
        <IconX className="size-4" />
      </IconButton>
    </div>
  )
}
