# Setting up Lumio

Lumio runs as one container next to Jellyfin and becomes its public face: people open Lumio, and everything that
belongs to Jellyfin is passed through by Lumio's server, so one address serves both.

```
Internet ─► your reverse proxy (TLS) ─► lumio:8097
                                          ├─ /            the Lumio app
                                          ├─ /api/…       Lumio's server (social, caches, metadata)
                                          ├─ /web/…       jellyfin-web, for the administration only
                                          └─ everything else ─► jellyfin:8096 (API, streams, WebSockets, /sso)
```

- **Jellyfin apps keep working.** Android, iOS, TV apps, Infuse and the like use the same address; their requests go
  straight through (streams with seeking, WebSockets for remote control).
- **Jellyfin's Android app shows Lumio.** The official Android app displays the server's web client, which at this
  address is Lumio; it signs in there as usual, and its app settings and server/account switch are in Lumio's profile
  menu.
- **jellyfin-web stays for administrators.** The dashboard (`/web/#/dashboard` and its subpages), the metadata manager
  (`/web/#/metadata`) and plugin pages (`/web/#/configurationpage?…`) open as before; everything else of jellyfin-web
  (its home, its player, leaving the dashboard) sends you back to Lumio. Signed in to Lumio, you are signed in there too.
- **Lumio's administrator menu** links to those pages.

## The bare minimum

Set Jellyfin up first, on its own, and put Lumio in front of it last. Once Lumio fronts it, jellyfin-web only opens its
administration pages, so the first-run wizard and anything you'd rather do in the familiar Jellyfin UI comes first.

### 1. Set up Jellyfin directly

With your reverse proxy still pointing at Jellyfin (`jellyfin:8096`):

1. Run Jellyfin's setup wizard: administrator account, libraries, metadata language.
2. Install the plugins you want (Dashboard → Plugins; see [Recommended](#recommended): SSO, Meilisearch, Intro
   Skipper) and restart Jellyfin.
3. If you use SSO, set the provider up in the SSO plugin now and check that signing in through jellyfin-web works.
   In the provider's settings, set **Scheme override** to `https`: behind proxies the plugin otherwise builds its
   redirect address with `http://`, which the identity provider rejects ("mismatching redirect URI").

### 2. Prepare Jellyfin for Lumio in front

In Jellyfin (Dashboard → Networking), while you can still reach it directly:

- **Known proxies**: the address range Lumio reaches Jellyfin from. Then Jellyfin trusts the headers Lumio passes on:
  it sees people's real addresses (otherwise everyone shows up with Lumio's address in the dashboard's activity and
  devices) and that they came over `https` (which the SSO plugin needs for its redirect address).

  Lumio talks to Jellyfin over the network they share in the stack (in Compose, the stack's `default` network,
  named `<stack>_default`). Find its range with
  `docker network inspect <stack>_default --format '{{(index .IPAM.Config 0).Subnet}}'` (e.g. `192.168.16.0/20`) and
  add that range. Prefer the range to single addresses, which change when containers are recreated. If your reverse
  proxy talked to Jellyfin directly before, keep its network there too until you have switched over.
- **Published server URL** (or `JELLYFIN_PublishedServerUrl` on the container): the public `https://` address.
- Restart Jellyfin (it reads the known proxies at start).

How the addresses travel: your reverse proxy tells Lumio who the visitor is (`X-Forwarded-For`, `X-Forwarded-Proto`);
Lumio passes that on to Jellyfin unchanged. So Lumio must be reachable **only through your reverse proxy** (don't
publish its port to the internet), or anyone could claim any address. Lumio believes these headers only from a
proxy in a private network (Docker networks, LAN, `127.0.0.1`); from a public address it drops them.

### 3. Add Lumio and switch over

