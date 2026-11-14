import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import {
  IconCast,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconPlayerStop,
  IconRewindBackward10,
  IconRewindForward10,
  IconX,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { FadeImage } from '@/components/media/fade-image'
import { Button } from '@/components/ui/button'
import { useAuthedSession } from '@/features/auth/session'
import { SeekBar } from '@/features/player/seek-bar'
import { formatClock, ticksToSeconds, secondsToTicks } from '@/lib/format'
import { useMessages } from '@/lib/i18n'
import { backdropImageUrl } from '@/lib/images'
import { cn } from '@/lib/utils'
import { remoteBarMessages } from './messages'
import type { RemoteTarget } from './remote-provider'
import { useRemoteSession } from './remote-session'

const SKIP_SECONDS = 10
/** Length of the exit animation; the bar is unmounted after it. */
const EXIT_MS = 200

interface RemoteBarProps {
  /** null hides the bar (with its exit animation). */
  target: RemoteTarget | null
  /** Stop controlling the device and use this one again. */
  onDisconnect: () => void
}

/** Keeps the bar on screen for its exit animation after the target is gone. */
export function RemoteBar({ target, onDisconnect }: RemoteBarProps) {
  const [shown, setShown] = useState(target)
  const [closing, setClosing] = useState(false)
  if (target && target !== shown) {
    setShown(target)
    setClosing(false)
  } else if (!target && shown && !closing) {
    setClosing(true)
  }
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setShown(null)
      setClosing(false)
    }, EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [closing])

  if (!shown) return null
  return <RemoteBarContent target={shown} closing={closing} onDisconnect={onDisconnect} />
}

