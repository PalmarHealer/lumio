import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { defineMessages, messagesFor } from '@/lib/i18n'
import { assemble } from './mix-engine'
import type { OfficialPlaylist } from './official'
import type { SoundData, SoundFeatures } from './sound'
import type { TasteModel } from './taste-model'

/**
 * Mood mixes (running, cozy, sad, motivation, good mood) and tag mixes (Last.fm's tags of songs and artists: queer
 * artists, female vocalists, a scene …).
 * - A song's mood comes from its sound (tempo, energy, major or minor, beat, brightness), its tags and the artists'
 *   tags, and from when the listener plays it (cozy songs are what they play in the evening, motivation in the
 *   morning). Without a measurement only the tags count.
 * - Each mood mix: two thirds songs the listener loves that fit best, a third new songs that fit; new every day.
 * - Tag mixes: one per tag with enough songs in the library (queer tags gathered into one), weekly; tags that are just
 *   the library's genres or say nothing ("seen live", "favourites") are left out.
 */
const MOOD_SIZE = 40
const TAG_SIZE = 30
const MIN_MOOD = 15
const MIN_TAG = 12
const MAX_TAG_MIXES = 24

export const moodMessages = defineMessages({
  de: {
    running: 'Laufen',
    runningDescription: 'Schnelle, treibende Songs im Lauftempo (160–180 BPM). Jeden Tag neu.',
    cozy: 'Gemütlich',
    cozyDescription: 'Warm, ruhig und weich – zum Einkuscheln. Jeden Tag neu.',
    sad: 'Traurig',
    sadDescription: 'Für Tage, an denen es weh tun darf. Jeden Tag neu.',
    motivation: 'Motivation',
    motivationDescription: 'Kraftvoll, hell, nach vorn. Jeden Tag neu.',
    upbeat: 'Gute Laune',
    upbeatDescription: 'Fröhlich, tanzbar, voller Energie. Jeden Tag neu.',
    queer: 'Queer Voices',
    queerDescription: 'Queere Künstler*innen und Songs aus der Bibliothek, nach den Tags auf Last.fm. Jede Woche neu.',
    tagDescription: (tag: string) => `Songs mit dem Tag „${tag}“ auf Last.fm, wie du sie magst. Jede Woche neu.`,
  },
  en: {
    running: 'Running',
    runningDescription: 'Fast, driving songs at running pace (160–180 BPM). New every day.',
    cozy: 'Cozy',
    cozyDescription: 'Warm, calm and soft – to curl up with. New every day.',
    sad: 'Sad',
    sadDescription: 'For days when it may hurt. New every day.',
    motivation: 'Motivation',
    motivationDescription: 'Powerful, bright, forward. New every day.',
    upbeat: 'Good vibes',
    upbeatDescription: 'Happy, danceable, full of energy. New every day.',
    queer: 'Queer Voices',
    queerDescription: 'Queer artists and songs from the library, by their Last.fm tags. New every week.',
    tagDescription: (tag: string) => `Songs tagged "${tag}" on Last.fm, the way you like them. New every week.`,
  },
})

// ---- the sound, as 0–1 qualities ----

const clamp = (value: number) => Math.max(0, Math.min(1, value))
/** How near a value is to a centre (1 there, about 0.6 one width away). */
const near = (value: number, centre: number, width: number) => Math.exp(-0.5 * ((value - centre) / width) ** 2)

/**
 * Where a song stands in the library (0–1, by rank): today's masters are all loud and bright, so only the comparison
 * with the other songs tells the calm ones from the driving ones.
 */
export function rankers(features: SoundFeatures[]) {
  const ranker = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return (value: number) => {
      if (sorted.length < 20) return 0.5
      let low = 0
      let high = sorted.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (sorted[mid]! < value) low = mid + 1
        else high = mid
      }
      return low / sorted.length
    }
  }
  return {
    loud: ranker(features.map((f) => f.loudness)),
    bright: ranker(features.map((f) => f.brightness)),
    busy: ranker(features.map((f) => f.onsets)),
    build: ranker(features.map((f) => f.dynamics)),
    pulse: ranker(features.map((f) => f.pulse)),
  }
}

export type Rankers = ReturnType<typeof rankers>

export function qualities(f: SoundFeatures, rank: Rankers) {
  const bright = rank.bright(f.brightness)
  const energy = 0.5 * rank.loud(f.loudness) + 0.3 * rank.busy(f.onsets) + 0.2 * bright
  // Major and clearly so reads happier; an unclear key says little either way.
  const major = f.minor ? 0.5 - 0.5 * f.keyClarity : 0.5 + 0.5 * f.keyClarity
  // Quiet-loud movement (builds, drops) carries the epic, "motivation" feel.
  return { energy, bright, major, build: rank.build(f.dynamics), pulse: rank.pulse(f.pulse), bpm: f.bpm }
}

type Mood = 'running' | 'cozy' | 'sad' | 'motivation' | 'upbeat'

interface MoodSpec {
  sound: (q: ReturnType<typeof qualities>) => number
  tags: RegExp
  /** How much each slot of the week (see slotOf) speaks for it, when the listener plays a song then. */
  slots?: number[]
}

