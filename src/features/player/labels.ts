import type { VideoFit } from '@/features/settings/local-settings'
import { defineMessages, getLocale, getLocaleTag, type Locale } from '@/lib/i18n'

/** Shared by the player menu, the statistics and the playback settings page. */
export const VIDEO_FITS: VideoFit[] = ['auto', 'contain', 'cover', 'fill']

export const fitLabels = defineMessages({
  de: { auto: 'Automatisch', contain: 'Einpassen', cover: 'Füllen', fill: 'Strecken' },
  en: { auto: 'Automatic', contain: 'Fit', cover: 'Fill', fill: 'Stretch' },
})

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** "Normal", "1,5×" / "1.5×". */
export function speedLabel(speed: number, locale: Locale = getLocale()) {
  return speed === 1 ? 'Normal' : `${new Intl.NumberFormat(getLocaleTag(locale)).format(speed)}×`
}

/** A number in the active language's notation ("1,5" / "1.5"); `digits` fixes the number of decimals. */
export function formatNumber(value: number, digits?: number, locale: Locale = getLocale()) {
  const options = digits === undefined ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits }
  return new Intl.NumberFormat(getLocaleTag(locale), options).format(value)
}

/** Quality steps of the player menu; the one without a bitrate is the original. */
export const QUALITY_OPTIONS: Array<{ resolution?: string; bitrate?: number }> = [
  {},
  { resolution: '1080p', bitrate: 20_000_000 },
  { resolution: '720p', bitrate: 8_000_000 },
  { resolution: '480p', bitrate: 3_000_000 },
  { resolution: '360p', bitrate: 1_500_000 },
]

/**
 * A bitrate as the player's quality menu names it ("720p · 8 Mbit/s"), so settings elsewhere (downloads, the episode
 * cache, streaming) can be recognised; a rate between the steps is just "12 Mbit/s".
 */
export function qualityLabel(bits: number, locale: Locale = getLocale()) {
  const resolution = QUALITY_OPTIONS.find((option) => option.bitrate === bits)?.resolution
  return [resolution, mbitLabel(bits, undefined, locale)].filter(Boolean).join(' · ')
}

/** Bit/s as "1,5 Mbit/s" / "1.5 Mbit/s". */
export function mbitLabel(bits: number, digits?: number, locale: Locale = getLocale()) {
  return `${formatNumber(bits / 1_000_000, digits, locale)} Mbit/s`
}
