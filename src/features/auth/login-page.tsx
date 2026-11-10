import { useQuery } from '@tanstack/react-query'
import { IconCheck, IconCopy, IconDeviceMobile, IconKey, IconLoader2, IconLogin2 } from '@tabler/icons-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useLanguagePreference, useLocale, useMessages, type Locale } from '@/lib/i18n'
import { DEFAULT_SERVER_URL } from '@/lib/jellyfin'
import { useServerAddress } from '@/lib/server-address'
import { cn } from '@/lib/utils'
import { loginMessages } from './messages'
import { useSession } from './session'
import { isQuickConnectEnabled, useQuickConnect } from './use-quick-connect'
import { useBranding } from '@/features/admin/branding'
import { markAppReady } from '@/lib/boot'
import { config } from '@/lib/config'
import { usePublicConfig } from '@/lib/public-config'

/** Where to go after signing in: back to the page that asked (`?next=`), a jellyfin-web admin page included. */
function nextPath() {
  const next = new URLSearchParams(window.location.search).get('next') ?? ''
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

/** jellyfin-web's stored sign-in, when it is for this server. */
function jellyfinWebToken(serverUrl: string): { AccessToken: string; UserId?: string } | null {
  // jellyfin-web only ever runs on this address; its token never goes to a server typed in by address.
  if (URL.parse(serverUrl)?.origin !== window.location.origin) return null
  try {
    const stored = JSON.parse(localStorage.getItem('jellyfin_credentials') ?? 'null') as { Servers?: Array<{ AccessToken?: string; ManualAddress?: string; UserId?: string }> } | null
    const trim = (value: string) => value.replace(/\/+$/, '')
    const server = stored?.Servers?.find((entry) => entry.AccessToken && (!entry.ManualAddress || trim(entry.ManualAddress) === trim(serverUrl)))
    return server?.AccessToken ? { AccessToken: server.AccessToken, UserId: server.UserId } : null
  } catch {
    return null
  }
}

/**
 * Takes over a sign-in made in jellyfin-web on this same address (the SSO plugin finishes its sign-ins there; Lumio
 * fronting Jellyfin sends those here): its token, checked with the server.
 */
function useAdoptJellyfinSignIn(serverUrl: string) {
  const { session, completeSignIn } = useSession()
  const [adopting, setAdopting] = useState(() => !session && !!jellyfinWebToken(serverUrl))
  useEffect(() => {
    const stored = jellyfinWebToken(serverUrl)
    if (session || !stored) return
    void fetch(`${serverUrl}/Users/Me`, { headers: { Authorization: `MediaBrowser Token="${stored.AccessToken}"` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Rejected')
        const user = (await response.json()) as { Id: string; Name: string }
        completeSignIn(serverUrl, { AccessToken: stored.AccessToken, User: { Id: user.Id, Name: user.Name } })
      })
      .catch(() => localStorage.removeItem('jellyfin_credentials'))
      .finally(() => setAdopting(false))
  }, [serverUrl, session, completeSignIn])
  return adopting
}

export function LoginPage() {
  const { session } = useSession()
  // As typed; "jelly.example.org" becomes https:// (or http:// when only that answers) before anything connects.
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_URL)
  const { address: serverUrl, reachable, resolving } = useServerAddress(serverInput)
  // With an address to type, the ways to sign in wait until a Jellyfin server answers there.
  const serverReady = config.serverLocked || reachable
  const [mode, setMode] = useState<'quick-connect' | 'password'>('quick-connect')
  const t = useMessages(loginMessages)
  const { appName, logo } = useBranding()
  const publicConfig = usePublicConfig().data
  // SSO goes through Jellyfin's plugin, on this address (Lumio in front of Jellyfin).
  const sso = publicConfig?.proxy && serverUrl === window.location.origin ? publicConfig.sso : []
  const adopting = useAdoptJellyfinSignIn(serverUrl)
  // The operator can leave the password form off (accounts live in the identity provider); never without SSO to use.
  const passwordAllowed = publicConfig?.passwordLogin !== false || sso.length === 0

  const quickConnectEnabled = useQuery({
    queryKey: ['quick-connect-enabled', serverUrl],
    queryFn: () => isQuickConnectEnabled(serverUrl),
    enabled: serverReady && URL.canParse(serverUrl),
    retry: false,
  })

  // Signed out: the login form is the first view, nothing else to wait for.
  useEffect(() => {
    if (!session) markAppReady()
  }, [session])

  if (session) {
    const next = nextPath()
    // Back to a jellyfin-web admin page: outside the app.
    if (next.startsWith('/web/')) {
      window.location.replace(next)
      return null
    }
    return <Navigate to={next} replace />
  }
  if (adopting)
    return (
      <main className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
        <IconLoader2 className="size-4 animate-spin" /> {t.adopting}
      </main>
    )

  const showPassword = passwordAllowed && (mode === 'password' || quickConnectEnabled.data === false)
  const showQuickConnect = !showPassword && quickConnectEnabled.data !== false

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-4">
      {/* The desktop app's window is moved by its top edge (index.css). */}
      <div data-titlebar aria-hidden className="fixed inset-x-0 top-0 h-14" />
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <CardTitle className="text-2xl">
            {logo ? <img src={logo} alt={appName} className="mx-auto h-10 w-auto max-w-56 object-contain" /> : appName}
          </CardTitle>
          <CardDescription>{t.signInTo}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {!config.serverLocked && (
            <div className="grid gap-2">
              <Label htmlFor="server">{t.server}</Label>
              <Input
                id="server"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="jellyfin.example.org"
                required
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
              />
              {serverInput.trim() && !reachable && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  {resolving ? (
                    <>
                      <IconLoader2 className="size-4 animate-spin" /> {t.checkingServer}
                    </>
                  ) : (
                    t.noServer
                  )}
                </p>
              )}
            </div>
          )}

          {serverReady && sso.length > 0 && (
            <div className="grid gap-2">
              {sso.map((provider) => (
                <Button key={provider.id} size="lg" onClick={() => window.location.assign(`${serverUrl}/sso/OID/start/${encodeURIComponent(provider.id)}`)}>
                  <IconLogin2 /> {provider.label}
                </Button>
              ))}
              {(showPassword || showQuickConnect) && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <Separator className="flex-1" /> {t.or} <Separator className="flex-1" />
                </div>
              )}
            </div>
          )}

          {!serverReady ? null : showPassword ? <PasswordForm serverUrl={serverUrl} /> : showQuickConnect ? <QuickConnectPanel serverUrl={serverUrl} /> : null}

          {serverReady && quickConnectEnabled.data && passwordAllowed && (
            <>
              <Separator />
              <Button variant="ghost" onClick={() => setMode(showPassword ? 'quick-connect' : 'password')}>
                {showPassword ? (
                  <>
                    <IconDeviceMobile /> {t.withQuickConnect}
                  </>
                ) : (
                  <>
                    <IconKey /> {t.withPassword}
                  </>
                )}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      <LanguageSwitch />
    </main>
  )
}

