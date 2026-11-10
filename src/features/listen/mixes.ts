import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { defineMessages, getLocale, getLocaleTag, messagesFor } from '@/lib/i18n'
import { artistsOf } from '@/lib/item-links'
import { fetchArtistTags } from './external'
import { assemble } from './mix-engine'
import { moodMixes, slugOf, tagMixes } from './mood-mixes'
import type { OfficialPlaylist } from './official'
import type { SoundData } from './sound'
import { artistIdsOf, slotOf, type DayPart, type TasteModel } from './taste-model'

/**
 * The made-for-you mixes, after Spotify's (built from the library and the taste model, see taste-model.ts):
 * - daylist: what the listener plays at this time of the day and week, with a title made of a mood, genres, the weekday
 *   and the part of the day. New six times a day (5, 9, 12, 17, 21 and 1 o'clock).
 * - Daily Mix 1–6: the listener's taste split into groups of artists who sound alike (by their genres), each mostly
 *   known favourites with some deep cuts and new songs nearby. New every day; the group they're in most lately first.
 * - On Repeat: what they can't stop playing now (the last weeks). Repeat Rewind: what they played a lot back then and
 *   not lately. Discoveries: songs they never played, close to their taste, new every Monday. New for you: songs new
 *   in the library by artists and in genres they like, new every Friday. Their phase: when an artist or genre takes a
 *   much bigger share lately, more of it (new songs too), every day.
 * - Genre and decade mixes: their own mix of each, mostly what they love in it with a quarter new to them, weekly.
 * Every mix is the same on all devices for the same day (seeded by the user, the mix and the date).
 */
const DAILY_SIZE = 50
const DAYLIST_SIZE = 40
const MIX_SIZE = 30
const MAX_DAILY_MIXES = 6

export const mixMessages = defineMessages({
  de: {
    dailyTitle: (n: number) => `Daily Mix ${n}`,
    dailyDescription: (names: string[]) => `${names.join(', ')} und mehr`,
    daylistDescription: (genres: string[], next: string) =>
      `${genres.length ? `${genres.join(', ')} – ` : ''}was du um diese Zeit gern hörst, mit ein paar neuen Songs. Neu um ${next}.`,
    daylistWhen: (weekday: number, part: DayPart) =>
      `${part === 5 ? 'späte ' : ''}${['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag'][weekday]}${['morgen', 'vormittag', 'nachmittag', 'abend', 'nacht', 'nacht'][part]}`,
    repeatTitle: 'Auf Repeat',
    repeatDescription: 'Die Songs, von denen du gerade nicht genug bekommst.',
    playsMonth: (n: string) => `${n}× in 30 Tagen`,
    playsMonthLabel: 'Letzte 30 Tage',
    rewindTitle: 'Repeat Rewind',
    rewindDescription: 'Was du früher rauf und runter gehört hast – und lange nicht mehr.',
    discoverTitle: 'Deine Entdeckungen',
    discoverDescription: 'Songs, die du noch nie gehört hast, nah an deinem Geschmack. Jeden Montag neu.',
    radarTitle: 'Neu für dich',
    radarDescription: 'Neu in der Bibliothek, von Künstler*innen und aus Genres, die du magst. Jeden Freitag neu.',
    phaseTitle: (name: string) => `Deine ${name}-Phase`,
    phaseDescription: (name: string) => `Du hörst gerade viel ${name}: hier mehr davon, auch Songs, die du noch nicht kennst.`,
    genreTitle: (genre: string) => `${genre}-Mix`,
    genreDescription: (genre: string) => `${genre}, wie du es magst, mit neuen Songs dazwischen. Jede Woche neu.`,
    decadeTitle: (decade: string) => `${decade}-Mix`,
    decadeDescription: (decade: string) => `Deine ${decade}: Lieblingssongs und Neues aus dem Jahrzehnt. Jede Woche neu.`,
    decadeName: (year: number) => `${String(year).slice(2)}er`,
  },
  en: {
    dailyTitle: (n: number) => `Daily Mix ${n}`,
    dailyDescription: (names: string[]) => `${names.join(', ')} and more`,
    daylistDescription: (genres: string[], next: string) => `${genres.length ? `${genres.join(', ')} – ` : ''}what you like at this time, with a few new songs. Next update at ${next}.`,
    daylistWhen: (weekday: number, part: DayPart) =>
      `${part === 5 ? 'late ' : part === 0 ? 'early ' : ''}${['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][weekday]} ${['morning', 'morning', 'afternoon', 'evening', 'night', 'night'][part]}`,
    repeatTitle: 'On Repeat',
    repeatDescription: "The songs you can't get enough of right now.",
    playsMonth: (n: string) => `${n}× in 30 days`,
    playsMonthLabel: 'Last 30 days',
    rewindTitle: 'Repeat Rewind',
    rewindDescription: "What you played over and over back then – and haven't in a while.",
    discoverTitle: 'Your discoveries',
    discoverDescription: "Songs you've never played, close to your taste. New every Monday.",
    radarTitle: 'New for you',
    radarDescription: 'New in the library, by artists and in genres you like. New every Friday.',
    phaseTitle: (name: string) => `Your ${name} phase`,
    phaseDescription: (name: string) => `You're into ${name} lately: here's more of it, including songs you don't know yet.`,
    genreTitle: (genre: string) => `${genre} Mix`,
    genreDescription: (genre: string) => `${genre} the way you like it, with new songs in between. New every week.`,
    decadeTitle: (decade: string) => `${decade} Mix`,
    decadeDescription: (decade: string) => `Your ${decade}: favourites and new finds from the decade. New every week.`,
    decadeName: (year: number) => `${year}s`,
  },
})

