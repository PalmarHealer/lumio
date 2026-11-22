import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { audioCacheAvailable, clearAudioCache, OFTEN_PLAYED, trimAudioCache, useAudioCacheStats, useStorageInfo } from '@/features/listen/player/audio-cache'
import { clearDownloads, downloadsAvailable, removeDownload, setDownloadQuality, useDownloadList, useDownloadStats } from '@/features/listen/player/downloads'
import { clearVideoCache, trimVideos, useVideoCacheStats, videoCacheAvailable } from '@/features/player/video-cache'
import { clearVideoDownloads, useVideoDownloadStats } from '@/features/player/video-downloads'
import { useAppMode } from '@/lib/app-mode'
import { appCacheBytes, clearAppCaches } from '@/lib/app-cache'
import { getLocaleTag, useLocale, useMessages, type Locale } from '@/lib/i18n'
import { QUALITY_OPTIONS, qualityLabel } from '@/features/player/labels'
import { networkTypeKnown, useCellular } from '@/lib/network'
import { Section, SelectField, SettingsPage, SwitchField } from './fields'
import { DEFAULT_SETTINGS, useLocalSettings } from './local-settings'
import { playbackMessages } from './messages'

const MB = 1024 * 1024
const MBIT = 1_000_000
const GB = 1024 * MB

/** Shows sizes in MB or GB. */
function useSize() {
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()), { maximumFractionDigits: 1 })
  return (bytes: number) => (bytes >= GB ? `${number.format(bytes / GB)} GB` : `${number.format(Math.max(bytes, 0) / MB)} MB`)
}

/**
 * The player's quality steps ("720p · 8 Mbit/s"), so a quality picked in the player is recognised here. A rate chosen
 * before the steps were aligned (12, 5 Mbit/s) stays in the list while it is set.
 */
function videoQualityOptions(current: number, original: string, locale: Locale) {
  const steps = QUALITY_OPTIONS.flatMap((option) => (option.bitrate ? [option.bitrate / MBIT] : []))
  if (current && !steps.includes(current)) steps.push(current)
  steps.sort((a, b) => b - a)
  return [{ value: 0, label: original }, ...steps.map((mbit) => ({ value: mbit, label: qualityLabel(mbit * MBIT, locale) }))]
}

// The download qualities stay: changing them downloads everything again.
const RESET_KEYS = ['downloadsWifiOnly', 'videoPrefetch', 'videoCacheGb', 'videoBitrateMbit', 'musicPrefetch', 'musicCacheMb', 'musicKeepOften'] as const

/**
 * Everything kept on this device: first what it all takes, then the downloads (their quality, removing them) and the
 * song and episode caches. Watch lists video first, Listen music.
 */
export function DownloadsPage() {
  const t = useMessages(playbackMessages)
  const listen = useAppMode() === 'listen'
  const video = videoCacheAvailable
  const pairs: Array<[ReactNode, ReactNode]> = [
    [video && <VideoDownloadsSection key="video-downloads" />, downloadsAvailable && <MusicDownloadsSection key="music-downloads" />],
    [video && <VideoCacheSection key="video-cache" />, audioCacheAvailable && <MusicCacheSection key="music-cache" />],
  ]
  return (
    <SettingsPage title={t.downloadsTitle} description={t.downloadsDescription} resetKeys={RESET_KEYS}
      onReset={() => {
        // Smaller limits take effect right away.
        trimAudioCache({ maxBytes: DEFAULT_SETTINGS.musicCacheMb * MB, keepOftenPlayed: DEFAULT_SETTINGS.musicKeepOften })
        void trimVideos(DEFAULT_SETTINGS.videoCacheGb * GB)
      }}
    >
      {(audioCacheAvailable || videoCacheAvailable) && (
        <Section anchor="storage" title={t.storage} description={t.storageDescription} scope="device">
          <StorageOverview />
        </Section>
      )}
      {networkTypeKnown() && <MobileDataSection />}
      {pairs.flatMap(([videoPart, musicPart]) => (listen ? [musicPart, videoPart] : [videoPart, musicPart]))}
    </SettingsPage>
  )
}

/** Where the device tells its network (Android): downloads only over Wi-Fi. */
function MobileDataSection() {
  const { settings, update } = useLocalSettings()
  const t = useMessages(playbackMessages)
  const cellular = useCellular()
  return (
    <Section title={t.mobileData} scope="device">
      <SwitchField id="downloads-wifi-only" label={t.wifiOnlyLabel} hint={t.wifiOnlyHint} checked={settings.downloadsWifiOnly} onChange={(checked) => update({ downloadsWifiOnly: checked })} />
      {cellular && settings.downloadsWifiOnly && <p className="px-4 py-3 text-sm text-muted-foreground">{t.waitingForWifi}</p>}
    </Section>
  )
}

