import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { LocationDialog } from '@/features/listen/concert-pages'
import { useConcertLocation } from '@/features/listen/concerts'
import { clearAudioCache } from '@/features/listen/player/audio-cache'
import { music } from '@/features/listen/player/music-player'
import { TasteExclusionsSection } from '@/features/listen/taste'
import { useMessages } from '@/lib/i18n'
import { Row, Section, SelectField, SettingsPage, SwitchField } from './fields'
import { SAME_AS_WIFI, useLocalSettings } from './local-settings'
import { networkTypeKnown } from '@/lib/network'
import { playbackMessages, musicMessages } from './messages'
import { ListeningHistorySection } from './spotify-import-section'

const QUALITIES = [320, 256, 192, 160, 128]

const RESET_KEYS = ['musicAutoplay', 'musicNormalization', 'musicQuality', 'musicQualityMobile'] as const

export function MusicPage() {
  const t = useMessages(musicMessages)
  const p = useMessages(playbackMessages)
  const { settings, update } = useLocalSettings()
  const location = useConcertLocation()
  const [picking, setPicking] = useState(false)
  const qualityOptions = [{ value: 0, label: p.musicOriginal }, ...QUALITIES.map((kbps) => ({ value: kbps, label: `${kbps} kbps` }))]

  return (
    <SettingsPage
      title={t.title}
      description={t.description}
      resetKeys={RESET_KEYS}
      onReset={(before) => {
        music.renormalize()
        // The cache held the old quality.
        if (before.musicQuality !== null) void clearAudioCache()
      }}
    >
      <Section title={t.playback} scope="account">
        <SwitchField
          id="music-autoplay"
          label={p.autoplayMusicLabel}
          hint={p.autoplayMusicHint}
          checked={settings.musicAutoplay}
          onChange={(checked) => update({ musicAutoplay: checked })}
        />
        <SelectField
          id="music-normalization"
          label={t.normalizationLabel}
          hint={t.normalizationHint}
          value={settings.musicNormalization}
          options={[
            { value: 'off', label: t.normalizationOff },
            { value: 'track', label: t.normalizationTrack },
            { value: 'album', label: t.normalizationAlbum },
          ]}
          onChange={(value) => {
            update({ musicNormalization: value })
            music.renormalize()
          }}
        />
      </Section>

      <Section title={t.quality} description={t.qualityDescription} scope="device">
        <SelectField
          id="music-quality"
          label={p.musicQualityLabel}
          hint={`${p.musicQualityHint} ${p.musicQualityCacheNote}`}
          value={settings.musicQuality ?? 0}
          options={qualityOptions}
          onChange={(value) => {
            update({ musicQuality: value || null })
            // The cache held the old quality: it fills again in the new one.
            if ((value || null) !== settings.musicQuality) void clearAudioCache()
          }}
        />
        {networkTypeKnown() && (
          <SelectField
            id="music-quality-cellular"
            label={p.musicQualityCellularLabel}
            hint={p.musicQualityCellularHint}
            value={settings.musicQualityMobile ?? 0}
            options={[{ value: SAME_AS_WIFI, label: p.sameAsWifi }, ...qualityOptions]}
            onChange={(value) => update({ musicQualityMobile: value || null })}
          />
        )}
      </Section>

      <Section anchor="concerts" title={t.concerts} scope="account">
        <Row label={t.locationLabel} hint={t.locationHint}>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <span className="truncate text-sm text-muted-foreground">{location?.label ?? t.locationNone}</span>
            <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
              {location ? t.change : t.set}
            </Button>
          </div>
        </Row>
      </Section>

      <ListeningHistorySection />
      <TasteExclusionsSection />
      <LocationDialog open={picking} onOpenChange={setPicking} />
    </SettingsPage>
  )
}
