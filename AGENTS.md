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
Hub allowlist are skipped, and none are used behind a loopback Hub. No Fabric Peer listen (the
Fabric relay below only dials out), no Bitcoin, no
`/services/star-citizen`. The one Discord gateway client is the metrics bot
below (non-privileged intents unless the Fabric relay or campaigns are configured, `autoCommands: false`); it never answers chat,
only the `/idlerpg`, `/1v1`, `/vote`, and `/goon` application commands, and DMs only inside a setup
script a server admin started with `/goon setup` (or `/goon council`, `embassy`,
`permafleet`, `voice`, which also create those channels on the admin's server
when the bot may) or a campaign one sent with `/goon campaign`. Favicons are the G00N SQUAD
skull, the org's RSI logo (`logoUrl` in `contracts/organizations.json`), not the
Fabric suite lettermark.
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
pinned to `server=permafleet`: the home server's events plus those of the member
orgs' servers in `discord.schedule.servers` (`DISCORD_SCHEDULE_SERVERS`; today
4M-CONTRACTORS, TRDE, and AIMOS — a listed server's events show once the bot is
in it; DOUBLEDOGZ points at the G00N SQUAD server), home server first so its day themes win, PERMAFLEET brand, no server
picker; a single server id draws just that server under its own name; every calendar renders through `EventsPage.calendar()` so they
share the look, the stacked phone layout, and the zone preference. The page footer's "Add our bot to your Discord" button
hits `GET /services/discord/invite`, which redirects to the OAuth invite for the
application that owns the bot token (scopes `bot applications.commands`, View Channels only).
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
plugs the `idlerpg` plugin (`IdleRPG` core Service, Fabric Store `stores/presence`)
into the one in-process `@fabric/doorman` host that `services/community.js` owns
(`http: false`, no `local` adapter; Presence runs its own only when built without a
community). Doorman's Discord adapter is **attached** to the same `@fabric/discord` client
`services/operations.js` already runs (`Operations` emits `gateway`; the adapter
has `replies: false`, never logs in, and never answers `!` commands). There is still
exactly one gateway client and one Doorman. Apart from application command replies, the only thing it posts is IdleRPG game
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
The PERMAFLEET section (`/operations/PERMAFLEET`, its `/schedule`,
`/squadrons[/<id>]`, `/onboarding`, and `/votes[/<id>]`, `/organizations`, and
`/federations[/<id>]`) swaps the site header for its own menu bar
(`components/PermafleetHeader.js`: Overview, Schedule, Squadrons,
Organizations, Join), shown while the router sets `body.pf-section`. Votes and
federations are deliberately not in the menu; they are reached by link.
`/operations/PERMAFLEET/votes` is **alliance votes**: one vote per member org,
composed as a Fabric named **Federation** (`services/alliance.js`, pure parts in
`functions/allianceFederation.js`, Fabric Store `stores/alliance`,
`GOON_ALLIANCE_STORE`; page `components/PermafleetVotes.js` +
`assets/scripts/alliance-votes.js`). The roster is `contracts/alliance.json`
(`GOON_ALLIANCE_ROSTER`): `name`, `network`, `publisher`, and per org its
`symbol` and its Org Stewards' account keys (`discord:<id>`, `fabric:<pubkey>`).
Each org's validator key is derived from goon.vc's Fabric key (the relay's
`GOON_FABRIC_XPRV` / `stores/fabric`) at `m/7777'/1'/<index from the symbol>'`,
and goon.vc signs with it when one of that org's stewards votes; an org that
sets its own compressed `pubkey` holds its key and posts its own signed frames
to `POST /services/alliance/messages { frame }` (the buttons refuse it). The
descriptor is core's `FabricFederationDescriptor` (sorted validators,
threshold floor(n/2)+1, built by `@fabric/core` `Federation.buildDescriptor`
when the installed core has it, else identically here); its id is the sha256
of the descriptor. No vault or funds are used. Messages are signed
`CONTRACT_MESSAGE` frames under the federation id: `FederationInvite` (signed by
the publisher org), `FederationProposal` (`title`, `summary`, `createdAt`,
`closesAt`, at most 30 days), `FederationVote` (`proposalId`, `yes` | `no` |
`abstain`, `castAt`). The latest vote per org counts and may change while open
(an older `castAt` is refused); a proposal passes once `threshold` orgs vote
yes, fails once it no longer can, expires at `closesAt`, and is closed after.
Frames go to the mesh through the Fabric relay when a peer is connected.
Changing the orgs or their keys makes a new federation; older proposals keep
theirs. **Orgs of officers** (a nested multisig): an org that lists `officers`
(`fabric:<x-only>` or compressed keys, at most 16) and optionally `threshold`
(default a majority of them) is its own `FabricFederationDescriptor` of those
keys (publisher the first listed). Its alliance validator is goon.vc's key at
the index of sha256(`PERMAFLEET:<symbol>:<org federation id>`), so changing
its officers or threshold makes a new alliance federation; `custody` is
`officers`, and stewards can't propose or vote for it (409). Officers sign
with their own keys (`npm run alliance:sign -- pubkey | vote <proposal>
<choice> | propose "<title>"`, `scripts/alliance-sign.js`; `FABRIC_XPRV` or
`--key-file`, `--org`, `--origin`, `--print` for offline signing) frames under
the org federation id (`FederationProposal` / `FederationVote` with
`allianceFederationId` and `org`), posted to `POST …/messages` or pasted on
the proposal page. One officer's proposal has goon.vc sign the org's alliance
proposal; once `threshold` officers' latest votes agree, goon.vc signs the
org's alliance vote. Both carry `orgFederationId` and the officer frames as
`endorsements`, checked against the org descriptor by everyone who reads them.
An officer's latest vote counts (an older `castAt` is refused). If the agreed
choice loses its quorum and nothing else reaches it, the org's last alliance
vote stands. Routes: `GET /services/alliance` (federation, orgs, steward count,
each org federation, who you vote for and are an officer of, proposals),
`GET|POST /services/alliance/proposals`,
`GET /services/alliance/proposals/<id or 12-char prefix>` (each org's vote and
officer counts, every signed frame, org descriptors, officer votes),
`POST …/proposals/<id>/votes { choice, org? }` (401 signed out, 403 not a
steward), `GET /services/alliance/federations[/<id or 12-char prefix>]`.
**Member votes** (advisory; orgs still decide pass / fail): any goon.vc member
votes once per proposal, from Discord with `/vote` in any server the bot is in,
or on the proposal page (`POST …/proposals/<id>/member-votes { choice }`, 401
signed out; it uses the account they signed in with). goon.vc is a **Bridge**
(`functions/bridgeAttestation.js`): a `FabricBridge` v1 descriptor `{ name,
origin, platforms, pubkey }` (`alliance.bridge` settings; default
`G00N SQUAD Discord`, `siteUrl`, `discord` + `fabric`) with its key at
`m/7777'/2'/0'` of goon.vc's Fabric key; its id is the sha256 of the
descriptor (`GET /services/alliance/bridge`, also on the overview and every
proposal). Each account that votes (`platform:id`, so Slack or any other
adapter calls `Alliance#memberVote` the same way) gets a goon.vc-held key at
`m/7777'/3'/<a>'/<b>'` (two 31-bit slices of sha256(`bridge-account:<key>`):
stable, and not linkable to the account without the xprv), vouched for once
by a `BridgeAttestation` frame signed by the bridge key (`{ bridge, platform,
account: <account pubkey>, attestedAt }`, no id or name; kept at
`/attested/<platform:id>` and `/attested-key/<pubkey>`). The account key signs
a `FederationMemberVote` (`proposalId`, `choice`, `castAt`, `attestation`)
under the alliance federation id. A Fabric key linked to a member may sign its
own (no `attestation`; `npm run alliance:sign -- member-vote <proposal>
<choice>`, posted to `…/messages`); an unlinked key gets 403, as does an
attestation from another Bridge or a vote not signed by the attested key.
The latest vote per member counts, across their linked accounts and merges;
votes are taken only while the proposal is open (409), and an older `castAt`
from the same member is refused (409). Proposal JSON adds `members { yes, no,
abstain, total }`, the counted `memberVotes` frames (choice, time, platform,
account pubkey — no names, member ids, or account ids), `bridge`, and
`you.memberVote`; summaries add `members`.
`/federations` (`components/Federations.js` + `assets/scripts/federations.js`,
`federationsPath` in `GoonSPA`) lists every alliance federation and every org
federation of officers ever seen, current first (an org federation is indexed
at `/org-federation/<id>` with the alliances it decided for); each has a page
at `/federations/<12-char id>` with its signers, threshold, descriptor, and the
alliance's invite and proposals or the org's officers and alliances (link
previews from `Alliance#federationPage`). Vote JSON carries those `path`s and
the vote pages link to them. Public JSON carries steward and officer display names and counts —
never Discord ids or member ids. Officer pubkeys are public, because the org
descriptor must list them for anyone to check a vote. A broken roster leaves
votes off (503) without failing the site. Tests: `tests/alliance.js`.
`/operations/PERMAFLEET/onboarding` (`components/PermafleetOnboarding.js`) is
for leaders of orgs joining the Protectorate: open an embassy in #embassy, tag
pilots `[PERMAFLEET]` on RSI, name Org Stewards, set up their Discord; then
what we expect of every member org (its own #embassy channel, a public
PERMAFLEET voice channel, and the Prospect system for onboarding new members),
what member orgs get, and the ground rules. Its copy follows the pinned #getting-started,
#alliance, #embassy, and #rules posts on the G00N SQUAD Discord; keep it in step
with them. It is not in the menu bar; the overview's "Your org here" tile and
the `/organizations` call to action link to it.
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
else — a full bracket refuses latecomers. A player who drops out is
disqualified from an open set with the set's **DQ** control (`POST …/forfeits
{ match, side, players }`, `side` = who dropped): the set ends with no wins,
the opponent advances, and games already scored stay in the record so Undo
restores them. A tournament is `locked` for good once it has a champion:
edits then need the password (`tournaments.password`, env
`GOON_TOURNAMENTS_PASSWORD` only — unset = finished tournaments stay final;
409), sent as `X-Tournament-Password` (401 without it). The bracket's padlock
(top right) checks it with `POST …/unlock { password }` and keeps it in memory
only; five wrong passwords from one address (last `X-Forwarded-For` hop) in 15
minutes get 429. An edit that takes the champion away reopens the tournament
(logged `reopen`, `results` null) — still locked — until it is decided again.
Results post to the Open League (`Tournaments#report` → `onResults` →
`Leagues#recordTournament`) on completion and on every edit of a locked
tournament: every set played (byes and DQs skipped) is a duel tagged
`source { tournament, name, path, match }` and dated `playedAt` when the set
finished, so it rates in its place however late it posts; a changed result or
a reopened tournament voids the duels it no longer backs (`voided.tournament`),
and they come back with the result (duels voided by hand stay void). Start-up
syncs every locked tournament, and a failed post never fails the game. Link previews for series and
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
joins new names to the roster. A player given as a Discord `@handle` is looked
up in the home server (`discord.guildId`; `functions/discordDirectory.js`: REST
member search with the bot token — no privileged intent, start of a handle or
nickname, results cached a minute — plus the members the operations gateway
client has already seen, matched by any part of their handle, nickname, or
display name) and placed by that account like a `/1v1` player below. A handle
nobody there has, or one typed while Discord can't be asked, is logged as a
plain name without the `@`; a member found later claims an unlinked name equal
to their handle. The form suggests members as you type
from `GET …/<id>/handles?query=` (handles and display names only, never ids).
Ratings are never stored: `functions/elo.js`
replays the season's duels in the order they were played (`playedAt`, the log
time for duels logged by hand; ties keep logged order), and each duel moves
K × √(best of) × (1 − expected) from loser to winner (the set score is kept but
doesn't change the rating). Nothing is deleted: a wrong duel is voided (and can be
restored) with `POST …/duels/<duelId>/void|restore`, and every change is in
the league `log`. Seasonal leagues roll over with `POST …/<id>/seasons`, which
closes the current season, freezes its `standings` + `champion`, and starts
everyone at the initial rating again; a closed season's duels are final.
`PATCH …/<id>` edits name / tagline / summary / usual set. The pages are
`components/LeaguesPage.js` + `assets/scripts/leagues.js` (`?season=<n>` shows
a past season); link previews come from `Leagues#page`.
The **Fabric relay** (`services/fabricRelay.js`, packs in
`functions/discordFabricShare.js`) puts messages from the G00N SQUAD **public
channels** (`discord.guildId` only; text and announcement channels @everyone
can view, not age-restricted — never private channels, threads, voice chat, or
other servers) on the Fabric network as GoonCitizen chat, so star-citizen-live's
Chat lists those channels and their history without a bot of its own. It
listens on the operations gateway client, which then also asks for the
privileged Message Content intent (only when relaying). Each batch is a
GoonCitizen `GroupDataShare` `CONTRACT_MESSAGE` (`chat.catalog`: guild + public
channels, no members; `chat.messages`: id, author id + display name, body with
mentions as names and attachments as `[file]`, time; ≤ 12 channels × 20 messages
and 24 KiB per share) for one Federation group: `fabric.group`
(`GOON_FABRIC_GROUP`), sent under its `fabric.contract`
(`GOON_FABRIC_GROUP_CONTRACT`; default the GoonCitizen namespace). GoonCitizen
accepts them only while the relay key is a member of that group, so nothing
relays until `group` is set and the key is added there. The key is goon.vc's
own: `GOON_FABRIC_XPRV`, else generated once and kept in `stores/fabric`
(`GOON_FABRIC_STORE`); its pubkey is logged on start and served with seeds,
counts, and status at `GET /services/fabric` (never content). An outbound-only
core Peer dials `fabric.peers` (`GOON_FABRIC_PEERS`, default
`hub.fabric.pub:7777,relay.goon.vc:7777`, redialed every minute). New messages
and edits go out every 15 s (kept, up to 1000, while no peer is connected); on
ready the last 20 messages of each public channel are read, and the catalog plus
the newest 20 per channel are re-shared on connect and every 30 minutes for
peers that joined later. A deletion only stops re-sharing — peers keep what they
already have. `GOON_FABRIC_RELAY=0` turns it off.
Discord **application commands** (`services/commands.js`) are answered on that
same gateway client (interactions need no intents) and registered globally for
servers only when it is ready. The application is shared (today "sensemaker"),
so only these names are upserted, never `set()`, and unchanged ones are skipped.
Everyone who runs one in a server gets a goon.vc member profile: the command
links their Discord (`Members#linkDiscord`: the same member Discord login
signs in to, found by the `discord:<id>` account; not a login, and an existing
display name is kept),
even when the command is then refused. A button press links only on Confirm.
`/idlerpg profile [pilot]` | `leaderboard` | `stats` reply from `Presence`
(`discordPlayer`, `players`, `report`): public numbers and display names, with
links to the player pages. `/1v1 winner loser score [league] [note]` is run by
one of the two players (the Open League unless `league`, which autocompletes;
`score` is a choice from `1-0` to `5-4`, and best of n follows from the winner's
games). It stores a private proposal (`Leagues#proposeDuel`, `/proposal/<id>` in the leagues Store,
7 days to answer). It then posts a card with Confirm / Decline buttons
(`1v1:confirm|decline:<proposal>`) pinging only the opponent. The opponent's
Confirm (`Leagues#confirmDuel`) links them too and logs the duel, dated when it
was proposed, with `by` the proposer and `confirmedBy` the opponent. Decline
by the opponent, a withdrawal by the proposer, and expiry log nothing. The card
is rewritten with the outcome. Players are found by Discord account, not name:
a roster player carries a private `member` link (never in public JSON), so a
renamed member keeps their place. Links hold goon.vc member ids, compared
through `Members#resolve` (the opponent's side of a proposal stays the
`discord:<id>` account key until they confirm); `Leagues#relinkMembers` moves
older links to the member on start and after every merge, and when one member
holds two players in a league the first keeps the link (logged `merge`). An unlinked member claims an unlinked roster
name equal to their server display name (nickname, then display name) or their
handle, e.g. one typed into a tournament (logged `link`). Otherwise they join under it, or as
`name (username)` when another member holds the name. Bots and self-duels are refused.
Errors are ephemeral. Replies carry no Discord ids and ping no one except the
opponent asked to confirm. `/vote proposal choice` (any member, any server; `proposal`
autocompletes open alliance proposals by title or short id, `choice` is yes / no / abstain)
casts the caller's advisory member vote through `Alliance#memberVote` with their
`discord:<id>` account (Commands takes `alliance` lazily, since Alliance starts later)
and replies privately with the member and org counts and a link; it notes when the vote
replaced one from another of their accounts, and says when votes are not set up.
`GOON_COMMANDS=0` turns the commands off.
`/goon setup` (server-only, `default_member_permissions` Manage Server, registered only
while DM scripts run; `/goon` carries only the subcommands whose feature runs, and
is not registered without either) re-checks the caller's Manage Server permission, then starts the
`goon-setup` script in their DMs (`Community#beginScript`, subject = the guild) and
replies privately "Check your DMs", or how to allow DMs from server members when
Discord refuses (50007). It defers its reply because the script reads permissions
from Discord and sends the DM first.
**DM setup scripts** (`services/community.js`) run on Doorman's Scripts plugin
(`@fabric/doorman/services/scripts`): data-only JSON conversations seeded from
`contracts/scripts/*.json` into a Fabric Store (`community.path`,
`GOON_COMMUNITY_STORE`, default `stores/community`), versioned by content hash
(a running session keeps its version; a seed never overwrites a runtime edit).
The Doorman Discord adapter has `whispers: true`: each step is a DM with buttons
(≤ 5 choices), a select menu (paged by 25), Continue, or an Answer button that
opens a modal, plus Skip / Cancel; presses on `doorman:<session>:<step>:…`
custom ids are answers (Commands ignores them), and a typed DM reply works too.
The gateway then also asks for the `DirectMessages` intent (not privileged) and
the `Channel` partial (`Community.INTENTS` / `PARTIALS`). DMs are answered only
by a running session; everything else stays unanswered. Community registers the
choice sources `discord.guild.textChannels` / `discord.guild.voiceChannels`
(names, in server order, noting permissions the bot lacks there) and
`goon.features`, and the `ManageGuild` requirement, read fresh from Discord
(`members.fetch({ force: true })`; the owner always passes) when the session
starts and again before the answers are recorded. `goon-setup` asks for the
features wanted (schedule calendar, clips, IdleRPG announcements, PERMAFLEET
membership), then only the matching steps (PERMAFLEET schedule or own calendar,
clips channel, IdleRPG channel, org name / RSI symbol and Org Stewards), shows
the guild-wide permissions the bot is missing with the `/services/discord/invite`
link, and confirms a summary. Completion runs `record`: the latest answers per
guild in the Store. **Nothing reads them yet**; services still take their
config from `settings/local.js`.
**PERMAFLEET channel scripts** set up the channels every member org keeps on
its own Discord, one script each, started like `goon-setup` (same checks,
registered with it) by `/goon council` (`permafleet-council`), `/goon embassy`
(`permafleet-embassy`), `/goon permafleet` (`permafleet-channel`), and
`/goon voice` (`permafleet-voice`). Specs live in `functions/allianceChannels.js`:
`#council` is private (@everyone denied View; the roles the admin picks and the
bot's own member get View / Send / Read History) — where the org's officers
settle alliance votes; `#embassy` and `#permafleet` are text channels and
`PERMAFLEET` a voice channel, all public (@everyone allowed View / Send / Read
History, or View / Connect / Speak). Each asks
whether to create the channel (choice source `permafleet.channels.<kind>`:
"Create …" then the server's channels of that type, likely matches first), then
a category (`discord.guild.categories`, optional), for `#council` the roles
(`discord.guild.roles`: highest first, no @everyone or managed roles), shows
what the bot lacks only when it lacks something, and confirms. Picking an
existing channel uses it as is. On completion the `permafleet.channel` action
(`Community#createChannel`) uses that channel, or one the server already has
by that name (case, emoji, and separators ignored), or creates it with
`guild.channels.create` (reason names the admin and command; existing channels
keep their permissions), and returns `{ channelId, created }` and a `<#id>`
line for the completion DM, so `record` keeps the channel. Creating needs the
bot to hold Manage Channels plus every permission it grants there (no Manage
Roles); otherwise the admin gets that list and
`/services/discord/invite?for=channels` (Manage Channels, View, Send, Read
History, Connect, Speak; re-running an invite updates a bot already in the
server), and nothing is created or recorded. Refusals reach the admin through
Doorman's exposed action errors. Sessions expire after a day; starting again
replaces an open one. The API is `GET /services/doorman/scripts[/<id>[/stats]]`
(open, no user ids) and, with `Authorization: Bearer $GOON_SCRIPTS_TOKEN`,
`PUT /services/doorman/scripts/<id>` (new version, hot) and
`GET /services/doorman/scripts/<id>/results` (who answered, and what); without
the token those two answer 404. Copy follows `PermafleetOnboarding`; keep the two
in step. An installed `@fabric/doorman` without the Scripts plugin leaves DM
scripts off (no intent, no `/goon`); `GOON_COMMUNITY=0` turns them off too, and
the Doorman host keeps running for IdleRPG either way. Settings:
`community.{enabled,path,scripts,token}`. `tests/community.js` loads Doorman from
`../doorman` (or `FABRIC_DOORMAN`) and is skipped when that checkout has no Scripts.
**Campaigns** (opt-in: `GOON_CAMPAIGNS=1`) DM one message, or a Start button for a
script, to a group of a server's members, on Doorman's Campaigns plugin
(`@fabric/doorman/services/campaigns`) plugged into the same Doorman host
(Fabric Store `community.campaigns.path`, `GOON_CAMPAIGNS_STORE`, default
`stores/campaigns`). Listing members needs the **privileged Server Members
intent**: turn it on for the bot in the Discord Developer Portal before setting
`GOON_CAMPAIGNS=1`, because Discord refuses the whole gateway connection when an
intent it hasn't granted is asked for. Only then does the gateway ask for
`GuildMembers` (plus `DirectMessages` / `Channel` as for scripts;
`Community.gateway(settings)` says which). Community supplies the `discord`
audience (`Community#discordAudience`: `guild.members.fetch()` for each server
the bot is in, or only the campaign's own server; role and exclusion filters;
never bots) and the activity hook (`Presence#lastSeen`: last time the member was
present in voice), and lists the scripts a campaign may offer (those without
`requires`). `/goon campaign message [role] [exclude_role] [active_days] [script]
[send_at]` (Manage Server; registered only while campaigns run) saves a draft
owned by the server and shows its author a private preview: the message, how
many members it reaches, who is skipped (excluded role, opted out, not in voice
lately), and Send — or Schedule, when `send_at` is "in 2 hours" or a date up to
30 days ahead — plus Cancel (`campaign:send|schedule|cancel:<id>[:<unix>]`).
Only the author may press them, and Send re-checks Manage Server fresh from
Discord. A server campaign reaches only that server, at most 500 members
(`maxAudience`; over it, only Cancel is offered), one per server a day
(`guildCooldownMs`), one DM every 2 s (`intervalMs`). Each DM says "Sent by
<server> via goon.vc" and has Stop messages from <server> / Stop all buttons
(`doorman-c:<campaign>:…`; typing STOP works for a week); opt-outs are kept and
skipped by every later campaign. Recipients and opt-outs are never served; the
report and API return counts. The API is `/services/doorman/campaigns` (list,
create, edit drafts, preview, schedule, pause, resume, cancel), all behind
`Authorization: Bearer $GOON_SCRIPTS_TOKEN` (404 without it). Settings:
`community.campaigns.{enabled,path,intervalMs,maxAudience,guildCooldownMs}`. Like
scripts, an installed `@fabric/doorman` without the plugin leaves campaigns off.
**Recruiting** (`contracts/recruiting.json`, `functions/recruiting.js`) is one
staff campaign per unit — TURTLE BRIGADE (FPS), BRAVO SQUADRON (dogfighting),
PERMAFLEET OFFICERS — reaching G00N SQUAD members who hold the rank just beneath
it in `contracts/roles.dot` (`qualified`: Prospect IV; Prospect roles are
cumulative on Discord, so V and VI hold it too) and none of the unit's `roles`
(the unit and everything above it: SHELLBACK, ALPHA SQUADRON, the officer and
command ranks), present in voice within `activeWithinDays` (30). Its Start button
opens the unit's DM script (`contracts/scripts/recruit-*.json`: experience,
unit questions, region and play times, RSI handle, the squadron application for
squadrons, notes, a summary to confirm), recorded per member for leadership
(`GET /services/doorman/scripts/<id>/results`). The scripts `requires` the
`qualified.name` role, which `Community#authorize` checks fresh from Discord at
start and before recording (`community.roles`: requirement name → role ids;
the owner gets no pass), so `/goon campaign` never offers them. Copy says
Prospect IV makes a member eligible and leadership selects; elite units are what
the best go on to. `npm run campaigns:recruiting` (needs `GOON_SCRIPTS_TOKEN`
and a server with `GOON_CAMPAIGNS=1`; `--unit`, `--origin`) saves or updates
the drafts through the campaigns API and prints each reach; `--send` or
`--at <date>` sends. A re-run skips members an earlier campaign for the unit
already reached (`excludeCampaigns`) and leaves one that is scheduled, sending,
or paused alone.
`/clips` is the public clip library and editor (`services/clips.js`, `GOON_CLIPS_STORE`
default `stores/clips`: a Fabric Store plus `media/`, `renders/`, `tmp/`; routes
under `/services/clips`). No sign-in: anyone may browse, edit, and render; a
signed-in member's display name goes on their changes (`identify`), otherwise
`null`. A render of a project revision that is queued, running, or done is
reused, and new renders are refused (429) while `maxQueuedRenders` wait.
Discord REST only: every guild the bot is in (`clips.guilds` narrows it), text,
announcement, forum, and media channels matching `clips.channels`
(`GOON_CLIPS_CHANNELS`; id, exact name, or `"/regex/"`; default names with
"clip(s)"/"video(s)"/"screenshot(s)") plus every media channel (`mediaChannels`), and the
active + archived public threads under them (forum / media posts are threads),
are polled every `ttlMs` with an `after=` cursor per channel or thread (90 days
of backfill for a new one; skipped while its `last_message_id` is behind the
cursor; `GOON_CLIPS=0` serves stored clips only). `npm run collect:clips`
(`scripts/clips.js`; stop the server first — one process per Store) reads the
whole history of those channels and threads in every guild (`--channel`,
`--guild` narrow it; `--days`, `--no-proxies`) and builds the proxies; it saves its
cursor every page, so a rerun resumes and stored clips are kept. Video attachments and video embeds
become clips. PNG / JPEG / WebP attachments (not GIFs) become **screenshots**
(`media: 'image'`; everything else, including records saved before screenshots,
is a video): a preview at most `stillHeight` (720p) tall served as the clip's
`proxy` (`image/jpeg`), a one-frame sprite, and the original kept as the
master. A screenshot is dated like a clip (ShadowPlay screenshot names match
its pattern) and sits in the sessions and tracks for `stillSeconds` (5 s; the
public `durationMs`, so blocks, lanes, and session span work unchanged;
sessions count `screenshotCount` inside `clipCount`). In a project its segment
is `{ in: 0, out }`, `out` being how long it shows (≤ `maxStillSeconds`, 60 s;
added at `stillSeconds`), rendered as a looped still (`-loop 1`) over silence.
Medal links (most #clips posts) are downloaded with yt-dlp and
become local clips too; other hosts stay link-only unless listed in
`externalLinks` (`GOON_CLIPS_LINKS`: unset = `medal.tv`, `1`/`all` = YouTube,
Streamable, and Twitch as well, `0` = none, or a host list; `collect:clips --
--links` = all). Every start queues stored link-only clips whose host is now listed. A
clip is marked `failed` after 3 attempts, but a missing tool never spends one:
processing pauses with the clips still queued, and every start requeues clips
that failed for a missing tool or codec (`Clips#retryFailed`;
`collect:clips -- --retry-failed` retries every failure). Every failure is
retried when `ffmpeg -version` or `yt-dlp --version` differs from the last one
seen (Store `/tools`, checked on start and hourly — yt-dlp's site extractors
break when a host changes its pages, and an upgrade fixes them), and the hourly
pass (`Clips#maintain`) retries failures over `recheckAfterMs` (a week) old. The durable source is guild / channel / message / attachment
— CDN URLs expire and are re-signed with `POST /attachments/refresh-urls` (a
404 on the message means it was deleted). Each clip is downloaded, probed, and
gets a 240p/15 fps proxy plus a thumbnail sprite (needs `ffmpeg` + `ffprobe`;
`npm run check:video` checks a host — codecs, filters, the real commands on a
generated clip, yt-dlp, disk, Discord CDN — and exits 1 on a gap). The download
itself (up to `maxSourceHeight`, 1080p) is kept as the clip's **master** in
`masters/` (`keepMasters`, `GOON_CLIPS_MASTERS=0` turns it off; none are stored
while the disk has under `minFreeBytes`, 20 GB, `GOON_CLIPS_MIN_FREE_GB`). Every
download (proxy build or rescan) waits, without spending an attempt, until its
largest allowed size (`maxDownloadBytes`, 1 GB) still leaves `minFreeBytes`
free. A rescan pass every
`rescanEveryMs` (hourly, `rescanBatch` clips) stores masters for ready clips
that lack one and asks yt-dlp (`-J`, no download) whether a link clip not
checked for `recheckAfterMs` (a week) now offers a taller version, downloading
it and rebuilding the proxy when it does; uploads are fixed files and are left
alone once stored (`collect:clips -- --rescan` runs a full pass). Recording time
(`functions/clipRecordingTime.js`): the **original file name is the authority**.
Recorder patterns (ShadowPlay, Medal, Game Bar, OBS, ReLive, VLC, compact, Unix
ms; Discord's `_` for spaces accepted) are read anywhere in the name, and a
re-recorded name holding several times (`vlc-record-<t>-<original>`) dates to the
earliest. A name time is local wall time; file **metadata** only supplies hints
(`functions/mediaTimeTags.js`: container tags such as `creation_time` and
QuickTime `creationdate`, EXIF / PNG `tIME` / text / WebP / XMP for screenshots,
kept on the record as `timeTags`). The zone comes from a hint with an explicit
offset, else a UTC hint a real zone offset away from the name time (within 90 s,
at the recording's start or end), else the author's remembered offset (learned
only from metadata zones), else the zone that ends the recording closest before
the post (or the host's upload — yt-dlp's `timestamp`, stored as `uploadedAt` —
when earlier), else the default zone. Game Bar dates are read month- or day-first,
whichever fits. With no name time, a metadata time is used, then the bound minus
the duration (`uploaded` / `posted`). `recording` carries `source`, `zone`, and
the hint `field`; every start re-dates stored clips under the current rules
(`Clips#redate`, no downloads). Anyone can override it or nudge sync (±10 min), and every
change is in the clip `log`. `functions/clipTimeline.js` groups clips into
play sessions (a new one after 2 hours without a clip, `sessionGapMs`;
multi-hour sessions stay whole, separate evenings don't merge) with one track per pilot. `/clips` is
`<clip-library>` (`assets/scripts/clip-library.js`): each session is a card
that wraps beside the others (as wide as up to four of its clips; bigger
sessions take the row) holding clip cards (sprite thumbnail with hover scrub, pilot, recorded time, length or "Screenshot", caption),
search + pilot / channel / sort / link / screenshot filters, a player (`?clip=<id>`) with
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
`mov_text` subtitle track. **Stream VODs**: text and announcement channels
matching `clips.streams.channels` (`GOON_CLIPS_STREAM_CHANNELS`; default names
with "stream(s)", i.e. G00N SQUAD #streams, where Streamcord and members post
go-live links) are polled with the clip channels, and every Twitch link in a
post (content, embeds, link buttons; `functions/streamAnnouncements.js`) is
saved as an announcement (`/streams/<message>-<login|vVOD>` in the clips Store:
`waiting` → `collected` | `none` | `missed`). `Clips#collectStreams` (each
background pass, an announcement at most every `checkEveryMs`, 30 min) lists
the channel's latest `archives` (20) past broadcasts with yt-dlp (`--print`,
no download; a linked `videos/<id>` is looked up by itself), picks the VOD
live at the announcement (started by 10 min after it, still running then), and
once it has ended and settled `settleMs` (30 min) adds it as one clip per VOD
(`twitch-v<id>`, a link clip with `stream { platform, channel, vodId }`, the
streamer's Twitch display name as author — not their Discord name — and the
VOD title as caption). Re-announcements share it. No VOD 6 h after the
announcement (the streamer keeps none, or the channel is unknown) = `none`; still
unfinished after `waitDays` (60) = `missed`. The VOD's go-live time
(`startedAt`) dates it as recording source `broadcast` (when no later than
10 min past the post and at most 60 days before it). VODs download at
`streams.maxSourceHeight` (720p) up to `streams.maxDownloadBytes` (8 GB) and
wait, without spending an attempt, while free disk is under `minFreeBytes`
plus that; rescans never re-check them. `GOON_CLIPS_STREAMS=links` keeps VODs
link-only, `0` turns announcements off; `collect:clips -- --stream-channel
'/streams/'` reads only the matching announcement channels and collects their VODs.
`list()` status carries `vods` and `streams { waiting, collected, none, missed }`.
Responses carry display names only — never Discord user ids or CDN URLs.
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
**Identity is cumulative** (`services/members.js`, like GoonCitizen's actor
rollup). A member is a permanent random id (16 hex characters) holding any
number of proven **accounts**, each an account key `platform:id`
(`functions/accountKey.js`: `discord:<snowflake>`, `fabric:<lowercase x-only
pubkey>`, and any other `[a-z][a-z0-9-]*` platform later, e.g. Slack or RSI,
with no model change). Store records: `/members/<id>`, `/accounts/<key>` →
member, `/aliases/<old id>` → member. Proof is always the account's own
sign-in inside an existing session: signed in, the login page's buttons become
**Link** (`GET /services/members/discord?link=1` keeps the member in the
OAuth state; `POST /services/members/passport { link: true }` for Passport or
desktop); a login while signed out never links. After every Passport sign-in
or link, the Hub that signed it is asked for the key's device cluster
(`GET /identity/cluster?pubkey=`, mutual IdentityCrossSign) and those keys are
linked `via: cluster`; keys a later answer no longer lists (a revoke) are
dropped, and a Hub that cannot answer changes nothing. Running a Discord
command links `via: command`; a `@handle` typed into a duel makes a placeholder
member `via: directory`. Linking an account another member already holds
**merges** them: the older member survives with its name and avatar, accounts
and logs combine, the other id becomes an alias (`mergedInto`), and `merged
{ from, into }` is emitted. Members saved before accounts
(`/members/discord:<id>`, `/members/fabric:<id>`) are adopted on first touch
with their history, so old session cookies and roster links keep working.
`GET /services/members/accounts` lists the signed-in member's accounts and
`DELETE /services/members/accounts/<key>` unlinks one (with the cluster keys
it brought); the last account cannot be unlinked (409). Session JSON carries
the member id, display name, linked platforms, and the login used
(`provider`), never account ids.

GoonCitizen release docs: `star-citizen-live/AGENTS.md`. Hub/core:
`docs/PRODUCTION*.md`. Human call for GoonCitizen contributors (not this zipper):
`star-citizen-live/DEVELOPERS.md`. This tree: [`DEVELOPERS.md`](DEVELOPERS.md),
[`SECURITY.md`](SECURITY.md).