const MOODS: Record<Mood, MoodSpec> = {
  running: {
    // Running pace, or half of it counted double (a 85 BPM half-time beat runs at 170).
    sound: (q) => 0.4 * Math.max(near(q.bpm, 170, 12), 0.8 * near(q.bpm * 2, 170, 12)) + 0.3 * q.energy + 0.3 * q.pulse,
    tags: /^(running|workout|gym|training|cardio|drum and bass|dnb|hardstyle|energetic|power)$/,
  },
  cozy: {
    sound: (q) => 0.35 * (1 - q.energy) + 0.2 * near(q.bpm, 85, 20) + 0.15 * (1 - q.bright) + 0.15 * (1 - q.pulse) + 0.15 * (0.5 + 0.5 * q.major),
    tags: /^(cozy|cosy|chill|chillout|mellow|acoustic|lo-fi|lofi|soft|relaxing|calm|singer-songwriter|folk|jazz|coffee|rainy day|winter|warm|bedroom pop)$/,
    slots: [0, 0, 0, 0.6, 1, 0.8, 0.3, 0.2, 0.2, 0.8, 1, 0.8],
  },
  sad: {
    sound: (q) => 0.35 * (1 - q.major) + 0.3 * (1 - q.energy) + 0.15 * near(q.bpm, 75, 20) + 0.1 * (1 - q.pulse) + 0.1 * (1 - q.bright),
    tags: /^(sad|melancholic|melancholy|heartbreak|depressing|depressive|emotional|breakup|sad songs|tearjerker|grief|lonely)$/,
    slots: [0, 0, 0, 0.3, 0.8, 1, 0, 0, 0, 0.3, 0.8, 1],
  },
  motivation: {
    sound: (q) => 0.3 * q.energy + 0.25 * q.build + 0.2 * q.major + 0.15 * near(q.bpm, 126, 18) + 0.1 * q.bright,
    tags: /^(motivational|motivation|epic|uplifting|empowering|anthem|inspirational|inspiring|powerful|workout|confidence)$/,
    slots: [1, 0.8, 0.4, 0, 0, 0, 0.8, 0.6, 0.3, 0, 0, 0],
  },
  upbeat: {
    sound: (q) => 0.25 * q.energy + 0.35 * q.major + 0.3 * q.pulse + 0.1 * near(q.bpm, 120, 15),
    tags: /^(happy|upbeat|party|dance|danceable|feel good|feelgood|summer|fun|sunny|good vibes|positive|cheerful)$/,
    slots: [0, 0, 0.3, 0.5, 0.6, 0.3, 0, 0.3, 0.6, 0.8, 1, 0.6],
  },
}

const MOOD_ORDER: Mood[] = ['upbeat', 'cozy', 'motivation', 'running', 'sad']

interface Context {
  tracks: BaseItemDto[]
  model: TasteModel
  sound: SoundData
  /** How the library's measured songs rank (filled in by moodMixes). */
  rank?: Rankers
  now: number
  userId: string
  day: string
  week: string
}

function tagScore(tags: { own: string[]; artists: string[] }, pattern: RegExp) {
  const own = tags.own.slice(0, 12).filter((tag) => pattern.test(tag)).length
  const artists = tags.artists.slice(0, 10).filter((tag) => pattern.test(tag)).length
  return clamp(0.6 * Math.min(own, 2) / 2 + 0.4 * Math.min(artists, 2) / 2)
}

/** How well a song fits a mood (0–1), from its sound, tags and when the listener plays it. */
function moodScore(context: Context, mood: MoodSpec, track: BaseItemDto) {
  const f = context.sound.features(track)
  const tags = tagScore(context.sound.tags(track), mood.tags)
  const q = f && context.rank ? qualities(f, context.rank) : null
  // The sound decides most; a fitting tag adds to it (and alone, without a measurement, carries less far).
  const base = q ? 0.75 * mood.sound(q) + 0.35 * tags : 0.75 * tags
  if (!mood.slots) return clamp(base)
  let fitting = 0
  let total = 0
  for (let slot = 0; slot < 12; slot++) {
    const plays = context.model.slot(track, slot)
    fitting += plays * mood.slots[slot]!
    total += plays
  }
  return clamp(base * (1 + 0.3 * (total > 0.2 ? fitting / total : 0)))
}

