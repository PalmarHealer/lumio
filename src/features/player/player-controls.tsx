import {
  IconListDetails,
  IconMaximize,
  IconMinimize,
  IconPlayerPause,
  IconPlayerPlay,
  IconPictureInPicture,
  IconPictureInPictureOff,
  IconPlayerSkipForward,
  IconRewindBackward10,
  IconRewindBackward15,
  IconRewindBackward20,
  IconRewindBackward30,
  IconRewindBackward5,
  IconRewindForward10,
  IconRewindForward15,
  IconRewindForward20,
  IconRewindForward30,
  IconRewindForward5,
  IconSettings,
  IconVolume,
  IconVolume2,
  IconVolume3,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { formatClock } from '@/lib/format'
import { useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { controlsMessages } from './messages'
import { SeekBar } from './seek-bar'
import type { TrickplayLookup } from './trickplay'
import type { VideoState } from './use-video-state'
import type { PictureArea } from './video-fit'
import { lengthLabel, toggleRemainingTime, useRemainingTime } from '@/lib/remaining-time'

interface PlayerControlsProps {
  state: VideoState
  fullscreen: boolean
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  frameAt?: TrickplayLookup | null
  pictureArea?: PictureArea
  onScrub?: (seconds: number | null) => void
  onSeekBy: (delta: number) => void
  skipBackSeconds: number
  skipForwardSeconds: number
  onVolume: (volume: number) => void
  onToggleMute: () => void
  /** Omitted where the player is always fullscreen (inside an app). */
  onToggleFullscreen?: () => void
  settingsOpen: boolean
  episodesOpen: boolean
  /** Omitted when there is no list to show (movies). */
  onToggleEpisodes?: () => void
  /** Omitted for audio-only items, which have no tracks or quality to choose. */
  onToggleSettings?: () => void
  /** Set when something follows (next episode / track). */
  onNext?: () => void
  /** Omitted when the browser has no picture-in-picture (or the item no picture). */
  onTogglePip?: () => void
  pip?: boolean
  /** Fingers: play and skip sit in the middle of the picture (TouchTransport), volume is the device's. */
  touch?: boolean
}

const BACK_ICONS = { 5: IconRewindBackward5, 10: IconRewindBackward10, 15: IconRewindBackward15, 20: IconRewindBackward20, 30: IconRewindBackward30 } as const
const FORWARD_ICONS = { 5: IconRewindForward5, 10: IconRewindForward10, 15: IconRewindForward15, 20: IconRewindForward20, 30: IconRewindForward30 } as const

export function PlayerControls({
  state,
  fullscreen,
  onTogglePlay,
  onSeek,
  frameAt,
  pictureArea,
  onScrub,
  onSeekBy,
  skipBackSeconds,
  skipForwardSeconds,
  onVolume,
  onToggleMute,
  onToggleFullscreen,
  settingsOpen,
  episodesOpen,
  onToggleEpisodes,
  onToggleSettings,
  onNext,
  onTogglePip,
  pip,
  touch,
}: PlayerControlsProps) {
  const t = useMessages(controlsMessages)
  const showRemaining = useRemainingTime()
  const silent = state.muted || state.volume === 0
  const BackIcon = BACK_ICONS[skipBackSeconds as keyof typeof BACK_ICONS] ?? IconRewindBackward10
  const ForwardIcon = FORWARD_ICONS[skipForwardSeconds as keyof typeof FORWARD_ICONS] ?? IconRewindForward10
  const VolumeIcon = silent ? IconVolume3 : state.volume < 0.5 ? IconVolume2 : IconVolume

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-black/80 via-black/40 to-transparent pt-16 pr-[max(1rem,var(--safe-right))] pb-[max(1rem,var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] text-white sm:pr-[max(2rem,var(--safe-right))] sm:pl-[max(2rem,var(--safe-left))]">
      <SeekBar currentTime={state.currentTime} duration={state.duration} buffered={state.buffered} ranges={state.ranges} onSeek={onSeek} frameAt={frameAt} pictureArea={pictureArea} onScrub={onScrub} />

      <div className="flex items-center gap-1">
        {!touch && (
          <>
            <Button variant="ghost" size="icon" aria-label={state.paused ? t.play : t.pause} onClick={onTogglePlay}>
              {state.paused ? <IconPlayerPlay className="fill-current" /> : <IconPlayerPause className="fill-current" />}
            </Button>
            <Button variant="ghost" size="icon" aria-label={t.skipBack(skipBackSeconds)} onClick={() => onSeekBy(-skipBackSeconds)}>
              <BackIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t.skipForward(skipForwardSeconds)} onClick={() => onSeekBy(skipForwardSeconds)}>
              <ForwardIcon />
            </Button>
          </>
        )}
        {onNext && (
          <Button variant="ghost" size={touch ? 'icon-lg' : 'icon'} aria-label={t.next} title={t.next} onClick={onNext}>
            <IconPlayerSkipForward />
          </Button>
        )}

        <div className={cn('group/volume flex items-center', touch && 'hidden')}>
          <Button variant="ghost" size="icon" aria-label={silent ? t.unmute : t.mute} onClick={onToggleMute}>
            <VolumeIcon />
          </Button>
          {/* py keeps the knob's shadow from being clipped by overflow-hidden (needed for the unfold animation). */}
          <div className="hidden w-0 overflow-hidden px-0 py-2 opacity-0 transition-all group-hover/volume:w-24 group-hover/volume:px-2 group-hover/volume:opacity-100 group-focus-within/volume:w-24 group-focus-within/volume:px-2 group-focus-within/volume:opacity-100 sm:block">
            <Slider
              min={0}
              max={1}
              // Fine steps, so dragging moves smoothly (in 5 % steps the short bar jumped by several pixels).
              step={0.01}
              value={[silent ? 0 : state.volume]}
              aria-label={t.volume}
              onValueChange={(next) => onVolume(Array.isArray(next) ? (next[0] ?? 0) : next)}
              // Centred on the level, the bar shows it from the start: an edge-aligned one is only placed once its knob
              // is measured, and folded away (and the knob scaled to nothing) it isn't until first touched.
              thumbAlignment="center"
              // Same look and behaviour as the seek bar: thin track that thickens on hover, knob only while hovered,
              // focused or dragged.
              className={cn(
                'group/slider',
                '**:data-[slot=slider-track]:h-1 **:data-[slot=slider-track]:bg-white/25 **:data-[slot=slider-track]:transition-[height] hover:**:data-[slot=slider-track]:h-1.5',
                '**:data-[slot=slider-range]:bg-white',
                '**:data-[slot=slider-thumb]:size-3.5 **:data-[slot=slider-thumb]:scale-0 **:data-[slot=slider-thumb]:border-0 **:data-[slot=slider-thumb]:bg-white **:data-[slot=slider-thumb]:shadow **:data-[slot=slider-thumb]:ring-0 **:data-[slot=slider-thumb]:transition-transform',
                'hover:**:data-[slot=slider-thumb]:scale-100 has-[:focus-visible]:**:data-[slot=slider-thumb]:scale-100 data-dragging:**:data-[slot=slider-thumb]:scale-100',
                // Pressing goes to the bar, never the knob: the knob would keep the distance it was grabbed at and
                // follow the pointer offset, the bar puts the level right under it.
                '**:data-[slot=slider-thumb]:pointer-events-none',
              )}
            />
          </div>
        </div>

        <span className={cn('text-sm tabular-nums text-white/90', !touch && 'ml-3')}>
          {formatClock(state.currentTime)} /{' '}
          {/* A click switches between the length and the time left (also in the music bar). */}
          <button type="button" onClick={toggleRemainingTime} title={t.lengthToggle} className="tabular-nums outline-none hover:text-white focus-visible:underline">
            {lengthLabel(state.currentTime, state.duration, showRemaining)}
          </button>
        </span>

        <div className="flex-1" />

        {onToggleEpisodes && (
          <Button variant="ghost" size="icon" aria-label={t.episodes} title={t.episodes} aria-expanded={episodesOpen} onClick={onToggleEpisodes}>
            <IconListDetails />
          </Button>
        )}
        {onTogglePip && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={pip ? t.exitPip : t.pip}
            title={pip ? t.exitPip : t.pip}
            aria-pressed={pip}
            onClick={onTogglePip}
          >
            {pip ? <IconPictureInPictureOff /> : <IconPictureInPicture />}
          </Button>
        )}
        {onToggleSettings && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.settings}
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            onClick={onToggleSettings}
          >
            <IconSettings className={settingsOpen ? 'rotate-45 transition-transform' : 'transition-transform'} />
          </Button>
        )}
        {onToggleFullscreen && (
          <Button variant="ghost" size="icon" aria-label={fullscreen ? t.exitFullscreen : t.fullscreen} onClick={onToggleFullscreen}>
            {fullscreen ? <IconMinimize /> : <IconMaximize />}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Fingers: play/pause and the skips large in the middle of the picture, as phone video apps have them. */
export function TouchTransport({
  paused,
  onTogglePlay,
  onSeekBy,
  skipBackSeconds,
  skipForwardSeconds,
  visible,
}: Pick<PlayerControlsProps, 'onTogglePlay' | 'onSeekBy' | 'skipBackSeconds' | 'skipForwardSeconds'> & { paused: boolean; visible: boolean }) {
  const t = useMessages(controlsMessages)
  const BackIcon = BACK_ICONS[skipBackSeconds as keyof typeof BACK_ICONS] ?? IconRewindBackward10
  const ForwardIcon = FORWARD_ICONS[skipForwardSeconds as keyof typeof FORWARD_ICONS] ?? IconRewindForward10
  // Hidden controls can't be hit: a tap on the picture then only brings them back.
  // Each button fades by itself (not a parent): see the player, the blur must stay on while it fades in.
  const round = cn(
    visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
    'grid place-items-center rounded-full bg-black/35 text-white outline-none backdrop-blur-sm active:scale-95 transition-[opacity,scale] duration-300 focus-visible:ring-2 focus-visible:ring-white/70',
  )
  return (
    // Taps beside the buttons reach the picture (show/hide the controls, double tap to skip).
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-10">
      <button type="button" aria-label={t.skipBack(skipBackSeconds)} onClick={() => onSeekBy(-skipBackSeconds)} className={cn(round, 'size-14')}>
        <BackIcon className="size-7" />
      </button>
      <button type="button" aria-label={paused ? t.play : t.pause} onClick={onTogglePlay} className={cn(round, 'size-18')}>
        {paused ? <IconPlayerPlay className="size-9 translate-x-0.5 fill-current" /> : <IconPlayerPause className="size-9 fill-current" />}
      </button>
      <button type="button" aria-label={t.skipForward(skipForwardSeconds)} onClick={() => onSeekBy(skipForwardSeconds)} className={cn(round, 'size-14')}>
        <ForwardIcon className="size-7" />
      </button>
    </div>
  )
}
