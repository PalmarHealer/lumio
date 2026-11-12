import { IconCopy, IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Row, Section, SelectField, SettingsPage, SettingsPending } from '@/features/settings/fields'
import { useLumioFetch } from '@/features/social/social'
import { defineMessages, getLocaleTag, useLocale, useMessages } from '@/lib/i18n'
import { useIsAdmin } from './use-admin-config'

const messages = defineMessages({
  de: {
    title: 'Stem-Worker',
    description:
      'Rechner, die Songs für den Editor in Stems zerlegen (Gesang, Drums, Bass, Rest). Ein Worker verbindet sich nur nach außen mit diesem Server; Musikbibliothek und Jellyfin braucht er nicht.',
    adminOnly: 'Nur für Administrator*innen.',
    addressTitle: 'Adresse für Worker',
    addressHint:
      'Unter dieser Adresse erreichen Worker diesen Server; sie landet im Join-Key. Container lösen Tailnet-Namen oft nicht auf: dann die Tailscale-IP nehmen, z. B. http://100.64.0.5:8097/api.',
    address: 'Server-Adresse (API)',
    save: 'Speichern',
    saved: 'Adresse gespeichert',
    saveFailed: (error: string) => `Nicht gespeichert: ${error}`,
    workersTitle: 'Worker',
    workersHint: 'Widerrufen sperrt einen Worker bei seiner nächsten Anfrage; seine laufenden Aufträge gehen zurück in die Warteschlange.',
    none: 'Noch keine Worker.',
    primary: 'Primär',
    fallback: 'Ersatz',
    revoked: 'Widerrufen',
    never: 'noch nie verbunden',
    seen: (when: string) => `zuletzt ${when}`,
    jobs: (n: number) => (n === 1 ? '1 Auftrag erledigt' : `${n} Aufträge erledigt`),
    working: (n: number) => (n === 1 ? 'arbeitet an 1 Auftrag' : `arbeitet an ${n} Aufträgen`),
    revoke: 'Widerrufen',
    remove: 'Löschen',
    revokedToast: (name: string) => `${name} widerrufen`,
    removedToast: (name: string) => `${name} gelöscht`,
    actionFailed: 'Das hat nicht geklappt',
    addTitle: 'Worker hinzufügen',
    name: 'Name',
    namePlaceholder: 'z. B. nauren-lpz GPU',
    role: 'Rolle',
    roleHint: 'Primär nimmt jeden Auftrag (z. B. ein Rechner mit GPU). Ersatz zerlegt nur Übergangs-Fenster und pausiert, solange ein primärer Worker verbunden ist (z. B. die CPU dieses Servers).',
    rolePrimary: 'Primär (alle Aufträge)',
    roleFallback: 'Ersatz (nur Fenster)',
    add: 'Hinzufügen',
    needAddress: 'Zuerst die Adresse für Worker speichern.',
    keyTitle: (name: string) => `Join-Key für ${name}`,
    keyOnce: 'Der Key wird nur jetzt angezeigt. Er enthält Adresse und Geheimnis des Workers; wie ein Passwort behandeln.',
    copy: 'Kopieren',
    copied: 'Kopiert',
    composeHint: 'In der .env des Workers (lpz-deploy):',
    dockerHint: 'Oder direkt mit Docker:',
    done: 'Fertig',
  },
  en: {
    title: 'Stem workers',
    description:
      'Machines that split songs into stems for the editor (vocals, drums, bass, the rest). A worker only connects out to this server; it needs neither the music library nor Jellyfin.',
    adminOnly: 'Administrators only.',
    addressTitle: 'Address for workers',
    addressHint:
      'Workers reach this server at this address; it goes into the join key. Containers often can’t resolve tailnet names: then use the Tailscale IP, e.g. http://100.64.0.5:8097/api.',
    address: 'Server address (API)',
    save: 'Save',
    saved: 'Address saved',
    saveFailed: (error: string) => `Not saved: ${error}`,
    workersTitle: 'Workers',
    workersHint: 'Revoking locks a worker out at its next request; the jobs it is working on go back into the queue.',
    none: 'No workers yet.',
    primary: 'Primary',
    fallback: 'Fallback',
    revoked: 'Revoked',
    never: 'never connected',
    seen: (when: string) => `last seen ${when}`,
    jobs: (n: number) => (n === 1 ? '1 job done' : `${n} jobs done`),
    working: (n: number) => (n === 1 ? 'working on 1 job' : `working on ${n} jobs`),
    revoke: 'Revoke',
    remove: 'Delete',
    revokedToast: (name: string) => `${name} revoked`,
    removedToast: (name: string) => `${name} deleted`,
    actionFailed: 'That didn’t work',
    addTitle: 'Add a worker',
    name: 'Name',
    namePlaceholder: 'e.g. nauren-lpz GPU',
    role: 'Role',
    roleHint: 'Primary takes every job (e.g. a machine with a GPU). Fallback only splits transition windows and pauses while a primary worker is connected (e.g. this server’s CPU).',
    rolePrimary: 'Primary (all jobs)',
    roleFallback: 'Fallback (windows only)',
    add: 'Add',
    needAddress: 'Save the address for workers first.',
    keyTitle: (name: string) => `Join key for ${name}`,
    keyOnce: 'The key is shown only now. It holds the worker’s address and secret; treat it like a password.',
    copy: 'Copy',
    copied: 'Copied',
    composeHint: 'In the worker’s .env (lpz-deploy):',
    dockerHint: 'Or with Docker directly:',
    done: 'Done',
  },
})

