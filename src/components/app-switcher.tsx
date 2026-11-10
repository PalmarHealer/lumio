import { IconCheck, IconChevronDown, IconHeadphones, IconMovie } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Link } from '@/components/link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useBranding } from '@/features/admin/branding'
import { useLocalSettings } from '@/features/settings/local-settings'
import { APP_MODES, modeHome, type AppMode } from '@/lib/app-mode'
import { defineMessages, useMessages } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export const appSwitcherMessages = defineMessages({
  de: {
    switchApp: 'App wechseln',
    watch: 'Filme, Serien und Anime',
    listen: 'Musik, Hörbücher und Podcasts',
  },
  en: {
    switchApp: 'Switch app',
    watch: 'Films, series and anime',
    listen: 'Music, audiobooks and podcasts',
  },
})

/** Each app's mark: its own icon on its own color, so the two read as sibling products (like Photoshop and After Effects). */
export const MODE_STYLE: Record<AppMode, { icon: typeof IconMovie; tile: string; text: string }> = {
  watch: { icon: IconMovie, tile: 'bg-linear-to-br from-rose-500 to-orange-500', text: 'text-rose-400' },
  listen: { icon: IconHeadphones, tile: 'bg-linear-to-br from-listen to-teal-800', text: 'text-listen' },
}

export function ModeTile({ mode, className }: { mode: AppMode; className?: string }) {
  const { icon: Icon, tile } = MODE_STYLE[mode]
  return (
    <span aria-hidden className={cn('grid size-6 shrink-0 place-items-center rounded-md text-white shadow-sm', tile, className)}>
      <Icon className="size-[60%]" stroke={2.25} />
    </span>
  )
}

/**
 * The brand plus the app it is in ("Lumio · Watch"), which also switches to the other app. The brand itself leads to
 * the app's start page; the label next to it opens the switcher. With only one app enabled it is just the brand.
 */
export function AppBrand({ mode, className, collapsibleName }: { mode: AppMode; className?: string; collapsibleName?: boolean }) {
  const t = useMessages(appSwitcherMessages)
  const navigate = useNavigate()
  const { appName, logo, modeLabel, modeLogo, hideName } = useBranding(mode)
  const { settings } = useLocalSettings()
  const switchable = settings.apps === 'both'
  const [open, setOpen] = useState(false)
  const { root, name, nameHidden } = useCollapsingName(!!collapsibleName, appName)
  const pick = (entry: AppMode) => {
    setOpen(false)
    // The other app opens on its start page, not where it was left.
    if (entry !== mode) void navigate(modeHome(entry))
  }

  return (
    <div ref={root} className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <Link to={modeHome(mode)} className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${appName} ${modeLabel}`}>
        {modeLogo ? (
          <img src={modeLogo} alt="" className="h-7 w-auto min-w-0 max-w-44 object-contain" />
        ) : logo ? (
          <img src={logo} alt="" className="h-7 w-auto min-w-0 max-w-40 object-contain" />
        ) : hideName ? (
          // Only the app's own mark; its name follows as the switcher.
          <ModeTile mode={mode} />
        ) : (
          <>
            <ModeTile mode={mode} />
            {!nameHidden && (
              <span ref={name} className="truncate">
                {appName}
              </span>
            )}
          </>
        )}
      </Link>
      {switchable ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={t.switchApp}
            title={t.switchApp}
            className={cn(
              'flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-lg font-semibold tracking-tight outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
              MODE_STYLE[mode].text,
            )}
          >
            {/* An app's own logo already says which app it is: then only the arrow opens the switcher. */}
            {!modeLogo && modeLabel}
            <IconChevronDown className="size-4 opacity-70" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1.5">
            {APP_MODES.map((entry) => (
              <ModeEntry key={entry} mode={entry} current={entry === mode} description={t[entry]} onPick={() => pick(entry)} />
            ))}
          </PopoverContent>
        </Popover>
      ) : (
        !modeLogo && <span className={cn('text-lg font-semibold tracking-tight', MODE_STYLE[mode].text)}>{modeLabel}</span>
      )}
    </div>
  )
}

/** A truncated name is dropped once only a couple of letters would be left. */
const MIN_VISIBLE_CHARS = 3.5
/** Extra room the brand needs before the name comes back (so it doesn't flicker at the edge). */
const SHOW_AGAIN_PX = 12

/**
 * For brands in a resizable space (Listen's sidebar): as it narrows, the instance name truncates, and once only a
 * couple of letters would show it disappears and only the app's name stays ("Listen"). It returns when there is room.
 */
function useCollapsingName(enabled: boolean, appName: string) {
  const root = useRef<HTMLDivElement>(null)
  const name = useRef<HTMLSpanElement>(null)
  const [nameHidden, setNameHidden] = useState(false)
  // How wide the surrounding space was when the name was dropped.
  const hiddenAt = useRef(0)
  useEffect(() => {
    const space = root.current?.parentElement
    if (!enabled || !space) return
    const observer = new ResizeObserver(() => {
      const element = name.current
      if (element) {
        const visibleChars = (appName.length * element.clientWidth) / Math.max(1, element.scrollWidth)
        if (element.scrollWidth > element.clientWidth && visibleChars < MIN_VISIBLE_CHARS) {
          hiddenAt.current = space.clientWidth
          setNameHidden(true)
        }
      } else if (space.clientWidth >= hiddenAt.current + SHOW_AGAIN_PX) setNameHidden(false)
    })
    observer.observe(space)
    return () => observer.disconnect()
  }, [enabled, appName, nameHidden])
  return { root, name, nameHidden: enabled && nameHidden }
}

export function ModeEntry({ mode, current, description, onPick }: { mode: AppMode; current: boolean; description: string; onPick: () => void }) {
  const { appName, modeLabel } = useBranding(mode)
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={current}
      className="flex w-full items-center gap-3 rounded-lg p-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
    >
      <ModeTile mode={mode} className="size-10 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">
          {appName} <span className={MODE_STYLE[mode].text}>{modeLabel}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
      {current && <IconCheck className="size-4 shrink-0 text-muted-foreground" />}
    </button>
  )
}
