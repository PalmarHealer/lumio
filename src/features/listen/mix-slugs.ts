/**
 * How the server names its mixes' addresses (server/src/mood-mixes.ts), so a page can link to the mix of a genre or
 * tag it shows.
 */
const QUEER = /^(queer|lgbt|lgbtq|lgbtq\+|lgbtqia|lgbtqia\+|gay|lesbian|bisexual|trans|transgender|queercore|drag|non-binary|nonbinary|queer pop|queer rap)$/

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
