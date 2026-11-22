import { Section, SelectField, SettingsPage, SettingsPending, SwitchField, withCurrent } from './fields'
import { SAME_AS_WIFI, useLocalSettings, type SegmentAction, type SegmentKind } from './local-settings'
import { networkTypeKnown } from '@/lib/network'
import { fitLabels, qualityLabel, SPEEDS, speedLabel, VIDEO_FITS } from '@/features/player/labels'
import { getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { fieldMessages, playbackMessages } from './messages'
import { useLanguageOptions } from './use-languages'
import { useUpdateConfiguration, useUserConfiguration } from './use-user-configuration'

const MBIT = 1_000_000
const BITRATES_MBIT = [120, 80, 60, 40, 20, 10, 8, 4, 3, 1.5]

const SKIP_SECONDS = [5, 10, 15, 20, 30]

const SEGMENT_ACTIONS: SegmentAction[] = ['None', 'AskToSkip', 'Skip']

const SEGMENT_KINDS: SegmentKind[] = ['Intro', 'Preview', 'Recap', 'Commercial', 'Outro']

const RESET_KEYS = [
  'playbackRate',
  'videoFit',
  'skipForwardSeconds',
  'skipBackSeconds',
  'segmentActions',
  'startAfterIntro',
  'maxBitrate',
  'maxBitrateCellular',
  'maxAudioChannels',
  'preloadNextEpisode',
  'preloadTrickplay',
] as const

/**
 * How films and series play. What follows the account comes first (tracks, the player, segments), what belongs to this
 * device last (quality and preloading).
 */
export function PlaybackPage() {
  const user = useUserConfiguration()
  const config = user.data?.Configuration
  const save = useUpdateConfiguration()
  const languages = useLanguageOptions()
  const { settings, update } = useLocalSettings()
  const locale = useLocale()
  const fitNames = useMessages(fitLabels)
  const speedOptions = SPEEDS.map((speed) => ({ value: speed, label: speedLabel(speed, locale) }))
  const fitOptions = VIDEO_FITS.map((fit) => ({ value: fit, label: fitNames[fit] }))
  const t = useMessages(playbackMessages)
  const { seconds } = useMessages(fieldMessages)
  const number = new Intl.NumberFormat(getLocaleTag(locale))
  const channelOptions = [
    { value: -1, label: t.auto },
    { value: 1, label: t.mono },
    { value: 2, label: t.stereo },
    { value: 6, label: t.channels(number.format(5.1)) },
    { value: 8, label: t.channels(number.format(7.1)) },
  ]
  const bitrateOptions = [{ value: 0, label: t.auto }, ...BITRATES_MBIT.map((mbit) => ({ value: mbit * MBIT, label: qualityLabel(mbit * MBIT, locale) }))]
  const skipOptions = SKIP_SECONDS.map((value) => ({ value, label: seconds(value) }))
  const segmentActions = SEGMENT_ACTIONS.map((value) => ({ value, label: t[`action${value}`] }))

  if (!config) {
    return (
      <SettingsPage title={t.title}>
        <SettingsPending error={user.isError} onRetry={() => void user.refetch()} rows={4} />
      </SettingsPage>
    )
  }

  const audioLanguage = config.AudioLanguagePreference ?? ''

  return (
    <SettingsPage title={t.title} description={t.description} resetKeys={RESET_KEYS}>
      <Section title={t.tracks} scope="account">
        <SelectField
          id="audio-language"
          label={t.audioLanguageLabel}
          hint={t.audioLanguageHint}
          value={audioLanguage}
          options={withCurrent(languages, audioLanguage)}
          onChange={(value) => save.mutate({ AudioLanguagePreference: value || null })}
        />
        <SwitchField
          id="play-default-audio"
          label={t.defaultAudioLabel}
          hint={t.defaultAudioHint}
          checked={config.PlayDefaultAudioTrack ?? true}
          onChange={(checked) => save.mutate({ PlayDefaultAudioTrack: checked })}
        />
        <SwitchField
          id="remember-audio"
          label={t.rememberAudioLabel}
          hint={t.rememberAudioHint}
          checked={config.RememberAudioSelections ?? true}
          onChange={(checked) => save.mutate({ RememberAudioSelections: checked })}
        />
        <SwitchField
          id="remember-subtitles"
          label={t.rememberSubtitlesLabel}
          hint={t.rememberSubtitlesHint}
          checked={config.RememberSubtitleSelections ?? true}
          onChange={(checked) => save.mutate({ RememberSubtitleSelections: checked })}
        />
      </Section>

      <Section title={t.player} scope="account">
        <SwitchField
          id="autoplay-next"
          label={t.autoplayNextLabel}
          checked={config.EnableNextEpisodeAutoPlay ?? true}
          onChange={(checked) => save.mutate({ EnableNextEpisodeAutoPlay: checked })}
        />
        <SelectField
          id="playback-rate"
          label={t.speedLabel}
          hint={t.speedHint}
          value={settings.playbackRate}
          options={speedOptions}
          onChange={(value) => update({ playbackRate: value })}
        />
        <SelectField
          id="video-fit"
          label={t.fitLabel}
          hint={t.fitHint}
          value={settings.videoFit}
          options={fitOptions}
          onChange={(value) => update({ videoFit: value })}
        />
        <SelectField
          id="skip-forward"
          label={t.skipForward}
          value={settings.skipForwardSeconds}
          options={skipOptions}
          onChange={(value) => update({ skipForwardSeconds: value })}
        />
        <SelectField
          id="skip-back"
          label={t.skipBack}
          value={settings.skipBackSeconds}
          options={skipOptions}
          onChange={(value) => update({ skipBackSeconds: value })}
        />
      </Section>

      <Section title={t.segments} description={t.segmentsDescription} scope="account">
        {SEGMENT_KINDS.map((kind) => (
          <SelectField
            key={kind}
            id={`segment-${kind}`}
            label={t[`kind${kind}`]}
            value={settings.segmentActions[kind]}
            options={segmentActions}
            onChange={(value) => update({ segmentActions: { ...settings.segmentActions, [kind]: value } })}
          />
        ))}
        <SwitchField
          id="start-after-intro"
          label={t.startAfterIntroLabel}
          hint={t.startAfterIntroHint}
          checked={settings.startAfterIntro}
          onChange={(checked) => update({ startAfterIntro: checked })}
        />
      </Section>

      <Section title={t.quality} description={t.streamingDescription} scope="device">
        <SelectField
          id="max-bitrate"
          label={t.bitrateLabel}
          hint={t.bitrateHint}
          value={settings.maxBitrate ?? 0}
          options={bitrateOptions}
          onChange={(value) => update({ maxBitrate: value || null })}
        />
        {networkTypeKnown() && (
          <SelectField
            id="max-bitrate-cellular"
            label={t.bitrateCellularLabel}
            hint={t.bitrateCellularHint}
            value={settings.maxBitrateCellular ?? 0}
            options={[{ value: SAME_AS_WIFI, label: t.sameAsWifi }, ...bitrateOptions]}
            onChange={(value) => update({ maxBitrateCellular: value || null })}
          />
        )}
        <SelectField
          id="max-audio-channels"
          label={t.channelsLabel}
          hint={t.channelsHint}
          value={settings.maxAudioChannels}
          options={channelOptions}
          onChange={(value) => update({ maxAudioChannels: value })}
        />
        <SwitchField
          id="preload-next"
          label={t.preloadNextLabel}
          hint={t.preloadNextHint}
          checked={settings.preloadNextEpisode}
          onChange={(checked) => update({ preloadNextEpisode: checked })}
        />
        <SwitchField
          id="preload-trickplay"
          label={t.preloadTrickplayLabel}
          hint={t.preloadTrickplayHint}
          checked={settings.preloadTrickplay}
          onChange={(checked) => update({ preloadTrickplay: checked })}
        />
      </Section>
    </SettingsPage>
  )
}
