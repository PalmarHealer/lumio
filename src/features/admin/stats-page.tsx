import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from '@/components/link'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthedSession } from '@/features/auth/session'
import { Section, SettingsPage } from '@/features/settings/fields'
import { lumioGet } from '@/features/social/social'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ProfileAvatar } from '@/features/listen/profile-page'
import { useIsAdmin } from './use-admin-config'
import { WishlistSection } from './wishlist-section'

const messages = defineMessages({
  de: {
    title: 'Wiedergabe-Statistik',
    description:
      'Wer was wann und womit schaut oder hört. Filme, Folgen und Musik kommen aus Jellyfins Playback Reporting, Podcasts aus Lumio (Jellyfin bekommt sie nie zu sehen).',
    adminOnly: 'Nur für Administrator*innen.',
    days: (n: number) => `${n} Tage`,
    year: '1 Jahr',
    typeMovie: 'Filme',
    typeEpisode: 'Folgen',
    typeAudio: 'Musik',
    typePodcast: 'Podcasts',
    count: 'Wiedergaben',
    time: 'Zeit',
    plays: 'Wiedergaben',
    totalTime: 'Gesamtzeit',
    activeUsers: 'Aktive Nutzer',
    perDay: 'Pro Tag',
    jellyfin: 'Jellyfin',
    users: 'Nutzer',
    podcastPart: (time: string) => `davon ${time} Podcasts`,
    playsCount: (count: string) => `${count} Wiedergaben`,
    byType: 'Nach Typ',
    offlineMethod: 'Offline vom Gerät',
    byMethod: 'Wiedergabe-Methode',
    byClient: 'Nach Client',
    byDevice: 'Nach Gerät',
    hours: 'Tageszeiten',
    recentPodcasts: 'Zuletzt gehörte Podcasts',
    weekdays: 'So,Mo,Di,Mi,Do,Fr,Sa',
    empty: 'Keine Wiedergaben in diesem Zeitraum.',
    noReporting:
      'Jellyfins Plugin „Playback Reporting“ antwortet nicht: Filme, Folgen und Musik fehlen hier. Installiere es in Jellyfin (Dashboard → Plugins), dann erscheinen sie.',
    noLumio: 'Der Lumio-Server ist nicht erreichbar: Podcasts fehlen hier.',
    musicTitle: 'Musik in Lumio',
    musicHint: 'Wie Songs in Lumio laufen: wie sie gestartet wurden, warum sie endeten und woher sie kamen. Gezählt werden die Wiedergaben weiter von Jellyfin.',
    started: 'Wie gestartet',
    ended: 'Warum beendet',
    from: 'Woher',
    skipRate: 'Übersprungen',
    fromDevice: 'Vom Gerät',
    buffering: 'Gepuffert',
    songs: 'Songs',
    reason_clickrow: 'Angeklickt',
    reason_playbtn: 'Abspielen-Knopf',
    reason_fwdbtn: 'Weiter / übersprungen',
    reason_backbtn: 'Zurück',
    reason_trackdone: 'Bis zum Ende',
    reason_trackerror: 'Fehler',
    reason_remote: 'Von einem anderen Gerät',
    reason_appload: 'Nach dem Neuladen',
    reason_endplay: 'Gestoppt',
    reason_logout: 'Abgemeldet',
    source_album: 'Alben',
    source_playlist: 'Playlists',
    source_official: 'Offizielle Playlists',
    source_radio: 'Radios',
    source_liked: 'Favoriten',
    source_artist: 'Künstler*innen',
    source_queue: 'Warteschlange',
    source_autoplay: 'Autoplay (empfohlen)',
    source_other: 'Sonstiges',
  },
  en: {
    title: 'Playback statistics',
    description:
      "Who watches or listens to what, when and with what. Films, episodes and music come from Jellyfin's Playback Reporting, podcasts from Lumio (Jellyfin never sees them).",
    adminOnly: 'Administrators only.',
    days: (n: number) => `${n} days`,
    year: '1 year',
    typeMovie: 'Films',
    typeEpisode: 'Episodes',
    typeAudio: 'Music',
    typePodcast: 'Podcasts',
    count: 'Plays',
    time: 'Time',
    plays: 'Plays',
    totalTime: 'Total time',
    activeUsers: 'Active users',
    perDay: 'Per day',
    jellyfin: 'Jellyfin',
    users: 'Users',
    podcastPart: (time: string) => `${time} of it podcasts`,
    playsCount: (count: string) => `${count} plays`,
    byType: 'By type',
    offlineMethod: 'Offline from the device',
    byMethod: 'Playback method',
    byClient: 'By client',
    byDevice: 'By device',
    hours: 'Times of day',
    recentPodcasts: 'Podcasts played lately',
    weekdays: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat',
    empty: 'No plays in this period.',
    noReporting: "Jellyfin's Playback Reporting plugin doesn't answer: films, episodes and music are missing here. Install it in Jellyfin (Dashboard → Plugins) and they show up.",
    noLumio: "The Lumio server can't be reached: podcasts are missing here.",
    musicTitle: 'Music in Lumio',
    musicHint: 'How songs play in Lumio: how they were started, why they ended and where they came from. Jellyfin still counts the plays.',
    started: 'How started',
    ended: 'Why ended',
    from: 'Where from',
    skipRate: 'Skipped',
    fromDevice: 'From the device',
    buffering: 'Buffered',
    songs: 'Songs',
    reason_clickrow: 'Clicked',
    reason_playbtn: 'Play button',
    reason_fwdbtn: 'Next / skipped',
    reason_backbtn: 'Back',
    reason_trackdone: 'To the end',
    reason_trackerror: 'Error',
    reason_remote: 'From another device',
    reason_appload: 'After reloading',
    reason_endplay: 'Stopped',
    reason_logout: 'Signed out',
    source_album: 'Albums',
    source_playlist: 'Playlists',
    source_official: 'Official playlists',
    source_radio: 'Radios',
    source_liked: 'Favorites',
    source_artist: 'Artists',
    source_queue: 'Queue',
    source_autoplay: 'Autoplay (recommended)',
    source_other: 'Other',
  },
})