/** Watch's downloads: their quality, how much they take, and removing them all (the list is Watch's Downloads tab). */
function VideoDownloadsSection() {
  const locale = useLocale()
  const { settings, update } = useLocalSettings()
  const t = useMessages(playbackMessages)
  const size = useSize()
  const stats = useVideoDownloadStats()
  return (
    <Section title={t.videoDownloadsTitle} description={t.videoDownloadsDescription} scope="device">
      <SelectField
        id="video-download-quality"
        label={t.videoDownloadQualityLabel}
        hint={t.videoDownloadQualityHint}
        value={settings.videoDownloadMbit}
        options={videoQualityOptions(settings.videoDownloadMbit, t.videoOriginal, locale)}
        onChange={(value) => update({ videoDownloadMbit: value })}
      />
      {stats.count + stats.pending > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm text-muted-foreground">{t.videoDownloadsUsage(stats.count, size(stats.bytes))}</p>
          <Button variant="outline" size="sm" onClick={clearVideoDownloads}>
            {t.removeVideoDownloads}
          </Button>
        </div>
      )}
    </Section>
  )
}

/** Listen's downloads: their quality and the list, to remove one by one. */
function MusicDownloadsSection() {
  const { settings, update } = useLocalSettings()
  const t = useMessages(playbackMessages)
  return (
    <Section title={t.musicDownloadsTitle} scope="device">
      <SelectField
        id="music-download-quality"
        label={t.downloadQualityLabel}
        hint={t.downloadQualityHint}
        value={settings.musicDownloadQuality ?? 0}
        options={[{ value: 0, label: t.musicOriginal }, ...[320, 256, 192, 128].map((kbps) => ({ value: kbps, label: `${kbps} kbps` }))]}
        onChange={(value) => {
          update({ musicDownloadQuality: value || null })
          void setDownloadQuality(value || null)
        }}
      />
      <DownloadList />
    </Section>
  )
}

function VideoCacheSection() {
  const locale = useLocale()
  const { settings, update } = useLocalSettings()
  const t = useMessages(playbackMessages)
  return (
    <Section title={t.videoCache} description={t.videoCacheDescription} scope="device">
      <SelectField
        id="video-prefetch"
        label={t.videoPrefetchLabel}
        hint={t.videoPrefetchHint}
        value={settings.videoPrefetch}
        options={[0, 1, 2, 3].map((count) => ({ value: count, label: count ? t.videoPrefetchEpisodes(count) : t.off }))}
        onChange={(value) => update({ videoPrefetch: value })}
      />
      <SelectField
        id="video-cache-size"
        label={t.cacheSizeLabel}
        hint={t.videoCacheSizeHint}
        value={settings.videoCacheGb}
        options={[2, 5, 10, 20, 50].map((gb) => ({ value: gb, label: `${gb} GB` }))}
        onChange={(value) => {
          update({ videoCacheGb: value })
          void trimVideos(value * GB)
        }}
      />
      <SelectField
        id="video-bitrate"
        label={t.videoBitrateLabel}
        hint={t.videoBitrateHint}
        value={settings.videoBitrateMbit}
        options={videoQualityOptions(settings.videoBitrateMbit, t.videoOriginal, locale)}
        onChange={(value) => update({ videoBitrateMbit: value })}
      />
    </Section>
  )
}

function MusicCacheSection() {
  const { settings, update } = useLocalSettings()
  const t = useMessages(playbackMessages)
  const number = new Intl.NumberFormat(getLocaleTag(useLocale()))
  return (
    <Section title={t.cache} description={t.cacheDescription} scope="device">
      <SelectField
        id="music-prefetch"
        label={t.prefetchLabel}
        hint={t.prefetchHint}
        value={settings.musicPrefetch}
        options={[0, 1, 2, 3, 5, 10].map((count) => ({ value: count, label: count ? t.prefetchTracks(count) : t.off }))}
        onChange={(value) => update({ musicPrefetch: value })}
      />
      <SelectField
        id="music-cache-size"
        label={t.cacheSizeLabel}
        hint={t.cacheSizeHint}
        value={settings.musicCacheMb}
        options={[256, 512, 1024, 2048, 5120, 10240, 20480, 51200].map((mb) => ({ value: mb, label: mb >= 1024 ? `${number.format(mb / 1024)} GB` : `${mb} MB` }))}
        onChange={(value) => {
          update({ musicCacheMb: value })
          trimAudioCache({ maxBytes: value * MB, keepOftenPlayed: settings.musicKeepOften })
        }}
      />
      <SwitchField
        id="music-keep-often"
        label={t.keepOftenLabel}
        hint={t.keepOftenHint(OFTEN_PLAYED)}
        checked={settings.musicKeepOften}
        onChange={(checked) => update({ musicKeepOften: checked })}
      />
    </Section>
  )
}

