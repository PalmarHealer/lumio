import type { Api } from '@jellyfin/sdk'
import type { SessionInfoDto } from '@jellyfin/sdk/lib/generated-client/models'
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import { getSystemApi } from '@jellyfin/sdk/lib/utils/api/system-api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthedSession } from '@/features/auth/session'
import { ticksToSeconds } from '@/lib/format'

/** How often a controlled device's state is asked for. */
export const REMOTE_POLL_MS = 2000
const CLOCK_SAMPLES = 4
/** How far the measured server clock may be off; widens the window a server answer is placed in. */
const CLOCK_SLACK_S = 0.15

/**
 * Time offset between this browser and the server: a few NTP-style round trips, keeping the one with the lowest latency.
 * SyncPlay commands and session check-ins carry server timestamps, so a client has to know what "now" is on the server.
 */
export async function measureClockOffset(request: () => Promise<{ RequestReceptionTime?: string; ResponseTransmissionTime?: string }>) {
  let best: { offset: number; ping: number } | null = null
  for (let i = 0; i < CLOCK_SAMPLES; i++) {
    const sent = Date.now()
    const reply = await request()
    const received = Date.now()
    const serverIn = Date.parse(reply.RequestReceptionTime ?? '')
    const serverOut = Date.parse(reply.ResponseTransmissionTime ?? '')
    if (Number.isNaN(serverIn) || Number.isNaN(serverOut)) continue
    const ping = received - sent - (serverOut - serverIn)
    const offset = (serverIn - sent + (serverOut - received)) / 2
    if (!best || ping < best.ping) best = { offset, ping }
  }
  return best?.offset ?? 0
}

/** Milliseconds to add to Date.now() for the server's time, measured once in a while. */
const clockOffsetQuery = (api: Api) => ({
  queryKey: ['server-clock-offset', api.basePath],
  staleTime: 10 * 60_000,
  queryFn: () => measureClockOffset(async () => (await getSystemApi(api).getUtcTime()).data),
})

interface Polled {
  sessions: SessionInfoDto[]
  /** Where the controlled device's playback stood, and the reports that can still be the one behind it. */
  anchor: RemoteAnchor | null
  narrowed: Narrowed | null
}

/** A controlled device's session as the server tells it, asked every couple of seconds (shared by all who show it). */
export function useRemoteSession(sessionId: string | undefined) {
  const { api, session } = useAuthedSession()
  const queryClient = useQueryClient()
  const queryKey = ['remote-sessions', sessionId]
  const query = useQuery({
    queryKey,
    enabled: !!sessionId,
    refetchInterval: REMOTE_POLL_MS,
    queryFn: async (): Promise<Polled> => {
      const offset = await queryClient.fetchQuery(clockOffsetQuery(api)).catch(() => 0)
      const sent = Date.now()
      const sessions = (await getSessionApi(api).getSessions({ controllableByUserId: session.userId })).data
      const received = Date.now()
      const remote = sessions.find((entry) => entry.Id === sessionId)
      const before = queryClient.getQueryData<Polled>(queryKey)?.narrowed ?? null
      const { anchor, narrowed } = remote ? anchorOf(remote, sent, received, offset, before) : { anchor: null, narrowed: null }
      return { sessions, anchor, narrowed }
    },
  })
  const remote = sessionId ? query.data?.sessions.find((entry) => entry.Id === sessionId) : undefined
  return { query, remote, anchor: query.data?.anchor ?? null }
}

/** A position (seconds) and the moment it applied (this device's clock); playback moves on from there. */
export interface RemoteAnchor {
  position: number
  at: number
}

/** The positions the device can have reported at one check-in, as far as the answers so far tell. */
interface Narrowed {
  checkin: string
  reported: number[]
}

/**
 * Where the device's playback stood, and when. Jellyfin moves a playing session's position on by itself: after each
 * report it adds a whole second every second (without touching LastPlaybackCheckIn), until the next report. So the
 * position read is "reported + k seconds" and applied at "check-in + k seconds", k being how many of those ticks ran
 * before the server answered. k follows from when the answer was made, known within the request's round trip; when
 * that window holds a tick, the answers about the same report are intersected until one k is left. Counting from the
 * check-in alone counts those ticks twice: the lyrics and the bar run ahead and fall back at every report.
 */
function anchorOf(remote: SessionInfoDto, sent: number, received: number, offset: number, before: Narrowed | null) {
  const position = ticksToSeconds(remote.PlayState?.PositionTicks ?? 0)
  const checkin = remote.LastPlaybackCheckIn ?? ''
  const checkedIn = Date.parse(checkin) - offset
  // Paused, the position stands still (the server's ticks stop too); without a usable check-in, as of the answer.
  if (remote.PlayState?.IsPaused || Number.isNaN(checkedIn) || checkedIn <= 0 || checkedIn > received + 60_000) {
    return { anchor: { position, at: received }, narrowed: null }
  }
  const from = Math.max(0, Math.floor((sent - checkedIn) / 1000 - CLOCK_SLACK_S))
  const to = Math.max(from, Math.floor((received - checkedIn) / 1000 + CLOCK_SLACK_S))
  const candidates: number[] = []
  for (let k = from; k <= to; k++) candidates.push(round(position - k))
  const same = before?.checkin === checkin ? before.reported.filter((value) => candidates.includes(value)) : []
  const reported = same.length ? same : candidates
  // Still ambiguous: the middle of the window is the likeliest.
  const middle = Math.floor(((sent + received) / 2 - checkedIn) / 1000)
  const best = reported.reduce((a, b) => (Math.abs(position - b - middle) < Math.abs(position - a - middle) ? b : a))
  return { anchor: { position: best, at: checkedIn }, narrowed: { checkin, reported } }
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000
