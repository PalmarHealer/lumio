import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiBase } from '@/lib/platform'
import { useAuthedSession } from '@/features/auth/session'

/**
 * Talking to the Lumio server (server/), which holds what Jellyfin can't share between users: who follows whom,
 * privacy choices, and what friends play.
 */
export interface SocialPerson {
  id: string
  name: string
  imageTag: string | null
}

export interface SocialPrivacy {
  showPlaylists: boolean
  showFollowing: boolean
  showFollowers: boolean
  shareActivity: boolean
}

export interface SocialActivity {
  itemId: string
  name: string
  subtitle?: string
  context?: string
  contextId?: string
  kind: 'audio' | 'video'
  playing: boolean
  at: number
}

export interface SocialProfile {
  person: SocialPerson
  privacy: Partial<SocialPrivacy>
  followingCount: number
  followerCount: number
  following: SocialPerson[] | null
  followers: SocialPerson[] | null
  followsYou: boolean
  youFollow: boolean
  friend: boolean
  activity: SocialActivity | null
}

export interface FriendActivity {
  user: SocialPerson
  activity: SocialActivity | null
}

/**
 * The Lumio server's API. Lumio always runs with its server, which also serves the app, so this is the same origin's
 * /api (in development Vite passes it on to the local server); the apps use the server signed in to (lib/platform).
 */

/** A picture from another host, relayed (and kept) by the Lumio server: cached like the app's own, drawable on canvases. */
export const relayedImage = (url: string | undefined) => (url ? `${apiBase()}/image?url=${encodeURIComponent(url)}` : undefined)

export function useSocialUrl(): string {
  return apiBase()
}

// ---- the connection, also used outside React (the players report what plays) ----

let connection: { base: string; token: string } | null = null
let sharing = false

export function setSocialConnection(next: typeof connection) {
  connection = next
}

/**
 * A GET to the Lumio server outside React, with the signed-in user's token; null when there is no connection yet (the
 * caller then goes without the server).
 */
export async function lumioGet(path: string): Promise<Response | null> {
  if (!connection) return null
  return fetch(`${connection.base}${path}`, { headers: { Authorization: `MediaBrowser Token="${connection.token}"` } })
}

/** A request with a JSON body (or none) to the Lumio server outside React; null when there is no connection yet. */
export async function lumioSend(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Response | null> {
  if (!connection) return null
  return fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `MediaBrowser Token="${connection.token}"`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** A file to the Lumio server (its bytes as the body, its type as the content type); null when there is no connection yet. */
export async function lumioUpload(path: string, file: Blob): Promise<Response | null> {
  if (!connection) return null
  return fetch(`${connection.base}${path}`, {
    method: 'POST',
    headers: { Authorization: `MediaBrowser Token="${connection.token}"`, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
}

/**
 * Asks an outside service through the Lumio server, which caches the answers for everyone (see the server's relay);
 * straight from the service while there is no connection, or when the server can't help.
 */
export async function relayFetch(service: 'concerts' | 'lastfm' | 'musicbrainz' | 'lyrics' | 'deezer' | 'tmdb', path: string, query: URLSearchParams, direct: string): Promise<Response> {
  const relayed = await lumioGet(`/relay/${service}/${path}?${query}`).catch(() => null)
  if (relayed && (relayed.ok || relayed.status === 404)) return relayed
  return fetch(`${direct}${path}?${query}`)
}

/** A podcast feed (or a chapter list or transcript) through the Lumio server; straight from its host otherwise. */
export async function fetchFeed(url: string): Promise<Response> {
  const relayed = await lumioGet(`/feed?url=${encodeURIComponent(url)}`).catch(() => null)
  if (relayed?.ok) return relayed
  return fetch(url)
}

/** Whether the user shares what they play (the players only report when they do). */
export function setSocialSharing(next: boolean) {
  sharing = next
}

async function call<T>(base: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `MediaBrowser Token="${token}"`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!response.ok) throw new Error(`Lumio server ${response.status}`)
  return (response.status === 204 ? undefined : await response.json()) as T
}

/** Reports what plays now (null when playback stops), for friends to see. Quietly does nothing without the server. */
export function reportActivity(activity: Omit<SocialActivity, 'at'> | null) {
  if (!connection || !sharing) return
  void call(connection.base, connection.token, '/me/activity', { method: 'POST', body: JSON.stringify(activity ?? {}) }).catch(() => undefined)
}

// ---- hooks ----

/** A request to the Lumio server from React, ready from the first render (the connection above is set a moment later). */
export type LumioFetch = (path: string, init?: RequestInit) => Promise<Response>

export function useLumioFetch(): LumioFetch {
  const { session } = useAuthedSession()
  const base = useSocialUrl()
  return (path, init) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `MediaBrowser Token="${session.accessToken}"`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    })
}

function useCaller() {
  const { session } = useAuthedSession()
  const base = useSocialUrl()
  return { base, call: <T,>(path: string, init?: RequestInit) => call<T>(base, session.accessToken, path, init) }
}

export function useSocialMe() {
  const { base, call: request } = useCaller()
  return useQuery({
    queryKey: ['social', 'me', base],
    enabled: !!base,
    staleTime: 60_000,
    retry: false,
    queryFn: () => request<SocialProfile & { friends: SocialPerson[] }>('/me'),
  })
}

export function useSocialProfile(userId: string | undefined) {
  const { base, call: request } = useCaller()
  return useQuery({
    queryKey: ['social', 'user', base, userId],
    enabled: !!base && !!userId,
    staleTime: 30_000,
    retry: false,
    queryFn: () => request<SocialProfile>(`/users/${userId}`),
  })
}

export function useSocialFollow() {
  const { call: request } = useCaller()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, follow }: { userId: string; follow: boolean }) => request<SocialProfile>(`/follows/${userId}`, { method: follow ? 'PUT' : 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['social'] }),
  })
}

export function useSetPrivacy() {
  const { base, call: request } = useCaller()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (privacy: Partial<SocialPrivacy>) => request<SocialPrivacy>('/me/privacy', { method: 'PUT', body: JSON.stringify(privacy) }),
    onMutate: (privacy) =>
      queryClient.setQueryData<SocialProfile>(['social', 'me', base], (me) => (me ? { ...me, privacy: { ...me.privacy, ...privacy } } : me)),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['social'] }),
  })
}

export function useFriendActivity() {
  const { base, call: request } = useCaller()
  return useQuery({
    queryKey: ['social', 'activity', base],
    enabled: !!base,
    staleTime: 60_000,
    retry: false,
    queryFn: () => request<FriendActivity[]>('/friends/activity'),
  })
}

export { call as socialCall }
