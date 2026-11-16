import type { Api } from '@jellyfin/sdk'
import { clearPersistedQueries } from '@/lib/query-persist'
import type { AuthenticationResult } from '@jellyfin/sdk/lib/generated-client/models'
import { getAuthenticationApi } from '@jellyfin/sdk/lib/utils/api/authentication-api'
import { useQueryClient } from '@tanstack/react-query'
import axios, { type AxiosError } from 'axios'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { absoluteServerUrl, createApi } from '@/lib/jellyfin'

const SESSION_KEY = 'lumio.session'

interface StoredSession {
  serverUrl: string
  accessToken: string
  userId: string
  userName: string
}

interface SessionContextValue {
  session: StoredSession | null
  api: Api | null
  login: (serverUrl: string, username: string, password: string) => Promise<void>
  /** Finish a sign-in obtained by another flow (Quick Connect, later SSO). */
  completeSignIn: (serverUrl: string, result: AuthenticationResult) => void
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as StoredSession
    // Sign-ins made while the sign-in page still worked out the address were kept without one ("").
    const serverUrl = absoluteServerUrl(stored.serverUrl ?? '')
    if (serverUrl === stored.serverUrl) return stored
    const repaired = { ...stored, serverUrl }
    localStorage.setItem(SESSION_KEY, JSON.stringify(repaired))
    return repaired
  } catch {
    return null
  }
}

function saveSession(session: StoredSession | null) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // Storage unavailable (private mode): session lives in memory only.
  }
}

/**
 * The sign-in also in jellyfin-web's format. Jellyfin's Android app reads it when the page reports its capabilities
 * (and goes back to its server screen without it); jellyfin-web on this address (the administration) is signed in too.
 */
function shareWithJellyfinClients(session: StoredSession) {
  try {
    const stored = JSON.parse(localStorage.getItem('jellyfin_credentials') ?? 'null') as { Servers?: Array<{ AccessToken?: string; UserId?: string }> } | null
    const current = stored?.Servers?.[0]
    if (current?.AccessToken === session.accessToken && current.UserId === session.userId) return
    localStorage.setItem('jellyfin_credentials', JSON.stringify({ Servers: [{
      ManualAddress: session.serverUrl, LocalAddress: session.serverUrl, AccessToken: session.accessToken, UserId: session.userId,
      DateLastAccessed: Date.now(), LastConnectionMode: 2, ManualAddressOnly: true,
    }] }))
  } catch {
    // Storage unavailable.
  }
}

/**
 * A 401 only means "signed out" if it rejected the token of the current session. Ignored: requests still carrying an
 * older token, other servers, and Quick Connect, which answers 401 when an admin has switched the feature off.
 */
function isRejectedSessionToken(error: AxiosError, session: StoredSession) {
  if (error.response?.status !== 401) return false
  const url = error.config?.url ?? ''
  if (!url.startsWith(session.serverUrl) || url.includes('/QuickConnect/')) return false
  const authorization = String(error.config?.headers?.Authorization ?? '')
  return authorization.includes(`Token="${encodeURIComponent(session.accessToken)}"`)
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<StoredSession | null>(loadSession)

  useEffect(() => {
    if (session) shareWithJellyfinClients(session)
  }, [session])

  // An expired or revoked token ends the session instead of leaving every request failing.
  useEffect(() => {
    if (!session) return
    const id = axios.interceptors.response.use(undefined, (error: unknown) => {
      if (axios.isAxiosError(error) && isRejectedSessionToken(error, session)) {
        saveSession(null)
        queryClient.clear()
        void clearPersistedQueries()
        setSession(null)
      }
      return Promise.reject(error)
    })
    return () => axios.interceptors.response.eject(id)
  }, [session, queryClient])

  const api = useMemo(
    () => (session ? createApi(session.serverUrl, session.accessToken) : null),
    [session],
  )

  const completeSignIn = useCallback((serverUrl: string, result: AuthenticationResult) => {
    if (!result.AccessToken || !result.User?.Id) throw new Error('Unexpected authentication response')
    const next: StoredSession = {
      serverUrl: absoluteServerUrl(serverUrl),
      accessToken: result.AccessToken,
      userId: result.User.Id,
      userName: result.User.Name ?? '',
    }
    queryClient.clear()
    saveSession(next)
    setSession(next)
  }, [queryClient])

  const login = useCallback(
    async (serverUrl: string, username: string, password: string) => {
      const { data } = await getAuthenticationApi(createApi(serverUrl)).authenticateUserByName({
        authenticateUserByName: { Username: username, Pw: password },
      })
      completeSignIn(serverUrl, data)
    },
    [completeSignIn],
  )

  const logout = useCallback(async () => {
    try {
      await api?.logout()
    } catch {
      // The server may already consider the token gone (or be unreachable); signing out locally is what matters.
    } finally {
      saveSession(null)
      // jellyfin-web (the administration, when Lumio fronts Jellyfin) shares this address: signed out there too, or
      // Lumio would take its sign-in over again.
      try {
        localStorage.removeItem('jellyfin_credentials')
      } catch {
        // Storage unavailable.
      }
      queryClient.clear()
      // The data kept for quick starts belongs to the account that signed out.
      void clearPersistedQueries()
      setSession(null)
    }
  }, [api, queryClient])

  const value = useMemo(
    () => ({ session, api, login, completeSignIn, logout }),
    [session, api, login, completeSignIn, logout],
  )
  return <SessionContext value={value}>{children}</SessionContext>
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}

/** For routes that are only rendered when logged in. */
export function useAuthedSession() {
  const { session, api, logout } = useSession()
  if (!session || !api) throw new Error('No active session')
  return { session, api, logout }
}
