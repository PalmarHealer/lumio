# Lumio

A from-scratch Jellyfin client with a shadcn/ui-inspired, cinematic interface: **Watch** for films and series,
**Listen** for music and podcasts. It runs in the browser, as an Android app and as a desktop app for Windows and
Linux, talks to a stock Jellyfin server (tested against 10.11) and needs no server plugin of its own.

## Setup

Lumio runs as one container in front of Jellyfin and becomes its public face (Jellyfin's API, apps and administration keep working through it). Jellyfin's official Android app, which shows the server's web client, then shows Lumio. See **[docs/SETUP.md](docs/SETUP.md)** for the bare minimum and the recommended setup (SSO, Meilisearch, Intro Skipper, keys).

Lumio's own apps for Android, Windows and Linux are attached to every [GitHub Release](https://github.com/PalmarHealer/lumio/releases/latest).
They ask for the server at sign-in; a Lumio server also offers the newest ones under "Download the app" (see "Apps" below).

## Screenshots

Taken against the public [Jellyfin demo server](https://demo.jellyfin.org/stable) (freely licensed films and music;
film stills © Blender Foundation, CC BY).

### Watch

| | |
| --- | --- |
| ![Watch home](docs/screenshots/watch-home.webp) | ![A library](docs/screenshots/watch-library.webp) |
| ![A film](docs/screenshots/watch-movie.webp) | ![A series](docs/screenshots/watch-show.webp) |

### Listen

| | |
| --- | --- |
| ![Listen home](docs/screenshots/listen-home.webp) | ![An album](docs/screenshots/listen-album.webp) |
| ![An artist](docs/screenshots/listen-artist.webp) | ![Now playing, big](docs/screenshots/listen-now-playing.webp) |

## Features

### Watch

- **Personal home**: rows built from the watch history (continue, "because you watched", favourite genres, a genre to
  discover, recently added); Jellyfin's classic "latest per library" layout is still available. Libraries can be
  reordered and hidden.
- **Browsing**: libraries with sorting, genre and watched filters and infinite scroll,
  detail pages with cast and guest stars, seasons and episodes, person pages, a watchlist (favorites) and a searchable
  watch history.
- **Search**: inline search in the header and a full search page.
- **Hover previews**: Netflix-style cards that load their content before they appear.
- **Ratings and links**: IMDb/TMDB ratings and external links. The real TMDB rating needs a key on the server, see below.
- **Player**: a custom player built on hls.js.
  - Audio, subtitle and quality menus.
  - Trickplay thumbnails, intro/outro skipping (media segments) and an in-player episode list.
  - A pause spotlight and a loading progress ring.
  - Readable track names ("Deutsch · Dolby Digital 5.1" instead of the file's stream titles).
  - On touch screens: big controls in the middle, double tap left or right to skip; in the Android app, swiping sets
    brightness and volume, and leaving the app shrinks the video into picture in picture.
- **Downloads**: films, seasons and episodes for offline watching, in a chosen quality (or the original file) and
  audio language, with Intro Skipper's segments. Upcoming episodes can be stored ahead. Plays made offline are handed
  in to Jellyfin once back online.
- **Films and series in two languages**: the Lumio server labels titles and overviews as German or English and fetches
  the other language (with posters and logos that carry writing) from TMDb; the app shows the interface language.

### Listen

- **Music**: a Spotify-like home, albums, artists (photos, bios, discography, concerts, similar artists), songs with
  credits and synced lyrics, a queue and lyrics side panel, personal radios and a taste profile.
- **Playlists**: own and shared ones, with an "Added by" column.
- **Podcasts**: search and charts from Apple's podcast directory, following shows, chapters, transcripts and episode
  downloads.
- **Downloads and offline mode**: albums, playlists and podcast episodes; offline, the library is made of downloads,
  unavailable songs are skipped, and plays are handed in later.

### Everywhere

- **Two languages**: German and English, following the browser or chosen in the settings (also on the sign-in page).
- **Phones**: a frame like Spotify's, with tabs along the bottom, a profile drawer, a mini player and a full-screen
  music player; menus open as bottom sheets, and pulling a song row to the right queues it.
- **Watch together and remote control**: SyncPlay groups ("Einer Gruppe beitreten") and controlling other Jellyfin
  sessions ("Abspielen auf"), music included. Other clients can also cast to Lumio.
- **Social**: profiles with following and followers, privacy settings and live friend activity.
- **Settings**: mirrors jellyfin-web's profile, playback, subtitle and controls pages.
  - Account-wide settings are stored in the Jellyfin user configuration.
  - Device-specific settings stay on the device.
- **Sign-in**: Quick Connect, which is how SSO setups such as Authentik sign in, SSO buttons, or a username and password.
- **Jellyfin's Android app**: the official app shows Lumio as the server's web client and stays signed in with it.
  Its back button and media notification work, and its own screens (app settings, switching server or account) are in
  Lumio's profile menu there.

### Administration

- **Branding and plugins**: app name, logo, favicon, accent color and custom CSS for everyone on the server,
  plus JavaScript plugins that can add to, change or remove parts of the UI (see "Plugins" below).
- **Metadata**: editing, images (per language), the two-language task and its review list.
- **Statistics**: built-in playback statistics from the Playback Reporting plugin, with Lumio's offline plays and podcasts.
- **Promote the apps**: per system (Android, Windows, Linux), browsers there get a card about the app once.
- Links to the Jellyfin dashboard.

## Apps

- **Android** (`de.lumio`, Capacitor): music plays on in the background with a media notification, the video
  player is fullscreen in landscape with picture in picture and swipe gestures, the back button walks back through
  panels and pages. Small native plugins in `android/` handle picture in picture, brightness and volume, and updates.
- **Windows and Linux** (Electron; NSIS installer, AppImage, deb): Lumio's header holds the window buttons (or a normal
  frame), a tray icon controls playback, and it can start with the system, minimized or in Watch or Listen.
- **Updates**: both download newer releases by themselves ("Update automatically", on by default). Android hands the
  APK to its installer; Windows installs when Lumio quits, an AppImage replaces itself, a deb opens in the package
  manager.

The apps carry the built pages (`VITE_BUNDLED`) and ask for the server at sign-in; the Lumio server allows their
origins (`https://localhost`, `app://lumio`). It also lists the newest release's files under `/api/apps` and redirects
`/api/apps/download/<android|windows|appimage|deb>` to them, so its "Download the app" links never go stale.

## Stack

- Vite, React 19, TypeScript
- Tailwind CSS v4 and shadcn/ui (on Base UI), Tabler icons
- `@jellyfin/sdk` for the API, TanStack Query for data fetching
- React Router: a data router, which is what makes view transitions between pages possible
- hls.js for transcoded streams; direct play uses the browser itself
- Server: Node 24 with its built-in SQLite and TypeScript support, no dependencies
- Apps: Capacitor 8 (Android), Electron with electron-builder (Windows, Linux)

## Development

Lumio always runs with its server (`server/`): it serves the app and, under `/api`, what Jellyfin can't share between
users (follows, followers, privacy settings, live friend activity). It needs Node 24 and nothing else (SQLite and
TypeScript support are built in). In development, run it next to Vite, which passes `/api` on to it:

```sh
cp .env.example .env   # at least set VITE_JELLYFIN_URL
pnpm install
JELLYFIN_URL=https://jellyfin.example.org node --no-warnings server/src/main.ts   # terminal 1
pnpm dev                                                                          # terminal 2
```

In production, build the app and let the server serve it (or use the `Dockerfile`, which does both):

```sh
pnpm build
JELLYFIN_URL=https://jellyfin.example.org PORT=8097 DATA_DIR=/var/lib/lumio node --no-warnings server/src/main.ts
```

| Server variable   | Required | Purpose                                                                                       |
| ----------------- | -------- | --------------------------------------------------------------------------------------------- |
| `JELLYFIN_URL`    | yes      | The Jellyfin server whose tokens it accepts (every API request is checked with it).          |
| `PORT`            | no       | Port to listen on (default 8097).                                                             |
| `DATA_DIR`        | no       | Where it keeps its SQLite database and caches (podcast covers, relayed answers; default `./data`). |
| `WEB_DIR`         | no       | The built app it serves (default `dist/` of this repository).                                 |
| `ALLOWED_ORIGINS` | no       | Comma-separated origins allowed to call the API from elsewhere (only for split setups).       |
| `LASTFM_API_KEY`  | no       | Last.fm key (free, non-commercial): listeners, popular songs, similar artists, bios, charts. The app asks Last.fm through the server. |
| `TICKETMASTER_API_KEY` | no  | Ticketmaster Discovery key (free): concerts. The app asks through the server.                  |
| `TMDB_API_KEY`    | no       | TMDb key: TMDb ratings, film series names and the second language of film and series texts. The app asks through the server. |
| `PROXY_JELLYFIN`  | no       | `true`: Lumio fronts Jellyfin and passes its API, WebSockets, `/web` and `/sso` through (see [docs/SETUP.md](docs/SETUP.md)). |
| `SSO_PROVIDERS`   | no       | Sign-in buttons for the Jellyfin SSO plugin's providers, `name:Label` separated by commas.      |
| `DISABLE_PASSWORD_LOGIN` | no | `true` (with SSO providers): the sign-in page offers SSO and Quick Connect only.               |
| `MUSICBRAINZ_CONTACT` | no  | A URL or e-mail address MusicBrainz can reach the operator at (it throttles anonymous clients). |
| `APP_RELEASES_REPO` | no    | GitHub repository (`owner/name`) whose newest release `/api/apps` offers (default `PalmarHealer/lumio`; for forks). |

The server relays and caches what the app asks Ticketmaster (6 h), Last.fm (artists 90 days, charts 24 h), MusicBrainz
(artist links and song credits, 180 days) and lrclib (lyrics, 180 days) for, podcast feeds with their chapters and transcripts (6 h / 30 days), and
podcast covers from Apple (kept), so one listener's lookup is there at once for everyone and the services' limits are
kept centrally.

| Script           | What it does                         |
| ---------------- | ------------------------------------ |
| `pnpm dev`       | Dev server with hot reload           |
| `pnpm build`     | Type check and production build      |
| `pnpm typecheck` | Type check only                      |
| `pnpm lint`      | oxlint                               |
| `pnpm preview`   | Serve the production build           |
| `pnpm build:android` | Build the pages for the Android app and sync them into `android/` (then build the APK with Gradle there) |
| `pnpm build:desktop` | Build the pages for the desktop app into `electron/dist` |
| `pnpm desktop`   | Build and start the desktop app      |
| `pnpm dist:desktop` | Build the desktop installers (electron-builder) |

Pushing a `v*` tag builds the signed APK (`android.yml`, signing key from the repository's secrets), the desktop
installers (`desktop.yml`) and the Docker image (`image.yml`); the apps are attached to the tag's GitHub Release.

### Environment variables

| Variable                        | Required | Purpose                                                                                                                                   |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_JELLYFIN_URL`             | yes      | The Jellyfin server shown on the login screen.                                                                                            |
| `VITE_SERVER_LOCKED`            | no       | `true` pins the login to `VITE_JELLYFIN_URL` and hides the server field (ignored when no URL is set).                                     |
| `VITE_TMDB_API_KEY`, `VITE_LASTFM_API_KEY`, `VITE_TICKETMASTER_API_KEY` | no | Only for builds that ask those services directly (no Lumio server); they end up in the client bundle. Normally the keys belong on the server (above). |
| `VITE_PASSWORD_CHANGE_DISABLED` | no       | `true` hides "Passwort ändern", e.g. when accounts live in an OIDC provider.                                                              |
| `VITE_ACCOUNT_URL`              | no       | Where users manage their account instead (for example the Authentik user settings). Quote it if it contains a `#`. |
| `VITE_SOCIAL_URL`               | no       | Address of the Lumio server's API when the app is served from somewhere else (default: the same origin's `/api`). |
| `VITE_BUNDLED`                  | no       | Set by `.env.android` and `.env.desktop`: the build is carried by an app, asks for the server at sign-in and uses that server's `/api`. |
| `VITE_PLUGIN_CATALOG_URL`       | no       | Where the plugin store's list comes from (default: `plugins/catalog.json` in this repository). |

All of these are read at build time; changing them needs a rebuild.

## Structure

```
server/                   the Lumio server (Node 24): serves the app, /api, the Jellyfin proxy, relays and caches
android/                  the Android app (Capacitor project, native plugins)
electron/                 the desktop app (main process, preload; the built pages go to electron/dist)
plugins/                  the plugin store's catalog
src/
  App.tsx                 routes (data router), query client, providers
  components/
    app-shell.tsx         header, navigation, profile menu
    media/                cards, rows, grids, hover preview, rating badges
    ui/                   shadcn components (generated, then adjusted)
  features/
    admin/                branding, plugins, display, metadata and statistics pages
    auth/                 session storage, login, Quick Connect
    home/                 home screen and hero
    items/                detail page, item queries, preview preloading
    library/              libraries, watchlist, history, person pages, video downloads
    listen/               Listen: music, playlists, podcasts, radios, concerts, downloads, its player
    player/               player page, controls, panels, device profile, segments, trickplay
    remote/               remote control ("Abspielen auf") and SyncPlay over the Jellyfin WebSocket
    search/               header search and search page
    settings/             settings pages; local (per-device) and server-side user settings
    social/               profiles, following, friend activity, the relays of the Lumio server
  lib/                    SDK setup, config, formatting, image URLs, TMDB, track labels, platform and app bridges
```

### Notes

- **Device profile**: `features/player/device-profile.ts` builds the profile by hand from `canPlayType`/MSE
  checks. The SDK helper only covers subtitles. Jellyfin uses the profile to decide between direct play and
  transcoding.
- **Settings storage**: settings jellyfin-web keeps per device (bitrate limit, skip lengths, subtitle look) are
  stored in `localStorage` per user. Account-wide ones (audio/subtitle language, autoplay) go to the server.
- **Jellyfin's Android app**: the app is a WebView around the server's web client and only counts the page as loaded
  once it requests a `main.*.bundle.js` (jellyfin-web's bundle name), so Lumio ships an empty
  `public/main.lumio.bundle.js`. It reads the sign-in from `jellyfin_credentials`, which Lumio mirrors its session
  into (`features/auth/session.tsx`). `lib/native-app.ts` wraps the app's `window.NativeInterface` and provides the
  `window.NavigationHelper` it calls for its back button and media notification. Inside it, and in Lumio's own
  Android app, the persistent-storage notice is skipped, since a WebView can't grant it.
- **Lumio's own apps**: `lib/platform.ts` tells the browser, the Android app and the desktop app apart;
  `lib/capacitor.ts` and `lib/desktop.ts` wrap their native sides (the Electron preload exposes a small, fixed API).
- **Tabs**: several Lumio tabs in one browser share a device id, and with it one server session. That matters for
  SyncPlay and remote control.

### Plugins

Admins add plugins under Settings → Plugins, as an ES module URL or as code. A module exports `setup(lumio)`:

```js
export default function setup(lumio) {
  lumio.addStyle('.hero h1 { color: gold }')
  lumio.addNavLink({ id: 'requests', label: 'Requests', href: 'https://requests.example.com', external: true })
  lumio.addMenuItem({ id: 'help', label: 'Help', href: '/plugin/help' })
  lumio.addRoute({ path: 'help', render: (element) => { element.textContent = 'Help' } })
  lumio.addSettingsPage({ id: 'stats', label: 'Statistics', admin: true, render: (element) => { element.textContent = '…' } })
  lumio.addSlot('item:bottom', (element, { item }) => { element.textContent = item.Name })
  lumio.hide('header:cast')
  lumio.transform('homeRows', (rows) => rows.filter((row) => row.id !== 'new'))
  lumio.on('playback:start', ({ itemId }) => console.log('playing', itemId))
}
```

- Slots: `header:start`, `header:end`, `home:top`, `home:bottom`, `item:actions`, `item:bottom`, `player:overlay`.
- Hideable: `header:search`, `header:syncplay`, `header:cast`, `nav:home`, `nav:watchlist`, `nav:<category>` (`movies`, `shows`, `anime`, `music`, `audiobooks`, `books`, `videos`), `nav:<library id>`,
  `home:hero`, `home:<row id>`, `item:ratings`, `item:links`.
- Events: `navigate`, `item`, `playback:start`, `playback:stop`.
- `lumio.jellyfin` gives the signed-in session (`api`, `serverUrl`, `userId`, `accessToken`, `isAdmin`).
- Lyrics providers: `lumio.addLyricsProvider({ id, name, find })`. `find(track)` gets `{ id, title, artists, album,
  albumArtist, duration, musicBrainzTrackId, isrc }` and returns `{ lrc, plain }` (either may be missing) or null.
  Providers are asked in order after Jellyfin and lrclib, for songs that have no synced lyrics yet. What one finds is
  kept on the Lumio server for everyone, so each song is asked about once and keeps its lyrics if the provider later
  stops working. `find` runs in the browser: the source has to allow cross-origin requests.
- Plugins are code, so in a browser they only run for the server this Lumio belongs to, not for one a visitor signs in
  to by address. Lumio's apps run the plugins of the server their user picked.

**Plugin store**: admins add plugins from Settings → Plugins → Available plugins. The list is
[`plugins/catalog.json`](plugins/catalog.json) in this repository, read at runtime, so new plugins show up on every
instance without a redeploy. Plugins are proposed by pull request, see [`plugins/README.md`](plugins/README.md).

Branding and plugins are stored in the Jellyfin server's branding configuration (as one comment inside its custom CSS),
which every client can read (even before signing in) and only admins can write. jellyfin-web only sees a CSS comment.

## License and notices

Lumio is free software under the [GNU General Public License v3.0](LICENSE).

It is an independent project, not affiliated with or endorsed by Jellyfin, TMDb, Last.fm, Ticketmaster, MusicBrainz,
Epidemic Sound, Deezer, lrclib or Rotten Tomatoes. Names and data of those services belong to their owners. Whoever
runs Lumio with keys for those services uses their own keys and keeps to their terms (attribution where asked; Last.fm
for non-commercial use only).
