import '@fontsource/archivo-black/latin-400.css'
import '@fontsource/figtree/latin-900.css'
import './wrapped.css'
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { FadeImage } from '@/components/media/fade-image'
import { useAuthedSession } from '@/features/auth/session'
import { useItem } from '@/features/items/queries'
import { useArtistPhoto } from '@/features/listen/artist-photo'
import { useArtistLookup } from '@/features/listen/credits'
import { getLocaleTag, useLocale } from '@/lib/i18n'
import { portraitImageUrl } from '@/lib/images'
import { cn } from '@/lib/utils'
import type { Look, Series, Spot, Topic } from './deck'
import { inLibrary, useSpotifyCover, type Wrapped, type WrappedTrack } from './wrapped-data'

/**
 * What every Wrapped slide is made of: its props, and the pieces they share (entrances, counters, pictures of songs,
 * albums and artists, the year's headline face). The slides themselves are in ./slides, one per file.
 */
export type Palette = Look['palettes'][number]

export interface SlideProps {
  data: Wrapped
  look: Look
  /** This slide's colors (the look's palettes in turn). */
  palette: Palette
  /** The slide is the one shown (counters and the like start then). */
  active: boolean
  /** A spotlight's place of its ranking (null for the other slides). */
  spot: Spot | null
}

export interface WrappedSlide {
  /** Stable: it decides which years show the slide. */
  id: string
  topic: Topic
  /** The first year it may be drawn for: a slide added later names the coming year, so years already out stay. */
  since?: number
  /** false: the slide brings its own full background (no moving backdrop behind it). */
  backdrop?: boolean
  /** The color of text on that background (for the progress bars over it), when it isn't the year's. */
  ink?: string
  /** A spotlight (topic `spotlight`): the rankings it can show a place of; it gets that place as `spot`. */
  series?: Series[]
  /**
   * A special (topic `special`): how much the year stands out for it, 1 being just enough for the slide (below: left
   * out). The story takes the two strongest.
   */
  special?: (data: Wrapped) => number
  /** A special: the topic it follows (at the end of that topic's part of the story when the topic isn't shown). */
  after?: Topic
  Component: (props: SlideProps) => ReactNode
}

/** A date format that gives nothing for a date that isn't one, instead of throwing (and taking the story down). */
function dates(locale: string, options: Intl.DateTimeFormatOptions) {
  const format = new Intl.DateTimeFormat(locale, options)
  return { format: (value: Date | number | undefined) => (value !== undefined && Number.isFinite(new Date(value).getTime()) ? format.format(value) : '') }
}

export function useFormats() {
  const locale = getLocaleTag(useLocale())
  return {
    locale,
    number: new Intl.NumberFormat(locale),
    compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    day: dates(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }),
    /** A moment's day in the viewer's own time zone (when a play started). */
    localDay: dates(locale, { day: 'numeric', month: 'long' }),
    weekday: dates(locale, { weekday: 'long', timeZone: 'UTC' }),
    month: dates(locale, { month: 'long', timeZone: 'UTC' }),
    shortMonth: dates(locale, { month: 'short', timeZone: 'UTC' }),
  }
}

/** A "YYYY-MM-DD" date as a Date (UTC midnight; format it in UTC). */
export const dateOf = (value: string) => new Date(`${value}T00:00:00Z`)

/** The class for the year's headline face. */
export function displayClass(look: Look) {
  return look.display === 'wide'
    ? 'font-[Archivo_Black] tracking-tight uppercase'
    : look.display === 'serif'
      ? 'font-serif italic font-black tracking-tight'
      : 'font-extrabold tracking-tighter'
}

/** The slide's content area: clear of the progress bars on top and the edge below. */
export function Body({ className, style, children }: { className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={cn('relative z-10 flex h-full flex-col px-7 pt-[calc(max(0.75rem,var(--safe-top))+4.5rem)] pb-[max(2.5rem,var(--safe-bottom))]', className)} style={style}>
      {children}
    </div>
  )
}

/** A headline in the year's face; plain text pops in word by word. */
export function Headline({ look, className, delay = 0, children }: { look: Look; className?: string; delay?: number; children: ReactNode }) {
  return (
    <p className={cn('leading-[0.95]', displayClass(look), className)}>
      {typeof children === 'string' ? <Stagger text={children} delay={delay} step={80} /> : children}
    </p>
  )
}

/** The slide's own background and text color (a palette may be a gradient). */
export function paletteStyle(palette: Palette): CSSProperties {
  return { background: palette.background, color: palette.color }
}