1. **Add Lumio to the Jellyfin stack.** Start from [`deploy/docker-compose.yml`](../deploy/docker-compose.yml): the
   `lumio` service, with `JELLYFIN_URL` pointing at Jellyfin *inside* the stack (`http://jellyfin:8096`) and
   `PROXY_JELLYFIN: "true"`. Declare its `lumio-data` volume under `volumes:` too (Docker refuses a stack that uses
   an undeclared volume; Portainer shows that as a bare "500"). The image is `ghcr.io/palmarhealer/lumio:latest`,
   built from `main` by GitHub Actions.
2. **Point your reverse proxy at Lumio** instead of Jellyfin: `lumio:8097`, with WebSocket support on (Nginx Proxy
   Manager: "Websockets Support"; Caddy and Traefik pass them by default). Lumio and the proxy need a network in
   common; Jellyfin no longer needs to be reachable from outside.
3. **Open the address** and sign in (SSO, password or Quick Connect). If you used jellyfin-web in that browser
   before, reload once: an old copy of jellyfin-web's page in the browser's cache doesn't know about Lumio yet.

That's all Lumio needs. Everything below makes it better.

## Recommended

### HTTPS

Needed for signing in safely, for the app to install and work offline (its service worker), and for downloads.

### Single sign-on (Jellyfin SSO plugin)

Lumio signs in through Jellyfin's [SSO plugin](https://github.com/9p4/jellyfin-plugin-sso) (OpenID Connect, e.g.
Authentik, Keycloak, Authelia), so accounts stay Jellyfin's:

1. Install the plugin (add its repository under Dashboard → Plugins → Repositories, see its README) and restart
   Jellyfin.
2. In your identity provider, create an OIDC application with the redirect URI
   `https://<your address>/sso/OID/redirect/<provider>`, `<provider>` being the name you give it in the plugin.