type Kind = 'Movie' | 'Episode' | 'Audio' | 'Podcast'
const KINDS: Kind[] = ['Movie', 'Episode', 'Audio', 'Podcast']
const JELLYFIN_KINDS: Kind[] = ['Movie', 'Episode', 'Audio']

interface Breakdown {
  label: string
  count: number
  time: number
}

interface UserActivity {
  user_id: string
  user_name: string
  total_count: number
  total_time: number
  latest_date?: string
  item_name?: string
  client_name?: string
}

interface Reporting {
  activity: UserActivity[]
  perDay: Array<{ user_id: string; user_name: string; user_usage: Record<string, number> }>
  byType: Breakdown[]
  byMethod: Breakdown[]
  byClient: Breakdown[]
  byDevice: Breakdown[]
  hourly: Record<string, number>
}

interface PodcastPlay {
  kind?: 'podcast' | 'audio' | 'video'
  source?: string
  reasonStart?: string
  reasonEnd?: string
  offline?: boolean
  bufferingMs?: number
  session: string
  userId: string
  userName: string
  key: string
  title: string
  subtitle?: string
  contextId?: string
  client?: string
  startedAt: number
  seconds: number
}

const pad = (value: number) => String(value).padStart(2, '0')
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** Playback Reporting's numbers for the span (null when the plugin doesn't answer). */
function useReporting(days: number, kinds: Kind[], measure: 'count' | 'time') {
  const { api, session } = useAuthedSession()
  const types = kinds.filter((kind) => kind !== 'Podcast')
  return useQuery({
    queryKey: ['playback-reporting', days, types, measure],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<Reporting | null> => {
      const end = new Date()
      const range = `days=${days}&endDate=${dayKey(end)}&timezoneOffset=${-end.getTimezoneOffset() / 60}`
      const filter = `filter=${(types.length ? types : JELLYFIN_KINDS).join(',')}`
      const get = async <T,>(path: string) => {
        const response = await fetch(`${api.basePath}/user_usage_stats/${path}`, { headers: { Authorization: `MediaBrowser Token="${session.accessToken}"` } })
        if (!response.ok) throw new Error(`Playback Reporting ${response.status}`)
        return (await response.json()) as T
      }
      try {
        const [activity, perDay, byType, byMethod, byClient, byDevice, hourly] = await Promise.all([
          get<UserActivity[]>(`user_activity?${range}`),
          get<Reporting['perDay']>(`PlayActivity?${range}&${filter}&dataType=${measure}`),
          get<Breakdown[]>(`ItemType/BreakdownReport?${range}`),
          get<Breakdown[]>(`PlaybackMethod/BreakdownReport?${range}`),
          get<Breakdown[]>(`ClientName/BreakdownReport?${range}`),
          get<Breakdown[]>(`DeviceName/BreakdownReport?${range}`),
          get<Record<string, number>>(`HourlyReport?${range}&${filter}`),
        ])
        return { activity, perDay, byType, byMethod, byClient, byDevice, hourly }
      } catch {
        return null
      }
    },
  })
}