/**
 * What the browser holds for Lumio, each kind on its own line with a bar against its limit and its own clear button:
 * songs, downloads, episodes, and the app with its pictures and kept data. Below, what the browser allows in total.
 */
function StorageOverview() {
  const t = useMessages(playbackMessages)
  const { settings } = useLocalSettings()
  const size = useSize()
  const songs = useAudioCacheStats()
  const downloads = useDownloadStats()
  const videoDownloads = useVideoDownloadStats()
  const episodes = useVideoCacheStats()
  const storage = useStorageInfo()
  const app = useQuery({ queryKey: ['app-cache-bytes', songs.bytes, episodes.bytes], queryFn: appCacheBytes, staleTime: 0 })
  const [appCleared, setAppCleared] = useState(false)
  return (
    <div className="space-y-5 px-4 py-4">
      {videoCacheAvailable && (
        <StorageLine
          title={t.videoDownloadsStored}
          detail={videoDownloads.count + videoDownloads.pending ? t.videoDownloadsUsageShort(videoDownloads.count) : t.nothingStored}
          used={videoDownloads.bytes}
          size={size}
          onClear={videoDownloads.count + videoDownloads.pending ? clearVideoDownloads : undefined}
          clear={t.clearDownloads}
        />
      )}
      <StorageLine
        title={t.downloadsStored}
        detail={downloads.count || downloads.pending ? t.downloadCount(downloads.count, downloads.pending) : t.nothingStored}
        used={downloads.bytes}
        size={size}
        onClear={downloads.count || downloads.collections ? () => void clearDownloads() : undefined}
        clear={t.clearDownloads}
      />
      <StorageLine
        title={t.episodesStored}
        detail={episodes.count ? t.episodeCount(episodes.count) : t.nothingStored}
        used={episodes.bytes}
        limit={settings.videoCacheGb * GB}
        size={size}
        onClear={episodes.count ? () => void clearVideoCache() : undefined}
        clear={t.clearCache}
      />
      <StorageLine
        title={t.songsStored}
        detail={songs.count ? t.songCount(songs.count) : t.nothingStored}
        used={songs.bytes}
        limit={settings.musicCacheMb * MB}
        size={size}
        onClear={songs.count ? () => void clearAudioCache() : undefined}
        clear={t.clearCache}
      />
      <StorageLine
        title={t.appStored}
        detail={appCleared ? t.appCacheCleared : t.appCacheHint}
        used={app.data ?? 0}
        size={size}
        onClear={
          appCleared
            ? undefined
            : () =>
                void clearAppCaches().then(() => {
                  setAppCleared(true)
                  void app.refetch()
                })
        }
        clear={t.clearCache}
      />
      {storage.data && (
        <p className="text-xs text-muted-foreground">
          {[storage.data.quota ? t.browserTotal(size(storage.data.usage), size(storage.data.quota)) : undefined, storage.data.persisted ? t.persisted : t.notPersisted]
            .filter(Boolean)
            .join(' ')}
        </p>
      )}
    </div>
  )
}

function StorageLine({
  title,
  detail,
  used,
  limit,
  size,
  onClear,
  clear,
}: {
  title: string
  detail: string
  used: number
  limit?: number
  size: (bytes: number) => string
  onClear?: () => void
  clear: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <p className="text-right text-sm font-semibold tabular-nums">
            {size(used)}
            {limit ? <span className="font-normal text-muted-foreground"> / {size(limit)}</span> : null}
          </p>
          <Button variant="outline" size="sm" disabled={!onClear} onClick={onClear}>
            {clear}
          </Button>
        </div>
      </div>
      {!!limit && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/** The downloads, each with its size and progress, to remove one by one. */
function DownloadList() {
  const t = useMessages(playbackMessages)
  const size = useSize()
  const list = useDownloadList()
  if (!list.length) return <p className="px-4 py-3 text-sm text-muted-foreground">{t.noDownloads}</p>
  return (
    <ul className="divide-y">
      {list.map((entry) => (
        <li key={entry.key} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.name || '—'}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[t.downloadKind(entry.key.split(':')[0] ?? ''), entry.done < entry.total ? t.downloadProgress(entry.done, entry.total) : t.songCountShort(entry.total), size(entry.bytes)].join(' · ')}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => removeDownload(entry.key)}>
            {t.removeDownload}
          </Button>
        </li>
      ))}
    </ul>
  )
}