type MixMessages = (typeof mixMessages)['de']

// ---- dates (the listener's own clock) ----

const DAY = 24 * 60 * 60_000

/** A local date as 2026-11-10. */
export function localDate(at: number) {
  return new Date(at).toLocaleDateString('sv')
}

/** The local date of the last given weekday (0 = Monday) on or before a moment: a week that turns over on that day. */
export function weekOf(at: number, startDay: number) {
  const date = new Date(at)
  const weekday = (date.getDay() + 6) % 7
  return localDate(at - ((weekday - startDay + 7) % 7) * DAY)
}

/** When the daylist next turns over (5, 9, 12, 17, 21, 1 o'clock). */
function nextDayPartStart(at: number) {
  const next = new Date(at)
  next.setMinutes(0, 0, 0)
  do next.setHours(next.getHours() + 1)
  while (![1, 5, 9, 12, 17, 21].includes(next.getHours()))
  return next
}

// ---- mood words for the daylist (from Last.fm's tags of the artists played at that time) ----

const MOODS: Array<{ tags: RegExp; de: string; en: string }> = [
  { tags: /^(chill|chillout|chill out|mellow|relaxing|relax|laid back|lounge|downtempo)$/, de: 'entspannt', en: 'chill' },
  { tags: /^(dreamy|dream pop|ethereal|atmospheric|ambient|shoegaze)$/, de: 'verträumt', en: 'dreamy' },
  { tags: /^(melancholic|melancholy|sad|depressive|heartbreak|emotional|emo)$/, de: 'melancholisch', en: 'melancholy' },
  { tags: /^(energetic|upbeat|party|dance|danceable|club|hype)$/, de: 'energiegeladen', en: 'upbeat' },
  { tags: /^(happy|feel good|feelgood|fun|summer|sunny|uplifting)$/, de: 'gut gelaunt', en: 'feel-good' },
  { tags: /^(dark|darkwave|gothic|goth|haunting|sinister)$/, de: 'düster', en: 'dark' },
  { tags: /^(romantic|love|love songs|sensual|sexy)$/, de: 'romantisch', en: 'romantic' },
  { tags: /^(aggressive|heavy|hard|angry|brutal)$/, de: 'wild', en: 'heavy' },
  { tags: /^(groovy|funky|funk|groove)$/, de: 'groovig', en: 'groovy' },
  { tags: /^(acoustic|unplugged|singer-songwriter|folk)$/, de: 'akustisch', en: 'acoustic' },
  { tags: /^(epic|cinematic|soundtrack|orchestral)$/, de: 'episch', en: 'epic' },
  { tags: /^(queer|lgbt|lgbtq|lgbtq\+|gay|lesbian|trans)$/, de: 'queer', en: 'queer' },
]
/** Without tags, a mood that suits the time of day. */
const PART_MOODS: Record<DayPart, { de: string; en: string }> = {
  0: { de: 'sanft', en: 'gentle' },
  1: { de: 'frisch', en: 'fresh' },
  2: { de: 'locker', en: 'easy' },
  3: { de: 'entspannt', en: 'chill' },
  4: { de: 'ruhig', en: 'mellow' },
  5: { de: 'verträumt', en: 'dreamy' },
}

