import { useSetPrivacy, useSocialMe, type SocialPrivacy } from '@/features/social/social'
import { useMessages } from '@/lib/i18n'
import { privacyMessages } from './messages'
import { Section, SettingsPage, SettingsPending, SwitchField } from './fields'

/** The user's privacy choices, kept on the Lumio server (which also enforces them). */
export function PrivacyPage() {
  const t = useMessages(privacyMessages)
  const me = useSocialMe()
  const save = useSetPrivacy()
  if (!me.data) {
    return (
      <SettingsPage title={t.title}>
        <SettingsPending error={me.isError} onRetry={() => void me.refetch()} rows={4} />
      </SettingsPage>
    )
  }
  const privacy = me.data.privacy as SocialPrivacy
  const toggle = (key: keyof SocialPrivacy) => (checked: boolean) => save.mutate({ [key]: checked })
  return (
    <SettingsPage title={t.title} description={t.description}>
      <Section title={t.profile} scope="account">
        <SwitchField id="privacy-playlists" label={t.showPlaylists} hint={t.showPlaylistsHint} checked={privacy.showPlaylists} onChange={toggle('showPlaylists')} />
        <SwitchField id="privacy-following" label={t.showFollowing} hint={t.showFollowingHint} checked={privacy.showFollowing} onChange={toggle('showFollowing')} />
        <SwitchField id="privacy-followers" label={t.showFollowers} hint={t.showFollowersHint} checked={privacy.showFollowers} onChange={toggle('showFollowers')} />
      </Section>
      <Section title={t.activity} scope="account">
        <SwitchField id="privacy-activity" label={t.shareActivity} hint={t.shareActivityHint} checked={privacy.shareActivity} onChange={toggle('shareActivity')} />
        <SwitchField id="privacy-taste" label={t.shareTaste} hint={t.shareTasteHint} checked={privacy.shareTaste !== false} onChange={toggle('shareTaste')} />
      </Section>
    </SettingsPage>
  )
}
