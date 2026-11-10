import { getImageApi } from '@jellyfin/sdk/lib/utils/api/image-api'
import { IconAdjustments, IconLayoutDashboard, IconTags } from '@tabler/icons-react'
import { shellMessages } from '@/components/messages'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useAuthedSession } from '@/features/auth/session'
import { useSettingsPages } from '@/features/settings/settings-pages'
import { useUserConfiguration } from '@/features/settings/use-user-configuration'
import { useMessages } from '@/lib/i18n'
import { nameColor } from '@/lib/name-color'
import { cn } from '@/lib/utils'

/** The signed-in user's picture and where they may go: shared by the header's profile menu and the phone's drawer. */

/** Jellyfin's own admin pages; Lumio has no admin UI, so these open the stock web client in a new tab. */
const ADMIN_PAGES = [
  { path: '/dashboard', labelKey: 'dashboard', icon: IconLayoutDashboard },
  { path: '/metadata', labelKey: 'metadata', icon: IconTags },
] as const

/** Where an administrator can go: Lumio's server-wide settings (one entry, the rest is reached from there), then Jellyfin's dashboard pages. */
export function useAdminLinks() {
  const { session } = useAuthedSession()
  const user = useUserConfiguration()
  const t = useMessages(shellMessages)
  const firstAdminPage = useSettingsPages().find((page) => page.admin)
  if (!user.data?.Policy?.IsAdministrator) return []
  // Behind Lumio (same address) Jellyfin's pages open in place, and leaving them comes back here; elsewhere in a new tab.
  const sameOrigin = session.serverUrl.replace(/\/+$/, '') === window.location.origin
  return [
    ...(firstAdminPage
      ? [{ key: 'lumio', label: t.lumioSettings, icon: IconAdjustments, to: firstAdminPage.to, href: undefined, external: false }]
      : []),
    ...ADMIN_PAGES.map(({ path, labelKey, icon }) => ({
      key: path,
      label: t[labelKey],
      icon,
      to: undefined,
      href: sameOrigin ? `/web/#${path}` : `${session.serverUrl}/web/#${path}`,
      external: !sameOrigin,
    })),
  ]
}

/** The user's profile picture, or their initials on a color generated from their name. */
export function UserAvatar({ className }: { className?: string }) {
  const { api, session } = useAuthedSession()
  const user = useUserConfiguration()
  const image = user.data?.PrimaryImageTag ? getImageApi(api).getUserImageUrl(user.data, { width: 96 }) : undefined
  return (
    <Avatar className={cn('size-8', className)}>
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback className="font-medium text-white" style={{ background: nameColor(session.userName) }}>
        {session.userName.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}