async function moodOf(artistNames: string[], part: DayPart, random: () => number, locale: 'de' | 'en') {
  const tags = (await Promise.all(artistNames.map((name) => fetchArtistTags(name).catch(() => [] as string[])))).flatMap((list) => list.slice(0, 12))
  const scores = MOODS.map((mood) => ({ mood, score: tags.filter((tag) => mood.tags.test(tag)).length })).filter((entry) => entry.score > 0)
  if (!scores.length) return PART_MOODS[part][locale]
  // Among the strongest moods, one by chance (seeded), so the title doesn't always say the same.
  const best = Math.max(...scores.map((entry) => entry.score))
  const top = scores.filter((entry) => entry.score >= best * 0.6)
  return top[Math.floor(random() * top.length)]!.mood[locale]
}

// ---- helpers ----

const sum = (values: Iterable<number>) => {
  let total = 0
  for (const value of values) total += value
  return total
}

function topKeys(map: Map<string, number>, count: number) {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key]) => key)
}

interface Context {
  tracks: BaseItemDto[]
  model: TasteModel
  now: number
  userId: string
  t: MixMessages
}

/** Library artists by id, with a name and their songs. */
function artistIndex(tracks: BaseItemDto[]) {
  const index = new Map<string, { id: string; name: string; tracks: BaseItemDto[] }>()
  for (const track of tracks) {
    const named = new Map([...artistsOf(track), ...(track.AlbumArtists ?? []).map((artist) => ({ id: artist.Id ?? undefined, name: artist.Name ?? '' }))].map((artist) => [artist.id, artist.name]))
    for (const id of artistIdsOf(track)) {
      const entry = index.get(id) ?? { id, name: named.get(id) ?? '', tracks: [] }
      entry.tracks.push(track)
      index.set(id, entry)
    }
  }
  return index
}

// ---- daylist ----

