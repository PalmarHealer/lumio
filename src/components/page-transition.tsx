import { useLayoutEffect, type ReactNode } from 'react'
import { useLocation, useNavigationType } from 'react-router'

const supportsViewTransitions = typeof document !== 'undefined' && 'startViewTransition' in document

/**
 * Sections with their own navigation: moving between their sub-pages keeps the frame and only swaps the content. The
 * player is one too: on to the next episode, its fullscreen frame must stay (a new one would end the fullscreen).
 */
const SECTIONS = ['/settings', '/listen/wrapped', '/play']

/** Scroll positions of pages left, by history entry, for frames that scroll in a panel of their own (Listen). */
const positions = new Map<string, number>()

/** The frame's scrolling panel, where it has one (`data-scroll-root`); otherwise the window scrolls. */
export const scrollRoot = () => document.querySelector<HTMLElement>('[data-scroll-root]')

const pageKey = (pathname: string) => SECTIONS.find((section) => pathname === section || pathname.startsWith(`${section}/`)) ?? pathname

/**
 * Pages animate in with a CSS fade, except when a link already runs a View Transition (forward navigation in browsers
 * that support it), which would double up. Also resets scroll on forward navigation; back/forward keep the position.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname, key, state } = useLocation()
  // An overlay opened or closed over the page (Wrapped's story): the page underneath stays where it was.
  const keepScroll = !!(state as { keepScroll?: boolean } | null)?.keepScroll
  const navigationType = useNavigationType()

  useLayoutEffect(() => {
    const root = scrollRoot()
    if (!root) {
      if (navigationType !== 'POP' && !keepScroll) window.scrollTo(0, 0)
      return
    }
    // Remembered while scrolling: by the time the page is left, the next one may already have cut the panel short.
    const remember = () => positions.set(key, root.scrollTop)
    root.addEventListener('scroll', remember, { passive: true })
    let frame = 0
    // The browser only restores the window's position; a panel's is put back here, once the page is tall enough
    // (its content may still be loading), for at most a couple of seconds.
    if (navigationType === 'POP') {
      const top = positions.get(key) ?? 0
      const until = performance.now() + 2500
      const restore = () => {
        root.scrollTo(0, top)
        if (Math.abs(root.scrollTop - top) > 1 && performance.now() < until) frame = requestAnimationFrame(restore)
      }
      restore()
    } else if (keepScroll) positions.set(key, root.scrollTop)
    else root.scrollTo(0, 0)
    // Scrolling by hand while it waits for the page means the user is elsewhere already: stop restoring.
    const stop = () => cancelAnimationFrame(frame)
    root.addEventListener('wheel', stop, { passive: true })
    root.addEventListener('touchstart', stop, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('scroll', remember)
      root.removeEventListener('wheel', stop)
      root.removeEventListener('touchstart', stop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const viewTransitionRuns = supportsViewTransitions && navigationType === 'PUSH'
  return (
    <div key={pageKey(pathname)} className={viewTransitionRuns ? undefined : 'animate-page-in'}>
      {children}
    </div>
  )
}
