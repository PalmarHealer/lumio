import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models'
import { Fragment } from 'react'
import { Link } from '@/components/link'
import { artistHref, useTrackArtists } from './credits'
import { DownloadedMark } from './download-ui'
import { fileArtist } from '@/lib/unscanned'

/**
 * A track's artists, each linking to their page where the library has them: the file's artists plus the featured ones
 * MusicBrainz names (see useTrackArtists). `exclude` leaves out names already shown (an album's own artists).
 */
export function TrackArtists({
  track,
  exclude,
  lookup,
  linked = true,
  stopPropagation,
}: {
  track: BaseItemDto
  exclude?: string[]
  /** Looks the credits up now when the server hasn't yet (the track that plays). */
  lookup?: boolean
  linked?: boolean
  /** For rows that play on click: following a link shouldn't also play. */
  stopPropagation?: boolean
}) {
  const all = useTrackArtists(track, lookup)
  const others = exclude ? all.filter((artist) => !exclude.includes(artist.name)) : all
  const tagged = others.length ? others : all
  // A file the scan hasn't read yet still names its artist.
  const fromFile = fileArtist(track)
  const artists = tagged.length || !fromFile ? tagged : [{ name: fromFile }]
  return [
    // Downloaded songs carry the green mark before their artists.
    <DownloadedMark key="downloaded" item={track} />,
    ...artists.map((artist, index) => (
    <Fragment key={artist.id ?? artist.name}>
      {index > 0 && ', '}
      {/* Guests the library has no page for lead to their guest page. */}
      {linked ? (
        <Link to={artistHref(artist)} onClick={stopPropagation ? (event) => event.stopPropagation() : undefined} className="hover:text-foreground hover:underline">
          {artist.name}
        </Link>
      ) : (
        artist.name
      )}
    </Fragment>
  )),
  ]
}