export async function daylist(context: Context, seededRandom: (seed: string) => () => number): Promise<OfficialPlaylist | null> {
  const { tracks, model, now, userId, t } = context
  const at = new Date(now)
  const { part, weekday, slot } = slotOf(at)
  const base = slot - part
  // This slot counts most, the neighbouring day parts and the same part on the other kind of day a little.
  const slotWeight = (track: BaseItemDto) =>
    model.slot(track, slot) + 0.35 * ((part > 0 ? model.slot(track, slot - 1) : 0) + (part < 5 ? model.slot(track, slot + 1) : 0)) + 0.25 * model.slot(track, (base === 0 ? 6 : 0) + part)
  const atThisTime = tracks.filter((track) => model.known(track) && slotWeight(track) > 0.05)
  const thisTime = new Set(atThisTime)
  const enough = atThisTime.length >= 12
  // The genres and artists of this time (or, without enough history, of the listener overall).
  const genres = new Map<string, number>()
  const artists = new Map<string, number>()
  for (const track of enough ? atThisTime : tracks.filter(model.known)) {
    const weight = enough ? slotWeight(track) : model.longRun(track)
    for (const genre of track.Genres ?? []) genres.set(genre, (genres.get(genre) ?? 0) + weight)
    for (const artist of artistsOf(track)) if (artist.name) artists.set(artist.name, (artists.get(artist.name) ?? 0) + weight)
  }
  if (!genres.size && !artists.size) return null
  const total = sum(genres.values()) || 1
  const genreShare = (track: BaseItemDto) => Math.max(0, ...(track.Genres ?? []).map((genre) => (genres.get(genre) ?? 0) / total))
  const topGenres = topKeys(genres, 3)
  const seed = `${userId}:daylist:${localDate(now)}:${part}`
  const familiar = enough ? atThisTime : tracks.filter(model.known)
  const mixed = assemble(
    [
      { tracks: familiar, weight: (track) => model.love(track) * (enough ? Math.log2(1 + 4 * slotWeight(track)) : 1), share: 0.6 },
      { tracks: tracks.filter((track) => model.known(track) && !thisTime.has(track)), weight: (track) => model.love(track) * genreShare(track) * 3, share: 0.25 },
      { tracks: tracks.filter((track) => !model.known(track)), weight: (track) => model.novelty(track) * genreShare(track) * 3, share: 0.15 },
    ],
    { size: DAYLIST_SIZE, seed },
  )
  if (mixed.length < 10) return null
  const locale = getLocale() === 'de' ? 'de' : 'en'
  const mood = await moodOf(topKeys(artists, 4), part, seededRandom(seed), locale)
  const genreWords = topGenres.slice(0, 2).map((genre) => genre.toLowerCase())
  const title = [mood, ...genreWords, t.daylistWhen(weekday, part)].join(' ')
  const next = nextDayPartStart(now).toLocaleTimeString(getLocaleTag(), { hour: '2-digit', minute: '2-digit' })
  return { slug: 'daylist', kind: 'daylist', personal: true, title, description: t.daylistDescription(topGenres, next), tracks: mixed }
}

// ---- Daily Mixes ----

/** Artists' genre profiles (rarer genres count more, so "Pop" doesn't glue everything together). */
function genreVectors(index: ReturnType<typeof artistIndex>, tracks: BaseItemDto[]) {
  const genreCount = new Map<string, number>()
  for (const track of tracks) for (const genre of track.Genres ?? []) genreCount.set(genre, (genreCount.get(genre) ?? 0) + 1)
  const idf = (genre: string) => Math.log(1 + tracks.length / (genreCount.get(genre) ?? 1))
  const vectors = new Map<string, Map<string, number>>()
  for (const [id, entry] of index) {
    const vector = new Map<string, number>()
    for (const track of entry.tracks) for (const genre of track.Genres ?? []) vector.set(genre, (vector.get(genre) ?? 0) + idf(genre) / entry.tracks.length)
    vectors.set(id, vector)
  }
  return vectors
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0
  for (const [key, value] of a) dot += value * (b.get(key) ?? 0)
  const norm = Math.sqrt(sum([...a.values()].map((v) => v * v))) * Math.sqrt(sum([...b.values()].map((v) => v * v)))
  return norm ? dot / norm : 0
}

function addInto(target: Map<string, number>, source: Map<string, number>, weight: number) {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value * weight)
}

