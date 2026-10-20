# goon.vc Agent Hints (AI)

Public **HTML zipper** for the Fabric suite. Do not grow this tree back into a Hub
or a GoonCitizen relay.

**Topology (PLAN.md):**
1. `goon.vc` — this repo: GoonSPA HTML + same-origin Hub API proxy
2. `relay.goon.vc` — GoonCitizen LiveRelay (`star-citizen-live`)
3. `hub.fabric.pub` — generic Fabric Hub (contract registry, Beacon, `/sessions` owner);
   `hub.goon.vc` is the same Hub under a second name

**What this process is:** `@fabric/http` `HTTPServer` serving `assets/` and
reverse-proxying `/sessions`, `/device-links`, `/services/rpc`, and
`/identity/cluster` + `/identity/cross-sign` to `FABRIC_HUB_ORIGIN`
(default `https://hub.fabric.pub`), then `hub.seeds` (`FABRIC_HUB_SEEDS`, default
`https://hub.goon.vc`) in order when the ones before can't be reached at all
(DNS / refused — never after a Hub answered or timed out). The proxy and the
Passport claim share one list (`createHubList` in `functions/hubApiProxy.js`)
that sticks to the Hub that answered last; seeds outside the `@fabric/http`
Hub allowlist are skipped, and none are used behind a loopback Hub. No Fabric Peer listen, no Bitcoin, no
`/services/star-citizen`. The one Discord gateway client is the read-only
metrics bot below (non-privileged intents, `autoCommands: false`, never
replies). Favicons are the suite lettermark
(serif **f** on royal purple `#4C1D95`) from `@fabric/http` `npm run make:icons`.
`/events` lists upcoming Discord Guild Scheduled Events from every server the
configured bot token can see (`GET /services/events`, REST only — no gateway
bot). Events are saved per guild in an on-disk Fabric Store (`stores/events`,
LevelDB) and requests are always answered from disk; Discord is polled on start
and every `ttlMs` in the background, a failing guild keeps its last saved events,
and the copy is served `stale` while Discord is unreachable. The page is a
single `<fabric-calendar>` Web Component (`assets/scripts/fabric-calendar.js`,
no goon.vc dependencies — the template for a Fabric-wide calendar control). It
shows the same week board as the PERMAFLEET schedule (`functions/scheduleGraphic.js`),
rendered live from that copy at `GET /services/events/schedule.svg?server=<id>&tz=<IANA zone>`
(endpoint default `America/Chicago`). Heading, description, counts, and every
control live on the board: the title picks the server, the zone label picks the
zone (default: the visitor's local zone; remembered in `localStorage`, kept in
`?tz=`), the footer downloads the SVG. The board's `#schedule-*` text ids are
the element's contract. `/operations/PERMAFLEET/schedule` is the same element
pinned to the home server (`server=<discordWidgetId>`, PERMAFLEET brand, no
server picker); every calendar renders through `EventsPage.calendar()` so they
share the look, the stacked phone layout, and the zone preference. The page footer's "Add our bot to your Discord" button
hits `GET /services/discord/invite`, which redirects to the OAuth invite for the
application that owns the bot token (scope `bot`, View Channels only).
Every route is the one built `assets/index.html`; link previews get per-page
Open Graph / Twitter tags because `services/goon.vc.js` swaps the
`<!-- page-meta -->` block (and `<title>`) per request from `GoonSPA#pages()`
(`functions/pageMeta.js`). Page paths have no trailing slash: `/x/` gets one 301
to `/x` (`GoonVC#_canonicalPathMiddleware`, mounted ahead of `express.static` so
a directory under `assets/` named like a page — e.g. a leftover `drills/` —
can't redirect it to `/x/`; Store-backed pages under `/tournaments/` and
`/leagues/` are matched by prefix). Add a route there when you add a page; absolute URLs
use the `siteUrl` site setting (default `https://goon.vc`).
The home page's "Subscribe on Discord" block lists the G00N guild's purchasable
Server Subscription tiers from `GET /services/discord/subscriptions` (tier roles
tagged `subscription_listing_id` + `available_for_purchase`, saved in the events
Store). Bots cannot read listing prices or perks, so the button links to
Discord's subscriptions page; the block stays hidden when there are no tiers.
The home page shows a G00N SQUAD overview (copy in `GoonSPA` `overviewParagraphs`,
facts from the G00N record) and our own Discord member list built from the
guild's public `widget.json` (no iframe). PERMAFLEET detail lives under
`/operations/PERMAFLEET/*`; the overview keeps a short teaser.
`/operations/PERMAFLEET/squadrons` is "Your path to membership" (join → Prospect
ranks → selected by leadership → elite units; never name a rank as the
selection point — members can pass Prospect IV without being selected), then
the cross-org squadrons (`contracts/squadrons.json`, `tier` `entry` | `elite`,
`next` for the unit the best go on to). Each squadron has its own page at
`/operations/PERMAFLEET/squadrons/<id>` (`components/PermafleetSquadrons.js`);
old `/operations/PERMAFLEET#<id>` links are sent there by the router.
One application covers every squadron: the squadrons page carries it
(`#squadron-apply`), a native form posting to its Google Form
(`squadronApplicationForm`: `formResponse` URL + `entry.*` ids). It is also
required for G00N SQUAD membership, even for PERMAFLEET members. Elite units
(ALPHA SQUADRON, SHELLBACK) are earned by performance — mention them as what
the best go on to, never as something to apply to.
`/operations` lists the operations in `contracts/operations.json` — currently
only PERMAFLEET, whose **metrics** count the public PERMAFLEET voice channel.
Each entry names the Discord channels its metrics count (channel id, exact
name, or `"/regex/"`). `services/operations.js` runs a `@fabric/discord`
gateway client (Guilds + GuildVoiceStates + GuildMessages only) into a
`@fabric/discord` `MetricsPipeline`; plugins (`voice`, `messages` from
`@fabric/discord/plugins`) keep per-operation UTC day buckets in a Fabric Store
(`stores/operations`, key `/metrics/plugins/<name>`), checkpointed every minute.
`GET /services/operations` returns aggregate counts only — never member ids or
message content. Without a token (or with `GOON_OPERATIONS_GATEWAY=0`) stored
metrics are still served. New metrics = a new plugin `{ name, intents, init, on,
report }` plus a `metrics` entry per operation. `npm run link:discord` points
`@fabric/discord` at `../fabric-discord` for local development.
The IdleRPG application is mounted at **`/services/idlerpg`**: browsers
(`Accept: text/html`) get the page, JSON clients get the alliance-wide presence
statistic (any `/services/*` path registered in `GoonSPA#pages()` negotiates
this way in `_pageMetaMiddleware`). `/idlerpg` and `/services/presence/*`
redirect there. `services/presence.js`
runs `@fabric/doorman` **in-process** (`http: false`, no `local` adapter) with the
`idlerpg` plugin (`IdleRPG` core Service, Fabric Store `stores/presence`), and
Doorman's Discord adapter is **attached** to the same `@fabric/discord` client
`services/operations.js` already runs (`Operations` emits `gateway`; the adapter
has `replies: false`, never logs in, and never answers commands). There is still
exactly one gateway client. The only thing it posts is IdleRPG game
announcements (welcomes, level-ups, battles, finds, penalties), and only to the text
channels in `presence.announcements` (G00N SQUAD `#idlerpg`); the bot needs
View Channel + Send Messages there. Chatting is penalized only in those
announcement channels (never in voice channel chat or anywhere else); with
none configured, `Presence` turns penalties off. IdleRPG credits every member present in a voice channel the bot
can see (`presence.channels` narrows it) once per `presence.tickMs` and keeps UTC
day buckets. Only voice earns XP on goon.vc: `presence.sources`
(`GOON_PRESENCE_SOURCES`, default `voice`) maps to idlerpg's `sources`, and
`text` (posting keeps a player present for idlerpg's `textWindowMs`) is for
text-only communities, not enabled here. idlerpg's `status` source is never
passed through — the Doorman adapter marks anyone who posts as online.
Its world comes from `@fabric/rpg` (a dependency of `idlerpg`, not of this tree): the tick is the rpg `WorldClock`, each tick a present
player may meet (`presence.luck`) a creature from their voice channel's biome
(near their level; 72 animals and fantasy creatures, tougher ones gated by
`minLevel`), gear, a cache, or a blessing; battles fight themselves,
wins pay XP and loot (better gear is equipped; gear rolls a prefix or suffix
for rare, both for legendary), losses cost 10% of credits. A creature's body
plan sets its slots and its equipment table what it wears (humanoids the
player's kit, quadrupeds collar + barding, others nothing); players are
humanoid and bag beast gear. No level cap; idlerpg's own curve (`100 * n^1.65`)
puts level 100 about three months of presence away, with monsters centered a
tenth of the player's level above it (at most 15). Gear,
creatures, and armor scale with level (balanced with idlerpg's
`npm run simulate`). The route returns aggregates only (`presentNow`, `uniquePlayers`,
`totalPresentHours`, `last7Days`/`last30Days`, 30-day `history`, level
histogram, `battles { won, lost, total }`, `kills`, top-5 `slain` creatures)
and `GET /services/idlerpg/players?limit=` the public leaderboard
(Discord display names — already public via the home-page widget — plus level /
XP / kills / weapon / credits / hours / online flag / player `id`) — never member ids or messages.
Each pilot has a page at `/services/idlerpg/players/<id>`
(`components/IdleRPGPlayerPage.js`; JSON clients get idlerpg's `profile(id)`:
rank, level progress, attributes, gear, bag, battles, top-5 slain; 404 when
unknown). The id is the idlerpg player id: 16 hex characters, unified across
the player's remote `accounts` (`{ service, id }` — Discord now; Slack or
another network later via `linkAccount`, still one page), unchanged by
renames, and not derived from any account id. Saves from before accounts move
to that shape on start with everything kept. Link previews come from
`Presence#page`. Names come
from the Doorman adapter's `user` events (member cache on voice join) plus a
one-time `Presence#backfillNames` on gateway ready. `/resources` lists an
IdleRPG card fed by that route; the `/services/idlerpg` page is the players
& statistics view (`components/IdleRPGPage.js`: stats, 30-day bars, level
histogram, battles + most slain, leaderboard, rules). Site copy: `idlerpg{Path,Heading,Tagline,Intro,
DocumentTitle}` in `GoonSPA`.
Settings: `presence.{path,tickMs,luck,channels,sources,gateway}` (`GOON_PRESENCE_STORE`,
`GOON_PRESENCE_TICK_MS`, `GOON_PRESENCE_SOURCES`); `gateway: false` keeps serving stored stats. `npm run
link:doorman` / `link:idlerpg` point at `../doorman` / `../idlerpg`; with a
linked `idlerpg`, run its own `npm run link:rpg` to use `../rpg`.
The PERMAFLEET section (`/operations/PERMAFLEET`, its `/schedule` and
`/squadrons[/<id>]`, and `/organizations`) swaps the site header for its own menu bar
(`components/PermafleetHeader.js`: Overview, Schedule, Squadrons,
Organizations, Join), shown while the router sets `body.pf-section`.
`/organizations` (plus `/organizations/<SYMBOL>`) lists PERMAFLEET member orgs
from `contracts/organizations.json`, a plain-text snapshot of public RSI org
pages refreshed by `npm run build:organizations` (never fetched at serve time).
`/resources` indexes guides and tools; `/resources/gooncitizen` describes the
GoonCitizen desktop app. `/resources/1v1-leaderboard` is the 1v1 dogfight ladder
synced from the pinned `# LEADERBOARD` message in G00N SQUAD #1v1-challenges
(`services/leaderboard.js`, Fabric Store `stores/leaderboard`,
`GOON_LEADERBOARD_STORE`; parser `functions/duelLeaderboard.js`). Discord REST
only: the pin is polled every 15 minutes and requests are answered from disk; a
failed poll or an unreadable pin keeps the last saved ladder (served `stale`).
`N. <@id>` lines become ranks as written (ties and gaps kept) with the name
Discord shows (server nickname, then display name; cached a day); `### Rules`
items come along. `GET /services/leaderboards/1v1` returns names and ranks only
— never Discord ids. The bot needs View Channel + Read Message History there
and the Message Content intent. The top 10 also shows on the squadron pages in
`GoonSPA` `leaderboardSquadrons` (BRAVO SQUADRON). `npm run build:downloads` copies the latest builds from
`../star-citizen-live` into `assets/downloads/gooncitizen/` (binaries gitignored —
over GitHub's 100 MB limit; only `index.json` is tracked) and the page renders
buttons + sha256 from that manifest. Interim only: future builds publish to the
Fabric network.
`/drills` indexes interactive training drills from `GoonSPA` `drills` (`id`,
`name`, `tagline`, `summary`, `element`, `script`, optional `attributes`); each
renders at `/drills/<id>` as its standalone Web Component
(`components/DrillsPage.js`). `<melee-rotation-drill>`
(`assets/scripts/melee-rotation-drill.js`, shadow DOM, no goon.vc dependencies)
runs only while visible, takes `heading` / `eyebrow` / `description` /
`pilots` / `storage-key` / `auto-every` / `fonts="none"` attributes,
and emits `splash` + `rosterchange`. Add a drill = a new element script plus a
`drills` entry. The old `/drills/melee-rotation-drill.html` redirects.
`/tournaments` is the permanent tournament record (`services/tournaments.js`,
Fabric Store `stores/tournaments`, `GOON_TOURNAMENTS_STORE`, routes under
`/services/tournaments`). Nothing is built in: anyone creates a tournament
from the index (`POST /services/tournaments` with `name`, optional `tagline` /
`summary`, `format`: `single-elimination` | `double-elimination`, `bestOf`:
odd n, `startsAt`, the creator's `timeZone`, optional `players`). Tournaments
with the same name share a **series** id (the name slug), so a weekly event
like the Saturday 1v1 is just a tournament created each week. A **tournament**
lives at `/tournaments/<series>/<YYYY-MM-DD>` (local date in the creator's
zone; `-2`… for the same day); `/tournaments/<series>` lists that name's
results (one tournament redirects to it). Each keeps its players, every game,
and a `log`
of each change (who, when — the signed-in member's display name when there is
one). Anyone may write for now (private tournaments come later); nothing is
deleted, undo is logged, and once the champion is recorded the tournament is
`complete` and locked with `results { champion, runnerUp, third, completedAt }`.
Seeds can be edited until the first game; after that a **latecomer** takes an
open first-round bye (lowest seed number first, only while nothing scored
depends on it), so they fight the same number of sets to the final as everyone
else — a full bracket refuses latecomers. Link previews for series and
tournament pages come from the Store (`Tournaments#page`, wired in
`_pageMetaMiddleware`). The bracket is `<tournament-bracket>`
(`assets/scripts/tournament-bracket.js`, shadow DOM, no goon.vc dependencies):
with `src` it loads and saves a record through that API, without it it keeps a
bracket in `localStorage`. `assets/scripts/tournaments.js` drives the index,
series, and record pages (`components/TournamentsPage.js`). In Node the
bracket script exports its pure engine, shared with the service
(`tests/tournament.js`, `tests/tournaments.service.js`).
`/leagues` holds standing duel leagues (`services/leagues.js`, Fabric Store
`stores/leagues`, `GOON_LEAGUES_STORE`, routes under `/services/leagues`).
One is built in: the perpetual **Open League** (`open-league`, open rules — no
ship class restrictions; `Leagues` `defaults`, created on start only while
its id is free, so renames and restarts never duplicate it).
Anyone creates more (`POST /services/leagues`: `name`, `kind` `perpetual` |
`seasonal`, usual `bestOf`, optional `k` (default 32) and `initialRating`
(default 1000), fixed at creation). A league lives at `/leagues/<id>` (name
slug, `-2`… when taken). Logging a duel (`POST …/<id>/duels`: `winner`,
`loser`, `bestOf`, `score` `[won, lost]`, where the winner took (n + 1) / 2)
joins new names to the roster. Ratings are never stored: `functions/elo.js`
replays the season's duels in logged order, and each duel moves
K × √(best of) × (1 − expected) from loser to winner (the set score is kept but
doesn't change the rating). Nothing is deleted: a wrong duel is voided (and can be
restored) with `POST …/duels/<duelId>/void|restore`, and every change is in
the league `log`. Seasonal leagues roll over with `POST …/<id>/seasons`, which
closes the current season, freezes its `standings` + `champion`, and starts
everyone at the initial rating again; a closed season's duels are final.
`PATCH …/<id>` edits name / tagline / summary / usual set. The pages are
`components/LeaguesPage.js` + `assets/scripts/leagues.js` (`?season=<n>` shows
a past season); link previews come from `Leagues#page`.
`/clips` is the public clip library and editor (`services/clips.js`, `GOON_CLIPS_STORE`
default `stores/clips`: a Fabric Store plus `media/`, `renders/`, `tmp/`; routes
under `/services/clips`). No sign-in: anyone may browse, edit, and render; a
signed-in member's display name goes on their changes (`identify`), otherwise
`null`. A render of a project revision that is queued, running, or done is
reused, and new renders are refused (429) while `maxQueuedRenders` wait.
Discord REST only: every guild the bot is in (`clips.guilds` narrows it), text,
announcement, forum, and media channels matching `clips.channels`
(`GOON_CLIPS_CHANNELS`; id, exact name, or `"/regex/"`; default names with
"clip(s)"/"video(s)") plus every media channel (`mediaChannels`), and the
active + archived public threads under them (forum / media posts are threads),
are polled every `ttlMs` with an `after=` cursor per channel or thread (90 days
of backfill for a new one; skipped while its `last_message_id` is behind the
cursor; `GOON_CLIPS=0` serves stored clips only). `npm run collect:clips`
(`scripts/clips.js`; stop the server first — one process per Store) reads the
whole history of those channels and threads in every guild (`--channel`,
`--guild` narrow it; `--days`, `--no-proxies`) and builds the proxies; it saves its
cursor every page, so a rerun resumes and stored clips are kept. Video attachments and video embeds
become clips. Medal links (most #clips posts) are downloaded with yt-dlp and
become local clips too; other hosts stay link-only unless listed in
`externalLinks` (`GOON_CLIPS_LINKS`: unset = `medal.tv`, `1`/`all` = YouTube,
Streamable, and Twitch as well, `0` = none, or a host list; `collect:clips --
--links` = all). Every start queues stored link-only clips whose host is now listed. A
clip is marked `failed` after 3 attempts, but a missing tool never spends one:
processing pauses with the clips still queued, and every start requeues clips
that failed for a missing tool or codec (`Clips#retryFailed`;
`collect:clips -- --retry-failed` retries every failure). The durable source is guild / channel / message / attachment
— CDN URLs expire and are re-signed with `POST /attachments/refresh-urls` (a
404 on the message means it was deleted). Each clip is downloaded, probed, and
gets a 240p/15 fps proxy plus a thumbnail sprite (needs `ffmpeg` + `ffprobe`;
`npm run check:video` checks a host — codecs, filters, the real commands on a
generated clip, yt-dlp, disk, Discord CDN — and exits 1 on a gap). The download
itself (up to `maxSourceHeight`, 1080p) is kept as the clip's **master** in
`masters/` (`keepMasters`, `GOON_CLIPS_MASTERS=0` turns it off; none are stored
while the disk has under `minFreeBytes`, 10 GB). A rescan pass every
`rescanEveryMs` (hourly, `rescanBatch` clips) stores masters for ready clips
that lack one and asks yt-dlp (`-J`, no download) whether a link clip not
checked for `recheckAfterMs` (a week) now offers a taller version, downloading
it and rebuilding the proxy when it does; uploads are fixed files and are left
alone once stored (`collect:clips -- --rescan` runs a full pass). Recording time
(`functions/clipRecordingTime.js`) comes from container `creation_time`, then
recorder filename patterns (ShadowPlay, Medal, Game Bar, OBS, ReLive) with the
author's UTC offset solved against the post time and remembered, then
`postedAt − duration`; anyone can override it or nudge sync (±10 min), and every
change is in the clip `log`. `functions/clipTimeline.js` groups clips into
play sessions (a new one after 2 hours without a clip, `sessionGapMs`;
multi-hour sessions stay whole, separate evenings don't merge) with one track per pilot. `/clips` is
`<clip-library>` (`assets/scripts/clip-library.js`): each session is a card
that wraps beside the others (as wide as up to four of its clips; bigger
sessions take the row) holding clip cards (sprite thumbnail with hover scrub, pilot, recorded time, length, caption),
search + pilot / channel / sort / link filters, a player (`?clip=<id>`) with
details, the Discord link, and the other pilots' overlapping angles at the same
moment, "Start a project" per session, and the project list.
`/clips/timeline?session=<id>|clip=<id>` is `<clip-timeline-editor>`
(`assets/scripts/clip-timeline-editor.js`) browsing one session. Both are shadow
DOM with no goon.vc dependencies; `components/ClipsPage.js` sets `src` only on
the active route. Projects live at `/clips/projects/<id>`: a program of segments
`{ clipId, in, out, audio, volume }`, saved as revisions (409 on a stale
`revision`; old revisions kept, nothing deleted). A render
(`functions/clipRenderPlan.js`, a pure ffmpeg argument builder; one at a time,
`maxRenderSeconds` / `maxSegments`) cuts from the masters (fetching the source
again only for a clip without one, so deleted messages and links still render) and
writes `renders/<id>.mp4` plus `<id>.sources.json` (each segment's pilot,
channel, message link, file, and recorded time); credits ride along as a
`mov_text` subtitle track. Responses carry display names only — never Discord
user ids or CDN URLs.
`/sessions` is the single login page (Discord, Passport, GoonCitizen desktop),
backed by the members Store under `/services/members`; `/members/login`
redirects there. The HTML client probes `OPTIONS /services/rpc` and
`GET /services/members` on load: Passport/desktop are disabled when the Hub
proxy is unreachable, and Login CTAs are hidden only when Discord login is
also unconfigured. Discord login is OAuth2 (`identify guilds`) through
`DISCORD_APP_ID`, or by default the application that owns the bot token
(looked up via `/oauth2/applications/@me`; today "sensemaker"). It is on once
the client secret is set: `DISCORD_APP_SECRET`, or `appSecret` in the bot's
`discord.secrets.json`. The application must list
`<origin>/services/members/discord/callback` as a redirect (redirect URI
follows the request host unless `DISCORD_REDIRECT_URI` is set).

GoonCitizen release docs: `star-citizen-live/AGENTS.md`. Hub/core:
`docs/PRODUCTION*.md`. Human call for GoonCitizen contributors (not this zipper):
`star-citizen-live/DEVELOPERS.md`. This tree: [`DEVELOPERS.md`](DEVELOPERS.md),
[`SECURITY.md`](SECURITY.md).