3. Configure that provider in the plugin (client id and secret, the provider's address, roles if you like).
4. Give Lumio a button for it: `SSO_PROVIDERS: "<provider>:Sign in with …"` (several separated by commas).

The sign-in page then shows the button. The plugin does the sign-in and finishes it in jellyfin-web; Lumio takes it
over from there (same address, so no second sign-in). Signing out of Lumio signs out of jellyfin-web too.

To offer SSO only, set `DISABLE_PASSWORD_LOGIN: "true"`: the sign-in page then shows the SSO buttons and Quick
Connect, no password form. (That is Lumio's page; Jellyfin itself still accepts passwords from other apps. To stop
those, give SSO users no password in Jellyfin, or switch password sign-in off in the SSO plugin's settings.)

With SSO, people change their password at the identity provider: build with `VITE_PASSWORD_CHANGE_DISABLED=true` and
`VITE_ACCOUNT_URL` (the provider's account page) to send them there from Lumio's profile page.

### Search (Meilisearch plugin)

Lumio searches through Jellyfin. The [Meilisearch plugin](https://github.com/arnesacnussem/jellyfin-plugin-meilisearch)
makes that search fast and forgiving (typos, partial words), for Lumio and every other app. Run a `meilisearch`
container in the stack and give Jellyfin `MEILI_URL` and `MEILI_MASTER_KEY`, as the plugin's README describes.

The same Meilisearch lets Listen's search find songs by a line of their lyrics (a section "In lyrics"). Lumio keeps
them in an index of its own (`lumio_lyrics`, or `MEILI_LYRICS_INDEX`) and needs a key for just that index, not the
master key. Create it once (inside the stack, with the master key):

```sh
curl -X POST http://meilisearch:7700/keys   -H "Authorization: Bearer $MEILI_MASTER_KEY" -H "Content-Type: application/json"   -d '{"name":"lumio","actions":["search","documents.add","documents.get","indexes.create","indexes.get","settings.update"],"indexes":["lumio_lyrics"],"expiresAt":null}'
```

and give Lumio `MEILI_URL` and the returned `key` as `MEILI_KEY`. Then fill the index once under Administration →
Metadata → *Lyrics search*: it takes the lyrics Jellyfin has (embedded, `.lrc` files, a lyrics plugin's) and the ones
Lumio kept from lrclib. Songs played later, and lyrics Lumio finds later, are added by themselves. Meilisearch only
ever hears from Lumio's server; what it finds is checked against Jellyfin, so people only see songs from libraries they
may open.

### Skipping intros and credits (Intro Skipper)

Lumio offers "Skip intro" / "Skip credits" (or skips by itself, set per user under Settings → Controls) wherever
Jellyfin knows a media segment. The [Intro Skipper](https://github.com/intro-skipper/intro-skipper) plugin finds them
for series; without it, only segments from other sources show up.

### What else Lumio uses from Jellyfin

| Feature in Lumio | Comes from | To set up |
| --- | --- | --- |
| Seek previews (thumbnails over the progress bar) | Jellyfin's trickplay images | Per library: enable trickplay image extraction (Dashboard → Libraries) |
| Synced lyrics | Jellyfin's lyrics, else [lrclib.net](https://lrclib.net) through Lumio's server | Optional: Jellyfin's LrcLib plugin to store them in the library |
| Watching together | Jellyfin SyncPlay | Built in (users need the SyncPlay permission) |
| Quick Connect sign-in | Jellyfin Quick Connect | Dashboard → General → Quick Connect |
| Featured artists, songwriters, producers, labels | MusicBrainz, looked up by Lumio's server | Optional: tag files with [MusicBrainz Picard](https://picard.musicbrainz.org); Lumio's admin page "Music metadata" fills in the whole library |
| Artist photos and biographies | Jellyfin, Epidemic Sound, Deezer, Last.fm (through Lumio's server, kept for months) | Optional Last.fm key (below) |
| Concerts | Ticketmaster (through Lumio's server) | Optional Ticketmaster key (below) |
| TMDb rating | TMDb | Optional TMDb key (below) |
| Remote control, "play on" | Jellyfin sessions | Built in |

### Keys for outside services (optional)

Free keys make Lumio richer. The image comes without any: everyone uses their own, set on the `lumio` container.
The app then asks those services through Lumio's server (which caches the answers for everyone and keeps the keys
off the browser).

| Variable | Service | What it brings |
| --- | --- | --- |
| `LASTFM_API_KEY` | [Last.fm](https://www.last.fm/api) (non-commercial use) | Listener counts, popular songs, similar artists, bios, charts, radios |
| `TICKETMASTER_API_KEY` | [Ticketmaster](https://developer.ticketmaster.com) | Concerts on artist pages and the concerts page |
| `TMDB_API_KEY` | [TMDb](https://www.themoviedb.org/settings/api) | TMDb ratings, names of film series |
| `MUSICBRAINZ_CONTACT` | [MusicBrainz](https://musicbrainz.org) (no key) | A URL or e-mail address; MusicBrainz throttles anonymous clients |

Without a key, what it brings simply stays off. Keep to each service's terms (attribution, Last.fm non-commercial).

### After the first start

As an administrator, in Lumio's settings:

- **Music metadata**: look up every song's credits (featured artists, songwriters …) and fetch every artist's
  information ahead, leaving out libraries, artists or genres (audio plays, say).
- **Branding**, **Display**, **Plugins**: name, logo, colours, where previews open, Lumio plugins.

## Cleaning up Jellyfin

With Lumio in front, jellyfin-web only serves the administration. Whatever was there to change how jellyfin-web looks
or behaves for viewers no longer reaches anyone and can go. What Jellyfin itself does on the server (metadata,
segments, search, sign-in) stays.

**No longer needed** (they only change jellyfin-web for viewers):

| What | Why it can go |
| --- | --- |
| Home screen plugins: *Home Screen Sections*, *Collection Sections*, *Media Bar* | Lumio has its own home screens |
| *Custom Tabs* | jellyfin-web tabs; links in Lumio's navigation come from a Lumio plugin (Settings → Plugins, `addNavLink`) |
| *InPlayerEpisodePreview* | jellyfin-web's player; Lumio's player has its own episode list |
| *File Transformation*, *Plugin Pages* | Helpers the plugins above use to change jellyfin-web; nothing else needs them |
| *JavaScript Injector* and its snippets | They change jellyfin-web's pages; Lumio puts in what jellyfin-web still needs itself |
| Theme and UI CSS in Dashboard → General → Custom CSS (themes, button fixes, skip-button styles) | Only jellyfin-web loads it. **Keep the comment that starts with `/* lumio`**: Lumio's branding, plugins and settings live in it |
| The sign-in button in Dashboard → General → Login disclaimer | jellyfin-web's sign-in page now leads to Lumio's, which has the SSO button |

**Keep** (Lumio uses them, or they work on the server):

| What | Why it stays |
| --- | --- |
| *SSO-Auth* | Lumio's sign-in goes through it |
| *Intro Skipper* | Finds intros and credits; Lumio's skip buttons use them. Keep it updated to a version for your Jellyfin, or it shows as "Not supported" and finds nothing |
| *Meilisearch* | Fast, forgiving search for Lumio and every app (same: keep it updated) |
| Metadata providers: *TMDb*, *OMDb*, *MusicBrainz*, *AudioDB*, *Studio Images*, anime providers (*AniDB*, *AniList*, *AniSearch*) if you have anime | Jellyfin's metadata, which Lumio shows |
| *LanguageTags* | Tags items with their languages on the server; harmless, keep it if you filter by it |
| *Playback Reporting*, *Reports* | Statistics and reports for administrators (in the dashboard); Lumio doesn't need them, keep them if you use them |
| *ListenBrainz Similarity Provider* | Similar artists for Jellyfin's instant mixes; Lumio uses Last.fm for its radios, keep it if other apps use instant mixes |

Remove plugins in Dashboard → Plugins (uninstall, then restart Jellyfin); plugins others depend on (File
Transformation, Plugin Pages) last.

## Building it yourself

The image needs nothing but Docker:

```sh
docker build -t lumio --build-arg VITE_JELLYFIN_URL=/ --build-arg VITE_SERVER_LOCKED=true .
```

`VITE_JELLYFIN_URL=/` means "Jellyfin is on the address Lumio is opened on" (the proxied setup). Without the proxy,
build with Jellyfin's own address and leave `PROXY_JELLYFIN` off; Lumio then talks to Jellyfin directly, and Jellyfin
must allow it (CORS).

## Updating and backups

- **Update**: pull `ghcr.io/palmarhealer/lumio:latest` and recreate the container (or pin a version tag).
- **Back up** the `lumio-data` volume (SQLite database, settings, caches). Jellyfin keeps its own data as before.

## Troubleshooting

- **Everyone shows up with the same IP in Jellyfin** (Lumio's): the range Lumio reaches Jellyfin from isn't in
  Jellyfin's *Known proxies*, or Jellyfin wasn't restarted since (see step 2).
- **Remote control or live updates don't work**: WebSockets aren't passed by the reverse proxy.
- **Jellyfin sees `http://` or the proxy's address although Known proxies are set**: the reverse proxy reaches Lumio
  from a public address (another host over the internet, a tunnel), so Lumio drops its `X-Forwarded-*` headers. Let it
  reach Lumio over a private network (Docker network, LAN or VPN).
- **"Mismatching redirect URI" with `http://` in it**: Jellyfin doesn't trust Lumio's forwarded headers yet. Add
  the Lumio container (or the Docker network's range) to *Known proxies* and restart Jellyfin, or set the provider's
  *Scheme override* to `https` in the SSO plugin.
- **The SSO button does nothing / "provider not found"**: the name in `SSO_PROVIDERS` must match the plugin's provider
  name exactly, and the redirect URI in the identity provider must use the public address.
- **The dashboard asks to sign in again**: sign in to Lumio first; opening `/web/#/dashboard` then signs you in.