export function dailyMixes(context: Context): OfficialPlaylist[] {
  const { tracks, model, now, userId, t } = context
  const index = artistIndex(tracks)
  const vectors = genreVectors(index, tracks)
  const phase = new Set(model.phaseArtists)
  // The artists the listener really knows: some songs heard, loved enough.
  const loved = [...index.values()]
    .map((entry) => ({ ...entry, known: entry.tracks.filter(model.known).length, affinity: model.artist(entry.id) + (phase.has(entry.id) ? 0.5 : 0) }))
    .filter((entry) => entry.known >= 2 && entry.affinity > 0.15)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 80)
  if (loved.length < 3) return []

  // Greedy clustering: each artist joins the group it sounds most like, or opens a new one (up to six).
  const clusters: Array<{ artists: typeof loved; centroid: Map<string, number>; score: number }> = []
  for (const artist of loved) {
    const vector = vectors.get(artist.id) ?? new Map()
    const best = clusters.map((cluster) => ({ cluster, similarity: cosine(vector, cluster.centroid) })).sort((a, b) => b.similarity - a.similarity)[0]
    if (best && (best.similarity >= 0.3 || (clusters.length >= MAX_DAILY_MIXES && best.similarity > 0))) {
      best.cluster.artists.push(artist)
      addInto(best.cluster.centroid, vector, artist.affinity)
      best.cluster.score += artist.affinity + (phase.has(artist.id) ? 1 : 0)
    } else if (clusters.length < MAX_DAILY_MIXES) {
      const centroid = new Map<string, number>()
      addInto(centroid, vector, artist.affinity)
      clusters.push({ artists: [artist], centroid, score: artist.affinity + (phase.has(artist.id) ? 1 : 0) })
    }
  }
  // Groups too small for a mix of their own are left out (their artists still turn up as neighbours).
  const groups = clusters.filter((cluster) => cluster.artists.length >= 2 && sum(cluster.artists.map((artist) => artist.known)) >= 12).sort((a, b) => b.score - a.score)
  const day = localDate(now)
  const used = new Set<string>()
  return groups.map((group, i) => {
    const ids = new Set(group.artists.map((artist) => artist.id))
    const own = group.artists.flatMap((artist) => artist.tracks)
    const nearby = [...index.values()].filter((entry) => !ids.has(entry.id)).map((entry) => ({ entry, similarity: cosine(vectors.get(entry.id) ?? new Map(), group.centroid) }))
    const neighbours = nearby.filter((entry) => entry.similarity >= 0.35)
    const similarity = new Map(neighbours.flatMap(({ entry, similarity }) => entry.tracks.map((track) => [track.Id!, similarity])))
    const mixed = assemble(
      [
        { tracks: own.filter(model.known), weight: model.love, share: 0.7 },
        { tracks: own.filter((track) => !model.known(track)), weight: model.novelty, share: 0.15 },
        { tracks: neighbours.flatMap(({ entry }) => entry.tracks), weight: (track) => (model.known(track) ? 0.5 * model.love(track) : model.novelty(track)) * (similarity.get(track.Id!) ?? 0), share: 0.15 },
      ],
      // A song in one daily mix isn't in the next.
      { size: DAILY_SIZE, seed: `${userId}:daily:${i}:${day}`, exclude: used, maxPerArtist: 7 },
    )
    for (const track of mixed) used.add(track.Id!)
    const lead = group.artists[0]!
    return {
      slug: `daily-${i + 1}`,
      kind: 'daily' as const,
      personal: true,
      artist: { Id: lead.id, Name: lead.name, Type: 'MusicArtist' },
      title: t.dailyTitle(i + 1),
      description: t.dailyDescription(group.artists.slice(0, 3).map((artist) => artist.name)),
      tracks: mixed,
    }
  })
}

// ---- On Repeat, Repeat Rewind, discoveries, new for you, the phase ----