/** Lumio's own plays (podcasts) in the span (null when the Lumio server can't be reached). */
function usePodcastPlays(days: number) {
  return useQuery({
    queryKey: ['admin-plays', days],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<PodcastPlay[] | null> => {
      const to = Date.now()
      const from = new Date(to - (days - 1) * 86_400_000).setHours(0, 0, 0, 0)
      const response = await lumioGet(`/admin/plays?from=${from}&to=${to}`)
      return response?.ok ? ((await response.json()) as PodcastPlay[]) : null
    },
  })
}

/** Plays shorter than this don't count as plays (a tap on an episode), though their time does. */
const MIN_PLAY_SECONDS = 30

export function StatsPage() {
  const t = useMessages(messages)
  const locale = getLocaleTag(useLocale())
  const isAdmin = useIsAdmin()
  const [days, setDays] = useState(30)
  const [kinds, setKinds] = useState<Kind[]>(KINDS)
  const [measure, setMeasure] = useState<'count' | 'time'>('count')
  // "Today" for the day axis, fixed for the page's life.
  const [now] = useState(() => Date.now())
  const reporting = useReporting(days, kinds, measure)
  const podcasts = usePodcastPlays(days)
  const number = new Intl.NumberFormat(locale)

  if (!isAdmin) {
    return (
      <SettingsPage title={t.title}>
        <p className="text-sm text-muted-foreground">{t.adminOnly}</p>
      </SettingsPage>
    )
  }

  const duration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.round((seconds % 3600) / 60)
    if (hours >= 24) return `${number.format(Math.floor(hours / 24))} d ${hours % 24} h`
    return hours ? `${hours} h ${minutes} min` : `${minutes} min`
  }
  const kindName = (kind: string) => (KINDS.includes(kind as Kind) ? t[`type${kind as Kind}`] : kind)
  const loading = reporting.isLoading || podcasts.isLoading
  const showPodcasts = kinds.includes('Podcast')
  const jellyfinKinds: Kind[] = kinds.filter((kind) => kind !== 'Podcast')

  // ---- merging the two sources ----
  const report = reporting.data
  // Lumio's log holds podcasts (counted here) and songs (counted by Jellyfin; Lumio adds how they played).
  const songPlays = (podcasts.data ?? []).filter((play) => play.kind === 'audio')
  const plays = showPodcasts ? (podcasts.data ?? []).filter((play) => !play.kind || play.kind === 'podcast') : []
  // Films and episodes watched offline (handed in later): Playback Reporting never saw them, so they're added to its
  // numbers as their type (subtitle).
  const offlineVideos = (podcasts.data ?? []).filter((play) => play.kind === 'video' && jellyfinKinds.includes(play.subtitle as Kind))
  const counted = plays.filter((play) => play.seconds >= MIN_PLAY_SECONDS)
  const podcastSeconds = plays.reduce((sum, play) => sum + play.seconds, 0)
  const typed = (report?.byType ?? []).filter((entry) => jellyfinKinds.includes(entry.label as Kind)).map((entry) => ({ ...entry }))
  for (const play of offlineVideos) {
    let entry = typed.find((other) => other.label === play.subtitle)
    if (!entry) typed.push((entry = { label: play.subtitle!, count: 0, time: 0 }))
    if (play.seconds >= MIN_PLAY_SECONDS) entry.count++
    entry.time += play.seconds
  }
  const byType: Breakdown[] = [...typed, ...(showPodcasts ? [{ label: 'Podcast', count: counted.length, time: podcastSeconds }] : [])]
  const totalPlays = byType.reduce((sum, entry) => sum + entry.count, 0)
  const totalSeconds = byType.reduce((sum, entry) => sum + entry.time, 0)

  // Users: Jellyfin's numbers (when its types are chosen) plus their podcasts; Lumio knows people by Jellyfin's ids.
  interface UserRow {
    id: string
    name: string
    count: number
    seconds: number
    podcastCount: number
    podcastSeconds: number
    lastItem?: string
    client?: string
    latest?: number
  }
  const users = new Map<string, UserRow>()
  if (jellyfinKinds.length)
    for (const entry of report?.activity ?? []) {
      if (!entry.total_count) continue
      users.set(entry.user_id, {
        id: entry.user_id,
        name: entry.user_name,
        count: entry.total_count,
        seconds: entry.total_time,
        podcastCount: 0,
        podcastSeconds: 0,
        lastItem: entry.item_name,
        client: entry.client_name,
        latest: entry.latest_date ? Date.parse(entry.latest_date) : undefined,
      })
    }
  for (const play of plays) {
    const id = play.userId.replace(/-/g, '')
    const row = users.get(id) ?? { id, name: play.userName, count: 0, seconds: 0, podcastCount: 0, podcastSeconds: 0 }
    if (play.seconds >= MIN_PLAY_SECONDS) {
      row.count++
      row.podcastCount++
    }
    row.seconds += play.seconds
    row.podcastSeconds += play.seconds
    const end = play.startedAt + play.seconds * 1000
    if (!row.latest || end > row.latest) {
      row.latest = end
      row.lastItem = [play.subtitle, play.title].filter(Boolean).join(' – ')
      row.client = play.client
    }
    users.set(id, row)
  }
  for (const play of offlineVideos) {
    const id = play.userId.replace(/-/g, '')
    const row = users.get(id) ?? { id, name: play.userName, count: 0, seconds: 0, podcastCount: 0, podcastSeconds: 0 }
    if (play.seconds >= MIN_PLAY_SECONDS) row.count++
    row.seconds += play.seconds
    const end = play.startedAt + play.seconds * 1000
    if (!row.latest || end > row.latest) {
      row.latest = end
      row.lastItem = play.title
      row.client = `${play.client ?? 'Lumio'} (offline)`
    }
    users.set(id, row)
  }
  const userRows = [...users.values()].sort((a, b) => (measure === 'time' ? b.seconds - a.seconds : b.count - a.count))

  // Per day: Jellyfin's (all users together) and the podcasts, side by side in each bar.
  const dayList: Array<{ day: string; jellyfin: number; podcasts: number }> = []
  const today = new Date(now)
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    dayList.push({ day: dayKey(date), jellyfin: 0, podcasts: 0 })
  }
  const dayIndex = new Map(dayList.map((entry, index) => [entry.day, index]))
  if (jellyfinKinds.length)
    for (const user of report?.perDay ?? []) {
      if (user.user_id === 'labels_user') continue
      for (const [day, value] of Object.entries(user.user_usage ?? {})) {
        const index = dayIndex.get(day)
        if (index !== undefined) dayList[index]!.jellyfin += value
      }
    }
  for (const play of plays) {
    const index = dayIndex.get(dayKey(new Date(play.startedAt)))
    if (index === undefined) continue
    if (measure === 'time') dayList[index]!.podcasts += play.seconds
    else if (play.seconds >= MIN_PLAY_SECONDS) dayList[index]!.podcasts++
  }
  for (const play of offlineVideos) {
    const index = dayIndex.get(dayKey(new Date(play.startedAt)))
    if (index === undefined) continue
    if (measure === 'time') dayList[index]!.jellyfin += play.seconds
    else if (play.seconds >= MIN_PLAY_SECONDS) dayList[index]!.jellyfin++
  }
  const dayMax = Math.max(1, ...dayList.map((entry) => entry.jellyfin + entry.podcasts))

  // Times of day: seconds by weekday and hour, both sources.
  const hourly: Record<string, number> = jellyfinKinds.length ? { ...(report?.hourly ?? {}) } : {}
  for (const play of [...plays, ...offlineVideos]) {
    const start = new Date(play.startedAt)
    const key = `${start.getDay()}-${pad(start.getHours())}`
    hourly[key] = (hourly[key] ?? 0) + play.seconds
  }
  const hourMax = Math.max(1, ...Object.values(hourly))

  const podcastClients = new Map<string, Breakdown>()
  for (const play of [...plays, ...offlineVideos]) {
    const label = play.kind === 'video' ? `${play.client ?? 'Lumio'} (offline)` : (play.client ?? 'Lumio')
    const entry = podcastClients.get(label) ?? { label, count: 0, time: 0 }
    if (play.seconds >= MIN_PLAY_SECONDS) entry.count++
    entry.time += play.seconds
    podcastClients.set(label, entry)
  }
  const clients = jellyfinKinds.length ? [...(report?.byClient ?? []), ...podcastClients.values()] : [...podcastClients.values()]

  // Watched offline: from the device, as a method of its own.
  const methods: Breakdown[] = [...(report?.byMethod ?? [])]
  if (offlineVideos.length)
    methods.push({
      label: t.offlineMethod,
      count: offlineVideos.filter((play) => play.seconds >= MIN_PLAY_SECONDS).length,
      time: offlineVideos.reduce((sum, play) => sum + play.seconds, 0),
    })

  const weekdays = t.weekdays.split(',')

  // Songs in Lumio: how they started, why they ended, where from.
  const tally = (values: Array<string | undefined>, label: (value: string) => string) => {
    const counts = new Map<string, Breakdown>()
    for (const value of values) {
      if (!value) continue
      const name = label(value)
      const entry = counts.get(name) ?? { label: name, count: 0, time: 0 }
      entry.count++
      counts.set(name, entry)
    }
    return [...counts.values()]
  }
  const reasonName = (value: string) => (t as unknown as Record<string, string>)[`reason_${value}`] ?? value
  const sourceGroup = (value: string) => {
    const group = value === 'liked' || value === 'queue' || value === 'autoplay' ? value : value.startsWith('official:radio-') ? 'radio' : value.split(':')[0]!
    return (t as unknown as Record<string, string>)[`source_${group}`] ?? t.source_other
  }
  const songsTotal = songPlays.length
  const skipped = songPlays.filter((play) => play.reasonEnd === 'fwdbtn').length
  const fromDevice = songPlays.filter((play) => play.offline).length
  const bufferingSeconds = songPlays.reduce((sum, play) => sum + (play.bufferingMs ?? 0), 0) / 1000
  const percent = (part: number) => (songsTotal ? `${Math.round((part / songsTotal) * 100)} %` : '–')
  const empty = !loading && !totalPlays && !userRows.length

  return (
    <SettingsPage title={t.title} description={t.description}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          aria-label={t.title}
          className="h-9 rounded-md border bg-transparent px-2.5 text-sm"
        >
          {[7, 30, 90, 365].map((value) => (
            <option key={value} value={value} className="bg-popover">
              {value === 365 ? t.year : t.days(value)}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((kind) => {
            const on = kinds.includes(kind)
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                onClick={() => (on ? kinds.length > 1 && setKinds(kinds.filter((entry) => entry !== kind)) : setKinds([...kinds, kind]))}
                className={cn('h-8 rounded-full border px-3 text-sm transition-colors', on ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
              >
                {kindName(kind)}
              </button>
            )
          })}
        </div>
        <div className="flex rounded-md border p-0.5 text-sm">
          {(['count', 'time'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={measure === value}
              onClick={() => setMeasure(value)}
              className={cn('rounded px-2.5 py-1', measure === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
            >
              {t[value]}
            </button>
          ))}
        </div>
      </div>

      {reporting.data === null && jellyfinKinds.length > 0 && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t.noReporting}</p>}
      {podcasts.data === null && showPodcasts && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t.noLumio}</p>}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            {[
              [t.plays, number.format(totalPlays)],
              [t.totalTime, duration(totalSeconds)],
              [t.activeUsers, number.format(userRows.length)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border bg-card p-4">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          <Section title={t.perDay}>
            <div className="space-y-2 p-4">
              <div className="flex h-36 items-end gap-0.5">
                {dayList.map((entry) => (
                  <div
                    key={entry.day}
                    className="flex h-full min-w-0 flex-1 flex-col-reverse"
                    title={`${new Date(`${entry.day}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}: ${
                      measure === 'time' ? duration(entry.jellyfin + entry.podcasts) : number.format(entry.jellyfin + entry.podcasts)
                    }`}
                  >
                    <span className="block rounded-b-sm bg-primary" style={{ height: `${(entry.jellyfin / dayMax) * 100}%` }} />
                    <span className="block rounded-t-sm bg-primary/45" style={{ height: `${(entry.podcasts / dayMax) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{new Date(`${dayList[0]!.day}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}</span>
                <span className="flex gap-3">
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-primary" /> {t.jellyfin}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-primary/45" /> {t.typePodcast}
                  </span>
                </span>
                <span>{new Date(`${dayList.at(-1)!.day}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}</span>
              </div>
            </div>
          </Section>

          <Section title={t.users}>
            {/* Ranked by the chosen measure, each with a bar against the top user and what they played last. */}
            <ol className="divide-y">
              {userRows.map((row, rank) => {
                const top = userRows[0]!
                const share = measure === 'time' ? row.seconds / (top.seconds || 1) : row.count / (top.count || 1)
                const last = [row.lastItem, row.client, row.latest ? new Date(row.latest).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '']
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="w-5 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{rank + 1}</span>
                    <ProfileAvatar userId={row.id} name={row.name} className="size-9 text-xs" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <Link to={`/listen/user/${row.id}`} className="truncate font-medium hover:underline">
                          {row.name}
                        </Link>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">{measure === 'time' ? duration(row.seconds) : number.format(row.count)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, share * 100)}%` }} />
                      </div>
                      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                        <span className="truncate" title={last}>
                          {last}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {[
                            measure === 'time' ? t.playsCount(number.format(row.count)) : duration(row.seconds),
                            row.podcastSeconds ? t.podcastPart(duration(row.podcastSeconds)) : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <BarList title={t.byType} entries={byType} measure={measure} name={kindName} duration={duration} number={number} />
            {jellyfinKinds.length > 0 && <BarList title={t.byMethod} entries={methods} measure={measure} duration={duration} number={number} />}
            <BarList title={t.byClient} entries={clients} measure={measure} duration={duration} number={number} />
            {jellyfinKinds.length > 0 && <BarList title={t.byDevice} entries={report?.byDevice ?? []} measure={measure} duration={duration} number={number} />}
          </div>

          <Section title={t.hours}>
            <div className="grid grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-0.5 p-4 text-[10px] text-muted-foreground">
              <span />
              {Array.from({ length: 24 }, (_, hour) => (
                <span key={hour}>{hour % 3 === 0 ? hour : ''}</span>
              ))}
              {weekdays.map((weekday, day) => (
                <div key={weekday} className="contents">
                  <span className="flex items-center">{weekday}</span>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const value = hourly[`${day}-${pad(hour)}`] ?? 0
                    return (
                      <span
                        key={hour}
                        title={`${weekday} ${pad(hour)}:00 – ${duration(value)}`}
                        className="aspect-square rounded-[2px] bg-primary"
                        style={{ opacity: value ? 0.12 + (value / hourMax) * 0.88 : 0.05 }}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </Section>

          {songsTotal > 0 && kinds.includes('Audio') && (
            <Section title={t.musicTitle} description={t.musicHint}>
              <div className="space-y-4 p-4">
                <dl className="grid gap-3 sm:grid-cols-4">
                  {[
                    [t.songs, number.format(songsTotal)],
                    [t.skipRate, percent(skipped)],
                    [t.fromDevice, percent(fromDevice)],
                    [t.buffering, duration(bufferingSeconds)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-muted/40 p-3">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-0.5 text-lg font-bold tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="grid gap-4 lg:grid-cols-3">
                  <BarList title={t.started} entries={tally(songPlays.map((play) => play.reasonStart), reasonName)} measure="count" duration={duration} number={number} />
                  <BarList title={t.ended} entries={tally(songPlays.map((play) => play.reasonEnd), reasonName)} measure="count" duration={duration} number={number} />
                  <BarList title={t.from} entries={tally(songPlays.map((play) => play.source ?? 'other'), sourceGroup)} measure="count" duration={duration} number={number} />
                </div>
              </div>
            </Section>
          )}

          {plays.length > 0 && (
            <Section title={t.recentPodcasts}>
              <ul className="divide-y">
                {[...plays]
                  .sort((a, b) => b.startedAt - a.startedAt)
                  .slice(0, 15)
                  .map((play) => (
                    <li key={play.session} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        {play.contextId ? (
                          <Link to={`/listen/podcast/${play.contextId}`} className="block truncate font-medium hover:underline">
                            {play.title}
                          </Link>
                        ) : (
                          <p className="truncate font-medium">{play.title}</p>
                        )}
                        <p className="truncate text-xs text-muted-foreground">{[play.subtitle, play.userName, play.client].filter(Boolean).join(' · ')}</p>
                      </div>
                      <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        <p>{duration(play.seconds)}</p>
                        <p>{new Date(play.startedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</p>
                      </div>
                    </li>
                  ))}
              </ul>
            </Section>
          )}
        </>
      )}
      <WishlistSection />
    </SettingsPage>
  )
}

function BarList({
  title,
  entries,
  measure,
  name = (label) => label,
  duration,
  number,
}: {
  title: string
  entries: Breakdown[]
  measure: 'count' | 'time'
  name?: (label: string) => string
  duration: (seconds: number) => string
  number: Intl.NumberFormat
}) {
  const key = measure === 'time' ? 'time' : 'count'
  const sorted = [...entries].filter((entry) => entry[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 8)
  const top = Math.max(1, ...sorted.map((entry) => entry[key]))
  return (
    <Section title={title}>
      <div className="space-y-2.5 p-4">
        {sorted.length === 0 && <p className="text-sm text-muted-foreground">–</p>}
        {sorted.map((entry) => (
          <div key={entry.label} className="space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <span className="truncate">{name(entry.label)}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{key === 'time' ? duration(entry.time) : number.format(entry.count)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${(entry[key] / top) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
