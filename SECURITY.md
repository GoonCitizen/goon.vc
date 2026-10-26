# Security (goon.vc)

Public **HTML zipper** for the Fabric suite. Not a Hub and not a GoonCitizen relay.

**Topology:** [PLAN.md](PLAN.md). Agent hints: [AGENTS.md](AGENTS.md).

## What this process is
`@fabric/http` `HTTPServer` serving `assets/` and reverse-proxying
`/device-links`, `/services/rpc`, and `/identity/cluster` + `/identity/cross-sign`
to `FABRIC_HUB_ORIGIN` (default `https://hub.fabric.pub`) for other clients;
member login does not use them. `/sessions` is goon.vc's own login page and is
never proxied. No Fabric Peer listen,
no Bitcoin, no Discord bot, no `/services/star-citizen`.

## Passport login
Member sign-in with a Fabric key is Passport v2 (spec: `@fabric/core`
`docs/PASSPORT.md`), on `@fabric/http` `passportRelyingParty`. No Hub session,
poll secret, or device cluster is involved. What keeps it safe:
- **Origins are pinned.** Challenges are issued only for `members.origins`
  (`GOON_MEMBERS_ORIGINS`), else `siteUrl` in production (or when it is
  loopback), else loopback. The `Host` header never picks an origin; a request
  on an address that isn't pinned gets no challenge, and production with
  nothing to pin turns Passport off. Set `GOON_MEMBERS_ORIGINS=https://goon.vc`.
- **The signer checks the origin.** Each `PASSPORT_CHALLENGE` names its origin;
  Passport (or the Hub desktop app or GoonCitizen it asks) compares it with
  the origin its browser shows and refuses a mismatch, so a phishing site can
  only collect assertions for its own origin.
- **Bound to this browser, redeemed once.** `POST
  /services/members/passport/challenges` sets a random binding secret (never
  the nonce) as an HttpOnly, SameSite=Lax `goon.passport` cookie and stores
  only its sha256. The claim reads the secret from that cookie (never the
  body) and takes the challenge on the member queue, so two racing claims
  can't both redeem it; expired challenges (2 minutes) are refused. An
  assertion relayed to another browser has no matching cookie.
- **The key proves itself.** `verifyAssertion` checks signature, origin,
  nonce, challenge hash, expiry, and that the pubkey is the frame's author.
  The account is that x-only pubkey; the `signer` label grants nothing.
- **Links need a real sign-in.** A session started by a one-time RSI claim
  link can't link accounts (`one_time_link`), and every Link button names the
  member the account will join before it goes ahead.
- **No framing, one channel.** `/sessions` is sent with `frame-ancestors
  'none'`. The page talks to Passport only over the `MessagePort` it handed
  over with the challenge.
- **Escrow keys are cosigner keys.** A Market party's escrow key is the BIP87
  cosigner key Passport discloses with consent, endorsed by the identity key;
  sign-in never shares an xpub.

## Sign-in reviews (waiting area)
New Discord sign-ins wait at `/waiting` until a reviewer approves them. It is
a status only; nothing is gated by it yet, so treat it as a label, not access
control.
- **Reviewers are a server-side list.** `members.review.reviewers`
  (`GOON_MEMBERS_REVIEWERS`) holds Discord user ids. The `member-review`
  script's "goon.vc reviewer" requirement checks the DMing user against it at
  start and again before any decision; Discord roles and permissions grant
  nothing here.
- **One decision per member.** Only a pending member can be approved or
  denied; a second reviewer's answer for someone already decided is ignored.
- **Nothing identifying is served.** Session JSON carries only the member's
  own `{ status, requestedAt, reviewedAt }`; the reviewer's account stays in
  the member record and log. Reviewer DMs list display names, Discord
  usernames, guild membership, and claimed RSI handles, the same details the
  members already show on Discord.

## Member profiles
The member directory isn't open yet: `/members` lists only the signed-in
member, and `/members/<id>` shows a profile only to that member.
- **Another member's profile is a 404**, the same answer as an unknown id, so
  the API can't be used to check whether a member exists. Signed out gets 401.
- **Link previews name no one.** `/members/<id>` previews are the same
  generic card for every id.
- **Account keys go to their owner only.** Profiles show platform labels
  (Discord username, RSI handle, a short Fabric key fingerprint) and link
  times; the account keys needed to unlink are in the owner's own profile
  JSON (as in `GET /services/members/accounts`) and in nothing anyone else
  can read. The directory carries none.
- **One Discord account per member.** A link that would give a member a
  second Discord account, directly or by merging in another member, is
  refused (409) before anything changes, so one person's Discord identity is
  never silently folded into another's profile.
- **Links prove themselves.** Every account is added by signing in to it
  from the signed-in session (Discord OAuth `state` bound to the browser and
  the member; a Passport frame for a fresh nonce; an RSI bio code). A Discord
  link started on a profile returns only to that member's own profile path.
- **Display names are proven, not typed.** A member renames themselves only
  to a name one of their linked accounts carries (RSI handle or citizen
  name, Discord display name or username); anything else is refused (400).
  Names show on votes, the Market, and reviews, so no one can pick another
  member's name without holding their account.

## Learnings (2026-08-14)
- Hosted GoonCitizen privacy gates live in **`star-citizen-live`**, not here.
- Sidechain path policy in `@fabric/core`: allow-prefix `'/'` matches every
  JSON Pointer. GoonCitizen aggregate patches currently target `/services/rsi`
  on Hub — keep that policy on Hub / LiveRelay, not this tree.

## Process
1. Do not grow this tree back into a Hub or LiveRelay.
2. Never commit Hub admin tokens or `settings/local.js` secrets.
3. Prefer loopback HTTP behind Caddy (`DEPLOY.md`).