export function onRepeat(context: Context): OfficialPlaylist | null {
  const { tracks, model, t } = context
  const now = tracks.filter((track) => model.love(track) > 0 || model.now(track) > 0).filter((track) => model.month(track) >= 2 || model.now(track) >= 1.5)
  if (now.length < 5) return null
  const list = now.sort((a, b) => model.now(b) + 0.2 * model.month(b) - (model.now(a) + 0.2 * model.month(a))).slice(0, MIX_SIZE)
  const number = new Intl.NumberFormat(getLocaleTag())
  const extras = Object.fromEntries(list.map((track) => [track.Id!, t.playsMonth(number.format(Math.round(model.month(track))))]))
  return { slug: 'month', kind: 'month', personal: true, title: t.repeatTitle, description: t.repeatDescription, tracks: list, ...(model.detailed ? { extras, extraLabel: t.playsMonthLabel } : {}) }
}

export function repeatRewind(context: Context): OfficialPlaylist | null {
  const { tracks, model, now, userId, t } = context
  const back = tracks.filter((track) => model.known(track) && model.now(track) < 0.3 && now - model.lastPlayed(track) > 45 * DAY && model.longRun(track) > 0)
  if (back.length < 8) return null
  const mixed = assemble([{ tracks: back, weight: model.longRun, share: 1 }], { size: MIX_SIZE, seed: `${userId}:rewind:${weekOf(now, 0)}` })
  return { slug: 'rediscover', kind: 'rediscover', personal: true, title: t.rewindTitle, description: t.rewindDescription, tracks: mixed }
}

export function discoveries(context: Context): OfficialPlaylist | null {
  const { tracks, model, now, userId, t } = context
  const fresh = tracks.filter((track) => !model.known(track))
  const lovedArtist = (track: BaseItemDto) => artistIdsOf(track).some((id) => model.artist(id) >= 0.3)
  const mixed = assemble(
    [
      // Deep cuts: songs of artists they love that they never played.
      { tracks: fresh.filter(lovedArtist), weight: model.novelty, share: 0.45 },
      // Further out: artists they hardly know, in genres they like or like the ones they love.
      { tracks: fresh.filter((track) => !lovedArtist(track)), weight: model.novelty, share: 0.55 },
    ],
    { size: MIX_SIZE, seed: `${userId}:discover:${weekOf(now, 0)}`, maxPerArtist: 2, artistGap: 5 },
  )
  if (mixed.length < 10) return null
  return { slug: 'discover', kind: 'discover', personal: true, title: t.discoverTitle, description: t.discoverDescription, tracks: mixed }
}

export function newForYou(context: Context): OfficialPlaylist | null {
  const { tracks, model, now, userId, t } = context
  const recent = tracks.filter((track) => now - (Date.parse(track.DateCreated ?? '') || 0) < 28 * DAY && !model.known(track))
  if (recent.length < 5) return null
  const mixed = assemble([{ tracks: recent, weight: (track) => 0.2 + model.novelty(track), share: 1 }], {
    size: MIX_SIZE,
    seed: `${userId}:radar:${weekOf(now, 4)}`,
    maxPerArtist: 4,
  })
  if (mixed.length < 5) return null
  return { slug: 'radar', kind: 'radar', personal: true, title: t.radarTitle, description: t.radarDescription, tracks: mixed }
}

export function phaseMix(context: Context): OfficialPlaylist | null {
  const { tracks, model, now, userId, t } = context
  const index = artistIndex(tracks)
  const artistId = model.phaseArtists.find((id) => index.has(id))
  const genre = model.phaseGenres[0]
  // A genre phase reads better than one artist (an artist's phase is On Repeat already), unless only the artist shows.
  const name = genre ?? (artistId ? index.get(artistId)!.name : undefined)
  if (!name) return null
  const inPhase = genre ? (track: BaseItemDto) => !!track.Genres?.includes(genre) : (track: BaseItemDto) => artistIdsOf(track).includes(artistId!)
  const pool = tracks.filter(inPhase)
  const mixed = assemble(
    [
      { tracks: pool.filter(model.known), weight: (track) => model.love(track) * (1 + model.now(track)), share: 0.6 },
      { tracks: pool.filter((track) => !model.known(track)), weight: model.novelty, share: 0.4 },
    ],
    { size: MIX_SIZE, seed: `${userId}:phase:${name}:${localDate(now)}` },
  )
  if (mixed.length < 10) return null
  return { slug: 'phase', kind: 'phase', personal: true, title: t.phaseTitle(name), description: t.phaseDescription(name), tracks: mixed }
}

