import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { defineMessages, getLocale, getLocaleTag, messagesFor } from '@/lib/i18n'
import { artistsOf } from '@/lib/item-links'
import { fetchArtistTags } from './external'
import { assemble } from './mix-engine'
import { moodMixes, NOISE, qualities, rankers, slugOf, tagMixes } from './mood-mixes'
import type { OfficialPlaylist } from './official'
import type { SoundData, SoundFeatures } from './sound'
import { artistIdsOf, slotOf, type DayPart, type TasteModel } from './taste-model'

/**
 * The made-for-you mixes, after Spotify's (built from the library and the taste model, see taste-model.ts):
 * - daylist: what the listener plays at this time of the day and week: the songs of that time and the artists who
 *   belong to it (heard then far more than otherwise), their unheard songs too. Its title says what sets the mix apart
 *   from the listener's usual: a mood (from the songs' tags and their sound), the tags and genres that stand out, the
 *   weekday and the part of the day. New six times a day (5, 9, 12, 17, 21 and 1 o'clock).
 * - Daily Mix 1–6: the listener's taste split into groups of artists who belong together (heard in the same sittings,
 *   sharing genres and Last.fm tags), each mostly known favourites with deep cuts and new songs nearby. New every day;
 *   the group they're in most lately first.
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

const wordsOf = (tag: string) => tag.split(/[\s-]+/).filter(Boolean)

/** What a list of songs is tagged with: each tag and genre (lower case) with the number of songs carrying it. */
function tagCounts(list: BaseItemDto[], sound: SoundData, keep: (tag: string) => boolean) {
  const counts = new Map<string, number>()
  for (const track of list) {
    const { own, artists } = sound.tags(track)
    const tags = new Set([...(track.Genres ?? []).map((genre) => genre.toLowerCase()), ...own.slice(0, 8), ...artists.slice(0, 8)])
    for (const tag of tags) if (keep(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return counts
}

/**
 * How much something stands out in a mix: common in it, and more so than in the listener's usual (so "pop", which is
 * everywhere, gives way to what makes this mix this mix).
 */
function standingOut(inMix: number, mixSize: number, overall: number, overallSize: number) {
  const share = inMix / mixSize
  const lift = share / ((overall + 1) / (overallSize + 1))
  return Math.sqrt(share) * (Math.min(lift, 4) - 0.5)
}

/** The mix's mood: from its songs' tags and how it sounds next to the rest of the library; none when neither says. */
function mixMood(mix: BaseItemDto[], usual: BaseItemDto[], library: BaseItemDto[], sound: SoundData, random: () => number, locale: 'de' | 'en') {
  const scores = new Map<string, number>()
  const add = (word: string, score: number) => {
    if (score > 0) scores.set(word, (scores.get(word) ?? 0) + score)
  }
  const matching = (list: BaseItemDto[], pattern: RegExp) =>
    list.filter((track) => {
      const { own, artists } = sound.tags(track)
      return own.slice(0, 8).some((tag) => pattern.test(tag)) || artists.slice(0, 8).some((tag) => pattern.test(tag))
    }).length
  for (const mood of MOODS) {
    const count = matching(mix, mood.tags)
    if (count >= Math.max(3, mix.length * 0.15)) add(mood[locale], standingOut(count, mix.length, matching(usual, mood.tags), usual.length))
  }
  const measured = mix.map(sound.features).filter((f): f is SoundFeatures => !!f)
  if (measured.length >= 8) {
    const rank = rankers(library.map(sound.features).filter((f): f is SoundFeatures => !!f))
    const all = measured.map((f) => qualities(f, rank))
    const mean = (pick: (q: (typeof all)[number]) => number) => sum(all.map(pick)) / all.length
    const energy = mean((q) => q.energy)
    const major = mean((q) => q.major)
    const pulse = mean((q) => q.pulse)
    // Half is the library's middle; a mix a good way off it sounds like something.
    if (energy >= 0.6) add(locale === 'de' ? 'energiegeladen' : 'upbeat', (energy - 0.5) * 6)
    if (energy <= 0.4) add(locale === 'de' ? 'entspannt' : 'chill', (0.5 - energy) * 6)
    if (major <= 0.42 && energy < 0.5) add(locale === 'de' ? 'melancholisch' : 'melancholy', (0.5 - major) * 6)
    if (major >= 0.58 && pulse >= 0.55) add(locale === 'de' ? 'gut gelaunt' : 'feel-good', (major - 0.5) * 6)
  }
  if (!scores.size) return null
  // Among the strongest moods, one by chance (seeded), so the title doesn't always say the same.
  const best = Math.max(...scores.values())
  const top = [...scores].filter(([, score]) => score >= best * 0.6)
  return top[Math.floor(random() * top.length)]![0]
}

/** The tags and genres that set a mix apart from the listener's usual, strongest first (no two sharing a word). */
function mixWords(mix: BaseItemDto[], usual: BaseItemDto[], sound: SoundData, count: number) {
  const names = new Set(mix.flatMap((track) => [...(track.Artists ?? []), track.AlbumArtist ?? '']).map((name) => name.toLowerCase()))
  const keep = (tag: string) => !NOISE.test(tag) && !names.has(tag) && !MOODS.some((mood) => mood.tags.test(tag))
  const inMix = tagCounts(mix, sound, keep)
  const overall = tagCounts(usual, sound, keep)
  const ranked = [...inMix]
    .filter(([, songs]) => songs >= Math.max(3, mix.length * 0.15))
    .map(([tag, songs]) => ({ tag, score: standingOut(songs, mix.length, overall.get(tag) ?? 0, usual.length) }))
    .sort((a, b) => b.score - a.score)
  const picked: string[] = []
  for (const { tag } of ranked) {
    if (picked.length >= count) break
    const words = wordsOf(tag)
    if (!picked.some((other) => wordsOf(other).some((word) => words.includes(word)))) picked.push(tag)
  }
  return picked
}

export async function daylist(context: Context, sound: SoundData, seededRandom: (seed: string) => () => number): Promise<OfficialPlaylist | null> {
  const { tracks, model, now, userId, t } = context
  const { part, weekday, slot } = slotOf(new Date(now))
  const base = slot - part
  // This slot counts most, the neighbouring day parts and the same part on the other kind of day a little.
  const around = (plays: (slot: number) => number) =>
    plays(slot) + 0.35 * ((part > 0 ? plays(slot - 1) : 0) + (part < 5 ? plays(slot + 1) : 0)) + 0.25 * plays((base === 0 ? 6 : 0) + part)
  const slotWeight = (track: BaseItemDto) => around((at) => model.slot(track, at))
  // The artists of this time: heard now, and a bigger part of this time than of the listener's week. A single song is
  // seldom heard often enough at one time to tell; its artist is (a year of listening: mornings have their own artists,
  // while the same songs come back at any hour).
  const all = (plays: (slot: number) => number) => sum(Array.from({ length: 12 }, (_, at) => plays(at)))
  const totalHere = around(model.slotTotal)
  const totalAll = all(model.slotTotal)
  const artistTimes = new Map<string, number>()
  const artistTime = (id: string) => {
    let value = artistTimes.get(id)
    if (value === undefined) {
      const here = around((at) => model.artistSlot(id, at))
      const overall = all((at) => model.artistSlot(id, at))
      const lift = here > 0 && totalHere > 0 ? here / totalHere / (overall / totalAll) : 0
      // Enough plays to tell (three count half), times how far above their usual share (none at it, 1.5 at twice).
      value = (here / (here + 3)) * Math.max(0, Math.min(2, lift) - 0.5)
      artistTimes.set(id, value)
    }
    return value
  }
  const timeOfArtists = (track: BaseItemDto) => Math.max(0, ...artistIdsOf(track).map(artistTime))
  const timeFit = (track: BaseItemDto) => slotWeight(track) + 2 * timeOfArtists(track)
  const known = tracks.filter(model.known)
  const atThisTime = known.filter((track) => slotWeight(track) > 0.05 || timeOfArtists(track) >= 0.5)
  const thisTime = new Set(atThisTime)
  const enough = atThisTime.length >= 12
  // The genres and artists of this time (or, without enough history, of the listener overall).
  const genres = new Map<string, number>()
  const artists = new Map<string, number>()
  for (const track of enough ? atThisTime : known) {
    const weight = enough ? timeFit(track) : model.longRun(track)
    for (const genre of track.Genres ?? []) genres.set(genre, (genres.get(genre) ?? 0) + weight)
    for (const artist of artistsOf(track)) if (artist.name) artists.set(artist.name, (artists.get(artist.name) ?? 0) + weight)
  }
  if (!genres.size && !artists.size) return null
  const total = sum(genres.values()) || 1
  const genreShare = (track: BaseItemDto) => Math.max(0, ...(track.Genres ?? []).map((genre) => (genres.get(genre) ?? 0) / total))
  const seed = `${userId}:daylist:${localDate(now)}:${part}`
  const mixed = assemble(
    [
      { tracks: enough ? atThisTime : known, weight: (track) => model.love(track) * (enough ? Math.log2(1 + 4 * timeFit(track)) : 1), share: 0.55 },
      { tracks: known.filter((track) => !thisTime.has(track)), weight: (track) => model.love(track) * (genreShare(track) * 3 + timeOfArtists(track)), share: 0.25 },
      // New songs: in this time's genres, and above all by this time's artists.
      { tracks: tracks.filter((track) => !model.known(track)), weight: (track) => model.novelty(track) * (genreShare(track) * 3 + 1.5 * timeOfArtists(track)), share: 0.2 },
    ],
    { size: DAYLIST_SIZE, seed },
  )
  if (mixed.length < 10) return null
  const locale = getLocale() === 'de' ? 'de' : 'en'
  const random = seededRandom(seed)
  // The title describes the mix itself; without tags or measurements, the tags of this time's artists (Last.fm).
  const mood = mixMood(mixed, known, tracks, sound, random, locale) ?? (await moodOf(topKeys(artists, 4), part, random, locale))
  const words = mixWords(mixed, known, sound, 3)
  const title = [mood, ...words.slice(0, 2), t.daylistWhen(weekday, part)].join(' ')
  const next = nextDayPartStart(now).toLocaleTimeString(getLocaleTag(), { hour: '2-digit', minute: '2-digit' })
  return { slug: 'daylist', kind: 'daylist', personal: true, title, description: t.daylistDescription(words, next), tracks: mixed }
}

// ---- Daily Mixes ----

/**
 * Artists' profiles: their genres and their Last.fm tags (rarer ones count more, so "Pop" doesn't glue everything
 * together; the tags tell apart what the library files under one genre).
 */
function genreVectors(index: ReturnType<typeof artistIndex>, tracks: BaseItemDto[], sound: SoundData) {
  const genreCount = new Map<string, number>()
  for (const track of tracks) for (const genre of track.Genres ?? []) genreCount.set(genre, (genreCount.get(genre) ?? 0) + 1)
  const idf = (genre: string) => Math.log(1 + tracks.length / (genreCount.get(genre) ?? 1))
  const vectors = new Map<string, Map<string, number>>()
  for (const [id, entry] of index) {
    const vector = new Map<string, number>()
    for (const track of entry.tracks) for (const genre of track.Genres ?? []) vector.set(genre, (vector.get(genre) ?? 0) + idf(genre) / entry.tracks.length)
    vectors.set(id, vector)
  }
  const tagsOf = (id: string) => sound.artistTags(id).slice(0, 8).filter((tag) => !NOISE.test(tag))
  const tagCount = new Map<string, number>()
  for (const id of index.keys()) for (const tag of tagsOf(id)) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
  for (const [id, vector] of vectors) {
    // Last.fm lists an artist's tags strongest first.
    tagsOf(id).forEach((tag, place) => vector.set(`#${tag}`, Math.log(1 + index.size / (tagCount.get(tag) ?? 1)) * (1 - place / 16)))
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

export function dailyMixes(context: Context, sound: SoundData): OfficialPlaylist[] {
  const { tracks, model, now, userId, t } = context
  const index = artistIndex(tracks)
  const vectors = genreVectors(index, tracks, sound)
  // How much an artist belongs to a group: what they sound like (genres, tags) and whether the listener hears them in
  // the same sittings as the group's artists (the three they're heard with most). Sittings say what labels can't: two
  // artists under one genre the listener never plays together are two groups.
  const belonging = (id: string, group: { artists: Array<{ id: string }>; centroid: Map<string, number> }) => {
    const sounds = cosine(vectors.get(id) ?? new Map(), group.centroid)
    if (!model.heardTogether) return sounds
    const heard = group.artists.map((member) => model.together(id, member.id)).sort((a, b) => b - a).slice(0, 3)
    return Math.min(1, 0.7 * sounds + 0.9 * (heard.length ? sum(heard) / heard.length : 0))
  }
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
    const best = clusters.map((cluster) => ({ cluster, similarity: belonging(artist.id, cluster) })).sort((a, b) => b.similarity - a.similarity)[0]
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
    const nearby = [...index.values()].filter((entry) => !ids.has(entry.id)).map((entry) => ({ entry, similarity: belonging(entry.id, group) }))
    const neighbours = nearby.filter((entry) => entry.similarity >= 0.35)
    const similarity = new Map(neighbours.flatMap(({ entry, similarity }) => entry.tracks.map((track) => [track.Id!, similarity])))
    const mixed = assemble(
      [
        // A third of what the listener played in a year were songs new to them, most by artists they knew: so a fifth
        // deep cuts and a fifth from nearby.
        { tracks: own.filter(model.known), weight: model.love, share: 0.6 },
        { tracks: own.filter((track) => !model.known(track)), weight: model.novelty, share: 0.2 },
        { tracks: neighbours.flatMap(({ entry }) => entry.tracks), weight: (track) => (model.known(track) ? 0.5 * model.love(track) : model.novelty(track)) * (similarity.get(track.Id!) ?? 0), share: 0.2 },
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
      // Deep cuts: songs of artists they love that they never played (new songs by known artists are the ones that
      // get played again: about one in seven three times or more, against one in twelve by artists new to them).
      { tracks: fresh.filter(lovedArtist), weight: model.novelty, share: 0.6 },
      // Further out: artists they hardly know, in genres they like or like the ones they love.
      { tracks: fresh.filter((track) => !lovedArtist(track)), weight: model.novelty, share: 0.4 },
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
  const day = await daylist(full, sound, seededRandom).catch(() => null)
  const moodContext = { ...context, sound, day: localDate(context.now), week: weekOf(context.now, 0) }
  return {
    forYou: [day, ...dailyMixes(full, sound), onRepeat(full), discoveries(full), phaseMix(full), newForYou(full), repeatRewind(full)].filter((entry): entry is OfficialPlaylist => !!entry),
    moods: moodMixes(moodContext),
    mixes: [...genreMixes(full), ...decadeMixes(full)],
    tags: tagMixes(moodContext),
  }
}