// Names in their own language, so each can be found whatever language is showing.
const LANGUAGES: Array<{ value: Locale; label: string }> = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
]

/** The settings can't be reached before signing in, so the language can be picked here too. */
function LanguageSwitch() {
  const t = useMessages(loginMessages)
  const locale = useLocale()
  const [, setLanguage] = useLanguagePreference()

  return (
    <div role="group" aria-label={t.language} className="flex gap-1">
      {LANGUAGES.map(({ value, label }) => (
        <Button
          key={value}
          variant="ghost"
          size="xs"
          lang={value}
          aria-pressed={locale === value}
          onClick={() => setLanguage(value)}
          className={cn(locale === value ? 'text-foreground' : 'text-muted-foreground')}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}

/** The Quick Connect code; a click copies all of it (and selects it, where copying isn't allowed). */
function CopyCode({ code }: { code: string }) {
  const t = useMessages(loginMessages)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <div className="grid justify-items-center gap-1">
      <button
        type="button"
        title={t.copyCode}
        aria-label={`${t.copyCode}: ${code}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
          } catch {
            // No clipboard here: the code is selected for copying by hand.
          }
        }}
        className="group relative rounded-lg px-4 py-1 font-mono text-4xl font-semibold tracking-[0.3em] outline-none transition-colors select-all hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        aria-live="polite"
      >
        {code}
      </button>
      <span className={cn('flex items-center gap-1 text-xs text-muted-foreground', copied && 'text-foreground')}>
        {copied ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />} {copied ? t.codeCopied : t.copyCode}
      </span>
    </div>
  )
}

function QuickConnectPanel({ serverUrl }: { serverUrl: string }) {
  const { status, start, cancel } = useQuickConnect(serverUrl)
  const t = useMessages(loginMessages)

  if (status.state === 'waiting') {
    return (
      <div className="grid gap-4 text-center">
        <p className="text-sm text-muted-foreground">
          {t.quickConnectBefore} <span className="text-foreground">{t.quickConnectPath}</span> {t.quickConnectAfter}
        </p>
        <CopyCode code={status.code} />
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 className="size-4 animate-spin" /> {t.waiting}
        </p>
        <Button variant="outline" onClick={cancel}>
          {t.cancel}
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {status.state === 'error' && <p className="text-sm text-destructive">{status.reason === 'start' ? t.startFailed : t.codeExpired}</p>}
      <Button onClick={() => void start()} disabled={status.state === 'starting'}>
        {status.state === 'starting' ? <IconLoader2 className="animate-spin" /> : <IconDeviceMobile />}
        {t.requestCode}
      </Button>
    </div>
  )
}

function PasswordForm({ serverUrl }: { serverUrl: string }) {
  const { login } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const t = useMessages(loginMessages)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setFailed(false)
    try {
      await login(serverUrl, username, password)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="username">{t.username}</Label>
        <Input id="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">{t.password}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {failed && <p className="text-sm text-destructive">{t.signInFailed}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? t.signingIn : t.signIn}
      </Button>
    </form>
  )
}