// ---- genre and decade mixes ----

/** A mix of a part of the library: mostly what they love in it, a quarter new to them; just a weighted shuffle for someone new. */
function partMix(context: Context, pool: BaseItemDto[], seed: string) {
  const { model } = context
  return assemble(
    [
      { tracks: pool.filter(model.known), weight: model.love, share: 0.75 },
      { tracks: pool.filter((track) => !model.known(track)), weight: (track) => 0.3 + model.novelty(track), share: 0.25 },
    ],
    { size: MIX_SIZE, seed },
  )
}

const MIN_GENRE = 8
const MIN_DECADE = 20

/** One mix per genre with enough songs, the listener's favourite genres first. */
export function genreMixes(context: Context): OfficialPlaylist[] {
  const { tracks, model, now, userId, t } = context
  const byGenre = new Map<string, BaseItemDto[]>()
  for (const track of tracks) for (const genre of track.Genres ?? []) byGenre.set(genre, [...(byGenre.get(genre) ?? []), track])
  const week = weekOf(now, 0)
  return [...byGenre]
    .filter(([, list]) => list.length >= MIN_GENRE)
    .sort((a, b) => model.genre(b[0]) - model.genre(a[0]) || b[1].length - a[1].length)
    .map(([genre, list]) => ({
      slug: `genre-${slugOf(genre)}`,
      kind: 'genre' as const,
      title: t.genreTitle(genre),
      description: t.genreDescription(genre),
      tracks: partMix(context, list, `${userId}:${genre}:${week}`),
    }))
}

/** One mix per decade with enough songs, those the listener plays most first. */
export function decadeMixes(context: Context): OfficialPlaylist[] {
  const { tracks, model, now, userId, t } = context
  const byDecade = new Map<number, BaseItemDto[]>()
  for (const track of tracks) {
    const year = track.ProductionYear ?? (track.PremiereDate ? new Date(track.PremiereDate).getFullYear() : undefined)
    if (!year || year < 1900) continue
    const decade = Math.floor(year / 10) * 10
    byDecade.set(decade, [...(byDecade.get(decade) ?? []), track])
  }
  const week = weekOf(now, 0)
  const loveOf = (list: BaseItemDto[]) => sum(list.map(model.longRun))
  return [...byDecade]
    .filter(([, list]) => list.length >= MIN_DECADE)
    .sort((a, b) => loveOf(b[1]) - loveOf(a[1]) || b[1].length - a[1].length)
    .map(([decade, list]) => {
      const name = t.decadeName(decade)
      return { slug: `decade-${decade}`, kind: 'decade' as const, title: t.decadeTitle(name), description: t.decadeDescription(name), tracks: partMix(context, list, `${userId}:decade:${decade}:${week}`) }
    })
}

/** All made-for-you mixes, in the order the home page shows them (moods and tags need the songs' sound and tags). */
export async function madeForYou(context: Omit<Context, 't'>, sound: SoundData, seededRandom: (seed: string) => () => number) {
  const full = { ...context, t: messagesFor(mixMessages) }
  const day = await daylist(full, seededRandom).catch(() => null)
  const moodContext = { ...context, sound, day: localDate(context.now), week: weekOf(context.now, 0) }
  return {
    forYou: [day, ...dailyMixes(full), onRepeat(full), discoveries(full), phaseMix(full), newForYou(full), repeatRewind(full)].filter((entry): entry is OfficialPlaylist => !!entry),
    moods: moodMixes(moodContext),
    mixes: [...genreMixes(full), ...decadeMixes(full)],
    tags: tagMixes(moodContext),
  }
}
