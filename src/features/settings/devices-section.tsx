import { getDeviceApi } from '@jellyfin/sdk/lib/utils/api/device-api'
import { getSessionApi } from '@jellyfin/sdk/lib/utils/api/session-api'
import { IconDeviceDesktop, IconDeviceMobile, IconDeviceTv } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuthedSession } from '@/features/auth/session'
import { getLocaleTag, defineMessages, useLocale, useMessages } from '@/lib/i18n'
import { jellyfin } from '@/lib/jellyfin'
import { Section } from './fields'
import { useUserConfiguration } from './use-user-configuration'

const messages = defineMessages({
  de: {
    title: 'Angemeldete Geräte',
    adminDescription: 'Wo du gerade angemeldet bist, zuletzt aktive zuerst. Abmelden beendet die Anmeldung dort; das Gerät muss sich neu anmelden.',
    userDescription: 'Wo du in den letzten 30 Tagen aktiv warst. Abmelden kann ein Gerät nur ein Admin oder das Gerät selbst.',
    thisDevice: 'Dieses Gerät',
    signOut: 'Abmelden',
    signedOut: (name: string) => `${name} abgemeldet`,
    signOutFailed: 'Das Gerät konnte nicht abgemeldet werden',
    showAll: (n: number) => `Alle ${n} zeigen`,
    none: 'Keine Geräte gefunden.',
    failed: 'Die Geräte konnten nicht geladen werden.',
  },
  en: {
    title: 'Signed-in devices',
    adminDescription: 'Where you are signed in, most recently active first. Signing out ends the sign-in there; the device has to sign in again.',
    userDescription: 'Where you were active in the last 30 days. Only an admin or the device itself can sign a device out.',
    thisDevice: 'This device',
    signOut: 'Sign out',
    signedOut: (name: string) => `${name} signed out`,
    signOutFailed: 'The device could not be signed out',
    showAll: (n: number) => `Show all ${n}`,
    none: 'No devices found.',
    failed: 'The devices could not be loaded.',
  },
})

interface Device {
  id: string
  name: string
  app: string
  lastActive: string | null
}

const SHOWN = 8
const MONTH_S = 30 * 24 * 60 * 60

/**
 * The devices signed in to this account. Admins get Jellyfin's device list (and can sign one out); other users only
 * their own recent sessions, since the device list is admin-only on the server.
 */
export function DevicesSection() {
  const t = useMessages(messages)
  const { api, session } = useAuthedSession()
  const isAdmin = !!useUserConfiguration().data?.Policy?.IsAdministrator
  const client = useQueryClient()
  const [all, setAll] = useState(false)
  const locale = useLocale()
  const date = new Intl.DateTimeFormat(getLocaleTag(locale), { dateStyle: 'medium', timeStyle: 'short' })

  const devices = useQuery({
    queryKey: ['account-devices', session.userId, isAdmin],
    queryFn: async (): Promise<Device[]> => {
      if (isAdmin) {
        // The server's userId filter lets every device through for an admin (it filters by "can access"), so keep only
        // the devices this account last signed in on.
        const items = (await getDeviceApi(api).getDevices({ userId: session.userId })).data.Items ?? []
        return items.filter((item) => item.LastUserId?.replace(/-/g, '').toLowerCase() === session.userId.replace(/-/g, '').toLowerCase()).map((item) => ({ id: item.Id ?? '', name: item.CustomName || item.Name || '—', app: [item.AppName, item.AppVersion].filter(Boolean).join(' '), lastActive: item.DateLastActivity ?? null }))
      }
      const sessions = (await getSessionApi(api).getSessions({ activeWithinSeconds: MONTH_S })).data
      return sessions
        .filter((entry) => entry.UserId?.replace(/-/g, '').toLowerCase() === session.userId.replace(/-/g, '').toLowerCase())
        .map((entry) => ({ id: entry.DeviceId ?? '', name: entry.DeviceName || '—', app: [entry.Client, entry.ApplicationVersion].filter(Boolean).join(' '), lastActive: entry.LastActivityDate ?? null }))
    },
    select: (list) => [...list].sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? '')),
    staleTime: 60_000,
  })

  const signOut = useMutation({
    mutationFn: (device: Device) => getDeviceApi(api).deleteDevice({ id: [device.id] }),
    onSuccess: (_, device) => {
      toast.success(t.signedOut(device.name))
      void client.invalidateQueries({ queryKey: ['account-devices'] })
    },
    onError: () => toast.error(t.signOutFailed),
  })

  const list = devices.data ?? []
  const shown = all ? list : list.slice(0, SHOWN)
  return (
    <Section anchor="devices" title={t.title} description={isAdmin ? t.adminDescription : t.userDescription}>
      {devices.isError && <p className="p-4 text-sm text-muted-foreground">{t.failed}</p>}
      {devices.isSuccess && !list.length && <p className="p-4 text-sm text-muted-foreground">{t.none}</p>}
      {shown.length > 0 && (
        <ul className="divide-y">
          {shown.map((device, position) => {
            const here = device.id === jellyfin.deviceInfo.id
            const Icon = /android|iphone|ios|mobile/i.test(`${device.name} ${device.app}`) ? IconDeviceMobile : /tv|kodi|roku/i.test(`${device.name} ${device.app}`) ? IconDeviceTv : IconDeviceDesktop
            return (
              <li key={`${device.id}-${position}`} className="flex items-center gap-3 px-4 py-3">
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {device.name}
                    {here && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">{t.thisDevice}</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{[device.app, device.lastActive && date.format(new Date(device.lastActive))].filter(Boolean).join(' · ')}</p>
                </div>
                {isAdmin && !here && (
                  <Button variant="ghost" size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate(device)}>
                    {t.signOut}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!all && list.length > SHOWN && (
        <div className="p-2">
          <Button variant="ghost" size="sm" className="w-full" onClick={() => setAll(true)}>
            {t.showAll(list.length)}
          </Button>
        </div>
      )}
    </Section>
  )
}