/** The relative luminance of a "#rrggbb" color (WCAG). */
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The contrast of two colors (1 to 21); for a gradient background, against its weakest color. */
export function contrast(color: string, background: string) {
  const backgrounds = background.match(/#[0-9a-f]{6}/gi) ?? ['#000000']
  return Math.min(
    ...backgrounds.map((other) => {
      const [light, dark] = [luminance(color), luminance(other)].sort((a, b) => b - a)
      return (light! + 0.05) / (dark! + 0.05)
    }),
  )
}

/** Text set on the accent: black or white, whichever reads better. */
export const onAccent = (palette: Palette) => (contrast('#111111', palette.accent) >= contrast('#ffffff', palette.accent) ? '#111111' : '#ffffff')

/**
 * The accent as a text color where it reads on the slide (3:1, for the large type it is used for), else the text color.
 * `on` is the color behind it, when that isn't the slide's own.
 */
export const accentText = (palette: Palette, on = palette.background) => (contrast(palette.accent, on) >= 3 ? palette.accent : palette.color)

const reducedMotion =() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Counts up to `value` once shown (the big numbers). */
/** The story is paused (held, or Space): a slide's own moving parts stand still too, like its CSS animations. */
export const PausedContext = createContext(false)

/** Whether the story is paused, as a ref (for animation loops that keep running and only skip their steps). */
export function usePausedRef() {
  const paused = useContext(PausedContext)
  const ref = useRef(paused)
  useEffect(() => {
    ref.current = paused
  }, [paused])
  return ref
}

/** Counts up to `value` once shown (the big numbers); a pause holds it where it is. */
export function useCountUp(value: number, active: boolean, ms = 1400, delay = 0) {
  const [shown, setShown] = useState(0)
  const still = reducedMotion()
  const paused = usePausedRef()
  useEffect(() => {
    if (!active || still) return
    // Time counted only while not paused.
    let elapsed = -delay
    let previous = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      if (!paused.current) elapsed += now - previous
      previous = now
      const progress = Math.max(0, Math.min(1, elapsed / ms))
      setShown(Math.round(value * (1 - Math.pow(1 - progress, 3))))
      if (progress < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [value, active, ms, delay, still, paused])
  return still ? value : shown
}

type Entrance = 'rise' | 'fall' | 'left' | 'right' | 'zoom' | 'fade' | 'spin'

const ENTRANCES: Record<Entrance, string> = {
  rise: 'slide-in-from-bottom-16',
  fall: 'slide-in-from-top-16',
  left: 'slide-in-from-left-24',
  right: 'slide-in-from-right-24',
  zoom: 'zoom-in-0',
  fade: '',
  spin: 'spin-in-45 zoom-in-0',
}

/** Comes in (from below by default) after `delay` ms. */
export function In({ delay = 0, from = 'rise', className, style, children }: { delay?: number; from?: Entrance; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={cn('wrapped-spring animate-in fade-in-0 duration-700 fill-mode-both', ENTRANCES[from], className)} style={{ animationDelay: `${delay}ms`, ...style }}>
      {children}
    </div>
  )
}

/** A line of text whose words (or letters) come in one after another. */
export function Stagger({ text, by = 'word', delay = 0, step = 70, className }: { text: string; by?: 'word' | 'letter'; delay?: number; step?: number; className?: string }) {
  const parts = by === 'word' ? text.split(/(\s+)/) : [...text]
  // Each visible part's place in the order (spaces don't count).
  const order = parts.map((_, position) => parts.slice(0, position).filter((part) => !/^\s+$/.test(part)).length)
  return (
    <span className={className} aria-label={text}>
      {parts.map((part, position) =>
        /^\s+$/.test(part) ? (
          <span key={position}>{part}</span>
        ) : (
          <span
            key={position}
            aria-hidden
            className="wrapped-pop inline-block"
            style={{ animationDelay: `${delay + order[position]! * step}ms` }}
          >
            {part}
          </span>
        ),
      )}
    </span>
  )
}

/** Text running across the slide without end (both directions with `reverse`). */
export function Marquee({ text, reverse, className, speed = 18 }: { text: string; reverse?: boolean; className?: string; speed?: number }) {
  const line = `${text} · `.repeat(6)
  return (
    <div aria-hidden className={cn('overflow-hidden whitespace-nowrap', className)}>
      <div className={cn('inline-block', reverse ? 'wrapped-marquee-reverse' : 'wrapped-marquee')} style={{ animationDuration: `${speed}s` }}>
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  )
}

/** A picture (cover or photo) or, without one, a shape in the slide's accent. */
export function Picture({ src, round, className, style }: { src: string | undefined; round?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn('overflow-hidden bg-black/20 shadow-2xl', round ? 'rounded-full' : 'rounded-md', className)} style={style}>
      {src && <FadeImage key={src} src={src} alt="" className="size-full object-cover" draggable={false} />}
    </div>
  )
}

/** A little film grain over the slide (looks that want it). */
export function Grain() {
  return <div aria-hidden className="wrapped-grain pointer-events-none absolute inset-0 z-0 opacity-[0.12] mix-blend-overlay" />
}

/** A song's cover: the library's song, or its album; else Spotify's for a song imported from there. */
export function useTrackCover(track: Pick<WrappedTrack, 'key' | 'contextId'> | null | undefined, size = 480) {
  const { api } = useAuthedSession()
  const own = useItem(track?.key ?? '', inLibrary(track?.key))
  const album = useItem(track?.contextId ?? '', !own.data && inLibrary(track?.contextId))
  const spotify = useSpotifyCover(track?.key)
  const item = own.data ?? album.data
  return item ? portraitImageUrl(api, item, { fillHeight: size }) : spotify
}

/** An album's cover and names: the library's, else from one of its songs (Spotify's, for one only known from there). */
export function useAlbum(album: Wrapped['topAlbums'][number] | undefined, size = 480) {
  const { api } = useAuthedSession()
  const own = useItem(album?.key ?? '', inLibrary(album?.key))
  const sample = useTrackCover(own.data ? undefined : album && { key: album.sampleKey, contextId: null }, size)
  return {
    cover: own.data ? portraitImageUrl(api, own.data, { fillHeight: size }) : sample,
    name: own.data?.Name ?? album?.name ?? '',
    artist: own.data?.AlbumArtist ?? album?.artist ?? null,
  }
}

/** An artist's photo: the library's artist when there is one, else one from outside. */
export function useArtistImage(name: string | undefined, size = 480) {
  const lookup = useArtistLookup(name ? [name] : [])
  const id = name ? lookup(name).id : undefined
  const item = useItem(id ?? '', !!id)
  const artist: BaseItemDto = item.data ?? { Name: name, Type: 'MusicArtist' }
  return useArtistPhoto(name ? artist : undefined, size)
}

/** The part of the day with the most music: morning 5–11, afternoon 11–17, evening 17–22, night 22–5. */
export function partOfDay(hours: number[]) {
  const parts = { morning: [5, 11], afternoon: [11, 17], evening: [17, 22], night: [22, 29] } as const
  return Object.entries(parts)
    .map(([name, [from, to]]) => {
      let sum = 0
      for (let hour = from; hour < to; hour++) sum += hours[hour % 24] ?? 0
      return { name: name as keyof typeof parts, sum: sum / (to - from) }
    })
    .sort((a, b) => b.sum - a.sum)[0]!.name
}

/** Minutes as hours or days, when that says more. */
export function inHours(minutes: number) {
  return { hours: Math.round(minutes / 60), days: Math.round((minutes / 60 / 24) * 10) / 10 }
}

/** One place of a ranking, whichever ranking: what a spotlight slide shows. */
export interface Subject {
  series: Series
  /** 0 for the top. */
  rank: number
  name: string
  /** The artist of a song or album. */
  by: string | null
  minutes: number
  plays: number
  /** Minutes in each month (January first); all zeros from an older server. */
  months: number[]
  /** The month heard most in (0 = January), or null without months. */
  peakMonth: number | null
  /** How many different songs (of an artist or album); 0 when unknown. */
  tracks: number
  /** The artist's photo or the song's or album's cover. */
  image: string | undefined
  /** An artist (round pictures suit them). */
  person: boolean
}

/** A spotlight's place of its ranking, with its picture. */
export function useSubject(data: Wrapped, spot: Spot | null, size = 480): Subject {
  const series = spot?.series ?? 'artists'
  const rank = spot?.rank ?? 0
  const artist = series === 'artists' ? data.topArtists[rank] : undefined
  const track = series === 'songs' ? data.topTracks[rank] : undefined
  const albumEntry = series === 'albums' ? data.topAlbums[rank] : undefined
  const photo = useArtistImage(artist?.name, size)
  const cover = useTrackCover(track, size)
  const album = useAlbum(albumEntry, size)
  const entry = artist ?? track ?? albumEntry
  const months = entry?.months?.length === 12 ? entry.months : Array<number>(12).fill(0)
  const max = Math.max(...months)
  return {
    series,
    rank,
    name: artist?.name ?? track?.title ?? album.name,
    by: track?.artist ?? (albumEntry ? album.artist : null),
    minutes: entry?.minutes ?? 0,
    plays: entry?.plays ?? 0,
    months,
    peakMonth: max > 0 ? months.indexOf(max) : null,
    tracks: artist?.tracks ?? albumEntry?.tracks ?? 0,
    image: artist ? photo : track ? cover : album.cover,
    person: series === 'artists',
  }
}

/** A closed, smooth line through the points (Catmull-Rom as Bézier curves). */
export function smoothLoop(points: Array<[number, number]>) {
  const at = (index: number) => points[(index + points.length) % points.length]!
  let path = `M ${at(0)[0]} ${at(0)[1]}`
  for (let index = 0; index < points.length; index++) {
    const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    path += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`
  }
  return `${path} Z`
}

/**
 * Each month's number one among the year's top artists (null for a month without them): who wore the crown when.
 * From the top artists' months, so a month's real number one may be missing when they weren't in the year's top ten.
 */
export function monthlyCrowns(data: Wrapped) {
  return Array.from({ length: 12 }, (_, month) => {
    let best: Wrapped['topArtists'][number] | null = null
    for (const artist of data.topArtists) if ((artist.months[month] ?? 0) > (best?.months[month] ?? 0)) best = artist
    return best && (best.months[month] ?? 0) > 0 ? { name: best.name, minutes: best.months[month]! } : null
  })
}