/** Controller for another device Lumio is playing on: what is playing there, a seek bar, and play/pause/skip/stop. */
function RemoteBarContent({ target, closing, onDisconnect }: { target: RemoteTarget; closing: boolean; onDisconnect: () => void }) {
  const { api } = useAuthedSession()
  const t = useMessages(remoteBarMessages)
  const { query: sessions, remote, anchor } = useRemoteSession(target.sessionId)
  const playing = remote?.NowPlayingItem
  const paused = remote?.PlayState?.IsPaused ?? false
  const position = remote?.PlayState?.PositionTicks ?? 0
  const duration = playing?.RunTimeTicks ?? 0
  const gone = sessions.isSuccess && !remote

  /** Where the last seek sent the device; repeated presses add up instead of all starting from the same poll. */
  const [lastSeek, setLastSeek] = useState<{ ticks: number; at: number } | null>(null)
  // The device reports its position every couple of seconds; in between, the bar moves on by itself.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (paused || !playing) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [paused, playing])
  const estimate = (at: number) => {
    const moved = (since: number) => (paused ? 0 : Math.max(0, at - since) * 10_000)
    const base =
      lastSeek && lastSeek.at > sessions.dataUpdatedAt
        ? lastSeek.ticks + moved(lastSeek.at)
        : anchor
          ? secondsToTicks(anchor.position) + moved(anchor.at)
          : position + moved(sessions.dataUpdatedAt)
    return duration ? Math.min(base, duration) : base
  }
  const livePosition = estimate(now)

  const send = (command: 'PlayPause' | 'Stop' | 'NextTrack' | 'PreviousTrack') =>
    void getSessionApi(api).sendPlaystateCommand({ sessionId: target.sessionId, command }).then(() => sessions.refetch())
  const seekTo = (ticks: number) => {
    const clamped = Math.max(0, duration ? Math.min(ticks, duration) : ticks)
    const at = Date.now()
    setLastSeek({ ticks: clamped, at })
    setNow(at)
    void getSessionApi(api)
      .sendPlaystateCommand({ sessionId: target.sessionId, command: 'Seek', seekPositionTicks: clamped })
      .then(() => sessions.refetch())
  }
  const seekBy = (seconds: number) => seekTo(estimate(Date.now()) + secondsToTicks(seconds))

  const title = playing?.Type === 'Episode' ? `${playing.SeriesName} · ${playing.Name}` : playing?.Name
  const backdrop = playing ? backdropImageUrl(api, playing, { fillWidth: 960 }) : undefined

  return (
    <div
      // In Listen it floats above the player bar (see index.css), not over it.
      data-remote-bar
      role="region"
      aria-label={t.region(target.name)}
      className={cn(
        'fixed inset-x-3 bottom-3 z-50 mx-auto max-w-3xl overflow-hidden rounded-2xl border bg-popover text-white shadow-2xl',

        closing
          ? 'pointer-events-none animate-out fade-out-0 slide-out-to-bottom-4 fill-mode-forwards duration-200'
          : 'animate-in fade-in-0 slide-in-from-bottom-4 duration-300',
      )}
    >
      {/* The title's own artwork as the card's background, darkened so the controls stay readable. */}
      {backdrop && <FadeImage key={backdrop} src={backdrop} alt="" className="absolute inset-0 size-full object-cover object-top" />}
      <div className="absolute inset-0 bg-linear-to-r from-black/90 via-black/75 to-black/55 backdrop-blur-[2px]" />

      <div className="relative space-y-1 p-3">
        <div className="flex items-center gap-3">
          <IconCast className="size-5 shrink-0 text-white/80" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{gone ? t.gone(target.name) : (title ?? t.nothingPlaying)}</p>
            <p className="truncate text-xs text-white/60">{target.name}</p>
          </div>
          {playing && !gone && (
            <div className="flex shrink-0 items-center text-white">
              <Button variant="ghost" size="icon-sm" className="hidden hover:bg-white/10 sm:inline-flex" aria-label={t.previous} onClick={() => send('PreviousTrack')}>
                <IconPlayerSkipBack />
              </Button>
              <Button variant="ghost" size="icon-sm" className="hover:bg-white/10" aria-label={t.back(SKIP_SECONDS)} onClick={() => seekBy(-SKIP_SECONDS)}>
                <IconRewindBackward10 />
              </Button>
              <Button variant="secondary" size="icon" aria-label={paused ? t.resume : t.pause} onClick={() => send('PlayPause')}>
                {paused ? <IconPlayerPlay className="fill-current" /> : <IconPlayerPause className="fill-current" />}
              </Button>
              <Button variant="ghost" size="icon-sm" className="hover:bg-white/10" aria-label={t.forward(SKIP_SECONDS)} onClick={() => seekBy(SKIP_SECONDS)}>
                <IconRewindForward10 />
              </Button>
              <Button variant="ghost" size="icon-sm" className="hidden hover:bg-white/10 sm:inline-flex" aria-label={t.next} onClick={() => send('NextTrack')}>
                <IconPlayerSkipForward />
              </Button>
              <Button variant="ghost" size="icon-sm" className="hover:bg-white/10" aria-label={t.stop} onClick={() => send('Stop')}>
                <IconPlayerStop />
              </Button>
            </div>
          )}
          <Button variant="ghost" size="icon-sm" className="hover:bg-white/10" aria-label={t.disconnect} title={t.disconnectHint} onClick={onDisconnect}>
            <IconX />
          </Button>
        </div>

        {playing && !gone && duration > 0 && (
          <div className="flex items-center gap-3 pl-8 text-xs tabular-nums text-white/70">
            <span>{formatClock(ticksToSeconds(livePosition))}</span>
            <div className="min-w-0 flex-1">
              <SeekBar
                currentTime={ticksToSeconds(livePosition)}
                duration={ticksToSeconds(duration)}
                buffered={0}
                onSeek={(seconds) => seekTo(secondsToTicks(seconds))}
              />
            </div>
            <span>{formatClock(ticksToSeconds(duration))}</span>
          </div>
        )}
      </div>
    </div>
  )
}