export function moodMixes(input: Context): OfficialPlaylist[] {
  const context = { ...input, rank: rankers(input.tracks.map(input.sound.features).filter((f): f is SoundFeatures => !!f)) }
  const { tracks, model, userId, day } = context
  const t = messagesFor(moodMessages)
  // Without measurements and tags there is nothing to tell moods by.
  if (!context.sound.measured && !tracks.some((track) => context.sound.tags(track).artists.length)) return []
  const result: OfficialPlaylist[] = []
  // A song already in another mood's mix steps back, so the moods don't all open with the same songs.
  const taken = new Set<BaseItemDto>()
  for (const mood of MOOD_ORDER) {
    const spec = MOODS[mood]
    const scored = tracks.map((track) => ({ track, score: moodScore(context, spec, track) })).filter((entry) => entry.score > 0)
    // The best-fitting part of the library: at least clearly fitting, and among its top sixth.
    const sorted = [...scored].sort((a, b) => b.score - a.score)
    const cut = Math.max(0.5, sorted[Math.floor(sorted.length / 6)]?.score ?? 1)
    const fitting = new Map(scored.filter((entry) => entry.score >= cut).map((entry) => [entry.track, entry.score]))
    if (fitting.size < MIN_MOOD) continue
    const pool = [...fitting.keys()]
    const fit = (track: BaseItemDto) => (fitting.get(track) ?? 0) ** 2 * (taken.has(track) ? 0.3 : 1)
    const mixed = assemble(
      [
        { tracks: pool.filter(model.known), weight: (track) => model.love(track) * fit(track), share: 0.65 },
        { tracks: pool.filter((track) => !model.known(track)), weight: (track) => (0.2 + model.novelty(track)) * fit(track), share: 0.35 },
      ],
      { size: MOOD_SIZE, seed: `${userId}:mood:${mood}:${day}` },
    )
    if (mixed.length < MIN_MOOD) continue
    for (const track of mixed) taken.add(track)
    const description = { running: t.runningDescription, cozy: t.cozyDescription, sad: t.sadDescription, motivation: t.motivationDescription, upbeat: t.upbeatDescription }[mood]
    result.push({ slug: `mood-${mood}`, kind: 'mood', personal: true, title: t[mood], description, tracks: mixed })
  }
  return result
}

// ---- tag mixes ----

const QUEER = /^(queer|lgbt|lgbtq|lgbtq\+|lgbtqia|lgbtqia\+|gay|lesbian|bisexual|trans|transgender|queercore|drag|non-binary|nonbinary|queer pop|queer rap)$/
/** Tags that say nothing about the music. */
export const NOISE =
  /^(seen live|favorites?|favourites?|my favorites?|my favourites?|love|loved|awesome|beautiful|amazing|best|cool|good|great|spotify|albums i own|under \d+ listeners|check out|[0-9]+|[0-9]+ stars?|all|music|songs?|other|misc|vocal|vocals|male vocalists|female|male|german|deutsch|english|usa|american|british|uk)$/

/** A name as it goes into an address ("Hip-Hop/Rap" → "hip-hop-rap"). */
export const slugOf = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** A tag mix's address (all queer tags share one). */
export function tagSlug(tag: string) {
  return QUEER.test(tag.toLowerCase()) ? 'tag-queer' : `tag-${slugOf(tag)}`
}

const titleCase = (tag: string) => tag.replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase())

export function tagMixes(context: Context): OfficialPlaylist[] {
  const { tracks, model, userId, week, sound } = context
  const t = messagesFor(moodMessages)
  const genres = new Set(tracks.flatMap((track) => (track.Genres ?? []).map((genre) => genre.toLowerCase())))
  // An artist's name as a tag is their "Best of", not a mix of its own.
  const artistNames = new Set(tracks.flatMap((track) => [...(track.Artists ?? []), track.AlbumArtist ?? ''].map((name) => name.toLowerCase())))
  const byTag = new Map<string, { name: string; tracks: BaseItemDto[] }>()
  for (const track of tracks) {
    const { own, artists } = sound.tags(track)
    const keys = new Set<string>()
    for (const tag of [...own.slice(0, 10), ...artists.slice(0, 8)]) {
      if (NOISE.test(tag) || genres.has(tag) || artistNames.has(tag)) continue
      const slug = tagSlug(tag)
      if (keys.has(slug)) continue
      keys.add(slug)
      const entry = byTag.get(slug) ?? { name: QUEER.test(tag) ? 'queer' : tag, tracks: [] }
      entry.tracks.push(track)
      byTag.set(slug, entry)
    }
  }
  const loveOf = (list: BaseItemDto[]) => list.reduce((sum, track) => sum + model.longRun(track), 0)
  return [...byTag]
    .filter(([, entry]) => entry.tracks.length >= MIN_TAG && entry.tracks.length <= tracks.length * 0.6)
    // Queer first (asked for by name), then the tags the listener plays most.
    .sort((a, b) => Number(b[0] === 'tag-queer') - Number(a[0] === 'tag-queer') || loveOf(b[1].tracks) - loveOf(a[1].tracks) || b[1].tracks.length - a[1].tracks.length)
    .slice(0, MAX_TAG_MIXES)
    .map(([slug, entry]) => {
      const mixed = assemble(
        [
          { tracks: entry.tracks.filter(model.known), weight: model.love, share: 0.7 },
          { tracks: entry.tracks.filter((track) => !model.known(track)), weight: (track) => 0.3 + model.novelty(track), share: 0.3 },
        ],
        { size: TAG_SIZE, seed: `${userId}:${slug}:${week}` },
      )
      const queer = slug === 'tag-queer'
      return { slug, kind: 'tag' as const, title: queer ? t.queer : titleCase(entry.name), description: queer ? t.queerDescription : t.tagDescription(entry.name), tracks: mixed }
    })
    .filter((playlist) => playlist.tracks.length >= MIN_TAG)
}
