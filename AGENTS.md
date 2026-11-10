# goon.vc Agent Hints (AI)

Public **HTML zipper** for the Fabric suite. Do not grow this tree back into a Hub
or a GoonCitizen relay.

**Topology (PLAN.md):**
1. `goon.vc` — this repo: GoonSPA HTML + same-origin Hub API proxy
2. `relay.goon.vc` — GoonCitizen LiveRelay (`star-citizen-live`)
3. `hub.fabric.pub` — generic Fabric Hub (contract registry, Beacon, `/sessions` owner);
   `hub.goon.vc` is the same Hub under a second name

**What this process is:** `@fabric/http` `HTTPServer` serving `assets/` and
reverse-proxying the linked-signer rendezvous and mailbox (`/delegations`,
`/services/delegation/mailbox`; delegation frames, `@fabric/core`
`docs/DELEGATION.md`) and `/services/rpc` (goon.vc's cookies never go to a
Hub, and a Hub's `Set-Cookie` never comes back) to `FABRIC_HUB_ORIGIN`
(default `https://hub.fabric.pub`), then `hub.seeds` (`FABRIC_HUB_SEEDS`, default
`https://hub.goon.vc`) in order when the ones before can't be reached at all
(DNS / refused — never after a Hub answered or timed out). The proxy (and the
Hub mailboxes below) share one list (`createHubList` in `functions/hubApiProxy.js`)
that sticks to the Hub that answered last; seeds outside the `@fabric/http`
Hub allowlist are skipped, and none are used behind a loopback Hub. No Fabric Peer listen (the
Fabric relay below only dials out), no bitcoind, no
`/services/star-citizen`. The one Bitcoin signing it does is the Market's
(below): goon.vc signs Fabric frames and, as escrow arbiter only, withdrawal
signatures through the core federation helpers; it never holds a buyer's or
seller's key, and the coins sit in a vault the Hub watches. The one Discord gateway client is the metrics bot
below (non-privileged intents unless the Fabric relay, the Market forum mirror, or campaigns are configured, `autoCommands: false`); it never answers chat,
only the `/idlerpg`, `/1v1`, `/vote`, `/market`, `/rsi`, `/hangar`, `/clips`, `/goon`, and `/help` application commands, and DMs only when a command starts it: inside a setup
script a server admin started with `/goon setup` (or `/goon council`, `embassy`,
`permafleet`, `voice`, `roles`, which also create those channels and Prospect ranks on the admin's server
when the bot may and the admin is one of the org's officers on record), the hangar walkthrough a member started with `/hangar guide`,
the review list a reviewer asked for with `/goon review`, or a broadcast someone
sent with `/goon campaign`, `checkins`, or `welcome` after a preview naming
every recipient. Favicons are the G00N SQUAD
skull, the org's RSI logo (`logoUrl` in `contracts/organizations.json`), not the
Fabric suite lettermark.
`/events` lists upcoming Discord Guild Scheduled Events from every server the
configured bot token can see (`GET /services/events`, REST only — no gateway
bot). Events are saved per guild in an on-disk Fabric Store (`stores/events`,
LevelDB) and requests are always answered from disk; Discord is polled on start
and every `ttlMs` in the background, a failing guild keeps its last saved events,
and the copy is served `stale` while Discord is unreachable. The page is a
single `<fabric-calendar>` Web Component (`components/FabricCalendar.js`,
no goon.vc dependencies — the template for a Fabric-wide calendar control). It
shows the same week board as the PERMAFLEET schedule (`functions/scheduleGraphic.js`),
rendered live from that copy at `GET /services/events/schedule.svg?server=<id>&tz=<IANA zone>`
(endpoint default `America/Chicago`). Heading, description, counts, and every
control live on the board: the title picks the server, the zone label picks the
zone (default: the visitor's local zone; remembered in `localStorage`, kept in
`?tz=`), the footer downloads the SVG. The board's `#schedule-*` text ids are
the element's contract. `/operations/PERMAFLEET/schedule` is the same element
pinned to `server=permafleet`: the home server's events plus those of the member
orgs' and squadrons' servers in `discord.schedule.servers` (`DISCORD_SCHEDULE_SERVERS`; today
4M-CONTRACTORS, TRDE, Risky Business (IDBC), and SC Shellback (SHELLBACK) — a listed server's events show once the bot is
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
All UI lives in `components/`. Browser code too large to inline is one
function in its component — a page's `client()`, or a Web Component's
`define<Element>(root)` in its own module — that `npm run build` compiles
(`functions/clientScript.js`, `GoonSPA#clientScripts`) to
`assets/scripts/<name>.js`, loaded with a deferred `<script>` at
`<name>.js?v=<first 12 hex of its sha256>`; that exact URL is served
`Cache-Control: public, max-age=31536000, immutable`
(`GoonVC#_clientScriptCacheMiddleware`), any other revalidates. Only the
function's source reaches the browser, so it can't use anything from its module.
`assets/scripts/` is build output, tracked like `index.html`:
`tests/clientScripts.js` fails on a hand-written or stale file there, or an
`index.html` not built with the current versions.
The home page's "Subscribe on Discord" block lists the G00N guild's purchasable
Server Subscription tiers from `GET /services/discord/subscriptions` (tier roles
tagged `subscription_listing_id` + `available_for_purchase`, saved in the events
Store). Bots cannot read listing prices or perks, so the button links to
Discord's subscriptions page; the block stays hidden when there are no tiers.
The home page shows a G00N SQUAD overview (copy in `GoonSPA` `overviewParagraphs`,
facts from the G00N record) and our own Discord member list built from the
guild's public `widget.json` (no iframe). The PERMAFLEET operation page
lists people in voice the same way, one widget per unique member-org Discord
in `contracts/alliance.json` (DOUBLEDOGZ shares G00N SQUAD, so once; a server
with its widget off contributes nobody), names and avatars only — never
Discord ids. PERMAFLEET detail lives under
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
The G00N SQUAD Discord's live channel and Prospect role ids live in
`contracts/goon-squad.json` (`#clips`, `#embassy`, the PERMAFLEET voice channel,
Prospect I–VI); PERMAFLEET setup matches those ids on that server even after a
rename. `/operations` lists the operations in `contracts/operations.json` — currently
only PERMAFLEET, whose **metrics** count members in voice on every member-org
Discord (`guilds: "alliance"` in `contracts/operations.json`, unique
`guildId`s from `contracts/alliance.json`; a channel matcher of `"/./"` is
every voice channel the bot can see there). Each entry names the Discord
channels its metrics count (channel id, exact name, or `"/regex/"`). `services/operations.js` runs a `@fabric/discord`
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
exactly one gateway client and one Doorman. Apart from application command replies and the Market forum mirror (below), the only thing it posts is IdleRPG game
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
`Presence#backfillNames` on gateway ready. The name shown on the G00N SQUAD
server — its server nickname, else the global display name, else the username —
outranks a nickname from any other server the bot is in, which outranks a
global display name, which outranks a username. IdleRPG keeps the
highest-ranked name it has seen (`nameRank` on the player); a later sighting
replaces it only at the same or a higher rank, so a chat username or another
server's nick cannot cover the G00N SQUAD name. A same-rank sighting still
updates it, so a new G00N SQUAD nickname replaces the old one. Backfill reads
the member cache and, until a player has a G00N SQUAD name, asks that server
once. `/resources` lists an
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
`GOON_ALLIANCE_STORE`; page `components/PermafleetVotes.js`). The roster is `contracts/alliance.json`
(`GOON_ALLIANCE_ROSTER`): `name`, `network`, `publisher`, and per org its
`symbol` and its `officers` (below). G00N SQUAD's officers on record are
remaeus, kersa (neorion), and thejohnram. INFN's officer on record is
ADSVOLCANO. **Only officers vote for an org**;
leadership puts them on record by account, and there is no other role in the
vote. **User-facing copy never mentions keys**: officers and members sign in
and press a button (or run `/vote`), and goon.vc signs for them. An org with
an empty `officers` list has none on record (`custody` `none`): goon.vc
derives its validator key at `m/7777'/1'/<index from the symbol>'` of
goon.vc's Fabric key (the relay's `GOON_FABRIC_XPRV` / `stores/fabric`) but
never signs with it, frames from it are refused (403), and the org doesn't
vote until leadership lists its officers — with fewer than `threshold` such
orgs nothing can pass (the overview's `federation.voting` counts the orgs that
can vote, and the page says so). An org that sets its own compressed `pubkey`
instead (`custody` `own`) casts its own one vote by posting signed frames to
`POST /services/alliance/messages { frame }`. The
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
theirs. **Orgs of officers** (a nested multisig): an org's `officers` are
account keys (`discord:<id>`, any `platform:id`; at most 16), with an optional
`threshold` (default a majority of them). goon.vc holds one officer key per
account at `m/7777'/5'/<a>'/<b>'` (two 31-bit slices of
sha256(`alliance-officer:<account>`); apart from the member-vote keys below,
so an officer's signature can't be matched to their member vote), and the org
is its own `FabricFederationDescriptor` of those keys (publisher the first
officer's). Its alliance validator is goon.vc's key at the index of
sha256(`PERMAFLEET:<symbol>:<org federation id>`), so changing its officers or
threshold makes a new alliance federation; `custody` is `officers`. A
signed-in officer (any account linked to their goon.vc member that is on the
roster; `Alliance#actor` / `actorFor`) proposes with `POST
/services/alliance/proposals { title, summary?, days?, org? }` (1–30 days,
default 7; `org` only when they are an officer of several) and votes with
`POST …/proposals/<id>/votes { choice, org? }` (signed out 401, not on
record 403); the proposal page has the form and Yes / No / Abstain buttons,
and `/vote` on Discord does the same. goon.vc signs the officer frame under
the org federation id (`FederationProposal` / `FederationVote` with
`allianceFederationId` and `org`) with that officer's key. One officer's
proposal has goon.vc sign the org's alliance proposal; once `threshold`
officers' latest votes agree, goon.vc signs the org's alliance vote. Both
carry `orgFederationId` and the officer frames as `endorsements`, checked
against the org descriptor by everyone who reads them; officer frames reach
the mesh only inside them. A vote signs for every org of the proposal the
officer sits for, and their latest vote counts. An officer's vote is also
their advisory member vote (cast first, so it lands even when the officer
vote closes the proposal). If the agreed choice loses its quorum and nothing
else reaches it, the org's last alliance vote stands. **Officers see each
other**: each officer's latest vote (`officerVotes`, with display name and
`officer` index), the org's yes / no / abstain / waiting counts, and the
names behind the org's vote are served only to that org's officers; everyone
else sees the org's vote, its `officers { threshold, total }`, and the signed
frames. Routes: `GET /services/organizations` (each org's Discord `{ linked,
name }`, no guild ids), `GET /services/alliance` (federation, orgs and their custody,
`voting`, each org federation, the orgs you are an officer of
(`you.officers`), proposals), `GET /services/alliance/proposals`,
`GET /services/alliance/proposals/<id or 12-char prefix>` (each org's vote,
every signed frame, org descriptors, and for officers `you.officers` with
their own latest choice), the two writes above,
`POST /services/alliance/messages { frame }` (own-key orgs and signed frames
from the mesh), `GET /services/alliance/federations[/<id or 12-char prefix>]`.
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
under the alliance federation id. `…/messages` also takes a member vote
signed by a Fabric account linked to a member (no `attestation`; not offered
in the UI); a key no member holds gets 403, as does an attestation from
another Bridge or a vote not signed by the attested key.
The latest vote per member counts, across their linked accounts and merges;
votes are taken only while the proposal is open (409), and an older `castAt`
from the same member is refused (409). Proposal JSON adds `members { yes, no,
abstain, total }`, the counted `memberVotes` frames (choice, time, platform,
account pubkey — no names, member ids, or account ids), `bridge`, and
`you.memberVote`; summaries add `members`.
`/federations` (`components/Federations.js`,
`federationsPath` in `GoonSPA`) lists every alliance federation and every org
federation of officers ever seen, current first (an org federation is indexed
at `/org-federation/<id>` with the alliances it decided for); each has a page
at `/federations/<12-char id>` with its signers, threshold, descriptor, and the
alliance's invite and proposals or the org's officers and alliances (link
previews from `Alliance#federationPage`). Vote JSON carries those `path`s and
the vote pages link to them. Public JSON carries officer display names and counts —
never Discord ids, account keys, or member ids; federation pages list officers by
name only (the descriptor still lists their keys so anyone can check a vote). A broken roster leaves
votes off (503) without failing the site. Tests: `tests/alliance.js`.
`/operations/PERMAFLEET/onboarding` (`components/PermafleetOnboarding.js`) is
for leaders of orgs joining the Protectorate: open an embassy in #embassy, tag
pilots `[PERMAFLEET]` on RSI, name their officers, set up their Discord; then
what we expect of every member org (its own #embassy channel, a public
PERMAFLEET voice channel, and the Prospect system for onboarding new members),
what member orgs get, and the ground rules. Its copy follows the pinned #getting-started,
#alliance, #embassy, and #rules posts on the G00N SQUAD Discord; keep it in step
with them. It is not in the menu bar; the overview's "Your org here" tile and
the `/organizations` call to action link to it.
`/organizations` (plus `/organizations/<SYMBOL>`) lists PERMAFLEET member orgs
from `contracts/organizations.json`, a plain-text snapshot of public RSI org
pages refreshed by `npm run build:organizations` (never fetched at serve time).
Each org card, profile, PERMAFLEET overview tile, onboarding list, and votes
org row shows whether the bot is in that org's Discord (`guildId` on
`contracts/alliance.json`; DOUBLEDOGZ shares the G00N SQUAD server; LCRP has
none on record). Live status is `GET /services/organizations`
(`{ symbol, name, path, discord: { linked, name } }`, names only — never guild
ids), filled by `Organizations.client()` from `Events.list().guilds`. An org
with no `guildId`, or one the bot is not in, shows as not linked. `guildId` is
not part of the alliance federation descriptor.
`/red-army` is **RED ARMY**: Discord servers and organizations that have added
the goon.vc bot but are not yet PERMAFLEET members (`contracts/red-army.json`,
`services/redArmy.js`, `functions/redArmy.js` — not a vote and not a Fabric
federation). Named orgs list officers on record (Robert's Rejects / mr_meaner,
SHELLBACKS / Brock_85); SHELLBACKS is the Shellback Industries org, not the
SHELLBACK elite infantry squadron. Monkey Business is the next org joining.
Alliance friends with PERMAFLEET Officer overlap or a mention on the G00N
`#red-army` pin (BLACK EXODUS, Rintak, SC Homies) sit here too until they are
members. Named `servers` are Discords not tied to an RSI org (DIA is a private
Discord). Other servers the bot is in show up live, minus the home server,
alliance `guildId`s, and an ignore list (personal and Fabric-suite servers).
Live status is `GET /services/red-army` (`organizations` + `servers`, each
`{ name, discord: { linked, name }, officers: [{ name }] }`, names only —
never guild ids, account keys, or member ids), filled by `RedArmyPage.client()`.
The G00N Discord role RED ARMY is pinned in `contracts/goon-squad.json`. The
`/organizations` index and the PERMAFLEET operation page (below the squadrons
path, after the member tiles) teaser it.
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
(`components/MeleeRotationDrill.js`, shadow DOM, no goon.vc dependencies)
runs only while visible, takes `heading` / `eyebrow` / `description` /
`pilots` / `storage-key` / `auto-every` / `fonts="none"` attributes,
and emits `splash` + `rosterchange`. Add a drill = a new element component plus a
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
(`components/TournamentBracket.js`, shadow DOM, no goon.vc dependencies):
with `src` it loads and saves a record through that API, without it it keeps a
bracket in `localStorage`. `components/TournamentsPage.js` drives the index,
series, and record pages. In Node the bracket component exports its pure engine, shared with the service
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
the league `log`. A logged duel is a past result: editing it (`PATCH
…/<id>/duels/<duelId>`: `winner`, `loser`, `bestOf`, `score`, `playedAt`,
`note`; roster names, new ones join) needs the password (`leagues.password`,
env `GOON_LEAGUES_PASSWORD`, else `GOON_TOURNAMENTS_PASSWORD`; unset = duels
stay as logged, 409), sent as `X-League-Password` (401 without it). The league
page's padlock (top right, current season only) checks it with `POST
…/<id>/unlock { password }`, keeps it in memory only, and adds Edit to each
duel; five wrong passwords from one address in 15 minutes get 429, as for
tournaments. An edit marks the duel `edited { at, by }` and logs `edit` with
each changed field's `before` and `after`. Tournament sets are edited in their
tournament (409) and closed seasons stay final. Seasonal leagues roll over with `POST …/<id>/seasons`, which
closes the current season, freezes its `standings` + `champion`, and starts
everyone at the initial rating again; a closed season's duels are final.
`PATCH …/<id>` edits name / tagline / summary / usual set. The pages are
`components/LeaguesPage.js` (`?season=<n>` shows
a past season); link previews come from `Leagues#page`.
**Market** (`/services/market`; `services/market.js`, Fabric Store
`stores/market`, `GOON_MARKET_STORE`; pure parts in `functions/marketPost.js`
and `functions/marketEscrow.js`; page `components/MarketPage.js`) is the G00N SQUAD Market forum on the web, 1:1:
every thread of the forum (`market.forum`, `GOON_MARKET_FORUM`: id, exact name,
or `"/regex/"` in `discord.guildId`, default `/market/`; mirrored only while
@everyone can view it) is a listing, and every listing made on the site or with
`/market sell` is a thread. Fields follow the Turtle Brigade spreadsheet (a
reference only; nothing reads or syncs it): title, kind (Ship, Paint, Vehicle,
Pack, CCU, Other), contents, qty, insurance (LTI or months), MSRP, price,
source (Hangar / Buyback), giftable, notes, image, status (available, dibs,
reserved, paid, delivered, sold, hidden; the forum's tags read Available, Dibs,
Reserved, Sold). Prices are BTC, stored as sats; `$` input converts at the
mempool.space BTC/USD rate (`rateUrl`, hourly, kept in the Store, served `stale`
when the fetch fails), which is otherwise only a USD hint. **Forum mirror**
(`GOON_MARKET_SYNC=0` serves stored listings only): REST passes every `ttlMs`
(15 min; archived threads daily) with a cursor per thread plus gateway thread
and message events (Message Content intent). Hand-written posts are parsed
best-effort (`Price:`, `0.005 BTC`, `500k sats`, `$40`, LTI, `x2`), sellers
are members found by Discord account (`via: directory`), and a field edited on
goon.vc keeps its value when the post later changes (`fieldSources`). Site
listings post as the seller through a bot-owned webhook (name and avatar;
`webhook: false` posts as the bot; the token stays in the Store, never served),
with an embed of the fields and buttons View on goon.vc and Buy with escrow;
site edits rewrite that post, or for hand-written posts move the tags and add
an "Updated on goon.vc" reply. Replies go both ways (site replies through the
webhook). Sold listings lock and archive their thread; a deleted thread hides
the listing. The bot needs View Channel, Send Messages (new posts), Read
Message History, Manage Webhooks, Manage Threads, Create Public Threads, and
Send Messages in Threads there (`/services/discord/invite?for=market`).
`npm run collect:market` (`scripts/market.js`; stop the server first) reads the
whole forum, archived threads included. **Dibs**: a member holds a listing for
`dibsHours` (24). **Escrow** (2-of-3): an order is a core named federation
(`FabricFederationDescriptor`, validators buyer + seller + goon.vc's arbiter
key at `m/7777'/4'/<a>'/<b>'` of goon.vc's Fabric key, two 31-bit slices of
sha256(`market-order:<id>`), threshold 2, publisher the arbiter, network the
Hub's — `market.network` / `GOON_MARKET_NETWORK` refuses any other, mainnet
only with `allowMainnet`). The buyer and seller validators are each member's
**escrow key**: the BIP87 cosigner key (`m/87'/B'/n'/0/0`, B = 0 on mainnet,
1 elsewhere) of their Passport account, never their `fabric:` identity key.
"Link your escrow key" (on the listing's `#buy` box and `/mine`;
`window.goonEscrowKey`) runs a Passport challenge (`POST
/services/members/passport/challenges { escrow: true }`, signed in only)
asking for the `cosigner` disclosure on the Hub's network (Members
`escrowNetwork` → `Market#_network`); core checks the proof that ties it to
the signing identity, and the claim keeps `cosigner { pubkey, network,
linkedAt }` on that `fabric:` account (logged `escrow-key`; account views show
only `escrow: <network>`, never the key). Without one for the Hub's network,
orders get 409 pointing at that step. The buyer gives a refund address and pays
the vault address (BIP21 + server-side QR) within `payHours` (24, else the
order expires); goon.vc posts the `FederationInvite` and every request to the
Hub mailbox (`POST /services/federations/messages`, through `createHubList`;
the invite is re-posted daily; reads carry an arbiter-signed proof for the
origin of the Hub asked, purpose `federation-mailbox`) and polls `GET
/services/federations/<id>/vault` for funding. The payment is a Hub invoice
(`escrow.invoice`: Hub `invoiceStore` shape `{ id, address, amountSats, memo,
label, createdAt, network, txids }` plus `amountBtc`, `expiresAt`,
`bitcoinUri`; `GET …/orders/<id>/invoice`), and the order page links the
Hub's Payments page (`<hub>/payments?bitcoinUri=…`) beside the wallet link.
The vault lists confirmed coins only, so the buyer may report a txid (`POST
…/orders/<id>/payments { txid }`, at most 5): goon.vc checks it with the
Hub's L1 invoice check (`GET /services/bitcoin/transactions/<txid>?address=&amountSats=`,
which sees the mempool; 409 when it doesn't pay the full price in one
payment) and re-checks unconfirmed ones on every vault pass. A payment seen
before `payBy` holds the order open `payGraceHours` (24) longer while it
confirms. Paid → the seller gifts the
pledge on RSI and marks it delivered with a payout address within
`deliveryDays` (7), which opens a `FederationWithdrawalRequest` (the release;
every payout leaves `feeSats`, 1000, to the network); the buyer releases (or
disputes) within `confirmDays` (3).
Parties sign `FederationWithdrawalSignature` frames with their own keys —
Passport / GoonCitizen from the mailbox, `npm run market:sign -- pubkey | show
<order> | sign <order> [release|refund]` (`scripts/market-sign.js`; derives
the escrow key from the master `FABRIC_XPRV` with `--account` (default 0) and
`--network` (default the Market's), and `pubkey` prints it; rebuilds the PSBT
from the request and checks its id before signing; `--print` for offline), or a frame pasted on the order page — posted to `POST
/services/market/messages { frame }` (a signer outside the descriptor gets 403).
goon.vc signs as arbiter only alongside one party: a release when the buyer
confirms or lets `confirmDays` pass, a refund when the seller refunds or never
delivers, in a dispute whatever a Market arbiter (`market.arbiters`,
`GOON_MARKET_ARBITERS` account keys) presses, and a refund of a payment that
arrives after the order expired or was cancelled (watched 30 days). Two signatures finalize the
transaction, broadcast through the Hub; milestones (reserved, paid, delivered,
sold) post in the thread without amounts or addresses and move its tag.
Routes: `GET /services/market` (HTML, or the JSON catalog: `kind`, `source`,
`status`, `tag`, `q`, `seller`, `sort`), `…/listings/<id>` (+ replies),
`…/listings/<id>/image` (re-signed Discord CDN redirect), `…/sellers/<slug>`,
`…/mine` (401 signed out), `…/orders/<id>` (parties and arbiters only),
`…/orders/<id>/request?pubkey=` (what that party's key signs; 404 for any
other key); writes need sign-in: `POST|PATCH …/listings[/<id>]` (PATCH on the
collection is a bulk `{ ids, changes }`), `POST …/listings/<id>/replies|dibs|orders`,
`POST …/orders/<id>/payments|delivered|dispute|release|refund|cancel`. Public JSON carries
display names only — never Discord ids, member ids, or the webhook. Pages:
the catalog (forum-style cards or the spreadsheet's table, kind chips,
filters), a listing page (fields, replies with a reply box, Open in Discord,
dibs and Buy in `#buy`, the seller's edit form), seller pages, `/mine` (your
listings with bulk status and price changes, your orders, a new listing form),
and an order page (step tracker, QR, vault address, actions, payouts to sign,
history). The copy notes pledges trade by RSI gifting, a grey market under
RSI's terms. `GET /services/discord/install` redirects to the user install
(`integration_type=1`, `applications.commands`) for `/market`; User Install
must be on for the shared application in the Developer Portal. Settings:
`market.{enabled,path,forum,tags,ttlMs,sync,webhook,network,allowMainnet,dibsHours,payHours,payGraceHours,deliveryDays,confirmDays,feeSats,arbiters,rateUrl}`;
`GOON_MARKET=0` turns it off. Tests: `tests/marketPost.js`,
`tests/marketEscrow.js`, `tests/market.service.js`.
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
servers only when it is ready (`/market` also installs on a member's own account
and runs in DMs and group DMs). The application is shared (today "sensemaker"),
so only these names are upserted, never `set()`, and unchanged ones are skipped.
Everyone who runs one in a server (except `/help`) gets a goon.vc member profile: the command
links their Discord (`Members#linkDiscord`: the same member Discord login
signs in to, found by the `discord:<id>` account; not a login, and an existing
display name is kept),
even when the command is then refused. A button press links only on Confirm
(and on Buy with escrow under a Market post).
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
`discord:<id>` account (Commands takes `alliance` lazily, since Alliance starts later);
an officer on record (`Alliance#actorFor`) votes through `Alliance#vote` instead, which
also signs for each of their orgs in the proposal. It replies privately with the member
and org counts, for an officer how many of the org's officers agree and the org's vote,
and a link; it notes when the vote replaced one from another of their accounts, and says
when votes are not set up.
`/market` (registered only while the Market runs; Commands takes `market`
lazily) has `integration_types` server + user install and `contexts` server,
bot DM, and group DM, so it reads no guild: `search [query]` lists up to ten
listings with links, `sell item price [kind] [qty] [insurance] [image] [notes]`
is `Market#create` (the listing and its forum post), `mine` lists the caller's
listings and open orders, `edit listing [price] [status] [notes]` is
`Market#update` (`listing` autocompletes from the caller's own listings), and
`buy listing` (autocompleting listings for sale) answers like the Buy with
escrow button on a forum post (`market:buy:<listing>`): the caller's open order,
or the listing page's `#buy` box (the order needs a refund address, so it opens
on goon.vc), with a pointer to `/sessions` while they have no Fabric key.
Replies are private (deferred: a sale posts to the forum first) and carry
display names and links only.
`/help [command]` (same install and contexts as `/market`; `command` offers the
commands running right now as choices, built from `Commands#definitions`, so it
never lists one that isn't registered) replies privately with every running
command and its subcommands, or one command in detail: each subcommand's
arguments (`[optional]`), a line of `HELP` copy with its goon.vc page, where it
runs, and Manage Server for `/goon`. It reads nothing about the caller and
makes no member profile. Add a `HELP` entry with every new command.
`/clips` (registered only while clips voice is on; `GOON_CLIPS_VOICE=0` turns it
off) `listen` joins the caller’s current voice channel and records talk into
`/clips`; `leave` disconnects. Servers only; Mute Members; the reply is private
and names the channel (never an id). A notice in that channel has Record me /
Don’t record me — other speakers, including people who join later, are mixed
only after they press Record me. The bot is visible in the channel while
recording. Commands takes `clips` lazily, same pattern as market.
`GOON_COMMANDS=0` skips registration.
`/schedule` (registered only while scheduling runs; `GOON_SCHEDULE=0` turns it
off) `open` posts a poll in the channel it was run. `people` (names or
`@handles`, commas between display names) and/or `role` and `also` say who
it’s for. The next `days` (default 7) offer `times` each day (default 4pm,
7pm, and 10pm in `zone`, default `America/Chicago`; `GOON_SCHEDULE_TZ`) for
`length` hours (default 2). Anyone named, and anyone holding one of the roles
when they answer, picks every time they can on the message; the latest answer
replaces. Names resolve on that server (the gateway’s member cache, then
Discord’s member search — no privileged intent). A role is not listed out, so
holding it is checked at the answer. The poll closes at `closes` (default 24
hours; “in 2 days” or a date; 15 minutes to 14 days) or when the opener runs
`/schedule close`. goon.vc then messages the opener — a DM, or a channel
message only they can press when DMs are closed — with up to five fullest
times (most people, earlier first) and Don’t schedule. The one they pick
becomes a Guild Scheduled Event on that same server: in `voice` when they
named a voice or stage channel, otherwise external at `where` (default the
server’s name). The bot needs Manage Events plus View, Send, and Read History
(`GET /services/discord/invite?for=events`); without them the choice stays up
so a manager can allow it and they pick again. The new event joins `/events`
on the next refresh. Polls live in a Fabric Store (`schedule.path`,
`GOON_SCHEDULE_STORE`, default `stores/schedule`). One opener can have three
open polls on a server. Replies, the poll, and the event description carry
display names and role names only — never Discord user ids — and ping nobody.
Tests: `tests/schedulePoll.js`, `tests/schedule.service.js`.
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
starts and again before the answers are recorded. **Only an org's officers on
record act for it**: the `PERMAFLEET org officer` requirement
(`Community.OFFICER`) passes when the caller's Discord account, or another
account linked to the same goon.vc member, is one of the org's `officers` in
`contracts/alliance.json` (`Alliance#representing`, `officer: true`, wired by
`services/goon.vc.js` through `Community#alliance`), the same officers who
vote for the org. Anyone else gets a refusal saying to ask in #embassy to be
put on record; nobody is taken for an officer because of a role name or a
typed answer. PERMAFLEET scripts make, match, and hand out **no steward-type
role** (G00N SQUAD's ORG STEWARDS role is for non-alliance org leaders and is
never touched). `goon-setup` asks for the
features wanted (schedule calendar, clips, IdleRPG announcements, and PERMAFLEET
membership — offered only to an org's officers on record; others
are told why), then only the matching steps (PERMAFLEET schedule or own calendar,
clips channel, IdleRPG channel, the org from the roster — `permafleet.orgs`,
only the orgs the caller is on record for, with every org's officers on record
named in the step), shows the server's PERMAFLEET compliance
checklist (below; nothing changes there), then offers **Set it all up
(recommended)** or "I'll pick existing channels and roles". Set it all up
(`permafleet.setup`, `Community#setupPermafleet`) makes the missing Prospect
ranks `[P1] Prospect I`…`[P6] Prospect VI` (highest first, since new roles
land at the bottom) and, in a PERMAFLEET category, `#embassy`, the PERMAFLEET
voice channel, `#permafleet`, and `#council`, opened by member permission
overwrites to the org's officers on record who are on the server (found by
their linked Discord accounts; skipped, with a pointer to `/goon council`,
when none is). Channels and ranks the server already has
by those names are kept as they are; without Manage Channels, Manage Roles (for
the ranks), and what the channels grant, nothing changes. It shows the guild-wide permissions
the bot is missing with the `/services/discord/invite` link, and confirms a
summary. Completion runs `permafleet.org` (checks the caller against the org
again; refused = nothing saved), `permafleet.setup`, and `record`: the latest
answers per guild in the Store (the org's symbol, the officer names on record,
`setup { channels }`). **Nothing reads them yet**; services still
take their config from `settings/local.js`.
**PERMAFLEET channel and rank scripts** set up the channels and Prospect ranks every member org keeps on
its own Discord, one script each, started like `goon-setup` (same checks,
registered with it, plus the `PERMAFLEET org officer` requirement) by `/goon council` (`permafleet-council`), `/goon embassy`
(`permafleet-embassy`), `/goon permafleet` (`permafleet-channel`),
`/goon voice` (`permafleet-voice`), and `/goon roles` (`permafleet-roles`:
the missing Prospect ranks only; `Community#createRoles`, needs Manage Roles;
`functions/allianceRoles.js`).
Creating is always the first, recommended choice, so every member org's
Discord ends up the same; picking an existing channel or role comes second. Specs live in `functions/allianceChannels.js`:
`#council` is private (@everyone denied View; View / Send / Read History for
the org's officers on record who are on the server, by name — the recommended
choice from `permafleet.council.access` — plus any roles the admin picks, and
the bot's own member) — where the org's officers settle alliance votes; `#embassy` and `#permafleet` are text channels and
`PERMAFLEET` a voice channel, all public (@everyone allowed View / Send / Read
History, or View / Connect / Speak). **Compliance**: before any question,
each of these scripts (and `goon-setup`) DMs a checklist of where the server
stands, computed when the session starts from the bot's cache
(`functions/allianceCompliance.js`, `Community#compliance`): expected of every
member org — `#embassy` and a PERMAFLEET voice channel that @everyone can use
(read from @everyone's effective permissions), and Prospect ranks starting at
Prospect I (role names) — then recommended: a private `#council` (@everyone
can't view it) and a public `#permafleet`. Each line is
✅ or ⬜ with what was found (channel and role names, never ids) and, when
unmet, the fix (`/goon <subcommand>` for channels, `/goon roles` for the ranks). A channel script adds
whether its own item already checks out. The checklist (`compliance`) and each
check's `{ id, required, ok, detail }` (`complianceChecks`) stay in the session
context, so the recorded results show leadership what the admin saw. Then each asks
whether to create the channel (choice source `permafleet.channels.<kind>`:
"Create … (recommended)" then the server's channels of that type, likely matches first), then
a category (`discord.guild.categories`, optional), for `#council` who may see
it (the officers on record, recommended, then `discord.guild.roles`: highest
first, no @everyone or managed roles), shows
what the bot lacks only when it lacks something, and confirms. Picking an
existing channel uses it as is. On completion the `permafleet.channel` action
(`Community#createChannel`) uses that channel, or one the server already has
by that name (case, emoji, and separators ignored), or creates it with
`guild.channels.create` (reason names the admin and command; existing channels
keep their permissions), and returns `{ channelId, created }` and a `<#id>`
line for the completion DM, so `record` keeps the channel. Creating needs the
bot to hold Manage Channels plus every permission it grants there (Manage
Roles is only for the Prospect ranks); otherwise the admin gets that list and
`/services/discord/invite?for=channels` (Manage Channels, Manage Roles, View,
Send, Read History, Connect, Speak; re-running an invite updates a bot already in the
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
**Campaigns** (on unless `GOON_CAMPAIGNS=0`) DM one message, or a Start button for a
script, to a group of a server's members. `GOON_CAMPAIGNS=0` loads no plugin, mounts
no campaigns API, and registers no `/goon campaign`, `/goon checkins`, or
`/goon welcome`. **Every outbound DM
starts from a command, and every broadcast from a preview naming its
recipients.** Nothing goes out on a timer, on a member joining, or on a sign-in
waiting for review. DMs to the command's own caller (setup and channel
scripts, `/hangar guide`, `/goon review`) and replies inside a conversation the
recipient started (Start, Stop, a typed answer) are the only other DMs; plugins
other than Scripts and Campaigns (IdleRPG's `!transfer`) can't DM at all
(`Community#plug` drops their `whisper` events). A broadcast (`/goon campaign`,
`/goon checkins`, `/goon welcome`, `npm run campaigns:*`, or the token-gated
API) is a Doorman preview first: `POST …/campaigns/<id>/preview` returns an
8-hex preview `id` and `recipients` (display names, "Name (@username)" when the
handle differs; never ids), and keeps that list privately (`approvals` in the
campaigns Store). Campaigns run with `requirePreview`, so `POST
…/<id>/schedule { preview }` is the only way to send: it reaches exactly the
members that preview listed who still qualify (opt-outs, role changes, new
activity drop them; anyone who joined since is left out, counted as
`notPreviewed`), and refuses a missing or stale preview (409; editing the draft
or previewing again makes the older one stale). Discord previews list the names
in the message as far as they fit and attach every name as `recipients.txt`.
They run on Doorman's Campaigns plugin
(`@fabric/doorman/services/campaigns`) plugged into the same Doorman host
(Fabric Store `community.campaigns.path`, `GOON_CAMPAIGNS_STORE`, default
`stores/campaigns`). Listing members needs the **privileged Server Members
intent**: turn it on for the bot in the Discord Developer Portal before leaving
campaigns on, because Discord refuses the whole gateway connection when an
intent it hasn't granted is asked for. Only then does the gateway ask for
`GuildMembers` (plus `DirectMessages` / `Channel` as for scripts;
`Community.gateway(settings)` says which). Community supplies the `discord`
audience (`Community#discordAudience`: `guild.members.fetch()` for each server
the bot is in, or only the campaign's own server; a successful listing is
kept warm for a few minutes so Send after preview does not ask Discord again,
and a refused fetch uses that cache or Discord's member cache, else 429
“Could not list the members…”; role and exclusion filters; never bots) and
the activity hook (last active: the later of `Presence#lastSeen`,
the last time the member was present in voice, and `Activity#lastPosted`, their
last post in the home server), and lists the scripts a campaign may offer (those without
`requires`). `/goon campaign message [role] [exclude_role] [active_days] [script]
[send_at]` (Manage Server; registered only while campaigns run) saves a draft
owned by the server and shows its author a private preview: the message, every
member it reaches by name, who is skipped (excluded role, opted out, not active
lately), and Send — or Schedule, when `send_at` is "in 2 hours" or a date up to
30 days ahead — plus Cancel
(`campaign:send|schedule|cancel:<id>[:<unix>][:<preview>]`; Send and Schedule
carry the preview id). **Only remaeus can send the DMs** (`campaigns.senders`,
default his Discord account in `contracts/goon-squad.json`); other managers can
preview. The token API's `POST …/schedule` is refused the same way, so
`npm run campaigns:* -- --send` does not fire DMs. Only the author may press the
buttons, Send re-checks Manage Server fresh from Discord, and it sends only that
preview. A server campaign reaches only that server, at most 500 members
(`maxAudience`; over it, only Cancel is offered), one per server a day
(`guildCooldownMs`), one DM every 2 s (`intervalMs`). Each DM says "Sent by
<server> via goon.vc" and has Stop messages from <server> / Stop all buttons
(`doorman-c:<campaign>:…`; typing STOP works for a week); opt-outs are kept and
skipped by every later campaign. Recipients and opt-outs are never served; the
report and API return counts. The API is `/services/doorman/campaigns` (list,
create, edit drafts, preview, schedule, pause, resume, cancel), all behind
`Authorization: Bearer $GOON_SCRIPTS_TOKEN` (404 without it). Settings:
`community.campaigns.{enabled,path,intervalMs,maxAudience,guildCooldownMs,senders}`. Like
scripts, an installed `@fabric/doorman` without the plugin, or with one that
doesn't lock sends to a preview (no `PREVIEW_APPROVALS` export), leaves
campaigns off.
**Recruiting** (`contracts/recruiting.json`, `functions/recruiting.js`) is one
staff campaign per unit — TURTLE BRIGADE (FPS), BRAVO SQUADRON (dogfighting),
PERMAFLEET OFFICERS — reaching G00N SQUAD members who hold the rank just beneath
it in `contracts/roles.dot` (`qualified`: Prospect IV; Prospect roles are
cumulative on Discord, so V and VI hold it too) and none of the unit's `roles`
(the unit and everything above it: SHELLBACK, ALPHA SQUADRON, the officer and
command ranks), active (voice or posting) within `activeWithinDays` (30). Its Start button
opens the unit's DM script (`contracts/scripts/recruit-*.json`: experience,
unit questions, region and play times, RSI handle, the squadron application for
squadrons, notes, a summary to confirm), recorded per member for leadership
(`GET /services/doorman/scripts/<id>/results`). The scripts `requires` the
`qualified.name` role, which `Community#authorize` checks fresh from Discord at
start and before recording (`community.roles`: requirement name → role ids;
the owner gets no pass), so `/goon campaign` never offers them. Copy says
Prospect IV makes a member eligible and leadership selects; elite units are what
the best go on to. `npm run campaigns:recruiting` (needs `GOON_SCRIPTS_TOKEN`
and a server with campaigns on; `--unit`, `--origin`) saves or updates
the drafts through the campaigns API and prints every recipient's name.
Nothing is sent: campaign DMs only go out when remaeus sends them from Discord.
`--send` is refused. A re-run skips members an earlier campaign for the unit
already reached (`excludeCampaigns`) and leaves one that is scheduled, sending,
or paused alone.
**Check-ins** (`contracts/checkin.json`, `functions/checkin.js`) are friendly
staff campaigns to G00N SQUAD members who have gone quiet, in three tiers by
last active (Doorman filter `inactiveForDays`, plus `activeWithinDays` as the
upper bound): very old (120+ days), somewhat old (60–120), getting old (30–60).
Members active in the last 30 days are never contacted, nor members with no
activity on record (`unseen`). Tiers are drafted and sent most inactive first,
and within a campaign Doorman sends the most inactive first. Each message is a
short, warmer-the-longer-away hello with a Start button for the `checkin` DM
script (what kept them away — skippable — what would bring them back, play
times, whether to ping them, notes, a summary to confirm), recorded per member
for leadership. Touches are capped at three: a tier's campaign skips everyone
an earlier campaign of that tier reached (one touch per tier, for good), and
everyone any check-in reached in the last `spacingDays` (30); campaigns that
reached no one aren't counted, within the 50-entry `excludeCampaigns` limit
(same tier first). The script `requires` "G00N SQUAD member", mapped to the
server's @everyone role (id = the server id; `Community#authorize` treats it as
"is a member of that server"), so it runs only in the home server and
`/goon campaign` never offers it. Check-ins go out only when remaeus, with
Manage Server in the home server, runs `/goon checkins` (`services/checkins.js`,
Fabric Store `stores/checkins`, `GOON_CHECKINS_STORE`; the subcommand is
registered only while campaigns run and refused in other servers) and presses
Send. Other managers can preview. It replies privately with what would go out right now (`Checkins#preview`):
each tier's message and every member it reaches by name (saved as drafts with
a Doorman preview each; skips counted), the `checkin` script's questions, and
Send (`checkins:send:<preview>`), Cancel, and Stop while earlier check-ins are
still going out. Stop and Cancel are pressable by anyone with Manage Server there,
checked fresh from Discord; Send is remaeus only. Send (`Checkins#send { preview }`) sends each tier
to exactly the members that preview listed, most inactive tier first; only the
latest preview sends, once, and not after a restart (409). Members who go quiet
later get theirs when someone runs it again. Stop (`Checkins#halt`) cancels
check-ins still scheduled, sending, or paused. Because repeated rounds outgrow
`excludeCampaigns`, `Checkins` also keeps its own record
of who each tier reached (Doorman's `delivered` event: Discord user id → tier
→ time, never served) and drops them from check-in audiences through
`Community#narrow`, a hook on every Discord audience. `GET /services/checkins`
returns only when they last went out, each tier's reach then, and how many are
still going out (`sending`) — no names or ids. `npm run campaigns:checkin`
(needs `GOON_SCRIPTS_TOKEN` and a server with campaigns on; `--tier`,
`--origin`) saves or updates the drafts, prints every recipient's name and why
others were skipped (warning while the message history is still being read),
and does not send. `--send` is refused; remaeus sends from Discord with
`/goon checkins`.
**Welcome DMs** (`contracts/welcome.json`, `functions/welcome.js`,
`services/welcome.js`, Fabric Store `stores/welcome`, `GOON_WELCOME_STORE`)
invite new G00N SQUAD members to join PERMAFLEET and earn their Prospect tags:
a staff campaign (title `Welcome: join PERMAFLEET`) whose message links the RSI
org page and the schedule, with a Start button for the `permafleet-apply` DM
script (applied on RSI yet, RSI handle, current org, experience, interests,
region, play times, notes, a summary to confirm), recorded per member so
leadership can tag Prospect I. Members holding any role in `exclude` never get
it: the alliance orgs' roles and ORG STEWARDS (alliance members are already
meant to be at least E1), and PERMAFLEET, Prospect I, Enlisted, E1, E2 (already
in). PERMAFLEET GUESTS still get it. A member is due `delayHours` (24) after
joining and stays due for `windowDays` (30): Community adds `joinedAt` (Discord
`joinedTimestamp`) to audience people, and `Welcome#narrow` keeps only those
who joined inside that window and were never welcomed. Who was welcomed is read
from Doorman's deliveries for campaigns with that title (any status but
cancelled), so it needs no ledger of its own and survives restarts. The script
`requires` "G00N SQUAD member" (the home server's @everyone role), so it runs
only there and `/goon campaign` never offers it. Welcome DMs go out only when
remaeus, with Manage Server in the home server, runs `/goon welcome` (registered
only while campaigns run, refused in other servers) and presses Send. Other
managers can preview: a private
preview of the message, every member due by name (joined in the last 30 days,
over a day ago, not excluded; skips counted), the excluded role names, the
script's questions, and Send (`welcome:send:<preview>`), Cancel, and Stop while
earlier welcomes are still going out, checked fresh from Discord (Send is remaeus
only). Send
(`Welcome#send { preview }`, reusing the open draft) sends to exactly those
members, once; members who join later get theirs when someone runs it again.
Stop (`Welcome#halt`) cancels welcomes still scheduled, sending, or paused.
`GET /services/welcome` returns only the delay and window, when it last went
out and to how many, how many are still going out, and how many were welcomed
(no names or ids).
**Activity** (`services/activity.js`, Fabric Store `stores/activity`,
`GOON_ACTIVITY_STORE`) is when each member of the home server
(`discord.guildId`) last posted: author ids and times only, never content or
channels. Every text, announcement, voice-chat, and stage-chat channel and every
public thread (active, and archived under text, announcement, forum, and media
channels) the bot can read is walked back to its first message once, with a
cursor per channel so a pass resumes, then polled forward hourly (`ttlMs`);
the operations gateway client adds posts as they happen (`messageCreate`, no
extra intent). Bots, webhooks, and system messages don't count. A channel the
bot can't read (403/404) is retried after a day. `npm run collect:activity`
reads everything with the server stopped. `GET /services/activity` returns
aggregates only (`members`, `oldestPost`, `channels { tracked, complete,
unreadable }`, `backfilled`, `syncedAt`, `error`). `GOON_ACTIVITY=0` stops
reading history (gateway posts are still noted). The bot needs View Channel +
Read Message History.
`/clips` is the public clip library and editor (`services/clips.js`, `GOON_CLIPS_STORE`
default `stores/clips`: a Fabric Store plus `media/`, `renders/`, `tmp/`; routes
under `/services/clips`). No sign-in: anyone may browse, edit, and render; a
signed-in member's display name goes on their changes (`identify`), otherwise
`null`. A render of a project revision that is queued, running, or done is
reused, and new renders are refused (429) while `maxQueuedRenders` wait.
Discord REST only: every guild the bot is in (`clips.guilds` narrows it), text,
announcement, forum, and media channels matching `clips.channels`
(`GOON_CLIPS_CHANNELS`; id, exact name, or `"/regex/"`; default the G00N SQUAD
`#clips` / `#videos` / `#screenshots` ids in `contracts/goon-squad.json` plus
names with "clip(s)"/"video(s)"/"screenshot(s)") plus every media channel (`mediaChannels`), and the
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
**Voice:** `/clips listen` (Mute Members; the caller must be in that voice
channel) joins through `@fabric/discord` voice receive (`joinVoiceReceive` on
the shared operations Discord client; `@discordjs/voice` lives in that package)
and records people talking — not Go Live video or game audio — into
`media: 'audio'` clips (`kind: 'voice'`, `recording.source: 'discord-voice'`).
The caller is included; everyone else (including people who join later) is
recorded only after they press Record me on the notice in that channel.
`/clips leave` disconnects; the bot also leaves after `idleMs` of an empty
channel. One channel at a time (`maxConcurrent: 1`); a restart does not rejoin. Chunks rotate on
`chunkMs` (60s) or `silenceMs` (3s of nobody speaking). Public JSON and UI are
names only (speakers, channel) — never Discord user ids. `GOON_CLIPS_VOICE=0`
turns listen off (and skips registering `/clips`). Settings
`clips.voice.{enabled,chunkMs,silenceMs,idleMs}`.
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
`<clip-library>` (`components/ClipLibrary.js`): each session is a card
that wraps beside the others (as wide as up to four of its clips; bigger
sessions take the row) holding clip cards (sprite thumbnail with hover scrub, pilot, recorded time, length or "Screenshot", caption),
search + pilot / channel / sort / link / screenshot / voice filters, a player (`?clip=<id>`) with
details, the Discord link, and the other pilots' overlapping angles at the same
moment, "Start a project" per session, and the project list.
`/clips/timeline?session=<id>|clip=<id>` is `<clip-timeline-editor>`
(`components/ClipTimelineEditor.js`) browsing one session. Both are shadow
DOM with no goon.vc dependencies; `components/ClipsPage.js` sets `src` only on
the active route. Projects live at `/clips/projects/<id>`: a program of segments
`{ clipId, in, out, audio, volume, at? }`, saved as revisions (409 on a stale
`revision`; old revisions kept, nothing deleted). Audio clips are overlays
(`at` seconds on the film; mixed onto `[aout]` with `adelay` / `amix`); picture
stays the video/screenshot concat (or black if the project is voice-only).
“Start a project” on a session includes overlapping voice clips as overlays.
A render
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
`/sessions` is the single login page (Discord, Passport), backed by the
members Store under `/services/members`; `/members/login` redirects there. It
is served with `Content-Security-Policy: frame-ancestors 'none'`. The HTML
client reads `GET /services/members` (`{ discord, passport }`) on load and
hides Login CTAs only when both are off. **Passport login is peer-to-peer
signed Fabric messages (Passport v2, `@fabric/core` `docs/PASSPORT.md`); no
Hub is involved, and `/sessions` is never proxied.** `Members` runs an
`@fabric/http` `passportRelyingParty` pinned to `members.origins`
(`GOON_MEMBERS_ORIGINS`, comma list), else `siteUrl` in production (or when
`siteUrl` is loopback), else loopback origins only; production with nothing
to pin turns Passport off. The `Host` header never picks an origin: a request
on an address that isn't pinned gets no challenge (400). `POST
/services/members/passport/challenges` issues a core `PASSPORT_CHALLENGE`
(origin, fresh nonce, 2-minute expiry, purpose, no network, no disclosures),
keeps `/passport-requests/<sha256(binding secret)>` in the Store, and sets the
**binding secret** (never the nonce) as an HttpOnly, SameSite=Strict
`goon.passport` cookie (path `/services/members/passport`). The page posts
`{ source: 'fabric-site', type: 'PASSPORT_CHALLENGE', challenge }` to Passport
with a transferred `MessagePort` and reads the answer only from that port
(`PASSPORT_ASSERTION`, or `{ ok: false, error }`); it requires
a `PASSPORT_HELLO` handshake (protocol 2) over a `MessagePort`. Passport, or a Hub desktop app or
GoonCitizen it asks, signs a `PASSPORT_ASSERTION` for the origin its browser
shows, and the page posts it to `POST /services/members/passport { assertion,
link? }`. The claim takes the secret from the cookie (never the body), clears
the cookie, and redeems: the challenge is taken on the member queue (two
racing claims can't both get it; each challenge works once, also across
restarts) and `verifyAssertion` checks signature, origin, nonce, challenge
hash, expiry, signer, and that the pubkey is the frame's author. The claim must
come in on the pinned origin the challenge was issued for, posted by a page on
that origin (its `Origin` header; none or another is 403). The account is
`fabric:<x-only pubkey>`; the `signer` label is only logged. Expired
challenges and Discord OAuth states are dropped when taken and swept on start
and every 10 minutes; one address (the proxy's last `X-Forwarded-For` hop) may
start 60 sign-ins a minute (`loginStarts`), then 429. Passport is offered only
when the installed `@fabric/http` has the relying party. **Links** (`link:
true`, and `GET …/discord?link=1`) are refused from a session a one-time RSI
claim link started (`one_time_link`: sign in with Discord or Passport first),
and every Link button asks first, naming the member the account will join
(`window.goonConfirmLink`). Discord login is OAuth2 (`identify guilds`) through
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
OAuth state; `POST /services/members/passport { fabric, link: true }` for
Passport); a login while signed out never links. Each Fabric key is proven by
its own signature; device clusters are not imported (accounts linked
`via: cluster` by earlier versions stay until unlinked). Running a Discord
command links `via: command`; a `@handle` typed into a duel makes a placeholder
member `via: directory`. Linking an account another member already holds
**merges** them: the older member survives with its name and avatar, accounts
and logs combine, the other id becomes an alias (`mergedInto`), and `merged
{ from, into }` is emitted. Members saved before accounts
(`/members/discord:<id>`, `/members/fabric:<id>`) are adopted on first touch
with their history, so old session cookies and roster links keep working.
`GET /services/members/accounts` lists the signed-in member's accounts and
`DELETE /services/members/accounts/<key>` unlinks one (with any `via: cluster`
keys it brought); the last account cannot be unlinked (409). Session JSON carries
the member id, display name, linked platforms, and the login used
(`provider`), never account ids. **A member holds one Discord account**
(`discordConflict` in `Members#_link`): linking a second one, or any
account whose member holds a different Discord account (a merge that would
bring it), is refused with 409 `one_discord`, and nothing changes; unlink
the old one first. Members that held several before the rule keep them.
Discord login and commands still make their own member for a Discord
account nobody holds. `GET …/discord?link=1&next=profile` starts a link
from the profile page and lands back on it (`?linked=discord[&merged=1]` or
`?error=<code>`); a member who already has Discord is sent back with
`one_discord` before Discord is asked.
**Members** (`/members`, `components/MembersPage.js`, `membersPath` in `GoonSPA`) is the future member
directory. It isn't open yet: `GET /services/members/directory` returns
`{ directory: false, members: [<you>] }` (401 signed out), so the page lists
only the signed-in member. Each member's profile is `/members/<member id>`
(`GET /services/members/profiles/<id>`: display name, avatar, member since,
in the G00N SQUAD Discord, linked accounts as labels — Discord username, RSI
handle with its citizen page, a short Fabric key fingerprint — and RSI handles,
plus their own review status while reviews run). Only the member themselves
can see it: any other id, merged-away ids aside (they resolve to the
survivor), gets 404 like an unknown one, and link previews are a generic card
(`Members#page`). The profile is also where its member manages accounts:
each has Unlink (`DELETE …/accounts/<key>`; the owner's profile JSON carries
each account's `key` and `via` for it, nobody else ever gets them), and "Add
an account" offers Link Discord (hidden, with the linked one named, while
the member has one), Link a Passport identity in place
(`window.goonPassport(linking, say)`, the Passport flow `Login.js` exposes on
every page), and Claim an RSI handle. The member also picks their **display
name** there, only from names their linked accounts carry (`nameChoices`,
RSI first: each RSI handle and its citizen page name, then each Discord
display name and username; served to the owner only): `PATCH
…/profiles/<id> { displayName }` (400 for any other name, 404 for another
member's profile, logged `rename`); the page redraws the footer card with
`window.goonMember(member)`. A member with no name takes the first such name
of the first account linked to them. Login and the current member live in the
footer, never the header (Events, Resources, PERMAFLEET; the Market is a
Resources card only): signed in, `Login.js` turns every footer Login button
into a card (avatar, display name, YOUR PROFILE) linking to the profile. Pages
without a footer of their own (the PERMAFLEET section, waiting, RSI, members)
get the site-wide `#site-member-footer` (`Login.footer`), shown only when the
visible `<main>` has no `.footer-login-button` and the page isn't the login
page; it sits above the PERMAFLEET fixed background (`z-index: 3`). The login
page links to the profile too. Opening
the directory later means listing more members from `_directory` and
widening `_profile`'s self check.
**Waiting area** (`/waiting`, `components/WaitingPage.js`, `waitingPath` in `GoonSPA`; `services/reviews.js`,
review state in `services/members.js`, script
`contracts/scripts/member-review.json`) holds new Discord sign-ins until an
alliance reviewer approves them. Settings `members.review.{enabled,reviewers}`
(`GOON_MEMBERS_REVIEW=0` turns it off; `GOON_MEMBERS_REVIEWERS`, comma list of
Discord user ids, default @remaeus `420222636954615808`). It is a status only:
nothing on the site is gated by it yet. The first start with reviews on
records `/reviews/since`; members created before it count as approved
(`grandfathered`), and so does anyone already approved. A member created
after it gets `review { status: 'pending', requestedAt }` on their first
Discord sign-in or Discord link (Passport-only members have none), is indexed
at `/reviews/pending`, and the sign-in lands on `/waiting?signedIn=discord`
instead of `/sessions` (a denied member lands there too). A merge keeps the
better review (approved, then pending, then denied). Members emits `review`
on joining and `reviewed` on a decision; `Reviews` only logs a join and DMs
nobody. A reviewer runs `/goon review` (registered only while reviews run;
`/goon` still defaults to Manage Server, so reviewers need it where they run
it) to get the `member-review` script in their DMs: everyone waiting (longest
first, with how long, whether they are in the G00N SQUAD Discord, and any RSI
handle), a multi-select of whom to approve, then whom to turn away, then a
summary to confirm (`review.notifiedAt` notes who was shown). The script `requires` "goon.vc reviewer", a
Community requirement (`Community#requirement`) that checks the Discord id
against the reviewer list at start and again before the `members.review`
action decides, so `/goon campaign` never offers it. A member someone else
already decided is left as they are. Session JSON carries `review { status,
requestedAt, reviewedAt }` (or null) while reviews are on, never the
reviewer; `GET /services/members` adds `review: true|false`. Tests:
`tests/memberReviews.js`, `tests/reviews.js`.
**RSI profile claim** (`/rsi`, `components/RsiClaimPage.js`, `rsiClaimPath` in `GoonSPA`; parser
`functions/rsiCitizen.js`, codes `functions/rsiClaim.js`) links an `rsi:<Handle>`
account (the handle as RSI writes it) to a member. `/rsi claim` (servers and
the bot's DMs) links the caller's Discord and replies privately with a
**one-time sign-in link** (`Members#claimLink`: `<siteUrl>/rsi/claim?t=<64 hex>`,
kept as `/claim-links/<sha256>`, single use, 30 minutes); opening it starts a
session (`provider: 'rsi-link'`, at most an hour, and never allowed to unlink
an account: 403) and lands on `/rsi`, and a used, expired, or
forged link lands on `/rsi?error=link`. The link is a login, so it only ever
goes out ephemerally. Signed in any way, the page asks for the handle (`POST
/services/members/rsi/claims { handle }` → a `g00n:` + 7 hex code, kept 24 h at
`/rsi-claims/<member>`, the same code while the handle is the same), the member
puts the code anywhere in their RSI bio, and Verify (`POST
…/rsi/claims/verify`) fetches `robertsspaceindustries.com/en/citizens/<handle>`
— the only time an RSI page is read at serve time — and links the account
`via: 'bio'` with the citizen's display name, record, and main org when the
code is there (409 when it isn't, or RSI shows another handle; 404 no such
citizen; 502 RSI unreachable; five verifies per member per 15 minutes, then
429). A handle another member holds merges the two like any link. `GET
/services/members/rsi` returns the member, their claimed handles, and the
pending claim (401 signed out). The code can come out of the bio afterwards.
**Hangar sync** (`services/hangar.js`, Fabric Store `stores/hangar`,
`GOON_HANGAR_STORE`; parser `functions/hangarExport.js`) accumulates the ships
members own from **Hangar Export** (hangar.link) JSON files. The add-on was
pulled from the Chrome Web Store and now installs only in Firefox
(addons.mozilla.org `hangar-export`); it adds Export to the RSI pledges page
and saves a .json and a .csv. `/hangar guide` starts the `hangar-import` DM
script (`contracts/scripts/hangar-import.json`, no `requires`, so `/goon
campaign` may offer it): what is kept, 2FA, the browser, installing, exporting,
and `/rsi claim` when the member holds no `rsi:` account (`context.rsiHandle`).
`/hangar import file:<.json>` (attachment, ≤ 5 MB, downloaded from Discord's
CDN) takes the export only for an `rsi:` handle the caller holds (otherwise the
claim link reply), and replaces that handle's ships. The file is `{ type:
'hangarlink', version, pledges }`; every pledge names the account in `hangar`
(several accounts in one file = refused), which must be one of the caller's
handles. A file naming none goes to the caller's only handle (several held =
refused, `WHICH_HANDLE`). Ships are pledge `items` of kind Ship (model from
`title`, not the pledge name; manufacturer from `liner`; custom name from
`itemCustomName`; LTI from `insuranceType` / the Insurance item; `warbond`),
skipping `pledgeType: 'upgrade'` and buyback pledges, and nothing else is kept —
never prices, pledge ids, dates, paints, or other items. Records are
`/hangars/<member>` with one hangar per handle (`importedAt`, `ships`, a short
import `history`); a hangar counts only while its member still holds that
handle, and a member merge moves hangars to the survivor. `/hangar status`
shows the caller's last import. `GET /services/hangar` is fleet totals only
(`members`, `ships`, `models [{ model, manufacturer, count, owners }]`,
`updatedAt`; no names, handles, or ids), shown on `/rsi`;
`GET /services/hangar/members` (per member: display name, handle, ships,
import time) needs `Authorization: Bearer $GOON_SCRIPTS_TOKEN` (404 without
it). Settings: `hangar.{enabled,path}`. Tests: `tests/rsiClaim.js`,
`tests/hangar.js`.

GoonCitizen release docs: `star-citizen-live/AGENTS.md`. Hub/core:
`docs/PRODUCTION*.md`. Human call for GoonCitizen contributors (not this zipper):
`star-citizen-live/DEVELOPERS.md`. This tree: [`DEVELOPERS.md`](DEVELOPERS.md),
[`SECURITY.md`](SECURITY.md).