interface Worker {
  id: string
  name: string
  role: 'primary' | 'fallback'
  created: number
  lastSeen: number | null
  jobsDone: number
  revoked: boolean
  jobs: Array<{ item: string; window: { id: string } }>
}

const QUERY_KEY = ['admin', 'stem-workers']

/** Administration: the stem workers (see server/src/stem-workers.ts): the address for join keys, the list, adding one. */
export function StemWorkersPage() {
  const t = useMessages(messages)
  const isAdmin = useIsAdmin()
  const lumioFetch = useLumioFetch()
  const client = useQueryClient()
  const locale = useLocale()
  const relative = new Intl.RelativeTimeFormat(getLocaleTag(locale), { numeric: 'auto' })
  // What the admin is typing; null shows the saved address.
  const [draft, setDraft] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState<'primary' | 'fallback'>('primary')
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null)

  const workers = useQuery({
    queryKey: QUERY_KEY,
    enabled: isAdmin,
    // Last seen and current jobs change while the page is open.
    refetchInterval: 15_000,
    queryFn: async (): Promise<{ url: string; workers: Worker[] }> => {
      const response = await lumioFetch('/admin/stem-workers')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return (await response.json()) as { url: string; workers: Worker[] }
    },
  })
  const savedAddress = workers.data?.url ?? ''
  const address = draft ?? savedAddress
  // "Last seen" relative to when the list was fetched (it refreshes every 15 s).
  const now = workers.dataUpdatedAt

  const call = async (path: string, init: RequestInit) => {
    const response = await lumioFetch(path, init)
    if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${response.status}`)
    return response.status === 204 ? null : ((await response.json()) as unknown)
  }
  const refresh = () => void client.invalidateQueries({ queryKey: QUERY_KEY })

  const saveAddress = useMutation({
    mutationFn: () => call('/admin/stem-workers/config', { method: 'PUT', body: JSON.stringify({ url: address.trim() }) }),
    onSuccess: () => {
      toast.success(t.saved)
      setDraft(null)
      refresh()
    },
    onError: (error) => toast.error(t.saveFailed(error.message)),
  })
  const add = useMutation({
    mutationFn: () => call('/admin/stem-workers', { method: 'POST', body: JSON.stringify({ name: name.trim(), role }) }) as Promise<{ worker: Worker; joinKey: string }>,
    onSuccess: (result) => {
      setIssued({ name: result.worker.name, key: result.joinKey })
      setName('')
      refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const act = useMutation({
    mutationFn: ({ worker, kind }: { worker: Worker; kind: 'revoke' | 'remove' }) =>
      call(kind === 'revoke' ? `/admin/stem-workers/${worker.id}/revoke` : `/admin/stem-workers/${worker.id}`, { method: kind === 'revoke' ? 'POST' : 'DELETE' }),
    onSuccess: (_, { worker, kind }) => {
      toast.success(kind === 'revoke' ? t.revokedToast(worker.name) : t.removedToast(worker.name))
      refresh()
    },
    onError: () => toast.error(t.actionFailed),
  })

  const ago = (time: number) => {
    const seconds = Math.min(0, Math.round((time - now) / 1000))
    const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
      Math.abs(seconds) < 60 ? [seconds, 'second'] : Math.abs(seconds) < 3600 ? [Math.round(seconds / 60), 'minute'] : Math.abs(seconds) < 86400 ? [Math.round(seconds / 3600), 'hour'] : [Math.round(seconds / 86400), 'day']
    return relative.format(value, unit)
  }

  if (!isAdmin) {
    return (
      <SettingsPage title={t.title}>
        <p className="text-sm text-muted-foreground">{t.adminOnly}</p>
      </SettingsPage>
    )
  }
  return (
    <SettingsPage title={t.title} description={t.description}>
      {!workers.data ? (
        <SettingsPending error={workers.isError} onRetry={() => void workers.refetch()} rows={2} />
      ) : (
        <>
          <Section anchor="stem-worker-address" title={t.addressTitle} description={t.addressHint}>
            <Row label={t.address} htmlFor="stem-worker-address-input">
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  saveAddress.mutate()
                }}
              >
                <Input id="stem-worker-address-input" value={address} placeholder="http://100.64.0.5:8097/api" onChange={(event) => setDraft(event.target.value)} />
                <Button type="submit" variant="outline" disabled={saveAddress.isPending || !address.trim() || address.trim() === savedAddress}>
                  {t.save}
                </Button>
              </form>
            </Row>
          </Section>

          <Section anchor="stem-workers" title={t.workersTitle} description={t.workersHint}>
            {!workers.data.workers.length && <p className="p-4 text-sm text-muted-foreground">{t.none}</p>}
            {workers.data.workers.length > 0 && (
              <ul className="divide-y">
                {workers.data.workers.map((worker) => (
                  <li key={worker.id} className="flex flex-col gap-2 px-4 py-3 @xl/settings:flex-row @xl/settings:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {worker.name}
                        <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">{worker.role === 'primary' ? t.primary : t.fallback}</span>
                        {worker.revoked && <span className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">{t.revoked}</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[worker.lastSeen ? t.seen(ago(worker.lastSeen)) : t.never, t.jobs(worker.jobsDone), worker.jobs.length ? t.working(worker.jobs.length) : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {!worker.revoked && (
                        <Button variant="ghost" size="sm" disabled={act.isPending} onClick={() => act.mutate({ worker, kind: 'revoke' })}>
                          {t.revoke}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-destructive" disabled={act.isPending} onClick={() => act.mutate({ worker, kind: 'remove' })}>
                        {t.remove}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section anchor="stem-worker-add" title={t.addTitle} description={savedAddress ? undefined : t.needAddress}>
            <Row label={t.name} htmlFor="stem-worker-name">
              <Input id="stem-worker-name" value={name} maxLength={60} placeholder={t.namePlaceholder} onChange={(event) => setName(event.target.value)} />
            </Row>
            <SelectField
              id="stem-worker-role"
              label={t.role}
              hint={t.roleHint}
              value={role}
              options={[
                { value: 'primary', label: t.rolePrimary },
                { value: 'fallback', label: t.roleFallback },
              ]}
              onChange={setRole}
            />
            <div className="flex justify-end p-4">
              <Button disabled={!savedAddress || !name.trim() || add.isPending} onClick={() => add.mutate()}>
                <IconPlus /> {t.add}
              </Button>
            </div>
          </Section>
        </>
      )}
      <JoinKeyDialog issued={issued} onClose={() => setIssued(null)} />
    </SettingsPage>
  )
}

/** Shows a new worker's join key once, with what to paste where. */
function JoinKeyDialog({ issued, onClose }: { issued: { name: string; key: string } | null; onClose: () => void }) {
  const t = useMessages(messages)
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success(t.copied),
      () => toast.error(t.actionFailed),
    )
  const env = issued ? `LUMIO_JOIN_KEY=${issued.key}` : ''
  const docker = issued ? `docker run -d --name lumio-stem-worker --restart unless-stopped --gpus all \\\n  -e LUMIO_JOIN_KEY='${issued.key}' \\\n  -v "$PWD/models:/models:ro" lumio-stem-worker:gpu` : ''
  return (
    <Dialog open={!!issued} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 overflow-y-auto p-6 sm:max-w-2xl">
        <DialogTitle className="text-xl font-bold">{issued ? t.keyTitle(issued.name) : ''}</DialogTitle>
        <DialogDescription>{t.keyOnce}</DialogDescription>
        <Snippet text={issued?.key ?? ''} onCopy={copy} label={t.copy} />
        <p className="text-sm text-muted-foreground">{t.composeHint}</p>
        <Snippet text={env} onCopy={copy} label={t.copy} />
        <p className="text-sm text-muted-foreground">{t.dockerHint}</p>
        <Snippet text={docker} onCopy={copy} label={t.copy} />
        <div className="flex justify-end">
          <Button onClick={onClose}>{t.done}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Snippet({ text, onCopy, label }: { text: string; onCopy: (text: string) => void; label: string }) {
  return (
    <div className="relative rounded-lg border bg-muted/40">
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs break-all whitespace-pre-wrap select-all">{text}</pre>
      <Button variant="ghost" size="icon-sm" className="absolute top-1.5 right-1.5" aria-label={label} title={label} onClick={() => onCopy(text)}>
        <IconCopy />
      </Button>
    </div>
  )
}
