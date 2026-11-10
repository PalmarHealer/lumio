import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

/** How long one try may take before the next one (http after https) is made. */
const TRY_MS = 5000

/** Whether a Jellyfin server (or Lumio in front of one) answers at this address. */
async function answers(url: string) {
  try {
    const response = await fetch(`${url}/System/Info/Public`, { signal: AbortSignal.timeout(TRY_MS) })
    if (!response.ok) return false
    const info = (await response.json()) as { Id?: unknown }
    return typeof info?.Id === 'string'
  } catch {
    return false
  }
}

/**
 * The server address as typed, made whole: with a scheme it stays as it is; without one ("jelly.example.org"),
 * https:// is tried first and http:// when that doesn't answer (https when neither does, so the error says why).
 */
export async function resolveServerAddress(typed: string): Promise<{ address: string; reachable: boolean }> {
  const value = typed.trim().replace(/\/+$/, '')
  if (!value) return { address: '', reachable: false }
  if (/^https?:\/\//i.test(value)) return { address: value, reachable: await answers(value) }
  for (const scheme of ['https', 'http']) {
    if (await answers(`${scheme}://${value}`)) return { address: `${scheme}://${value}`, reachable: true }
  }
  return { address: `https://${value}`, reachable: false }
}

/**
 * The address being typed, resolved a moment after typing stops ('' while that runs), and whether a Jellyfin server
 * answers there.
 */
export function useServerAddress(typed: string) {
  const [settled, setSettled] = useState(typed)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(typed), 500)
    return () => window.clearTimeout(timer)
  }, [typed])
  const resolved = useQuery({
    queryKey: ['server-address', settled.trim()],
    queryFn: () => resolveServerAddress(settled),
    enabled: !!settled.trim(),
    staleTime: Infinity,
    retry: false,
  })
  if (typed !== settled) return { address: '', reachable: false, resolving: true }
  return { address: resolved.data?.address ?? '', reachable: resolved.data?.reachable ?? false, resolving: resolved.isFetching }
}
